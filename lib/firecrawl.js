/**
 * Minimal Firecrawl client for scraping JavaScript-heavy pages.
 *
 * Used by competitor-ads to scrape Meta Ad Library (which is fully
 * JS-rendered and uses every anti-bot trick in the book — Firecrawl
 * handles browser rendering + proxy rotation transparently).
 *
 * API reference:
 *   POST https://api.firecrawl.dev/v2/scrape
 *   Authorization: Bearer <api_key>
 *   Body: { url, formats, waitFor, onlyMainContent, ... }
 *   → { success, data: { markdown, html, links, metadata } }
 */

const FIRECRAWL_SCRAPE_URL = 'https://api.firecrawl.dev/v2/scrape';

/**
 * Scrape a URL. Returns the data block on success or null on any failure
 * (so callers can degrade gracefully — Meta Ad Library is flaky).
 *
 * Defaults are tuned for JS-heavy public pages: 5 s waitFor for content
 * to render, auto proxy with retry on first failure, ad/cookie blocking on.
 */
export async function scrape(apiKey, url, opts = {}) {
  if (!apiKey || !url) return null;
  const {
    formats = ['markdown', 'links'],
    waitFor = 5000,
    onlyMainContent = true,
    timeout = 90000,
    proxy = 'auto',
    blockAds = true,
    fetchImpl = fetch,
  } = opts;

  try {
    const res = await fetchImpl(FIRECRAWL_SCRAPE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        url, formats, waitFor, onlyMainContent, timeout, proxy, blockAds,
        removeBase64Images: true,
      }),
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (!body?.success || !body?.data) return null;
    return body.data;
  } catch {
    return null;
  }
}

/**
 * Build the Meta Ad Library URL for a brand keyword search.
 * Pure — exported for tests.
 */
export function metaAdLibraryUrl(brandQuery, { country = 'US' } = {}) {
  if (!brandQuery) return null;
  const q = encodeURIComponent(String(brandQuery).trim());
  return `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=${country}&q=${q}&search_type=keyword_unordered`;
}
