/**
 * The page URL Search Console actually indexed, for a page-level filter.
 *
 * Every page-level GSC lookup (`getPagePerformance`, `getPagePerformanceForRange`,
 * `getPageKeywords`) filters with `operator: 'equals'`, so the URL must match
 * GSC's own spelling EXACTLY. GSC records the canonical storefront,
 * `https://www.realskincare.com/...`. But every one of the 183 production posts
 * stores `shopify_url` on the Shopify admin host, `realskincare-com.myshopify.com`
 * (measured 2026-09-21), and several agents pass exactly that. The filter then
 * matches nothing, GSC returns no rows, and the helper reports 0 clicks and
 * 0 impressions: a plausible reading of a page that, e.g., really had 106 clicks
 * and 21,835 impressions. `agents/post-performance` scored EVERY 30/60/90-day
 * verdict it ever made on those zeros, which is how the dashboard came to list
 * 159 "underperforming" posts and the engine started refreshing healthy ones.
 *
 * So the helpers normalise at the one chokepoint instead of trusting ~20 callers
 * to remember: a myshopify host, the apex domain or plain http becomes the
 * canonical origin; path and query are kept, a fragment is dropped
 * (GSC never records one). Any OTHER host is left
 * alone — normalising a URL we do not own would silently measure a different
 * site. Pure, so it is testable without credentials (`lib/gsc.js` throws at
 * import without them).
 */

export const CANONICAL_ORIGIN = 'https://www.realskincare.com';
const CANONICAL_HOST = new URL(CANONICAL_ORIGIN).host;
const APEX_HOST = CANONICAL_HOST.replace(/^www\./, '');

export function gscPageUrl(pageUrl) {
  if (typeof pageUrl !== 'string' || !pageUrl) return pageUrl;
  let u;
  try { u = new URL(pageUrl); } catch { return pageUrl; }
  const host = u.host.toLowerCase();
  const ours = host === CANONICAL_HOST || host === APEX_HOST || host.endsWith('.myshopify.com');
  if (!ours) return pageUrl;
  return `${CANONICAL_ORIGIN}${u.pathname}${u.search}`;
}
