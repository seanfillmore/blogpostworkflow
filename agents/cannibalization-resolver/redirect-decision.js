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
