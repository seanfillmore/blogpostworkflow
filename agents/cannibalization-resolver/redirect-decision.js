// agents/cannibalization-resolver/redirect-decision.js
//
// Pure decision for whether to create the loser->winner redirect when a
// CONSOLIDATE merge is HELD (the editor gate flagged blockers, so the merged
// draft is not live and the winner still shows its pre-merge content).
// Separate from index.js because importing index.js runs the agent (live
// GSC + Shopify + Claude calls) — mirrors agents/gsc-query-miner/leaks-feed.js
// and agents/seo-opportunity-analyzer/queue-item.js, which extract pure
// shaping/decision logic out of an agent entrypoint for the same reason.
//
// What this protects, and why it used to be unconditional: redirecting a
// loser into a winner that still shows OLD content loses the loser's unique
// content until someone reviews and publishes the merged draft. That is a
// real risk. But applied unconditionally, its failure mode is "unresolved
// forever" — a merge can stay held indefinitely (the editor holds on quality
// blockers with no re-trigger), and while it's held, the cannibalization the
// merge was supposed to fix stays live. The tattoo-soap merge sat held from
// 2026-08-16 to 2026-08-22 (six days) on "overall quality: needs work" while
// the loser (best-soap-for-tattoos-what-to-use-for-safe-healing: 0 clicks,
// 50 impressions, position 23.0) kept splitting ranking signal from the
// winner (best-soap-for-tattoos-what-to-use-for-safe-healing-2: 10 clicks,
// 1,102 impressions, position 6.9) — signal the loser was not converting
// into any traffic worth protecting.
//
// Narrowed rule: a held merge still blocks the redirect UNLESS the loser's
// own clicks (from the same GSC window already fetched to detect the
// cannibalization group — no extra call) are provably zero. Zero clicks
// means there is no visitor to lose: redirecting sends nobody to stale
// content, because nobody is reaching the loser at all. Any click above
// zero means a real visitor is landing on that URL today, and the original
// protection stands — that page still earns something a stale winner
// wouldn't serve them. Missing/unknown traffic data fails safe (skip),
// because acting on an unverified redirect is exactly what the carve-out
// exists to prevent.

export const NEGLIGIBLE_LOSER_CLICKS = 0;

/**
 * @param {object} p
 * @param {boolean} p.consolidateHeld  true when a CONSOLIDATE merge failed
 *   the editor gate and the live winner was left untouched (see index.js's
 *   applyResolutions).
 * @param {number|null|undefined} p.loserClicks  the loser page's clicks from
 *   the GSC query+page rows already fetched for cannibalization detection —
 *   null/undefined when no clicks figure could be found for that path.
 * @returns {{ createRedirect: boolean, reason: string }}
 *   reason is one of:
 *     'not_held'                    — no carve-out applies, always redirect
 *     'held_negligible_loser_traffic' — held, but loser earns ~nothing; redirect
 *     'held_loser_has_traffic'      — held, loser earns real clicks; skip
 *     'held_no_traffic_data'        — held, traffic unknown; fail safe, skip
 */
export function decideHeldMergeRedirect({ consolidateHeld, loserClicks }) {
  if (!consolidateHeld) {
    return { createRedirect: true, reason: 'not_held' };
  }
  if (loserClicks === null || loserClicks === undefined || Number.isNaN(loserClicks)) {
    return { createRedirect: false, reason: 'held_no_traffic_data' };
  }
  if (loserClicks <= NEGLIGIBLE_LOSER_CLICKS) {
    return { createRedirect: true, reason: 'held_negligible_loser_traffic' };
  }
  return { createRedirect: false, reason: 'held_loser_has_traffic' };
}

// ── the glue: getting loserClicks in the first place ──────────────────────
//
// decideHeldMergeRedirect only ever sees a number (or null). Getting that
// number means joining a decision's loserPath back to the GSC group it came
// from, and matching a page within it — two lookups a hand-written test
// fixture can silently get "right" by construction even when the join it's
// supposed to be exercising is broken. So the join itself, and the exact
// shape it joins against, live here as named, imported, single-source-of-
// truth functions — the same functions index.js's detectCannibalization and
// applyResolutions call, not a parallel re-implementation of them in a test
// file. If `shapeCannibalizationPage` ever stops calling its field `path`,
// every caller — production AND any test built from these fixtures — breaks
// together, instead of production breaking silently while hand-typed test
// fixtures keep passing. (That exact class of bug has shipped here before:
// a producer/consumer field-name mismatch — `query` destructured from rows
// whose real field was `keyword` — passed the whole suite because the test
// fixtures were hand-written from a plan instead of derived from the real
// producing code, and was only caught by running the agent against live data.)

/** Pathname-only view of a GSC row's URL. Never throws on a malformed URL. */
export function urlPath(fullUrl) {
  try { return new URL(fullUrl).pathname; } catch { return fullUrl; }
}

/** Shopify article handle from a `/blogs/news/<handle>` path. */
export function slugFromPath(path) {
  return path.split('/').pop();
}

/**
 * Shapes one GSC query+page row into the page object a cannibalization
 * group's `pages[]` array carries — the exact transform
 * agents/cannibalization-resolver/index.js's detectCannibalization applies
 * per page (`url`, `path`, `handle`, `impressions`, `clicks`, rounded
 * `position`/`ctr`). detectCannibalization calls this directly rather than
 * inlining its own copy, so the field names `findLoserClicks` (below) and
 * any test built on it rely on can't drift from what actually gets produced.
 *
 * @param {{page:string, impressions:number, clicks:number, position:number, ctr:number}} row
 * @returns {{url:string, path:string, handle:string, impressions:number, clicks:number, position:number, ctr:number}}
 */
export function shapeCannibalizationPage(row) {
  const path = urlPath(row.page);
  return {
    url: row.page,
    path,
    handle: slugFromPath(path),
    impressions: row.impressions,
    clicks: row.clicks,
    position: Math.round(row.position * 10) / 10,
    ctr: Math.round(row.ctr * 1000) / 10,
  };
}

/**
 * Finds a loser page's clicks within the cannibalization-detection groups
 * already fetched for this run (see detectCannibalization / shapeCannibalizationPage
 * above for the shape). Matches `group.query === query` then
 * `page.path === loserPath` — the two joins index.js's applyResolutions needs
 * before it has a clicks number to hand decideHeldMergeRedirect.
 *
 * Returns null (never 0) whenever anything fails to match — no group for the
 * query, no page for the path, or a page whose `clicks` isn't a number — so
 * a broken join reads as "traffic unknown" rather than a fabricated "zero",
 * and decideHeldMergeRedirect's fail-safe branch (skip on null) is what
 * fires, not its zero-clicks redirect branch.
 *
 * @param {object} p
 * @param {Array<{query:string, pages:Array<{path:string, clicks:number}>}>} p.groups
 * @param {string} p.query
 * @param {string} p.loserPath
 * @returns {number|null}
 */
export function findLoserClicks({ groups, query, loserPath }) {
  const group = (groups ?? []).find((g) => g.query === query);
  if (!group) return null;
  const page = (group.pages ?? []).find((p) => p.path === loserPath);
  if (!page || typeof page.clicks !== 'number') return null;
  return page.clicks;
}
