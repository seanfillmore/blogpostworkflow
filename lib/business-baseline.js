// lib/business-baseline.js
//
// The measured business figures, in ONE place, with an expiry.
//
// WHY THIS EXISTS. Two modules each carried their own hardcoded `50.46`, set on
// 2026-07-25 and never revisited: `lib/bing-keyword-gap.js`'s `DEFAULT_AOV`, which turns
// a keyword gap into a dollar forecast, and `lib/marketing-learner.js`'s constraint
// block, which scores every tactic the fleet ever ingests. Re-measured on 2026-09-20 the
// real figure is $54.73 — an 8.5% drift, in a number two independent code paths quote as
// fact. Neither copy knew about the other and nothing anywhere said either had aged.
//
// That is the same failure `PAID_STATUS_AS_OF` was added to stop, and the same
// single-source rule that makes `lib/demand-questions.js` import `AWARENESS_LEVELS`
// rather than redeclare it. A second copy of a fact is a second copy that drifts.
//
// THE FIGURES ARE MEASURED, NOT ESTIMATED. Regenerate all three with one command, on the
// SERVER (a local checkout has no order history):
//
//   ssh root@137.184.119.230 'cd ~/seo-claude && node scripts/aov-analysis.mjs 90'
//
// Read `total_price (incl ship+tax)` for the AOV — that is what a customer actually paid
// and what every downstream forecast multiplies. `subtotal_price` is the goods-only view
// and is the right basis for cluster line-item work, which is why `lib/cluster-revenue.js`
// reconciles to it instead. Do not mix the two.
//
// TWO CAVEATS THAT SURVIVE ANY RE-MEASUREMENT, both from the AOV investigation:
//
//  1. There is a STRUCTURAL BREAK at ~2025-09 — AOV ran high-$20s/low-$30s before it and
//     mid-$40s-and-up after. Never quote an average spanning it. The all-time "$19" figure
//     is real and useless: it is 1,296 orders since 2019, dragged by June 2024 alone doing
//     239 orders at $19.21. The trailing-90d window is the only honest current basis.
//  2. At ~16 orders/month the MEDIAN and the mean diverge hard — three orders of $203-$226
//     were 53% of one 28-day window's revenue. These constants are means, which is correct
//     for a forecast that multiplies by a click count, and wrong for describing a typical
//     order. Quote the median beside the mean when the audience is a human.

/** Trailing-90d AOV, `total_price` basis (incl. shipping + tax), live paid orders only. */
export const AOV_TRAILING_90D = 54.73;

/** Shopify-only monthly revenue, from the same 90-day pull. Excludes Amazon. */
export const SHOPIFY_MONTHLY_REVENUE = 894;

/** Shopify-only monthly orders. ~54/month is Shopify PLUS Amazon — a different number. */
export const SHOPIFY_MONTHLY_ORDERS = 16;

/**
 * When the figures above were last measured against production.
 *
 * Moving this date without re-running `aov-analysis.mjs` is the one thing that makes the
 * whole module worse than the hardcoded constants it replaced: it converts a loud,
 * testable staleness into a false assurance of freshness.
 */
export const BASELINE_AS_OF = '2026-09-20';

/**
 * Deliberately the same 45 days as `PAID_STATUS_MAX_AGE_DAYS`, so the constraint block
 * has ONE review cadence rather than two that drift apart. It is also about right on its
 * own terms: the figure moved 8.5% over the ~57 days it was left alone, so 45 days bounds
 * drift at roughly 5% — small enough that no tactic's score turns on it.
 */
export const BASELINE_MAX_AGE_DAYS = 45;

export function assertBusinessBaselineFresh(now = new Date()) {
  const age = Math.floor((now - new Date(`${BASELINE_AS_OF}T00:00:00Z`)) / 86_400_000);
  if (age > BASELINE_MAX_AGE_DAYS) {
    throw new Error(
      `The business baseline (AOV, revenue, order volume) was last measured ${age} days `
      + `ago (${BASELINE_AS_OF}), past the ${BASELINE_MAX_AGE_DAYS}-day limit. Every `
      + `tactic score and every Bing revenue forecast rests on it. Re-measure with `
      + `\`ssh root@137.184.119.230 'cd ~/seo-claude && node scripts/aov-analysis.mjs 90'\`, `
      + `take the total_price AOV, update all three constants together, and move `
      + `BASELINE_AS_OF.`);
  }
  return { age, stale: false };
}
