// lib/ctr-power.js
//
// HOW BIG A CTR MOVE THIS SITE CAN ACTUALLY SEE — and therefore what it is
// allowed to conclude.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS
//
// `agents/meta-optimizer` mutates a live title/meta, `agents/meta-ab-checker`
// re-measures 28 days later and auto-reverts what looks worse. Neither one has
// ever asked whether the page carries enough traffic for that comparison to
// mean anything. On 2026-08-24 the tracker held nine concluded tests. Their
// baselines ran from 133 impressions to 12,305. The 133-impression test —
// "tom's of maine toothpaste alternative", 1.5% CTR, two clicks — was concluded
// `improved` on a +0.38pp delta. The smallest move that sample can distinguish
// from noise is +4.2pp. That verdict was a coin flip wearing a checkmark, and
// the variant it blessed is still live.
//
// So: before a page is tested, and before a test is concluded, something has to
// say what the instrument can read. That is all this module does.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE MEASURE
//
// A CTR test is a two-proportion comparison. For equal arms of n impressions at
// baseline rate p, the smallest true difference detectable with power (1−β) at
// two-sided significance α is
//
//     MDE = (z_{α/2} + z_β) · sqrt( 2·p·(1−p) / n )
//
// and inverting it for a target absolute lift d gives the impressions each arm
// needs:
//
//     n = 2·p·(1−p)·(z_{α/2} + z_β)² / d²
//
// The normal approximation is doing real work at p ≈ 0.004; it is fine at the
// impression counts that matter here (thousands per arm) and it is deliberately
// the conventional formula rather than something cleverer, because the number's
// job is to be checkable by hand against any power calculator.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THE ANSWER TURNED OUT TO BE, AND WHY IT RESHAPES THE PROGRAM
//
// Measured over the 90 days to 2026-08-21, at the default target of a +50%
// RELATIVE lift:
//
//   · THREE of 190 blog pages clear the bar alone, and only three:
//     `toothpaste-without-sls` (102,816 impressions/90d at 0.79%, MDE 0.196pp
//     against a 0.393pp target — the only comfortable one),
//     `best-soap-for-tattoos-…-2` (37,531 at 0.56%, MDE 0.274pp against
//     0.280pp) and `best-toothpaste-without-sls-2025` (36,238 at 0.66%, MDE
//     0.302pp against 0.330pp). The latter two clear it by about 2% and 8% —
//     a knife edge, not a margin, and an ordinary week of traffic variance puts
//     either back under;
//   · the other 187 do not, including the fourth- and fifth-largest pages on the
//     site. `lib/ctr-cohort.js`'s `partitionByPower` is what splits them;
//   · a COHORT of ten of those 187 (~100,800 impressions/90d at 0.46%) IS
//     powered, at MDE 0.152pp against a 0.232pp target — about 53% of margin.
//
// The conclusion is not "test fewer pages" and it is certainly not "test more
// pages faster". It is that the UNIT OF MEASUREMENT is wrong for almost every
// page: for 187 of 190 a 28-day before/after cannot resolve the effect it is
// looking for, at any throughput, and raising the weekly cap only produces more
// verdicts that nothing supports. `lib/ctr-cohort.js` is the unit that can — and
// its `partitionByPower` keeps the three that do NOT need pooling out of the
// pool, because pooling a page that is 19.7% of the corpus makes the cohort a
// single-page test wearing a cohort's name.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY 50% RELATIVE IS THE DEFAULT TARGET
//
// Not because a title rewrite reliably delivers it — nothing here claims that.
// It is the floor of consequence: sitewide blog CTR is 0.47%, the program's
// stated goal is 0.9%, and a rewrite that cannot move a page by half again is
// not worth a live Shopify mutation plus 28 days of the store's only
// measurement capacity. Setting it lower does not make small effects visible;
// it makes the required sample explode (n scales with 1/d²), so the gate would
// simply reject everything while pretending to be generous.
//
// Pure: no I/O, no env, no clock.

/** Two-sided α = 0.05. */
export const Z_ALPHA_TWO_SIDED_95 = 1.959963984540054;
/** Power = 0.80. */
export const Z_BETA_80 = 0.8416212335729143;

