// lib/meta-ab-decision.js
// Pure decision logic for concluding a meta A/B test.
//
// A test makes the rewritten title/meta ("variant B") live and records the
// original ("variant A") plus the pre-test CTR. After the measurement window we
// compare current CTR to baseline and decide:
//   - improved  → B wins, keep it.
//   - flat      → within a dead-band, treat A as winner but don't bother reverting.
//   - regressed → B clearly hurt CTR → A wins and we revert to it.
//
// The dead-band avoids churning Shopify over GSC noise.

// 0.5 percentage points (CTR is a fraction, so 0.005).
export const DEFAULT_REGRESS_THRESHOLD = 0.005;

/**
 * Which baseline to compare against, and on what basis.
 *
 * The checker measures `gsc.getPagePerformance(pageUrl, 28)` — PAGE-level CTR
 * over 28 days. The tracker's original `baselineCtr` is the KEYWORD-level CTR
 * over 90 days that made the page a candidate. Comparing the two is not a
 * measurement of the change: a page whose one tested query is a small slice of
 * its total impressions can read "improved" or "regressed" purely from the
 * difference in denominator. meta-optimizer now records `baselinePageCtr` on
 * the same basis the checker measures, so new tests compare like with like.
 *
 * Entries written before that field existed keep the old behaviour rather than
 * being silently re-based — `basis` says which one was used so a report can be
 * honest about it.
 *
 * @returns {{ctr:number|null, basis:'page-28d'|'keyword-90d'}}
 */
export function pickBaselineCtr(entry = {}) {
  const page = entry.baselinePageCtr;
  if (page != null && Number.isFinite(Number(page))) {
    return { ctr: Number(page), basis: 'page-28d' };
  }
  const kw = entry.baselineCtr;
  return { ctr: kw == null ? null : Number(kw), basis: 'keyword-90d' };
}

/**
 * @param {{baselineCtr:number, currentCtr:number|null|undefined}} entry
 * @param {{regressThreshold?:number}} [opts]
 * @returns {{delta:number, outcome:'improved'|'flat'|'regressed', winner:'A'|'B', shouldRevert:boolean}}
 */
export function decideOutcome({ baselineCtr, currentCtr }, { regressThreshold = DEFAULT_REGRESS_THRESHOLD } = {}) {
  const base = Number(baselineCtr) || 0;
  const cur = currentCtr == null ? 0 : Number(currentCtr);
  const delta = cur - base;

  // Epsilon absorbs floating-point drift so a delta exactly at -threshold lands
  // in the dead-band rather than tipping to "regressed".
  const EPS = 1e-9;
  let outcome;
  if (delta > 0) outcome = 'improved';
  else if (delta >= -regressThreshold - EPS) outcome = 'flat'; // dead-band (incl. 0 and exactly -threshold)
  else outcome = 'regressed';

  const winner = outcome === 'improved' ? 'B' : 'A';
  const shouldRevert = outcome === 'regressed';
  return { delta, outcome, winner, shouldRevert };
}
