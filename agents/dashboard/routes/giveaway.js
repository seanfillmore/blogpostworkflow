// agents/dashboard/routes/giveaway.js
/**
 * Public giveaway entry collector.
 *
 * POST /api/giveaway/enter    — create the entry (the Meta `Lead` conversion)
 * POST /api/giveaway/answers  — store survey answers, credit the +3 rung
 * GET  /api/giveaway/entries  — read a profile's current entry total
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
import { join, basename, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { ROOT } from '../lib/paths.js';
import { createRateLimiter, getClientIp } from '../lib/rate-limit.js';
import { entryTotal, normalizeEmail } from '../../../lib/giveaway/entries.js';
import { uploadImageToShopifyCDN } from '../../../lib/shopify.js';
import {
  subscribeToList, getProfileByEmail, updateProfileProperties,
} from '../../../lib/klaviyo-profiles.js';

const MAX_BODY_BYTES = 4 * 1024;
const UPLOAD_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const MAX_UPLOAD_BASE64 = 8 * 1024 * 1024; // ~6MB file

// Per-IP write budget, shared across /enter, /answers and /upload. Not a
// security boundary -- see agents/dashboard/lib/rate-limit.js. Deliberately
// loose: 5/hour absorbs a normal entrant's enter + answers + upload + a
// retry or two, while still damping a runaway script. GET /entries is
// intentionally NOT limited -- the entered page polls it on every load and
// limiting it would break the ladder display for real visitors.
const writeLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 5 });

function withRateLimit(handler) {
  return async (req, res) => {
    const ip = getClientIp(req);
    if (!writeLimiter.check(ip)) {
      return json(res, req, 429, { ok: false, error: 'too many requests — please try again in a bit' });
    }
    return handler(req, res);
  };
}

const ALLOWED_ORIGINS = new Set([
  'https://www.realskincare.com',
  'https://realskincare.com',
]);

const ENUMS = {
  household: new Set(['solo', 'couple', 'family', 'gift']),
  frustration: new Set(['dry', 'reactive', 'fragrance', 'ingredients']),
  currentBrand: new Set(['cerave', 'cetaphil', 'dove', 'natural_competitor', 'natural_brand', 'whatever']),
  switchBlocker: new Set(['price', 'didnt_work', 'confused', 'ingredients', 'first_time']),
  unscentedReaction: new Set(['multiple', 'once', 'no', 'unsure']),
};
const ALSO_BUYS = new Set(['deodorant', 'toothpaste', 'lotion', 'lipbalm', 'hair']);

const listId = () => JSON.parse(readFileSync(join(ROOT, 'config', 'giveaway.json'), 'utf8')).listId;

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
  if (patch.instagram === true) out.instagram = true;
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

/** Read the body with a hard byte cap, destroying the socket if exceeded. */
function readCappedBody(req, cap = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > cap) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
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
    handler: withRateLimit(async (req, res) => {
      let parsed;
      try { parsed = JSON.parse(await readCappedBody(req)); }
      catch { return json(res, req, 400, { ok: false, error: 'bad body' }); }

      const v = validateEntryPayload(parsed);
      if (!v.ok) return json(res, req, 400, { ok: false, error: v.error });

      const { email, firstName, referredBy } = v.value;
      try {
        // A resubmit must never reset earned progress. Klaviyo replaces the
        // value at a top-level property key rather than deep-merging it, so
        // writing the zeroed gv_breakdown again would wipe a confirmed,
        // surveyed, referred entrant back to a single entry. Double-submits and
        // back-button resubmissions are routine on a cold lander.
        const existing = await getProfileByEmail(email);
        const first = !existing?.properties?.gv_breakdown;

        const properties = { gv_entrant: true };
        if (first) {
          // confirmed starts false and is owned solely by the nightly
          // reconciler, which reads the SUBSCRIBED set — the only authority on
          // who actually clicked the double-opt-in link. No request may set it.
          properties.gv_breakdown = { confirmed: false, survey: false, referrals: 0, instagram: false, upload: false };
          properties.gv_entries = 1;
        }
        // First referrer wins. Without this guard, re-entering lets someone
        // swap in a different referrer after the fact.
        if (referredBy && !existing?.properties?.gv_referred_by) {
          properties.gv_referred_by = referredBy;
        }

        await subscribeToList(listId(), { email, firstName, properties });
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
    handler: withRateLimit(async (req, res) => {
      let parsed;
      try { parsed = JSON.parse(await readCappedBody(req)); }
      catch { return json(res, req, 400, { ok: false, error: 'bad body' }); }
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
    handler: withRateLimit(async (req, res) => {
      let parsed;
      try { parsed = JSON.parse(await readCappedBody(req, MAX_UPLOAD_BASE64 + 2048)); }
      catch { return json(res, req, 400, { ok: false, error: 'bad body' }); }

      const v = validateUpload(parsed);
      if (!v.ok) return json(res, req, 400, { ok: false, error: v.error });

      const tmp = join(tmpdir(), `gv-${Date.now()}-${v.value.filename}`);
      try {
        writeFileSync(tmp, Buffer.from(v.value.dataBase64, 'base64'));
        const url = await uploadImageToShopifyCDN(tmp, 'Giveaway entrant submission');
        const out = await computeAndPersistEntries(v.value.email, { upload: true });
        await updateProfileProperties(v.value.email, { gv_upload_url: url });
        return json(res, req, 200, { ok: true, url, ...out });
      } catch (e) {
        console.error('[giveaway] upload failed', e.message);
        return json(res, req, 502, { ok: false, error: 'could not save your photo' });
      } finally {
        // This box's 24GB disk has already taken down every cron job once by
        // filling up. The temp file goes, success or failure.
        try { unlinkSync(tmp); } catch { /* already gone */ }
      }
    }),
  },
  {
    method: 'GET',
    match: (url) => url.split('?')[0] === '/api/giveaway/entries',
    handler: createEntriesHandler(),
  },
];

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
      if (!profile) return json(res, req, 404, { ok: false, error: 'not found' });
      return json(res, req, 200, {
        ok: true,
        entries: profile.properties.gv_entries ?? 1,
        breakdown: profile.properties.gv_breakdown ?? {},
      });
    } catch (e) {
      console.error('[giveaway] entries lookup failed', e.message);
      return json(res, req, 502, { ok: false, error: 'could not read entries' });
    }
  };
}
