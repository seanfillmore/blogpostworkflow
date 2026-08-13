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

const API_VERSION = 'v21.0';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

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
  if (!pixelId || !accessToken || !email) return false;

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
      `https://graph.facebook.com/${API_VERSION}/${pixelId}/events?access_token=${encodeURIComponent(accessToken)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    );
    const text = await res.text();
    if (!res.ok) {
      console.error('[meta-capi] Lead rejected', res.status, text.slice(0, 300));
      return false;
    }
    // A 200 with events_received: 0 means Meta accepted the request and dropped
    // the event — the silent failure this whole module exists to make visible.
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* non-JSON success body */ }
    if (parsed && parsed.events_received === 0) {
      console.error('[meta-capi] Lead accepted but NOT recorded (events_received: 0)', text.slice(0, 300));
      return false;
    }
    return true;
  } catch (e) {
    console.error('[meta-capi] Lead send failed', e.message);
    return false;
  }
}

export default { sendLeadEvent };
