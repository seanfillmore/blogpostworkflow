// lib/ctr-cohort.js
//
// THE UNIT OF MEASUREMENT THIS PROGRAM WAS MISSING.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT WENT WRONG WITH PER-PAGE BEFORE/AFTER
//
// `agents/meta-ab-checker` judges a rewrite by comparing one page's CTR after
// the change to the same page's CTR before it. That design has no control, and
// on this store it produced nine concluded tests of which none is attributable.
// Two measured failure modes, both from data/snapshots/gsc/:
//
//  1. CORPUS DRIFT. Blog CTR across all 190 pages went 0.166% → 0.203% → 0.282%
//     → 0.433% → 0.502% → 0.505% over six consecutive 28-day blocks ending
//     2026-08-21. It TRIPLED with nobody touching most of those pages. The four
//     tests concluded `improved` were all applied 2026-03-09 and concluded
//     2026-06-14 — 97 days, straddling the steepest part of that climb, which
//     was worth about +0.27pp on its own. Three of their four winning deltas
//     (+0.13pp, +0.10pp, +0.19pp) are SMALLER than the drift they sat inside.
//     The fourth, +0.38pp, is on 133 impressions, where nothing under +4.2pp is
//     detectable at all.
//
//  2. POSITION MOVEMENT. The 2026-07-27 `sls free toothpaste` test concluded
//     `regressed` and auto-reverted. Reconstructed from the daily snapshots, the
//     page's average position over the same window went 13.2 → 27.6 and its
//     impressions fell 9,934 → 3,462. CTR is a function of position before it is
//     a function of anything a title says. `decideOutcome` never saw the
//     position at all; it read the ranking collapse as a bad headline and threw
//     the headline away.
//
// A holdout answers both at once. Pages in the holdout live through the same
// algorithm updates, the same seasonality and the same corpus-wide drift as the
// treated pages, and are not rewritten. Whatever moves both arms is not the
// rewrite.
//
// ─────────────────────────────────────────────────────────────────────────────
// AND IT IS THE ONLY UNIT WITH THE POWER
//
// See lib/ctr-power.js: THREE of 190 blog pages carry enough traffic to resolve
// a +50% relative CTR move in 28 days on their own, and two of those three clear
// the bar by under 10%. Ten pooled pages from the remaining 187 clear it by
// about 53%. Pooling is not a convenience here — for 187 pages it is the
// difference between a measurement and a coin flip. For the other three it is
// the opposite, which is what `partitionByPower` below exists to prevent.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS DOES NOT DO
//
// It does not make a cohort result a per-page result. A wave that improves in
// aggregate has not proved that every page in it improved, and the per-page
// auto-revert in `agents/meta-ab-checker` stays exactly where it is for the case
// where one page falls off a cliff. What the cohort verdict decides is whether
// the WAVE was worth running — which is the question "should we keep doing
// this?", and the one nine per-page tests never managed to answer.
//
// Pure: no I/O, no env, no clock.

import {
  minDetectableEffect, assessPower, DEFAULT_TARGET_RELATIVE_LIFT,
  Z_ALPHA_TWO_SIDED_95, Z_BETA_80,
} from './ctr-power.js';

/**
 * Ten pages a wave. Sized from the power arithmetic above, not from taste.
 * Measured on the real pooled corpus (the 187 pages that are not individually
 * powered): at size 5 the wave is UNDERPOWERED — MDE 0.146pp against a 0.139pp
 * target — and at size 8 it only just clears. Ten gives ~53% of margin, which is
 * what survives an ordinary bad month, and twelve buys little more. It is also,
 * at 20 pages across both arms, most of the impression mass worth touching.
 */
export const DEFAULT_COHORT_SIZE = 10;

// ── normal distribution ──────────────────────────────────────────────────────

/**
 * Abramowitz & Stegun 7.1.26. Accurate to ~1.5e-7, which is several orders more
 * than a p-value on 50,000 impressions deserves, and it is inlined because Node
 * has no erf and a dependency for one polynomial is not worth the supply chain.
 */
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * z);
  const poly = t * (0.254829592
    + t * (-0.284496736
      + t * (1.421413741
        + t * (-1.453152027
          + t * 1.061405429))));
  return sign * (1 - poly * Math.exp(-z * z));
}

