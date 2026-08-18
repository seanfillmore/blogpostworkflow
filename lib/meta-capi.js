// lib/meta-capi.js
/**
 * Send a server-side `Lead` event to Meta's Conversions API.
 *
 * WHY THIS EXISTS: the giveaway had no Lead event at all. `/enter` was
 * documented as "the Meta `Lead` conversion" but nothing fired one — not
 * client-side, not server-side. Confirmed 2026-08-12 against the Dataset
 * Quality API, which returned five events for pixel 1948396628850834
 * (PageView, ViewContent, AddToCart, InitiateCheckout, Purchase) and no Lead.
 *
 * The consequence was not a missing report. The ad set optimises on
 * `custom_event_type: LEAD`, so Meta would have been asked to find people
 * likely to perform an event it could never observe: no learning-phase exit,
 * zero reported conversions, and budget spent against a signal that cannot
 * arrive. AEM also cannot rank an event Meta has never seen, which is why
 * `Lead` could not be prioritised in Events Manager.
 *
 * WHY SERVER-SIDE rather than fbq() in the browser:
 *   - the pixel runs inside Shopify's sandboxed web-pixels runtime, so `fbq`
 *     is not reachable from page scripts (see scripts/giveaway/verify-launch.mjs,
 *     which greps the web-pixels config for exactly this reason)
 *   - ad blockers drop browser-side lead events; this endpoint is on a
 *     first-party subdomain specifically because that lesson was already paid for
 *   - it fires when an entry is actually recorded, not when a page loads
 *
 * Email is hashed with SHA-256 before it leaves this process. Meta requires
 * that; so does not shipping customer PII to a third party in the clear.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { notify } from './notify.js';

const API_VERSION = 'v21.0';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Resolve the token from process.env first, then .env.
 *
 * This is defence in depth, NOT a fix for a live outage. The live path already
 * works: `agents/dashboard/index.js` calls `hydrateProcessEnv(loadEnvAuth())` at
 * bootstrap, which copies all ~59 keys of .env into process.env before any route
 * serves a request, so the entry route's `process.env.FACEBOOK_ACCESS_TOKEN` is
 * populated. Verified 2026-08-17 end to end: a real entry through the live
 * endpoint took the dataset's Lead count from 6 to 7.
 *
 * What this guards is a caller that has NO hydration step — a cron script, a
 * one-off, a future service — passing the token through from a bare process.env
 * and getting undefined. Without the fallback that is a silent `false` and a
 * missing conversion.
 *
 * ── TWO MEASUREMENT TRAPS, both of which produced a confidently wrong diagnosis
 * on 2026-08-17. Do not repeat either:
 *
 * 1. `/proc/<pid>/environ` is the EXEC-TIME snapshot. It does not reflect
 *    `process.env.X = ...` assigned at runtime, which is exactly what
 *    hydrateProcessEnv does. Reading `grep -c FACEBOOK_ACCESS_TOKEN` there
 *    returns 0 on a perfectly working process. To ask whether a running Node
 *    process has a variable, ask the process, not /proc.
 *
 * 2. Meta's `/{pixel}/stats` endpoint LAGS by many minutes and defaults to a
 *    window of roughly the last 36 HOURS. An event that has been accepted may
 *    not appear for a long while, and one sent days ago may sit outside the
 *    default window entirely. `sendLeadEvent`'s own return value is the fast,
 *    authoritative signal: true means Meta replied with events_received > 0.
 *
 * Precedence matches what CLAUDE.md documents for CREATIVES_BUDGET_BYTES:
 * process.env first, then .env, so both the unattended and hand-run paths find it.
 */
export function resolveLeadAccessToken(env = process.env) {
  if (env.FACEBOOK_ACCESS_TOKEN) return env.FACEBOOK_ACCESS_TOKEN;
  try {
    for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i === -1) continue;
      if (t.slice(0, i).trim() === 'FACEBOOK_ACCESS_TOKEN') return t.slice(i + 1).trim();
    }
  } catch { /* no .env is a valid state */ }
  return null;
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

/**
 * A failed Lead used to reach a console.error and nothing else. That is the wrong
 * place for it: the ad set optimises on LEAD, so a Lead that stops landing means
 * budget is being spent against a signal that can no longer arrive — and the only
 * symptom is a PM2 log line nobody is watching. At $30/day, a silent failure over
 * a weekend is real money against a campaign that is also not learning.
 *
 * Two deliberate choices:
 *
 *  - `immediate: true`, so it does not wait for the 5 AM digest. A conversion
 *    signal that has stopped is worth interrupting for; a day of blind spend is
 *    the thing this exists to prevent.
 *  - Throttled per reason. The failure mode is systemic, not per-entrant — an
 *    expired token fails EVERY entry — so an unthrottled alert turns one outage
 *    into an inbox flood and gets muted, which is the same as having no alert.
 *    One email per reason per hour is enough to notice and not enough to ignore.
 */
const ALERT_THROTTLE_MS = 60 * 60 * 1000;
const lastAlertAt = new Map();

/**
 * Test seam. `notify` loads .env itself and emails through Resend, and .env is
 * symlinked into every worktree — so without this, running the test suite sends
 * real mail. Tests swap in a collector; nothing else touches it.
 */
let notifier = notify;

