// lib/pr-target-enrich.js
//
// The pure half of `agents/pr-target-finder`'s enrichment pass: what to fetch,
// how to spend the author-page budget, and how to tell "we looked and found
// nothing" from "we never got to look". No I/O — the agent owns the fetching
// (and importing the agent RUNS it, so anything testable has to live here).
//
// WHY THE AUTHOR BUDGET IS PLANNED UP FRONT rather than claimed as rows arrive.
// The serial loop spent `AUTHOR_CHECKS` on whichever rows it reached first,
// which under a serial walk IS rank order. Racing the article fetches breaks
// that: two workers finishing in a different order would spend the budget on a
// different set of authors, so two runs over identical inputs could disagree
// about which bylines were verified. `planAuthorChecks` restores it by deciding
// the whole spend from the ranked list BEFORE any author page is fetched — the
// same reason the $0-cluster hold is applied before the per-run cap rather than
// after it.
//
// It also does the dedupe the serial loop did with a cache: several ranked rows
// can name the same author archive page, and one fetch answers all of them.

/**
 * Where a row's freshness reading came from — and `unreachable` is the value
 * that did not exist before concurrency, because the old loop could not tell a
 * page with no dates from a page it never received.
 *
 * `homepage` is the pre-existing guard, kept verbatim: with no `top_url` the
 * agent falls back to the site root, whose `dateModified` is the SITE's and is
 * always fresh, so reading it as article freshness would certify exactly the
 * dead targets the check exists to demote.
 */
export function articleDateSource({ topUrl = null, outcome = 'ok' } = {}) {
  if (outcome !== 'ok') return 'unreachable';
  return topUrl ? 'article' : 'homepage';
}

/**
 * The `author_currency_reason` for a row whose ARTICLE never arrived.
 *
 * Without this such a row reads `no-author-page-found`, which claims we looked
 * at the article and it named no author page. We never saw the article. The
 * outcome is carried into the reason (`article-blocked`, `article-timeout`, …)
 * so the digest's reason histogram names the real cause.
 */
export function unreachableCurrencyReason(outcome) {
  return `article-${outcome || 'network-error'}`;
}

/**
 * Decide the whole author-page spend from the ranked rows, before any fetch.
 *
 * Deterministic by construction: rows are walked in rank order, each new
 * `author_url` takes the next budget slot, and duplicates join the group that
 * already holds that URL. Nothing here depends on timing.
 *
 * @param {Array<{author?:string|null, author_url?:string|null}>} rows ranked
 * @param {{budget?:number}} [opts]
 * @returns {{funded:Array<{url:string, rows:Array}>,
 *            unfunded:Array<{url:string, rows:Array}>,
 *            unchecked:Array}}  `unchecked` = rows with no person or no URL
 */
export function planAuthorChecks(rows, { budget = 0 } = {}) {
  const groups = new Map();
  const unchecked = [];
  for (const row of rows || []) {
    const url = row?.author_url;
    if (!row?.author || !url) { unchecked.push(row); continue; }
    if (!groups.has(url)) groups.set(url, []);
    groups.get(url).push(row);
  }
  // Map preserves insertion order, which is rank order.
  const entries = [...groups.entries()].map(([url, group]) => ({ url, rows: group }));
  const cap = Math.max(0, Math.trunc(budget) || 0);
  return { funded: entries.slice(0, cap), unfunded: entries.slice(cap), unchecked };
}

/**
 * Roll the per-row enrichment fields into the numbers the summary, the console
 * and the digest body all read — one derivation rather than three.
 *
 * The splits that matter: `freshness_unknown` is broken into the two reasons it
 * can have, because "the citation data named no article URL" is a permanent
 * property of the snapshot and "the publisher refused us" is a transient one,
 * and a single number cannot be acted on.
 */
export function enrichmentCounts(rows) {
  const list = Array.from(rows || []);
  const enriched = list.filter((t) => t.enriched);
  const count = (pred) => list.filter(pred).length;
  return {
    total: list.length,
    enriched: enriched.length,
    not_attempted: count((t) => !t.enriched),
    fetched_ok: count((t) => t.enrich_fetch === 'ok'),
    fetch_failed: enriched.filter((t) => t.enrich_fetch && t.enrich_fetch !== 'ok').length,
    with_person_byline: count((t) => t.author),
    non_person_bylines: count((t) => t.author_rejected != null),
    stale_articles: count((t) => t.stale_article === true),
    freshness_checkable: count((t) => t.article_date_source === 'article'),
    freshness_unknown_homepage: count((t) => t.article_date_source === 'homepage'),
    freshness_unknown_unreachable: count((t) => t.article_date_source === 'unreachable'),
  };
}
