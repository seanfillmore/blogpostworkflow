/**
 * Judge.me API v1 client
 *
 * Required .env keys:
 *   JUDGEME_API_TOKEN   — private API token from Judge.me dashboard
 *   JUDGEME_SHOP_DOMAIN — must be the .myshopify.com domain (e.g. realskincare.myshopify.com)
 */

const JUDGEME_BASE = 'https://judge.me/api/v1';

// ── Pure helpers (exported for testing) ───────────────────────────────────────

export function stripHtmlForReview(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/\s+([.,!?;:])/g, '$1');
}

export function truncateToWord(text, maxLen) {
  if (text.length <= maxLen) return text;
  const cut = text.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(' ');
  return lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
}

/**
 * Strip HTML, check ≥ 20 words, truncate to 200 chars.
 * Returns cleaned string or null if too short.
 */
export function renderReviewBody(rawBody) {
  const text = stripHtmlForReview(rawBody);
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (wordCount < 20) return null;
  return truncateToWord(text, 200);
}

// ── API calls ─────────────────────────────────────────────────────────────────

/**
 * Fetch the best qualifying 5-star review for a product.
 * Returns { quote, verified } or null.
 */
export async function fetchTopReview(productHandle, shopDomain, apiToken) {
  const qs = new URLSearchParams({
    api_token: apiToken,
    shop_domain: shopDomain,
    product_handle: productHandle,
    per_page: '10',
    'rating[gte]': '5',
  });
  const res = await fetch(`${JUDGEME_BASE}/reviews?${qs}`);
  if (!res.ok) {
    console.warn(`  Judge.me reviews → HTTP ${res.status} (skipping)`);
    return null;
  }
  const data = await res.json();
  for (const review of (data.reviews || [])) {
    const quote = renderReviewBody(review.body || '');
    if (quote) {
      return { quote, verified: review.reviewer?.verified_buyer === true };
    }
  }
  return null;
}

/**
 * Fetch aggregate rating and review count for a product.
 * Returns { rating, reviewCount } or null.
 * Note: -1 is a Judge.me sentinel meaning "look up by handle, not by numeric ID".
 */
export async function fetchProductStats(productHandle, shopDomain, apiToken) {
  const qs = new URLSearchParams({
    api_token: apiToken,
    shop_domain: shopDomain,
    handle: productHandle,
  });
  const res = await fetch(`${JUDGEME_BASE}/products/-1?${qs}`);
  if (!res.ok) {
    console.warn(`  Judge.me product stats → HTTP ${res.status} (skipping)`);
    return null;
  }
  const data = await res.json();
  const p = data.product;
  if (!p) return null;
  return { rating: p.rating, reviewCount: p.reviews_count };
}