/** Exported for tests only — module state would otherwise leak between cases. */
export function __setLeadNotifier(fn) {
  notifier = fn ?? notify;
}

/** Exported for tests only — module state would otherwise leak between cases. */
export function __resetLeadAlertThrottle() {
  lastAlertAt.clear();
}

async function alertLeadFailure(reason, detail) {
  const now = Date.now();
  const previous = lastAlertAt.get(reason);
  if (previous && now - previous < ALERT_THROTTLE_MS) return;
  lastAlertAt.set(reason, now);

  // This runs inside the public entry route on a floating promise. It must not
  // throw under any circumstance, including Resend being down.
  try {
    await notifier({
      subject: `Meta Lead event FAILED — ${reason}`,
      body:
        `A giveaway entry was recorded but its Meta Lead event did not land.\n\n` +
        `Reason: ${reason}\n` +
        `Detail: ${detail}\n\n` +
        `The ad set optimises on LEAD. While this is failing, spend continues against a\n` +
        `conversion Meta cannot observe: no learning-phase progress and no reported\n` +
        `conversions. Check the token first — it is the usual cause.\n\n` +
        `Further alerts for this reason are suppressed for 1 hour.`,
      status: 'error',
      category: 'giveaway',
      immediate: true,
    });
  } catch (e) {
    console.error('[meta-capi] alert failed to send', e?.message);
  }
}

/**
 * Fire one Lead event. Resolves true on success, false on ANY failure.
 *
 * It never throws. The entry is the thing that was paid for — roughly $2.50 of
 * ad spend — and losing it because an analytics call failed would be a far
 * worse trade than losing the analytics event. Every caller can safely ignore
 * the return value.
 *
 * @param {object}  o
 * @param {string}  o.email      raw address; normalised and hashed here
 * @param {string}  o.pixelId    dataset id
 * @param {string}  o.accessToken token with ads permissions on that dataset
 * @param {string} [o.eventId]   dedup key, in case a browser-side Lead is ever added
 * @param {string} [o.fbc]       Meta click id cookie (_fbc) — the largest single match-quality lever
 * @param {string} [o.fbp]       Meta browser id cookie (_fbp)
 * @param {string} [o.clientIp]
 * @param {string} [o.userAgent]
 * @param {string} [o.sourceUrl]
 * @param {string} [o.testEventCode] routes the event to Events Manager → Test Events instead of the live dataset
 */
export async function sendLeadEvent({
  email, pixelId, accessToken, eventId = null,
  fbc = null, fbp = null, clientIp = null, userAgent = null, sourceUrl = null,
  testEventCode = null,
} = {}) {
  // An unconfigured environment must be a silent no-op, not a crash: this runs
  // inside the public entry route.
  //
  // But distinguish the two ways of getting here. No email is a caller bug and
  // stays silent. An email WITH missing credentials means a real entrant just
  // came through and no Lead was even attempted — in production that is an
  // outage, and it is precisely the state the giveaway shipped in before
  // 2026-08-13, so it gets an alert rather than a silent false.
  if (!email) return false;

  // Fall back to .env when the caller has no token. The dashboard runs under
  // PM2, which does not source .env, so a caller reading process.env directly
  // passes undefined here — see resolveLeadAccessToken.
  const token = accessToken || resolveLeadAccessToken();

  if (!pixelId || !token) {
    await alertLeadFailure(
      'not configured',
      `pixelId ${pixelId ? 'present' : 'MISSING'}, accessToken ${token ? 'present' : 'MISSING'}`,
    );
    return false;
  }

  const normalized = String(email).trim().toLowerCase();
  const user_data = { em: [sha256(normalized)] };

  // Omit rather than send null. Meta treats an explicit null as a supplied
  // value and it drags the match score down.
  if (fbc) user_data.fbc = fbc;
  if (fbp) user_data.fbp = fbp;
  if (clientIp) user_data.client_ip_address = clientIp;
  if (userAgent) user_data.client_user_agent = userAgent;

  const event = {
    event_name: 'Lead',
    event_time: Math.floor(Date.now() / 1000),
    action_source: 'website',
    user_data,
  };
  if (eventId) event.event_id = eventId;
  if (sourceUrl) event.event_source_url = sourceUrl;

  const body = { data: [event] };
  if (testEventCode) body.test_event_code = testEventCode;

  try {
    const res = await fetch(
      `https://graph.facebook.com/${API_VERSION}/${pixelId}/events?access_token=${encodeURIComponent(token)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    );
    const text = await res.text();
    if (!res.ok) {
      console.error('[meta-capi] Lead rejected', res.status, text.slice(0, 300));
      await alertLeadFailure(`HTTP ${res.status}`, text.slice(0, 300));
      return false;
    }
    // A 200 with events_received: 0 means Meta accepted the request and dropped
    // the event — the silent failure this whole module exists to make visible.
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* non-JSON success body */ }
    if (parsed && parsed.events_received === 0) {
      console.error('[meta-capi] Lead accepted but NOT recorded (events_received: 0)', text.slice(0, 300));
      await alertLeadFailure('accepted but dropped (events_received: 0)', text.slice(0, 300));
      return false;
    }
    return true;
  } catch (e) {
    console.error('[meta-capi] Lead send failed', e.message);
    await alertLeadFailure('network error', e?.message ?? String(e));
    return false;
  }
}

export default { sendLeadEvent };
