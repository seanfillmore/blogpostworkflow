// lib/reachable-pages.js
//
// "Can a searcher actually land on this URL?" — the question GSC cannot answer,
// and the one that decides whether a page may be treated as a cannibalization
// candidate, a consolidation WINNER, or an optimization opportunity.
//
// WHY THIS EXISTS
// ───────────────
// GSC keeps reporting impressions for a URL long after it has been drafted or
// redirected away. `agents/collection-content-optimizer` learned this on
// 2026-09-08: three of its four queued collection bodies were for pages that
// were BOTH `published_at: null` AND behind a /collections/<handle> redirect,
// and they looked like opportunities purely because GSC still listed them.
//
// `agents/cannibalization-resolver` had the identical defect on a far more
// dangerous path — it creates 301s and merges live article bodies. Measured on
// production 2026-09-09 across its 20 stored decisions:
//
//   * 7 of 20 named a WINNER that is a draft behind a redirect — a page that
//     cannot rank, cannot receive traffic, and cannot be the canonical URL of
//     anything. Four of those are toothpaste; THREE are lotion, which is 62%
//     of store revenue.
//   * `best-toothpaste-without-sls-2025` — LIVE, 26,860 impressions and 140
//     clicks over 90 days, the second-biggest page in its cluster — was marked
//     `REDIRECT` (i.e. destroy it) in FOUR separate decisions, in favour of a
//     dead page, with the stated reason "Ranks far lower (pos 42 vs pos 5) with
//     zero clicks".
//
// Nothing was destroyed, because `decideHeldMergeRedirect` skips the redirect
// when the loser earns real clicks. That guard did its job — but it is the LAST
// line of defence against a decision that should never have been produced, and
// relying on it is how the tattoo-soap merge sat held for six days.
//
// THE FIX IS UPSTREAM OF THE MODEL, NOT DOWNSTREAM
// ────────────────────────────────────────────────
// Filtering after the LLM has chosen a winner means paying for the call and
// then discarding it. Filtering the ROWS first means the model never sees an
// unreachable URL, so it cannot name one — and a conflict group left with
// fewer than two reachable pages is not a conflict at all. Same "before the
// cap" rule `lib/cluster-hold.js` and `selectCollectionCandidates` both apply.
//
// IT DEGRADES, IT DOES NOT BLOCK
// ──────────────────────────────
// A failed article or redirect fetch yields a `null` index, and a null index
// passes EVERYTHING through — the agent then runs exactly as it did before this
// module existed, and says so. Refusing to detect cannibalization because one
// GET failed would be a worse outcome than the defect: the resolver is the only
// thing that consolidates duplicate pages at all.

/** A URL or path is reduced to its site-relative path for comparison. */
export function urlPath(urlOrPath) {
  const s = String(urlOrPath || '').trim();
  if (!s) return '';
  try {
    return new URL(s).pathname.replace(/\/+$/, '') || '/';
  } catch {
    return s.split('?')[0].split('#')[0].replace(/\/+$/, '') || '/';
  }
}

/**
 * Build the reachability index.
 *
 * @param {object} o
 * @param {Array<{handle:string, published_at:*}>} [o.articles]  live-and-draft articles
 * @param {Array<{path:string}>}                   [o.redirects] the Shopify URL redirect table
 * @param {string} [o.blogPrefix]  path prefix articles live under
 * @returns {{draftHandles:Set<string>, redirectedPaths:Set<string>, blogPrefix:string}}
 */
export function buildReachableIndex({ articles, redirects, blogPrefix = '/blogs/news' } = {}) {
  if (!Array.isArray(articles) || !Array.isArray(redirects)) return null;

  const draftHandles = new Set();
  for (const a of articles) {
    if (a && a.handle && !a.published_at) draftHandles.add(a.handle);
  }

  const redirectedPaths = new Set();
  for (const r of redirects) {
    const p = urlPath(r && r.path);
    if (p) redirectedPaths.add(p);
  }

  return { draftHandles, redirectedPaths, blogPrefix };
}

/**
 * Is this URL reachable? Unreachable means a DRAFT article, or any path the
 * store redirects away — either one makes the page unable to rank or convert.
 *
 * A null index means "we could not measure", and that always answers TRUE:
 * see the degradation note in the header.
 *
 * @returns {{reachable:boolean, reason:string|null}}
 */
export function checkReachable(url, index) {
  if (!index) return { reachable: true, reason: null };

  const path = urlPath(url);
  if (!path) return { reachable: true, reason: null };

  if (index.redirectedPaths.has(path)) {
    return { reachable: false, reason: 'redirected' };
  }

  if (path.startsWith(`${index.blogPrefix}/`)) {
    const handle = path.slice(index.blogPrefix.length + 1);
    if (index.draftHandles.has(handle)) {
      return { reachable: false, reason: 'draft' };
    }
  }

  return { reachable: true, reason: null };
}

/**
 * Split GSC query/page rows into the reachable ones and what was dropped.
 *
 * The dropped rows are RETURNED rather than silently discarded, because a page
 * that keeps drawing impressions while unreachable is itself worth reporting —
 * that is how these were found.
 *
 * @param {Array<{page:string}>} rows
 * @param {object|null} index
 * @returns {{kept:Array, dropped:Array<{page:string, reason:string, impressions:number}>}}
 */
export function filterReachableRows(rows, index) {
  const kept = [];
  const droppedByPage = new Map();

  for (const row of rows || []) {
    const { reachable, reason } = checkReachable(row && row.page, index);
    if (reachable) {
      kept.push(row);
      continue;
    }
    const prev = droppedByPage.get(row.page) || { page: row.page, reason, impressions: 0, queries: 0 };
    prev.impressions += row.impressions || 0;
    prev.queries += 1;
    droppedByPage.set(row.page, prev);
  }

  return {
    kept,
    dropped: [...droppedByPage.values()].sort((a, b) => b.impressions - a.impressions),
  };
}

/** One-line digest/console summary of what the filter removed. */
export function reachabilityBanner({ index, dropped = [] } = {}) {
  if (!index) {
    return '  · Reachability NOT checked this run (article or redirect fetch failed) — '
      + 'every URL was treated as reachable, exactly as before this check existed.';
  }
  if (!dropped.length) {
    return '  · Reachability checked: every candidate URL is live and not redirected.';
  }
  const impr = dropped.reduce((s, d) => s + d.impressions, 0);
  const lines = [
    `  · Reachability: dropped ${dropped.length} unreachable URL(s) carrying ${impr} impression(s) `
    + 'before any conflict was formed — GSC keeps reporting a drafted or redirected page for weeks.',
  ];
  for (const d of dropped.slice(0, 8)) {
    lines.push(`      ${d.reason.padEnd(10)} ${urlPath(d.page)}  (${d.impressions} impr across ${d.queries} query/queries)`);
  }
  if (dropped.length > 8) lines.push(`      … and ${dropped.length - 8} more`);
  return lines.join('\n');
}
