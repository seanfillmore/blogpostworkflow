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
//
// ─────────────────────────────────────────────────────────────────────────────
// THREE CONFOUNDS, ADDED 2026-08-24 AFTER RECONSTRUCTING EVERY CONCLUDED TEST
//
// PR #630 fixed the baseline BASIS (page-28d vs keyword-90d). It did not fix
// what the comparison is exposed to. Replaying all nine concluded tests against
// data/snapshots/gsc/ showed none of them is attributable to the rewrite:
//
//  1. NO NOISE FLOOR ON THE WIN SIDE. `delta > 0` meant `improved`, forever, on
//     any margin. The dead-band guarded regressions only. All five verdicts
//     ever recorded as improved sit INSIDE that same dead-band (+0.38, +0.13,
//     +0.10, +0.19, +0.25 pp against a 0.5pp band) — three of them on fewer than
//     four clicks. The band is now symmetric, which is the whole of that fix and
//     breaks none of the existing tests: it only changes deltas in (0, 0.005),
//     which is precisely the noise.
//
//  2. CORPUS DRIFT. Blog-wide CTR across all 190 pages went 0.166% → 0.505%
//     over six consecutive 28-day blocks ending 2026-08-21, untouched. The four
//     tests concluded `improved` ran 2026-03-09 → 2026-06-14, straddling the
//     steepest stretch — about +0.27pp of free tailwind, larger than three of
//     the four deltas it was credited for. `controlDrift` subtracts what the
//     rest of the corpus did over the same window. Supply it or the comparison
//     is measuring the algorithm, not the headline.
//
//  3. POSITION. CTR is a function of rank before it is a function of copy. The
//     2026-07-27 `sls free toothpaste` test was auto-reverted for a 0.46% →
//     0.17% fall; over that window the page's average position went 13.2 → 27.6
//     and impressions fell 9,934 → 3,462. The old code fetched `currentPosition`
//     and never looked at it. A page that moved beyond tolerance now returns
//     `confounded` — not concluded, not reverted, re-measured later.
//
// AND A FOURTH THING, WHICH IS NOT A CONFOUND BUT A CEILING: most pages here
// cannot resolve the effect at all (see lib/ctr-power.js — exactly one of 190
// blog pages clears a +50% relative target over 28 days). Pass
// `impressionsPerArm` and an unreadable test returns `underpowered` instead of a
// coin-flip verdict.
//
// ALL FOUR ARE OPT-IN BY ABSENCE. Call this with the original two fields and it
// behaves exactly as it always did, minus the asymmetric win rule. That matters
// because 13 of the 18 live tracker entries predate these fields.
//
// NEITHER `confounded` NOR `underpowered` REVERTS, and neither concludes. That
// is deliberate and it is the lesson of the 2026-07-27 revert: acting on an
// unreadable measurement destroys good work exactly as eagerly as it undoes bad
// work, and a test left open can still be answered later, while a concluded one
// cannot.

import { assessPower } from './ctr-power.js';

// 0.5 percentage points (CTR is a fraction, so 0.005).
export const DEFAULT_REGRESS_THRESHOLD = 0.005;

/**
 * Minimum average-position move, in places, that counts as a confound. The rule
 * actually applied is `max(DEFAULT_POSITION_TOLERANCE, 25% of the baseline
 * position)`, because three places at rank 3 is a different event from three
 * places at rank 40 — the first crosses most of page one, the second is noise
 * on a page nobody reaches.
 */
export const DEFAULT_POSITION_TOLERANCE = 3;
export const DEFAULT_POSITION_TOLERANCE_RELATIVE = 0.25;

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

const isNum = (v) => Number.isFinite(Number(v));

/**
 * @param {{
 *   baselineCtr:number, currentCtr:number|null|undefined,
 *   controlDrift?:number|null,        // what the untouched corpus did, same window
 *   baselinePosition?:number|null, currentPosition?:number|null,
 *   impressionsPerArm?:number|null,   // for the power gate; omit to skip it
 * }} entry
 * @param {{regressThreshold?:number, positionTolerance?:number,
 *          positionToleranceRelative?:number, targetRelativeLift?:number}} [opts]
 * @returns {{
 *   delta:number, rawDelta:number, controlDrift:number,
 *   outcome:'improved'|'flat'|'regressed'|'confounded'|'underpowered',
 *   winner:'A'|'B'|null, shouldRevert:boolean, concluded:boolean,
 *   positionDelta:number|null, positionTolerance:number|null, power:object|null,
 * }}
 */
export function decideOutcome({
  baselineCtr,
  currentCtr,
  controlDrift,
  baselinePosition,
  currentPosition,
  impressionsPerArm,
} = {}, {
  regressThreshold = DEFAULT_REGRESS_THRESHOLD,
  positionTolerance = DEFAULT_POSITION_TOLERANCE,
  positionToleranceRelative = DEFAULT_POSITION_TOLERANCE_RELATIVE,
  targetRelativeLift,
} = {}) {
  const base = Number(baselineCtr) || 0;
  const cur = currentCtr == null ? 0 : (Number(currentCtr) || 0);
  const rawDelta = cur - base;

  // Subtract what the rest of the corpus did over the same window. A non-finite
  // value is ignored rather than propagated — a broken control must not turn a
  // real measurement into NaN and thence into a silent `regressed`.
  const drift = isNum(controlDrift) ? Number(controlDrift) : 0;
  const delta = rawDelta - drift;

  // Position move, evaluated on the tolerance that scales with rank.
  let positionDelta = null;
  let tolerance = null;
  if (isNum(baselinePosition) && isNum(currentPosition)) {
    positionDelta = Math.abs(Number(currentPosition) - Number(baselinePosition));
    tolerance = Math.max(positionTolerance, positionToleranceRelative * Math.abs(Number(baselinePosition)));
  }

  const power = isNum(impressionsPerArm)
    ? assessPower({
      impressionsPerArm: Number(impressionsPerArm),
      baselineCtr: base,
      ...(isNum(targetRelativeLift) ? { targetRelativeLift: Number(targetRelativeLift) } : {}),
    })
    : null;

  const shared = {
    delta, rawDelta, controlDrift: drift, positionDelta, positionTolerance: tolerance, power,
  };

  // PRECEDENCE: invalid before insufficient. There is no sample size that
  // repairs a page which moved twenty places, so reporting such a test as
  // `underpowered` would send an operator to fix the wrong thing.
  if (positionDelta !== null && positionDelta > tolerance) {
    return { ...shared, outcome: 'confounded', winner: null, shouldRevert: false, concluded: false };
  }
  if (power && !power.powered) {
    return { ...shared, outcome: 'underpowered', winner: null, shouldRevert: false, concluded: false };
  }

  // Epsilon absorbs floating-point drift so a delta exactly at ±threshold lands
  // on the decisive side of the band rather than tipping across it.
  const EPS = 1e-9;
  let outcome;
  if (delta >= regressThreshold - EPS) outcome = 'improved';
  else if (delta >= -regressThreshold - EPS) outcome = 'flat'; // dead-band, now symmetric
  else outcome = 'regressed';

  return {
    ...shared,
    outcome,
    winner: outcome === 'improved' ? 'B' : 'A',
    shouldRevert: outcome === 'regressed',
    concluded: true,
  };
}
