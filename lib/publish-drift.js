// lib/publish-drift.js
//
// Detects "publish-status drift": posts our records consider PUBLISHED that are
// actually a draft (or gone) on Shopify. This is the silent failure behind the
// 2026-06-13 sweep where 5 live posts had reverted to drafts — broken internal
// links + lost traffic, invisible because change-diff-detector only diffs content
// (title/summary/body), never publish status. See [[project_shopify_unpublish_drift]].

/**
 * @param {Array<{slug:string, articleId:string|number|null, handle:string}>} records
 *        posts we believe are published (meta.shopify_status === 'published').
 * @param {Map<string,{published:boolean, handle?:string}>} live
 *        live Shopify articles keyed by String(article id).
 * @param {{intentional?:Set<string>}} [opts]
 *        `intentional` — slugs/handles deliberately unpublished (cannibalization
 *        REDIRECT/CONSOLIDATE, kill-article). These are NOT drift; excluding them
 *        keeps the detector from fighting a deliberate consolidation every run.
 * @returns {Array<{slug, articleId, handle, reason:'draft'|'missing'}>}
 */
export function findPublishDrift(records, live, { intentional } = {}) {
  const skip = intentional || new Set();
  const drift = [];
  for (const r of records || []) {
    if (r.articleId == null || r.articleId === '') continue; // nothing to compare against
    if (skip.has(r.slug) || skip.has(r.handle)) continue;    // deliberately retired — not drift
    const id = String(r.articleId);
    const liveArticle = (live && live.get) ? live.get(id) : undefined;
    if (!liveArticle) {
      drift.push({ slug: r.slug, articleId: id, handle: r.handle, reason: 'missing' });
    } else if (!liveArticle.published) {
      drift.push({ slug: r.slug, articleId: id, handle: r.handle, reason: 'draft' });
    }
  }
  return drift;
}
