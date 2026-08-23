/**
 * A/B tracker record shaping for meta-optimizer.
 *
 * The tracker (`data/reports/meta-ab/meta-ab-tracker.json`) is the ONLY thing
 * that makes a title/meta rewrite reversible: `agents/meta-ab-checker` reads it
 * ≥28 days later and reverts anything whose CTR regressed past the dead-band in
 * `lib/meta-ab-decision.js`. A Shopify mutation with no tracker entry is one
 * nothing will ever measure or undo — which is precisely why the winner lock is
 * allowed to permit metadata tests at all (see lib/post-lock.js).
 *
 * Pure, so the shaping is testable without touching Shopify or the filesystem.
 */

/**
 * Replace any existing entry for a page and append the new one. Keyed on
 * pageUrl, matching what the agent has always done — one live test per page.
 */
export function upsertTrackerEntry(tracker, entry) {
  const rest = (Array.isArray(tracker) ? tracker : []).filter((e) => e.pageUrl !== entry.pageUrl);
  return [...rest, entry];
}

/**
 * @param {object} result   the meta-optimizer result row
 * @param {string} testedAt YYYY-MM-DD
 * @param {{pageCtr?:number|null, locked?:boolean}} [ctx]
 */
export function buildTrackerEntry(result, testedAt, ctx = {}) {
  return {
    keyword: result.keyword,
    pageUrl: result.pageUrl,
    originalTitle: result.currentTitle,
    proposedTitle: result.proposedTitle,
    originalMeta: result.currentMeta,
    proposedMeta: result.proposedMeta,
    // Keyword-level 90-day CTR — kept for continuity with historical entries.
    baselineCtr: result.ctr,
    // Page-level 28-day CTR, captured at test time. meta-ab-checker measures
    // the PAGE over 28 days, so this is the only field that compares like with
    // like; see pickBaselineCtr in lib/meta-ab-decision.js. Null when the
    // lookup failed, in which case the checker falls back to baselineCtr.
    baselinePageCtr: ctx.pageCtr ?? null,
    baselineImpressions: result.impressions,
    baselinePosition: result.position,
    validation_source: result.validation_source ?? null,
    // Recorded so a reverted or kept variant on a protected page is auditable.
    legacyLocked: ctx.locked === true,
    testedAt,
  };
}
