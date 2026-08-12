/**
 * Google Ads offline conversion import — pure payload logic.
 *
 * WHY THIS EXISTS
 * ---------------
 * Google Ads counted 0 conversions from 2026-04 through 2026-08 while the store was
 * taking real orders from paid clicks. Root cause: the account's only counted purchase
 * conversion was a GA4 import, and GA4 never saw most of the traffic — 264 ad clicks
 * produced 85 GA4 sessions (68% lost) and 7 storefront orders produced 4 GA4
 * transactions. Every native WEBPAGE conversion action in the account is REMOVED, so
 * there was no first-party fallback.
 *
 * Client-side tracking cannot be repaired into reliability here (the loss is consent
 * banners, ad blockers and the sandboxed Shopify channel pixel — NOT page speed; real
 * p75 LCP is ~1.5s). So conversions are uploaded server-side from Shopify orders, which
 * carry the Google click identifier in `landing_site`. This is immune to every
 * client-side failure mode above.
 *
 * This module is deliberately credential-free so it can be unit tested; the HTTP call
 * lives in lib/google-ads.js.
 */

// A real gclid/gbraid/wbraid is 50-100+ characters. Shopify caps `landing_site` at 255
// characters and Google Shopping puts gclid last in the query string, so the gclid is
// routinely sliced down to a stump ("CjwK"). Uploading a stump is worse than uploading
// nothing: Google accepts it and attributes it to no click. Anything shorter than this
// is treated as damaged and discarded.
const MIN_CLICK_ID_LENGTH = 20;

// Highest fidelity first. gclid identifies the exact click; gbraid/wbraid are the
// privacy-preserving replacements Google sends when a gclid cannot be set.
const CLICK_ID_PRIORITY = ['gclid', 'gbraid', 'wbraid'];

/**
 * Pull the best usable Google click identifier out of a Shopify `landing_site` value.
 * Returns { type, value } or null when there is nothing trustworthy to upload.
 */
export function extractClickId(landingSite) {
  if (!landingSite || typeof landingSite !== 'string') return null;
  const qs = landingSite.slice(landingSite.indexOf('?') + 1);
  if (!qs || !landingSite.includes('?')) return null;
  const params = new URLSearchParams(qs);
  for (const type of CLICK_ID_PRIORITY) {
    const value = params.get(type);
    if (value && value.length >= MIN_CLICK_ID_LENGTH) return { type, value };
  }
  return null;
}

/**
 * Data Manager takes ISO 8601 with a UTC offset, which is already Shopify's `created_at`
 * format, so the value passes through unchanged. It is still validated: a malformed
 * timestamp must fail loudly here rather than be rejected opaquely by Google later.
 * The original offset is never re-based to UTC — that would move the event into a
 * different local day and can push it outside the click lookback window.
 */
export function validateEventTimestamp(iso) {
  const ok = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(String(iso));
  if (!ok) throw new Error(`Unparseable order timestamp: ${iso}`);
  return String(iso);
}

/**
 * Build one Data Manager `Event` from a Shopify order.
 */
export function buildConversionEvent(order) {
  const clickId = extractClickId(order.landing_site);
  if (!clickId) throw new Error(`Order ${order.order_number} has no usable click identifier`);

  return {
    eventTimestamp: validateEventTimestamp(order.created_at),
    // Google deduplicates on transactionId, which is what makes re-uploading the same
    // window every day safe. Without it a daily cron would multiply every conversion.
    transactionId: String(order.order_number),
    conversionValue: Number(order.total_price),
    currency: order.currency || 'USD',
    eventSource: 'WEB',
    adIdentifiers: { [clickId.type]: clickId.value },
  };
}

// ── ingest status ────────────────────────────────────────────────────────────
//
// events:ingest is ASYNCHRONOUS. Its response body is only { requestId, fieldWarnings? }
// and carries no per-event acceptance. The first version of this agent computed
// `accepted = events.length - errors.length`, so an empty response was reported as
// "2/2 accepted" while Google had recorded nothing — the exact "a 200 is not evidence"
// failure this whole pipeline exists to eliminate. Real status comes from
// GET /v1/requestStatus:retrieve?requestId=<id>, and only for non-validateOnly requests
// (validate-only ids are prefixed "v-" and are rejected).

const PROCESSING = 'PROCESSING';

/** Anything that is not explicitly still processing is terminal — including a status
 *  string we have never seen, so a future enum value cannot make the poller spin. */
export function isTerminalStatus(status) {
  if (!status) return false;
  return status !== PROCESSING;
}

/**
 * Reduce a requestStatus:retrieve body to { status, terminal, confirmed }.
 * `confirmed` is true ONLY when every destination reported SUCCESS. An absent or
 * unparseable body is never confirmed.
 */
export function summarizeIngestStatus(body) {
  const rows = body?.requestStatusPerDestination || [];
  if (!rows.length) return { status: 'UNKNOWN', terminal: false, confirmed: false, destinations: [] };
  const statuses = rows.map((r) => r.requestStatus);
  return {
    status: statuses.join(','),
    terminal: statuses.every(isTerminalStatus),
    confirmed: statuses.every((s) => s === 'SUCCESS'),
    destinations: rows,
  };
}

/**
 * Wrap events in a full events:ingest request body.
 *
 * `productDestinationId` is the numeric conversion action id (not the resource name).
 * No `loginAccount` is sent: the Ads account is not under a manager, so the operating
 * account is also the login account and Google infers it.
 */
export function buildIngestRequest(orders, { accountId, conversionActionId, validateOnly = false }) {
  return {
    destinations: [{
      operatingAccount: { accountType: 'GOOGLE_ADS', accountId: String(accountId) },
      productDestinationId: String(conversionActionId),
    }],
    events: orders.map(buildConversionEvent),
    validateOnly,
  };
}

/**
 * Filter a batch of Shopify orders down to the ones worth uploading.
 */
export function selectUploadableOrders(orders, { now = new Date(), lookbackDays = 90 } = {}) {
  const cutoff = new Date(now.getTime() - lookbackDays * 86_400_000);
  return orders.filter((o) => {
    if (o.cancelled_at) return false;              // refunded revenue teaches the wrong lesson
    if (!(Number(o.total_price) > 0)) return false; // $0 test/comp orders
    if (!extractClickId(o.landing_site)) return false;
    return new Date(o.created_at) >= cutoff;        // outside the click lookback window
  });
}
