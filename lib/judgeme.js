/**
 * Judge.me API v1 client
 *
 * Required .env keys:
 *   JUDGEME_API_TOKEN — private API token from Judge.me dashboard
 *   SHOPIFY_STORE     — .myshopify.com domain (used as shop_domain for Judge.me)
 *
 * Note: Judge.me's /reviews endpoint does not support filtering by product_handle or
 * product_id. Instead, we resolve the Shopify product's external_id via /products/-1,
 * then filter reviews client-side by product_external_id.
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
 * Resolve a product handle to its Shopify external_id via Judge.me.
 * Returns the external_id number or null on failure.
 */
export async function resolveExternalId(productHandle, shopDomain, apiToken) {
  const qs = new URLSearchParams({ api_token: apiToken, shop_domain: shopDomain, handle: productHandle });
  const res = await fetch(`${JUDGEME_BASE}/products/-1?${qs}`);
  if (!res.ok) return null;
  const data = await res.json();
  return data.product?.external_id ?? null;
}

/**
 * Fetch all reviews for the shop and return those matching the product's external_id.
 * Judge.me's /reviews endpoint does not support per-product filtering server-side,
 * and server-side rating filters shift pagination — so we fetch all and filter client-side.
 */
export async function fetchProductReviews(externalId, shopDomain, apiToken) {
  const qs = new URLSearchParams({
    api_token: apiToken,
    shop_domain: shopDomain,
    per_page: '100',
  });
  const res = await fetch(`${JUDGEME_BASE}/reviews?${qs}`);
  if (!res.ok) {
    console.warn(`  Judge.me reviews → HTTP ${res.status} (skipping)`);
    return [];
  }
  const data = await res.json();
  // eslint-disable-next-line eqeqeq — external_id may be number or string
  return (data.reviews || []).filter(r => r.product_external_id == externalId);
}

/**
 * Fetch the best qualifying 5-star review for a product.
 * Returns { quote, verified } or null.
 */
export async function fetchTopReview(productHandle, shopDomain, apiToken) {
  const externalId = await resolveExternalId(productHandle, shopDomain, apiToken);
  if (!externalId) return null;
  const reviews = await fetchProductReviews(externalId, shopDomain, apiToken);
  for (const review of reviews.filter(r => r.rating >= 5)) {
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
 * Computes rating as the average of all 5-star reviews found (may be a subset if store
 * has >100 total reviews). reviewCount reflects the total visible in this result set.
 */
export async function fetchProductStats(productHandle, shopDomain, apiToken) {
  const externalId = await resolveExternalId(productHandle, shopDomain, apiToken);
  if (!externalId) return null;
  // Fetch all reviews (not just 5-star) for an accurate count and average
  const qs = new URLSearchParams({ api_token: apiToken, shop_domain: shopDomain, per_page: '100' });
  const res = await fetch(`${JUDGEME_BASE}/reviews?${qs}`);
  if (!res.ok) {
    console.warn(`  Judge.me product stats → HTTP ${res.status} (skipping)`);
    return null;
  }
  const data = await res.json();
  // eslint-disable-next-line eqeqeq
  const reviews = (data.reviews || []).filter(r => r.product_external_id == externalId);
  if (reviews.length === 0) return null;
  const avgRating = reviews.reduce((sum, r) => sum + (r.rating || 0), 0) / reviews.length;
  return { rating: avgRating, reviewCount: reviews.length };
}

/**
 * Fetch all reviews from the last N days across all products.
 * Returns array of { product_external_id, rating, reviewer, body, verified, created_at }.
 */
export async function fetchRecentReviews(days, shopDomain, apiToken) {
  const cutoff = new Date(Date.now() - days * 86400000);
  const qs = new URLSearchParams({ api_token: apiToken, shop_domain: shopDomain, per_page: '100' });
  const res = await fetch(`${JUDGEME_BASE}/reviews?${qs}`);
  if (!res.ok) {
    console.warn(`  Judge.me recent reviews → HTTP ${res.status} (skipping)`);
    return [];
  }
  const data = await res.json();
  return (data.reviews || [])
    .filter((r) => new Date(r.created_at) >= cutoff)
    .map((r) => ({
      product_external_id: r.product_external_id,
      rating: r.rating,
      reviewer: r.reviewer?.name || 'Anonymous',
      body: r.body || '',
      verified: r.reviewer?.verified_buyer === true,
      created_at: r.created_at,
    }));
}
