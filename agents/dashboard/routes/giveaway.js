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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../lib/paths.js';
import { entryTotal, normalizeEmail } from '../../../lib/giveaway/entries.js';
import {
  subscribeToList, getProfileByEmail, updateProfileProperties,
} from '../../../lib/klaviyo-profiles.js';

const MAX_BODY_BYTES = 4 * 1024;

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

/** Merge a client-declared patch into a breakdown, dropping anything unauthorised. */
export function mergeBreakdown(current, patch = {}) {
  const out = { ...current };
  if (patch.survey === true) out.survey = true;
  if (patch.instagram === true) out.instagram = true;
  if (patch.upload === true) out.upload = true;
  for (const [key, allowed] of Object.entries(ENUMS)) {
    if (patch[key] !== undefined && allowed.has(patch[key])) out[key] = patch[key];
  }
  if (Array.isArray(patch.alsoBuys)) {
    const clean = patch.alsoBuys.filter((v) => ALSO_BUYS.has(v));
    if (clean.length) out.alsoBuys = clean;
  }
  if (typeof patch.igHandle === 'string' && patch.igHandle.trim()) {
    out.igHandle = patch.igHandle.trim().replace(/^@/, '').slice(0, 40);
  }
  // `confirmed` and `referrals` have no write path above — they can only ever
  // come from `current` (i.e. from what the reconciler already persisted).
  // Any client-supplied total is never honoured either.
  delete out.gv_entries;
  return out;
}

export async function computeAndPersistEntries(email, patch = {}) {
  const profile = await getProfileByEmail(email);
  const current = profile?.properties?.gv_breakdown
    ?? { confirmed: false, survey: false, referrals: 0, instagram: false, upload: false };
  const breakdown = mergeBreakdown(current, patch);
  const entries = entryTotal(breakdown);
  await updateProfileProperties(email, { gv_breakdown: breakdown, gv_entries: entries });
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
function readCappedBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('body too large')); req.destroy(); return; }
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

export default [
  {
    method: 'OPTIONS',
    match: (url) => url.split('?')[0].startsWith('/api/giveaway/'),
    handler: (req, res) => { res.writeHead(204, corsHeaders(req)); res.end(); },
  },
  {
    method: 'POST',
    match: (url) => url.split('?')[0] === '/api/giveaway/enter',
    handler: async (req, res) => {
      let parsed;
      try { parsed = JSON.parse(await readCappedBody(req)); }
      catch { return json(res, req, 400, { ok: false, error: 'bad body' }); }

      const v = validateEntryPayload(parsed);
      if (!v.ok) return json(res, req, 400, { ok: false, error: v.error });

      const { email, firstName, referredBy } = v.value;
      // confirmed starts false and is owned solely by the nightly reconciler,
      // which reads the SUBSCRIBED set — the only authority on who actually
      // clicked the double-opt-in link. Nothing in a request may set it.
      const properties = {
        gv_entrant: true,
        gv_entries: 1,
        gv_breakdown: { confirmed: false, survey: false, referrals: 0, instagram: false, upload: false },
      };
      if (referredBy) properties.gv_referred_by = referredBy;

      try {
        await subscribeToList(listId(), { email, firstName, properties });
        return json(res, req, 201, { ok: true, entries: 1 });
      } catch (e) {
        console.error('[giveaway] enter failed', e.message);
        return json(res, req, 502, { ok: false, error: 'could not record entry' });
      }
    },
  },
  {
    method: 'POST',
    match: (url) => url.split('?')[0] === '/api/giveaway/answers',
    handler: async (req, res) => {
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
    },
  },
  {
    method: 'GET',
    match: (url) => url.split('?')[0] === '/api/giveaway/entries',
    handler: async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      let email;
      try { email = normalizeEmail(url.searchParams.get('email')); }
      catch { return json(res, req, 400, { ok: false, error: 'a valid email is required' }); }
      const profile = await getProfileByEmail(email);
      if (!profile) return json(res, req, 404, { ok: false, error: 'not found' });
      return json(res, req, 200, {
        ok: true,
        entries: profile.properties.gv_entries ?? 1,
        breakdown: profile.properties.gv_breakdown ?? {},
      });
    },
  },
];
