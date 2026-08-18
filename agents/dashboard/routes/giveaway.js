// agents/dashboard/routes/giveaway.js
/**
 * Public giveaway entry collector.
 *
 * POST /api/giveaway/enter    — create the entry (the Meta `Lead` conversion)
 * POST /api/giveaway/answers  — store survey answers, credit the +3 rung
 * POST /api/giveaway/upload   — licensed photo, credit the +10 rung
 * GET  /api/giveaway/entries  — read an ENTRANT's current entry total
 *
 * PUBLIC and unauthenticated, exactly like /api/rum, because storefront
 * browsers cannot send dashboard basic-auth and those credentials must never
 * appear in theme JS. Bodies are capped and every field is enum-validated.
 *
 * Entry totals are computed SERVER-SIDE ONLY. A client may say which action it
 * performed; it may never say what that action is worth. `confirmed` and
 * referral credits are owned solely by scripts/giveaway/reconcile-referrals.mjs
 * (Task 5), which reads Klaviyo's SUBSCRIBED set after the referred friend
 * double-opt-in confirms — never from a request. mergeBreakdown below has no
 * write path for either field, by construction.
 */
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, basename, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { ROOT } from '../lib/paths.js';
import { createRateLimiter, getClientIp } from '../lib/rate-limit.js';
import { entryTotal, normalizeEmail } from '../../../lib/giveaway/entries.js';
import { uploadImageToShopifyCDN } from '../../../lib/shopify.js';
import {
  subscribeToList, getProfileByEmail, updateProfileProperties,
} from '../../../lib/klaviyo-profiles.js';
import { sendLeadEvent } from '../../../lib/meta-capi.js';

const MAX_BODY_BYTES = 4 * 1024;
const UPLOAD_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const MAX_UPLOAD_BASE64 = 8 * 1024 * 1024; // ~6MB file

// Two independent per-IP budgets, not one shared one. Not a security boundary
// -- see agents/dashboard/lib/rate-limit.js. A single shared 5/hour budget
// was tried first and was wrong: the legitimate funnel is FOUR write
// requests (enter, answers/survey, answers/Instagram, upload), so one clean
// pass already consumes 4 of 5 and a single accidental double-tap 429s a
// genuine, rights-granting entrant out of the +10 upload rung -- the
// ladder's single most valuable action.
//
// The right split follows the actual abuse surface: /enter is the ONLY
// route that CREATES a Klaviyo profile, so it is the entire abuse surface
// and keeps the tight 5/hour budget. /answers and /upload only mutate a
// profile that already exists -- they cannot create one -- so they share a
// much looser 30/hour budget that comfortably covers the full funnel plus
// retries.
//
// GET /entries gets its OWN, deliberately LOOSE 120/hour budget. It was
// previously unlimited, which made it an unmetered proxy onto Klaviyo's
// account-wide API quota -- the same quota the live customer flows share --
// and an unlimited-rate probe of who is an entrant. It must stay loose
// because the entered page calls it on every single pageview; 120/hour per IP
// is roughly two pageloads a minute sustained, far above any real visitor and
// far below a useful scraping rate.
const enterLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 5 });
const mutateLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 30 });
const entriesLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 120 });

function withRateLimit(limiter, handler) {
  return async (req, res) => {
    const ip = getClientIp(req);
    if (!limiter.check(ip)) {
      return json(res, req, 429, { ok: false, error: 'too many requests — please try again in a bit' });
    }
    return handler(req, res);
  };
}

const ALLOWED_ORIGINS = new Set([
  'https://www.realskincare.com',
  'https://realskincare.com',
]);

// NOT YET COLLECTED, deliberately kept: `switchBlocker` and `unscentedReaction`
// (and `alsoBuys` below) are validated, mapped to gv_* properties and bucketed by
// lib/giveaway/summarize.js, but NO surface asks for them -- the spec's three
// OPTIONAL questions were never built into the entered page or any email, so
// these three properties are always empty in production today. Left wired rather
// than deleted so adding the UI is a one-file change, pending a product decision
// on whether a second survey step is worth the drop-off. Do not read a report
// bucket for these as "nobody picked that answer"; nobody was asked.
const ENUMS = {
  household: new Set(['solo', 'couple', 'family', 'gift']),
  frustration: new Set(['dry', 'reactive', 'fragrance', 'ingredients']),
  currentBrand: new Set(['cerave', 'cetaphil', 'dove', 'natural_competitor', 'natural_brand', 'whatever']),
  switchBlocker: new Set(['price', 'didnt_work', 'confused', 'ingredients', 'first_time']), // not yet collected
  unscentedReaction: new Set(['multiple', 'once', 'no', 'unsure']), // not yet collected
};
const ALSO_BUYS = new Set(['deodorant', 'toothpaste', 'lotion', 'lipbalm', 'hair']); // not yet collected

