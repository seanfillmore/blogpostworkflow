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
/**
 * Reconcile the "ever-published" ledger against current live Shopify state.
 * Pure function — no I/O. Seeds the ledger with every article currently live and
 * published, prunes entries no longer present on Shopify (deleted), and returns
 * the records derived from ledger entries that are NOT already tracked locally.
 * This is what lets drift detection cover posts with no local meta.json.
 *
 * @param {Record<string,{handle:string,firstSeen?:string,lastSeenPublished?:string}>} ledger
 * @param {Map<string,{published:boolean, handle?:string}>} live  keyed by String(id)
 * @param {string} now  ISO timestamp
 * @param {Set<string>} [localIds]  article ids already covered by local records
 * @returns {{ledger:object, records:Array<{slug,articleId,handle}>}}
 */
export function reconcileEverPublishedLedger(ledger, live, now, localIds = new Set()) {
  const next = { ...(ledger || {}) };
  for (const [id, a] of (live || new Map())) {
    if (a.published) next[id] = { handle: a.handle, firstSeen: next[id]?.firstSeen || now, lastSeenPublished: now };
  }
  const records = [];
  for (const [id, entry] of Object.entries(next)) {
    if (!live.has(id)) { delete next[id]; continue; }          // deleted on Shopify — drop from watch-list
    if (!localIds.has(id)) records.push({ slug: entry.handle, articleId: id, handle: entry.handle });
  }
  return { ledger: next, records };
}

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
