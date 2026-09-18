// lib/live-articles.js
//
// "Which Shopify articles still EXIST?" — one bulk read, then a pure Set.
//
// WHY THIS EXISTS. `agents/performance-engine` re-queued a post whose live
// article had been consolidated away, every morning at 07:30 UTC, and
// `agents/queue-autoapply` dismissed it every afternoon at 15:07. Measured on
// production it ran every day from 2026-09-08 to 2026-09-18 on
// `best-sls-free-toothpaste-2025` (article 563289653418, gone from Shopify),
// burning a paid content-refresher + Claude summary pass each morning and
// putting a phantom row in the one report the operator actually reads.
//
// The loop is structural, not a fluke: `activeSlugs()` deliberately treats a
// `dismissed` item as NOT active, so the analyzer may re-surface it — which is
// correct in general and exactly wrong for an article that no longer exists.
// A dismissal can therefore never break the cycle; only the PICKER can.
//
// ONE BULK READ, NOT N PROBES. `getArticles(blogId, 250)` pages the whole blog
// (~204 articles today) in a couple of calls, where a per-candidate
// `getArticle` would be one round trip per candidate every morning. This is the
// same shape `agents/publish-drift` already uses to build its live map.
//
// IT FAILS OPEN, DELIBERATELY. A Shopify outage must not silently empty the
// pick list — that would be a picker that quietly stops picking, which reads
// identically to a clean run and is the failure mode CLAUDE.md names again and
// again (`hold.disarmed`, `efficiencyBanner`). `fetchLiveArticleIds` returns
// `null` on any failure, `isArticleLive` treats `null` as "cannot tell → allow",
// and the caller is expected to SAY so rather than pretend it filtered.

/**
 * Build the id Set from already-fetched article pages.
 *
 * Pure, so the whole rule is testable without a network or OAuth credentials
 * (`lib/shopify.js` throws at import time without them — the same reason
 * `lib/queue-apply.js` takes its Shopify functions by injection).
 *
 * Ids are stored as STRINGS: Shopify returns a number, `meta.json` has carried
 * both, and a `Set.has(number)` against string keys silently matches nothing —
 * which here would mean "every article looks dead" and would empty the pick
 * list on a healthy store. Normalising on the way in is what prevents that.
 *
 * @param {Array<Array<{id:*}>>} pages article arrays, one per blog
 * @returns {Set<string>}
 */
export function liveArticleIdSet(pages) {
  const out = new Set();
  for (const page of pages || []) {
    for (const a of page || []) {
      if (a && a.id != null) out.add(String(a.id));
    }
  }
  return out;
}

/**
 * Read every blog's articles and return the live id Set, or `null` if the read
 * failed for any reason.
 *
 * `null` is not an empty Set and callers must not conflate them: an empty Set
 * means "this store genuinely has no articles" (filter everything), `null`
 * means "we could not find out" (filter nothing).
 *
 * @param {{getBlogs:Function, getArticles:Function}} deps injected Shopify reads
 * @returns {Promise<Set<string>|null>}
 */
export async function fetchLiveArticleIds({ getBlogs, getArticles }) {
  try {
    const blogs = await getBlogs();
    const pages = [];
    for (const blog of blogs || []) {
      pages.push(await getArticles(blog.id, 250));
    }
    return liveArticleIdSet(pages);
  } catch {
    return null;
  }
}

/**
 * Is this article id still live?
 *
 * Unknown-means-ALLOW, the same whitelist doctrine as `PRODUCT_NOUNS` in
 * lib/product-category-terms.js: a missing set, or an id we cannot read, can
 * only ever produce a MISS (we keep a candidate we might have dropped), never a
 * silently emptied pick list.
 *
 * @param {Set<string>|null} liveIds
 * @param {*} articleId
 * @returns {boolean}
 */
export function isArticleLive(liveIds, articleId) {
  if (!liveIds) return true;            // could not tell → do not filter
  if (articleId == null) return true;   // not our question; callers guard this separately
  return liveIds.has(String(articleId));
}
