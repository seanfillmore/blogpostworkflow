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

/**
 * Extract the article handle from a Shopify blog-article URL.
 * `https://x/blogs/news/some-handle?utm=1` → `some-handle`. Returns null if the
 * URL is not a /blogs/{blog}/{handle} path.
 * @param {string} url
 * @returns {string|null}
 */
export function handleFromBlogUrl(url) {
  const m = String(url || '').match(/\/blogs\/[^/]+\/([^/?#]+)/);
  return m ? m[1] : null;
}

/**
 * Third drift-detection source: cross-reference the site crawler's 404 list
 * against live Shopify status. A URL that 404s for visitors but still exists on
 * Shopify as a DRAFT is drift — and live content links to it (that's why the
 * crawler found it). This catches drafts that have neither a local meta.json nor
 * a ledger entry (e.g. they reverted before the ledger existed, or within a
 * ledger-blind window), which is exactly how the 2026-06-23 backlog escaped both
 * other sources. Missing (deleted) 404 targets are skipped — those want a
 * redirect, not republishing. Redirect-source / intentionally-retired handles are
 * skipped via `intentional`.
 *
 * @param {Array<{url:string}>} error404Rows  site-crawler issues.error_404
 * @param {Map<string,{published:boolean, id:string|number, handle?:string}>} liveByHandle
 * @param {{intentional?:Set<string>}} [opts]
 * @returns {Array<{slug, articleId, handle, source:'crawl-404'}>}
 */
export function crawlDraftDriftRecords(error404Rows, liveByHandle, { intentional } = {}) {
  const skip = intentional || new Set();
  const seen = new Set();
  const out = [];
  for (const row of error404Rows || []) {
    const h = handleFromBlogUrl(row && row.url);
    if (!h || seen.has(h)) continue;
    seen.add(h);
    if (skip.has(h)) continue;                       // deliberately retired — not drift
    const art = (liveByHandle && liveByHandle.get) ? liveByHandle.get(h) : undefined;
    if (!art || art.published) continue;             // not present, or already live → not draft-drift
    out.push({ slug: h, articleId: String(art.id), handle: h, source: 'crawl-404' });
  }
  return out;
}

/**
 * Products the roster declares live that Shopify is not actually serving.
 *
 * The article detector above never looked at products, which is how eight
 * bundles `config/bundles.json` called "live" sat at HTTP 404 on 2026-08-25
 * with nothing alerting — the entire multipack catalogue, unbuyable, found by
 * hand. The roster is the declared source of truth for what should be live, so
 * any live entry Shopify does not serve is drift.
 *
 * ACTIVE and published-to-Online-Store drift independently: a product can be
 * ACTIVE and still unreachable because its Online Store publication was
 * dropped. Both are reported, with distinct reasons, because only the first is
 * fixed by flipping status.
 *
 * `missing` is deliberately a separate reason from `draft`: a deleted product
 * cannot be republished, so a caller auto-fixing drift must skip it rather than
 * try. Same split, and same rationale, as the article detector.
 *
 * @param {Array<{handle: string, status: string}>} rosterBundles
 * @param {Record<string, {status: string, publishedToOnlineStore: boolean}>} liveByHandle
 * @returns {Array<{handle: string, reason: 'draft'|'unpublished'|'missing'}>}
 */
export function findProductPublishDrift(rosterBundles, liveByHandle, { intentional } = {}) {
  const skip = intentional || new Set();
  const live = liveByHandle || {};
  const drift = [];

  for (const b of rosterBundles || []) {
    if (b?.status !== 'live') continue;   // only the roster's own "live" is a promise
    if (skip.has(b.handle)) continue;     // deliberately held — not drift

    const p = live[b.handle];
    if (!p) drift.push({ handle: b.handle, reason: 'missing' });
    else if (p.status !== 'ACTIVE') drift.push({ handle: b.handle, reason: 'draft' });
    else if (p.publishedToOnlineStore === false) drift.push({ handle: b.handle, reason: 'unpublished' });
  }
  return drift;
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
