// lib/voice-of-customer.js
//
// Pure brain for the voice-of-customer agent. No network, no filesystem, no
// LLM — everything here is deterministic and unit-tested so the agent shell
// stays thin. Mirrors the lib/seo-opportunities.js split.

/**
 * The skin cluster, as an explicit handle list rather than a keyword match.
 * A keyword match on "lotion"/"soap" would silently pull in or drop products
 * as the catalog changes; this list is asserted in tests.
 *
 * organic-foaming-hand-soap is deliberately included: it is a skin-contact
 * wash-off product whose reviewers share the sensitive-skin and
 * ingredient-scrutiny concerns of the lotion buyers.
 */
export const SKIN_CLUSTER_HANDLES = [
  'coconut-lotion',
  'body-lotion-1',
  'coconut-moisturizer',
  'coconut-soap',
  'organic-foaming-hand-soap',
];

const SKIN_SET = new Set(SKIN_CLUSTER_HANDLES);

/** Strip querystring + trailing slash so the same page from two sources matches. */
function canonicalUrl(url) {
  if (!url) return null;
  const withoutQuery = String(url).split(/[?#]/)[0];
  return withoutQuery.replace(/\/+$/, '').toLowerCase();
}

export function normalizeJudgemeReview(r) {
  return {
    source: 'judgeme',
    id: `judgeme:${r.id}`,
    url: null,
    handle: r.product_handle || null,
    rating: typeof r.rating === 'number' ? r.rating : null,
    text: String(r.body || '').trim(),
  };
}

export function normalizeTavilyResult(r) {
  const title = String(r.title || '').trim();
  const content = String(r.content || '').trim();
  return {
    source: 'reddit',
    id: `reddit:${canonicalUrl(r.url)}`,
    url: r.url || null,
    handle: null,
    rating: null,
    text: [title, content].filter(Boolean).join(' — '),
  };
}

export function normalizeSerpItem(item) {
  const title = String(item.title || '').trim();
  const description = String(item.description || item.snippet || '').trim();
  return {
    source: 'serp',
    id: `serp:${canonicalUrl(item.url)}`,
    url: item.url || null,
    handle: null,
    rating: null,
    text: [title, description].filter(Boolean).join(' — '),
  };
}

/**
 * Collapse records that point at the same page. Judge.me reviews have no URL
 * and are keyed by their own id, so they never collapse into each other.
 */
export function dedupeRecords(records) {
  const seen = new Set();
  const out = [];
  for (const rec of records) {
    const key = rec.url ? `url:${canonicalUrl(rec.url)}` : rec.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rec);
  }
  return out;
}

/**
 * Keep only skin-cluster material. Records with no handle are external
 * (Reddit/SERP) and are already scoped by the queries that fetched them.
 */
export function filterSkinCluster(records) {
  return records.filter((r) => r.handle === null || SKIN_SET.has(r.handle));
}