/** Standard normal CDF. */
function normalCdf(x) {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

// ── cohort assignment ────────────────────────────────────────────────────────

function impressionsOf(p) {
  const v = Number(p?.impressions);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Split a ranked candidate pool into a treatment arm and a matched holdout.
 *
 * BALANCE ON TWO AXES, AND CLUSTER MIX WINS THE TIE. Clusters are processed in
 * descending total impressions, pages within a cluster in descending
 * impressions, and each cluster is dealt ALTERNATELY between the arms starting
 * with whichever currently holds fewer impressions. Alternation guarantees each
 * cluster splits within one page of even; the starting side is what keeps the
 * arms close on impressions.
 *
 * A PURE GREEDY "SEND EACH PAGE TO THE LIGHTER ARM" WAS TRIED FIRST AND IS
 * WRONG HERE, measured on the real 2026-08-21 pool. One page —
 * toothpaste-without-sls, 102,816 impressions — is 19.7% of the entire blog.
 * Greedy hands it to treatment, treatment is then 100k impressions ahead, and
 * every remaining toothpaste page falls to the holdout: the arms came out
 * beautifully balanced on impressions (6.0% skew) and split toothpaste ONE
 * against FOUR. That is the worse failure. A difference-in-differences is
 * already robust to the two arms sitting at different CTR levels; what it
 * cannot survive is the arms having different CATEGORY MIXES, because then a
 * trend in one category is indistinguishable from the treatment. Arm-size
 * imbalance only costs power, and the wave has 2.3× the power it needs.
 *
 * Deliberately NOT random. Randomisation is the right tool at scale and the
 * wrong one at n=20, where a single bad draw puts the flagship and its duplicate
 * in the same arm and there is no second experiment to average it out. This is
 * deterministic, inspectable, and reproducible from the same pool.
 *
 * @param {Array<{url:string, cluster?:string, impressions?:number, score?:number}>} rankedPages
 *        best-first, e.g. from lib/ctr-opportunity.js's rankOpportunities
 * @param {{size?:number}} opts treatment arm size (the holdout matches it)
 * @returns {{treatment:Array, holdout:Array, unassigned:Array,
 *            balance:{treatmentImpressions:number, holdoutImpressions:number, skew:number}}}
 */
export function assignCohorts(rankedPages, { size = DEFAULT_COHORT_SIZE } = {}) {
  const pool = Array.isArray(rankedPages) ? rankedPages.filter((p) => p && p.url != null) : [];
  const cap = Number.isFinite(Number(size)) && Number(size) > 0 ? Math.floor(Number(size)) : DEFAULT_COHORT_SIZE;

  // Only the top 2×size are eligible; everything below is the next wave's problem.
  const eligible = pool.slice(0, cap * 2);
  const unassigned = pool.slice(cap * 2);

  const byCluster = new Map();
  for (const p of eligible) {
    const k = p.cluster ?? 'unknown';
    if (!byCluster.has(k)) byCluster.set(k, []);
    byCluster.get(k).push(p);
  }
  const clusters = [...byCluster.entries()]
    .map(([k, ps]) => ({ k, ps, total: ps.reduce((s, p) => s + impressionsOf(p), 0) }))
    .sort((a, b) => (b.total - a.total) || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));

  const treatment = []; const holdout = [];
  let tImp = 0; let hImp = 0;

  for (const { ps } of clusters) {
    const ordered = [...ps].sort((a, b) => (impressionsOf(b) - impressionsOf(a))
      || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
    // Start this cluster on the lighter arm, then strictly alternate.
    let toTreatment = tImp <= hImp;
    for (const p of ordered) {
      const tFull = treatment.length >= cap;
      const hFull = holdout.length >= cap;
      if (tFull && hFull) { unassigned.push(p); continue; }
      // Alternation yields to a full arm rather than dropping the page.
      const side = tFull ? false : hFull ? true : toTreatment;
      if (side) { treatment.push(p); tImp += impressionsOf(p); }
      else { holdout.push(p); hImp += impressionsOf(p); }
      toTreatment = !side;
    }
  }

  const total = tImp + hImp;
  return {
    treatment,
    holdout,
    unassigned,
    balance: {
      treatmentImpressions: tImp,
      holdoutImpressions: hImp,
      skew: total > 0 ? Math.abs(tImp - hImp) / total : 0,
    },
  };
}

/**
 * Split a ranked pool into pages that can be judged ALONE and pages that cannot.
 *
 * WHY THIS EXISTS: pooling a page that does not need pooling is not free, it is
 * harmful in both directions. Measured on the real 2026-08-21 corpus,
 * `toothpaste-without-sls` carries 102,816 impressions — 19.7% of the entire
 * blog, and 51% of a ten-page treatment arm. A cohort containing it is a
 * single-page test wearing a cohort's name: that one page's ranking moves swamp
 * the difference-in-differences, and the nine pages the wave was actually about
 * contribute noise. Meanwhile the page itself clears the power bar comfortably
 * on its own, so pooling it also throws away the one clean per-page measurement
 * the site can make.
 *
 * So the rule is: **individually powered pages get individual A/B tests**
 * (the existing meta-optimizer → meta-ab-checker path, now with the confound
 * guards in lib/meta-ab-decision.js), and everything else — which is 187 of 190
 * blog pages — goes into cohort waves with a holdout.
 *
 * Note the zero-click case, which the power floor in lib/ctr-power.js handles
 * and which would otherwise invert this rule: a page with no clicks has a
 * near-zero baseline, and the required-sample arithmetic collapses toward
 * nothing as p → 0. Without that floor a 0-click page reads as the easiest
 * thing on the site to measure, when it is the hardest.
 *
 * @param {Array} rankedPages rows carrying `impressions` and `ctr` (or `clicks`)
 * @param {{windowDays?:number, armDays?:number, targetRelativeLift?:number}} opts
 *        `windowDays` is the span the impressions were summed over (90 by
 *        default); `armDays` the measurement arm (28), so the two can be scaled
 *        against each other rather than compared as though they matched.
 * @returns {{individual:Array, pooled:Array}} each row gains a `power` field
 */
export function partitionByPower(rankedPages, {
  windowDays = 90, armDays = 28, targetRelativeLift = DEFAULT_TARGET_RELATIVE_LIFT,
} = {}) {
  const individual = []; const pooled = [];
  for (const p of Array.isArray(rankedPages) ? rankedPages : []) {
    if (!p) continue;
    const imps = Number(p.impressions);
    const ctr = Number.isFinite(Number(p.ctr))
      ? Number(p.ctr)
      : (Number.isFinite(imps) && imps > 0 ? (Number(p.clicks) || 0) / imps : 0);
    const perArm = Number.isFinite(imps) && imps > 0 && windowDays > 0
      ? (imps / windowDays) * armDays
      : 0;
    const power = assessPower({ impressionsPerArm: perArm, baselineCtr: ctr, targetRelativeLift });
    const row = { ...p, power };
    (power.powered ? individual : pooled).push(row);
  }
  return { individual, pooled };
}

// ── measurement ──────────────────────────────────────────────────────────────

/**
 * Sum an arm's clicks and impressions from a per-URL metrics map.
 *
 * A page absent from the map counts as ZERO and is tallied in `missing`, rather
 * than being silently dropped. Dropping it would shrink the arm's denominator
 * and make a page that lost all its impressions look like a page that was never
 * in the experiment — which is the specific way an arm quietly stops being
 * comparable to the other one.
 *
 * @param {Array<{url:string}>} pages
 * @param {Map<string,{clicks:number,impressions:number}>|object} metricsByUrl
 */
export function cohortTotals(pages, metricsByUrl) {
  const get = metricsByUrl instanceof Map
    ? (u) => metricsByUrl.get(u)
    : (u) => (metricsByUrl && typeof metricsByUrl === 'object' ? metricsByUrl[u] : undefined);

  let clicks = 0; let impressions = 0; let missing = 0;
  for (const p of Array.isArray(pages) ? pages : []) {
    const m = get(p?.url);
    if (!m) { missing++; continue; }
    clicks += Number(m.clicks) || 0;
    impressions += Number(m.impressions) || 0;
  }
  return { clicks, impressions, ctr: impressions > 0 ? clicks / impressions : 0, missing, pages: (pages || []).length };
}

function ctrOf(arm) {
  const i = Number(arm?.impressions) || 0;
  const c = Number(arm?.clicks) || 0;
  return i > 0 ? c / i : 0;
}

function variance(arm) {
  const i = Number(arm?.impressions) || 0;
  if (i <= 0) return 0;
  const p = ctrOf(arm);
  return (p * (1 - p)) / i;
}

/**
 * Difference-in-differences on four binomial arms.
 *
 *     DiD = (treatment_post − treatment_pre) − (holdout_post − holdout_pre)
 *
 * The standard error is the root of the four arms' variances summed, which
 * treats the pre and post windows as independent samples. They are not
 * perfectly independent — the same pages appear in both — so this SE is mildly
 * CONSERVATIVE, and conservative is the correct direction for a number whose
 * job is to stop the fleet mutating live pages on noise.
 *
 * @param {{treatment:{pre:object,post:object}, holdout:{pre:object,post:object}}} arms
 */
export function differenceInDifferences(arms = {}) {
  const tPre = arms?.treatment?.pre ?? {}; const tPost = arms?.treatment?.post ?? {};
  const hPre = arms?.holdout?.pre ?? {}; const hPost = arms?.holdout?.post ?? {};

  const treatmentDelta = ctrOf(tPost) - ctrOf(tPre);
  const holdoutDelta = ctrOf(hPost) - ctrOf(hPre);
  const did = treatmentDelta - holdoutDelta;

  const se = Math.sqrt(variance(tPre) + variance(tPost) + variance(hPre) + variance(hPost));
  const z = se > 0 ? did / se : 0;
  const pValue = se > 0 ? 2 * (1 - normalCdf(Math.abs(z))) : 1;

  return {
    treatmentPreCtr: ctrOf(tPre),
    treatmentPostCtr: ctrOf(tPost),
    holdoutPreCtr: ctrOf(hPre),
    holdoutPostCtr: ctrOf(hPost),
    treatmentDelta,
    holdoutDelta,
    did,
    standardError: se,
    z,
    pValue: Math.min(1, Math.max(0, pValue)),
    outcomeSign: did > 0 ? 1 : did < 0 ? -1 : 0,
    treatmentImpressions: Number(tPost?.impressions) || 0,
    holdoutImpressions: Number(hPost?.impressions) || 0,
  };
}

/**
 * Turn a DiD into a decision.
 *
 * THREE OUTCOMES, NOT TWO, and the third is the point. `underpowered` is what
 * the old per-page checker had no way to say: the wave neither won nor lost,
 * the instrument simply could not read it. It must never revert, because
 * reverting on an unreadable measurement is how a good rewrite gets thrown away
 * — which is exactly what happened to the 2026-07-27 test.
 *
 * `flat` and `underpowered` differ only in whether the sample was big enough for
 * "no effect" to be a finding. Collapsing them would let a genuinely null result
 * (400,000 impressions, nothing moved) read the same as no result at all.
 *
 * @param {ReturnType<typeof differenceInDifferences>} did
 * @param {{targetRelativeLift?:number, alpha?:number}} opts
 */
export function cohortVerdict(did = {}, { targetRelativeLift = DEFAULT_TARGET_RELATIVE_LIFT } = {}) {
  const base = Number(did.treatmentPreCtr) || 0;
  const targetAbsoluteLift = base * (Number(targetRelativeLift) || DEFAULT_TARGET_RELATIVE_LIFT);

  // The MDE of the DiD itself, on the same (z_α + z_β) scale lib/ctr-power.js uses.
  const se = Number(did.standardError) || 0;
  const mde = se > 0 ? (Z_ALPHA_TWO_SIDED_95 + Z_BETA_80) * se : Infinity;

  const significant = Math.abs(Number(did.z) || 0) >= Z_ALPHA_TWO_SIDED_95;

  let outcome;
  if (significant) outcome = (Number(did.did) || 0) > 0 ? 'improved' : 'regressed';
  else if (!Number.isFinite(mde) || mde > targetAbsoluteLift) outcome = 'underpowered';
  else outcome = 'flat';

  return {
    outcome,
    significant,
    did: Number(did.did) || 0,
    z: Number(did.z) || 0,
    pValue: Number(did.pValue) ?? 1,
    mde,
    targetAbsoluteLift,
    targetRelativeLift: Number(targetRelativeLift) || DEFAULT_TARGET_RELATIVE_LIFT,
    shouldRevert: outcome === 'regressed',
  };
}

export { minDetectableEffect };