const listId = () => JSON.parse(readFileSync(join(ROOT, 'config', 'giveaway.json'), 'utf8')).listId;
const metaPixelId = () => JSON.parse(readFileSync(join(ROOT, 'config', 'giveaway.json'), 'utf8')).metaPixelId;

export function validateEntryPayload(body = {}) {
  let email;
  try {
    email = normalizeEmail(body.email);
  } catch {
    return { ok: false, error: 'a valid email is required' };
  }
  const firstName = String(body.firstName ?? '').trim();
  if (!firstName) return { ok: false, error: 'firstName is required' };

  let referredBy = null;
  if (body.referredBy) {
    try {
      const r = normalizeEmail(body.referredBy);
      // Self-referral: drop the referral, keep the entry. Losing a paid entry
      // over a bad optional field is the more expensive mistake.
      referredBy = r === email ? null : r;
    } catch { referredBy = null; }
  }
  return { ok: true, value: { email, firstName: firstName.slice(0, 80), referredBy } };
}

/**
 * Upload rung (+10): a photo/video with a granted usage-rights checkbox.
 * Worth more than the Instagram rung because a tagged post gives reach but
 * NO licence to use the asset -- this produces licensed creative instead.
 * The rights checkbox is not optional decoration: an upload without it is
 * rejected outright, before the file is even decoded.
 */
export function validateUpload(body = {}) {
  let email;
  try { email = normalizeEmail(body.email); }
  catch { return { ok: false, error: 'a valid email is required' }; }

  if (body.rightsGranted !== true) {
    return { ok: false, error: 'usage rights must be granted for us to use your photo' };
  }
  const data = String(body.dataBase64 ?? '');
  if (!data) return { ok: false, error: 'no file supplied' };
  if (data.length > MAX_UPLOAD_BASE64) return { ok: false, error: 'file is too large (6MB max)' };

  // basename() strips any traversal before we ever touch the filesystem.
  const filename = basename(String(body.filename ?? '')).slice(-80);
  const ext = extname(filename).toLowerCase();
  if (!UPLOAD_EXTS.has(ext)) {
    // The test's regex checks the literal substring "jpg, jpeg, png, webp"
    // (no "or") -- keep this phrasing exact if it is ever reworded.
    return { ok: false, error: 'please send a jpg, jpeg, png, webp file' };
  }
  return { ok: true, value: { email, filename, dataBase64: data } };
}

/**
 * Merge a client-declared patch into the entry-ladder breakdown.
 *
 * The breakdown holds LADDER STATE ONLY — the booleans and counts that
 * entryTotal() prices. Survey answers are deliberately NOT stored here: they go
 * out as top-level gv_* profile properties instead (see answerProperties below),
 * because a Klaviyo flow filter and a Klaviyo segment both need a top-level
 * property. The nurture flow branches on gv_frustration, and the daily report
 * reads gv_household / gv_frustration / gv_current_brand. Neither can see a key
 * buried inside a JSON-object property.
 */
export function mergeBreakdown(current, patch = {}) {
  const out = { ...current };
  if (patch.survey === true) out.survey = true;
  // The Instagram rung (+3) requires the HANDLE, not just the claim. The rung
  // pays for a public tagged post, and the handle is the only way to spot-check
  // that one exists; crediting `instagram: true` with no handle banks 3 entries
  // against nothing anyone can verify. The storefront never sends one without
  // the other, so this only ever rejects a hand-crafted request.
  if (patch.instagram === true && typeof patch.igHandle === 'string' && patch.igHandle.trim()) {
    out.instagram = true;
  }
  if (patch.upload === true) out.upload = true;
  // referrals and confirmed are owned by the nightly reconciler; a client-supplied
  // total is never honoured.
  delete out.gv_entries;
  return out;
}

/** Enum answer name -> the top-level Klaviyo property it is stored as. */
const ANSWER_PROPERTY = {
  household: 'gv_household',
  frustration: 'gv_frustration',
  currentBrand: 'gv_current_brand',
  switchBlocker: 'gv_switch_blocker',
  unscentedReaction: 'gv_unscented_reaction',
};