/**
 * The relative lift a test is sized to detect. 0.5 = a 50% relative move
 * (0.40% → 0.60%). See the header for why this number and not a smaller one.
 */
export const DEFAULT_TARGET_RELATIVE_LIFT = 0.5;

/**
 * A CTR of exactly zero has zero variance and would make the required sample
 * collapse to nothing — which is backwards, since a page with no clicks is the
 * hardest thing on the site to measure. Floor p at one click in fifty thousand
 * impressions, roughly the thinnest real signal these snapshots carry.
 */
const MIN_BASELINE_CTR = 0.00002;

function finitePositive(n) {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : null;
}

function baselineOrFloor(ctr) {
  const v = Number(ctr);
  return Number.isFinite(v) && v > MIN_BASELINE_CTR ? Math.min(v, 1) : MIN_BASELINE_CTR;
}

/**
 * Smallest absolute CTR difference detectable at the given power/significance.
 *
 * @param {{impressionsPerArm:number, baselineCtr:number, zAlpha?:number, zBeta?:number}} o
 * @returns {number} absolute CTR fraction, or Infinity when the sample is unusable
 */
export function minDetectableEffect({
  impressionsPerArm,
  baselineCtr,
  zAlpha = Z_ALPHA_TWO_SIDED_95,
  zBeta = Z_BETA_80,
} = {}) {
  const n = finitePositive(impressionsPerArm);
  if (n === null) return Infinity;
  const p = baselineOrFloor(baselineCtr);
  return (zAlpha + zBeta) * Math.sqrt((2 * p * (1 - p)) / n);
}

/**
 * Impressions each arm needs to detect `absoluteLift` — the inverse of
 * `minDetectableEffect`, and tested as an exact round trip against it.
 *
 * @returns {number} impressions, or Infinity when no sample would do
 */
export function requiredImpressionsPerArm({
  baselineCtr,
  absoluteLift,
  zAlpha = Z_ALPHA_TWO_SIDED_95,
  zBeta = Z_BETA_80,
} = {}) {
  const d = finitePositive(absoluteLift);
  if (d === null) return Infinity;
  const p = baselineOrFloor(baselineCtr);
  return (2 * p * (1 - p) * (zAlpha + zBeta) ** 2) / d ** 2;
}

/**
 * The admission test, and the same test again at conclusion time.
 *
 * `powered` false does NOT mean "do not touch this page" — it means this page
 * cannot be judged on its own, which is the argument for putting it in a cohort
 * rather than the argument for leaving it alone.
 *
 * @param {{impressionsPerArm?:number, baselineCtr?:number, targetRelativeLift?:number}} o
 * @returns {{
 *   powered: boolean,
 *   impressionsPerArm: number,
 *   baselineCtr: number,
 *   mde: number,
 *   relativeMde: number,
 *   targetRelativeLift: number,
 *   targetAbsoluteLift: number,
 *   requiredImpressionsPerArm: number,
 *   shortfall: number,
 * }}
 */
export function assessPower({
  impressionsPerArm,
  baselineCtr,
  targetRelativeLift = DEFAULT_TARGET_RELATIVE_LIFT,
} = {}) {
  const n = finitePositive(impressionsPerArm) ?? 0;
  const p = baselineOrFloor(baselineCtr);
  const rel = finitePositive(targetRelativeLift) ?? DEFAULT_TARGET_RELATIVE_LIFT;
  const targetAbsoluteLift = p * rel;

  const mde = minDetectableEffect({ impressionsPerArm: n, baselineCtr: p });
  const required = requiredImpressionsPerArm({ baselineCtr: p, absoluteLift: targetAbsoluteLift });
  const powered = Number.isFinite(mde) && mde <= targetAbsoluteLift;

  return {
    powered,
    impressionsPerArm: n,
    baselineCtr: p,
    mde,
    relativeMde: mde / p,
    targetRelativeLift: rel,
    targetAbsoluteLift,
    requiredImpressionsPerArm: required,
    shortfall: powered ? 0 : Math.max(0, required - n),
  };
}