/** Extract validated survey answers as top-level gv_* properties. Unknown enum values are dropped. */
export function answerProperties(patch = {}) {
  const out = {};
  for (const [key, allowed] of Object.entries(ENUMS)) {
    if (patch[key] !== undefined && allowed.has(patch[key])) out[ANSWER_PROPERTY[key]] = patch[key];
  }
  if (Array.isArray(patch.alsoBuys)) {
    const clean = patch.alsoBuys.filter((v) => ALSO_BUYS.has(v));
    if (clean.length) out.gv_also_buys = clean;
  }
  if (typeof patch.igHandle === 'string' && patch.igHandle.trim()) {
    out.gv_ig_handle = patch.igHandle.trim().replace(/^@/, '').slice(0, 40);
  }
  return out;
}

/**
 * The Klaviyo properties a POST /enter should write, given the profile that
 * already exists (or null) and the validated payload.
 *
 * Pure and exported so the resubmit invariant is TESTABLE. It is not a
 * hypothetical: writing the zeroed gv_breakdown on a repeat entry wiped a
 * confirmed, surveyed, referred entrant back to a single entry, because Klaviyo
 * REPLACES the value at a top-level property key rather than deep-merging it.
 * Double-submits and back-button resubmissions are routine on a cold lander, so
 * this is the difference between an entrant keeping 11 entries and keeping 1.
 *
 * @param {{properties?: object}|null} existing profile as returned by getProfileByEmail
 * @param {{referredBy?: string|null}} value validated entry payload
 */
export function entryProperties(existing, value = {}) {
  const properties = { gv_entrant: true };
  const first = !existing?.properties?.gv_breakdown;
  if (first) {
    // confirmed starts false and is owned solely by the nightly reconciler,
    // which reads the SUBSCRIBED set — the only authority on who actually
    // clicked the double-opt-in link. No request may set it.
    properties.gv_breakdown = { confirmed: false, survey: false, referrals: 0, instagram: false, upload: false };
    properties.gv_entries = 1;
    // Stamped on FIRST entry only, and never rewritten on a resubmit — the
    // cohort denominator in lib/giveaway/cohort.js dates every window from it,
    // so a resubmit moving it forward would reset that entrant's clock and make
    // a real conversion look like it happened before entry.
    properties.gv_entered_at = new Date().toISOString();
  }
  // First referrer wins. Without this guard, re-entering lets someone swap in a
  // different referrer after the fact.
  if (value.referredBy && !existing?.properties?.gv_referred_by) {
    properties.gv_referred_by = value.referredBy;
  }
  return properties;
}

export async function computeAndPersistEntries(email, patch = {}) {
  const profile = await getProfileByEmail(email);
  const current = profile?.properties?.gv_breakdown
    ?? { confirmed: false, survey: false, referrals: 0, instagram: false, upload: false };
  const breakdown = mergeBreakdown(current, patch);
  const entries = entryTotal(breakdown);
  await updateProfileProperties(email, {
    gv_breakdown: breakdown,
    gv_entries: entries,
    ...answerProperties(patch),
  });
  return { entries, breakdown };
}

function corsHeaders(req) {
  const origin = req.headers.origin;
  const allowed = ALLOWED_ORIGINS.has(origin) ? origin : 'https://www.realskincare.com';
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

/**
 * Read the body with a hard byte cap.
 *
 * Rejects with code BODY_TOO_LARGE once the cap is passed, and deliberately
 * does NOT destroy the socket here. Destroying it at this point reset the
 * connection before the error response could flush, so nginx logged
 *   recv() failed (104: Connection reset by peer) while reading response
 *   header from upstream ... POST /api/giveaway/upload
 * and served the entrant a bare 502 with no message. Teardown belongs after
 * the response is written — see refuseBody.
 *
 * Further chunks are dropped rather than buffered, so an oversized body costs
 * bounded memory even though we stop reading it.
 */
function readCappedBody(req, cap = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let overflowed = false;
    const chunks = [];
    req.on('data', (c) => {
      if (overflowed) return;
      size += c.length;
      if (size > cap) {
        overflowed = true;
        const e = new Error('body too large');
        e.code = 'BODY_TOO_LARGE';
        reject(e);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!overflowed) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

/**
 * Turn a body-read failure into a response.
 *
 * An oversized body is 413 with a message the entrant can act on, not a
 * generic 400 and never a reset. The 'finish' listener is attached BEFORE the
 * response is written so the socket is torn down only once the bytes are out.
 */
function refuseBody(req, res, e, tooLargeMessage) {
  if (e?.code !== 'BODY_TOO_LARGE') return json(res, req, 400, { ok: false, error: 'bad body' });
  if (typeof res.on === 'function') res.on('finish', () => req.destroy());
  return json(res, req, 413, { ok: false, error: tooLargeMessage });
}

const json = (res, req, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...corsHeaders(req) });
  res.end(JSON.stringify(body));
};

// Route objects are matched by `dispatch()` in agents/dashboard/lib/router.js,
// which reads `route.match` — NOT `route.path`. And when `match` is a string it
// compares against the full `req.url`, query string included, so an exact-string
// match breaks any route that takes query params. Both reasons to use a function
// that strips the query, exactly as routes/rum.js does.
export default [
  {
    method: 'OPTIONS',
    match: (url) => url.split('?')[0].startsWith('/api/giveaway/'),
    handler: (req, res) => { res.writeHead(204, corsHeaders(req)); res.end(); },
  },
  {
    method: 'POST',
    match: (url) => url.split('?')[0] === '/api/giveaway/enter',
    handler: withRateLimit(enterLimiter, async (req, res) => {
      let parsed;
      try { parsed = JSON.parse(await readCappedBody(req)); }
      catch (e) { return refuseBody(req, res, e, 'that request is too large'); }

      const v = validateEntryPayload(parsed);
      if (!v.ok) return json(res, req, 400, { ok: false, error: v.error });

      const { email, firstName } = v.value;
      try {
        // A resubmit must never reset earned progress — see entryProperties.
        const existing = await getProfileByEmail(email);
        const properties = entryProperties(existing, v.value);

        await subscribeToList(listId(), { email, firstName, properties });

        // Tell Meta a Lead happened. NOT awaited: the entrant's response must
        // not wait on a third party, and sendLeadEvent never throws or rejects,
        // so a floating promise here cannot surface as an unhandled rejection.
        //
        // Fired only for a FIRST entry. A resubmit — routine on a cold lander,
        // back button or double tap — is the same lead, and counting it twice
        // would inflate the conversion Meta optimises on and corrupt CAC.
        if (!existing?.properties?.gv_breakdown) {
          sendLeadEvent({
            email,
            pixelId: metaPixelId(),
            accessToken: process.env.FACEBOOK_ACCESS_TOKEN,
            // Deterministic from the address, so a browser-side Lead added later
            // deduplicates against this one instead of double counting.
            eventId: `gv-lead-${createHash('sha256').update(email).digest('hex').slice(0, 24)}`,
            fbc: typeof parsed.fbc === 'string' ? parsed.fbc.slice(0, 255) : null,
            fbp: typeof parsed.fbp === 'string' ? parsed.fbp.slice(0, 255) : null,
            clientIp: getClientIp(req),
            userAgent: req.headers['user-agent'] || null,
            sourceUrl: 'https://www.realskincare.com/pages/free-soap-giveaway',
          });
        }

        return json(res, req, 201, { ok: true, entries: existing?.properties?.gv_entries ?? 1 });
      } catch (e) {
        console.error('[giveaway] enter failed', e.message);
        return json(res, req, 502, { ok: false, error: 'could not record entry' });
      }
    }),
  },
  {
    method: 'POST',
    match: (url) => url.split('?')[0] === '/api/giveaway/answers',
    handler: withRateLimit(mutateLimiter, async (req, res) => {
      let parsed;
      try { parsed = JSON.parse(await readCappedBody(req)); }
      catch (e) { return refuseBody(req, res, e, 'that request is too large'); }
      let email;
      try { email = normalizeEmail(parsed.email); }
      catch { return json(res, req, 400, { ok: false, error: 'a valid email is required' }); }

      try {
        const out = await computeAndPersistEntries(email, { ...parsed, survey: true });
        return json(res, req, 200, { ok: true, ...out });
      } catch (e) {
        console.error('[giveaway] answers failed', e.message);
        return json(res, req, 502, { ok: false, error: 'could not save answers' });
      }
    }),
  },
  {
    method: 'POST',
    match: (url) => url.split('?')[0] === '/api/giveaway/upload',
    handler: withRateLimit(mutateLimiter, createUploadHandler()),
  },
  {
    method: 'GET',
    match: (url) => url.split('?')[0] === '/api/giveaway/entries',
    handler: withRateLimit(entriesLimiter, createEntriesHandler()),
  },
];

// Factory for the same reason as createEntriesHandler below: the ORDER of the
// two side effects here is the thing worth testing, and it cannot be observed
// without stubbing both boundaries.
export function createUploadHandler({
  getProfileByEmail: getProfile = getProfileByEmail,
  uploadImageToShopifyCDN: uploadToCDN = uploadImageToShopifyCDN,
  computeAndPersistEntries: persist = computeAndPersistEntries,
  updateProfileProperties: updateProps = updateProfileProperties,
} = {}) {
  return async (req, res) => {
    let parsed;
    try { parsed = JSON.parse(await readCappedBody(req, MAX_UPLOAD_BASE64 + 2048)); }
    catch (e) { return refuseBody(req, res, e, 'that file is too large (6MB max)'); }

    const v = validateUpload(parsed);
    if (!v.ok) return json(res, req, 400, { ok: false, error: v.error });

    const tmp = join(tmpdir(), `gv-${Date.now()}-${v.value.filename}`);
    try {
      // Resolve the entrant BEFORE anything is written to the store's Files
      // library. uploadImageToShopifyCDN is PERMANENT and unauthenticated
      // callers reach this route, so uploading first meant any address — one
      // that had never entered, one that does not exist in Klaviyo at all —
      // could push arbitrary images into production Files, and only then get a
      // 502 when computeAndPersistEntries threw "no Klaviyo profile". The file
      // stayed. Requiring a gv_breakdown (not merely a Klaviyo profile) also
      // keeps the store's Files library closed to the 481 existing newsletter
      // subscribers who never entered the giveaway.
      const profile = await getProfile(v.value.email);
      if (!profile?.properties?.gv_breakdown) {
        return json(res, req, 404, { ok: false, error: 'we could not find your entry — please enter the giveaway first' });
      }

      writeFileSync(tmp, Buffer.from(v.value.dataBase64, 'base64'));
      const url = await uploadToCDN(tmp, 'Giveaway entrant submission');
      const out = await persist(v.value.email, { upload: true });
      await updateProps(v.value.email, { gv_upload_url: url });
      return json(res, req, 200, { ok: true, url, ...out });
    } catch (e) {
      console.error('[giveaway] upload failed', e.message);
      return json(res, req, 502, { ok: false, error: 'could not save your photo' });
    } finally {
      // This box's 24GB disk has already taken down every cron job once by
      // filling up. The temp file goes, success or failure.
      try { unlinkSync(tmp); } catch { /* already gone */ }
    }
  };
}

// Factory rather than an inline handler so the test suite can inject a
// stubbed `getProfileByEmail` and exercise the crash path directly, without
// a real network call to Klaviyo. The route array above uses the default
// (real) dependency, so production behaviour is unchanged.
export function createEntriesHandler({ getProfileByEmail: getProfile = getProfileByEmail } = {}) {
  return async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let email;
    try { email = normalizeEmail(url.searchParams.get('email')); }
    catch { return json(res, req, 400, { ok: false, error: 'a valid email is required' }); }
    // MUST be wrapped. dispatch() in agents/dashboard/lib/router.js calls the
    // handler without awaiting it, and this codebase installs no
    // unhandledRejection hook — so an un-caught throw here terminates the
    // whole PM2 process under Node 22's defaults, taking every other
    // dashboard function down with it. This route is public and
    // unauthenticated, and klaviyoRequest throws on any non-2xx, so a routine
    // Klaviyo 5xx or rate-limit would be enough to do it.
    try {
      const profile = await getProfile(email);
      // Answer only for GIVEAWAY ENTRANTS, not for "any address Klaviyo knows".
      // getProfileByEmail searches the whole account, so a bare
      // profile-exists check turned this public, unauthenticated route into a
      // subscriber-enumeration oracle: 200 meant "this address is in Real Skin
      // Care's Klaviyo", 404 meant it is not, at whatever rate the caller liked.
      // gv_breakdown is written on first entry and by nothing else, so it is the
      // narrowest available test for "this person entered".
      if (!profile?.properties?.gv_breakdown) {
        return json(res, req, 404, { ok: false, error: 'not found' });
      }
      return json(res, req, 200, {
        ok: true,
        entries: profile.properties.gv_entries ?? 1,
        breakdown: profile.properties.gv_breakdown,
      });
    } catch (e) {
      console.error('[giveaway] entries lookup failed', e.message);
      return json(res, req, 502, { ok: false, error: 'could not read entries' });
    }
  };
}
