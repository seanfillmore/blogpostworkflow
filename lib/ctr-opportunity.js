// lib/ctr-opportunity.js
//
// RANK THE PAGE, NOT THE QUERY — and weight it by what the cluster actually
// earns. The candidate-selection half of blog CTR work: given every blog page
// GSC knows about, which handful is worth spending a title/meta rewrite on?
//
// ────────────────────────────────────────────────────────────────────────────
// THE MEASURED SITUATION (90 days to 2026-08-21, from `data/snapshots/gsc/`).
//
//   190 blog pages · 521,159 impressions · 2,501 clicks · 0.48% CTR
//
// The impressions are concentrated to the point where a budget is nearly a
// choice of ten pages: the top 10 hold 59.4% of blog impressions, the top 20
// hold 73.9%, the top 30 hold 82.4%. So the ranking barely needs a long tail —
// what it needs is to pick the right ten.
//
// WHY RAW IMPRESSIONS ARE THE WRONG KEY, in one number: the `toothpaste`
// cluster is 41.4% of blog impressions and 54.7% of blog clicks for 2.9% of
// revenue. Ranking candidates by impressions therefore hands roughly 41% of the
// budget to the least efficient cluster in the catalogue, every run, forever.
// That is the Prime Directive's "measure in dollars, not clicks" stated as a
// sort key, and it is why `score` is revenue-weighted rather than raw.
//
// WHY PAGES, NOT QUERIES. `agents/meta-optimizer` today ranks CANDIDATE QUERIES
// through `lib/sort.js`'s `sortByValidation` — Amazon-validated first, then by
// the query's own impressions. A title rewrite is a PAGE-level act, and on this
// corpus a query is a poor stand-in for its page: the flagship
// `best-soap-for-tattoos-what-to-use-for-safe-healing-2` earns 37,531
// impressions across 666 distinct queries, and its single biggest query is
// 1,045 — 6.1% of the page. Ranking on that 6.1% both understates the page by
// 16× and lets ONE page occupy two slots under two different queries, which is
// why `rankOpportunities` dedupes by url before it scores anything.
//
// ────────────────────────────────────────────────────────────────────────────
// THE BENCHMARK IS A RANKING INSTRUMENT, NOT A FORECAST.
//
// `BENCHMARK_CTR_BY_POSITION` is a conservative published organic CTR-by-
// position curve. EVERY page on this site sits far below it — sitewide blog CTR
// is 0.48% against a curve implying several percent at the positions these
// pages actually hold — so the absolute gap it computes is large for every page
// and means nothing in dollars. **Never quote `recoverable` as recoverable
// clicks or recoverable revenue.** Its only valid use is comparing pages ON ONE
// REPORT, exactly as `lib/cluster-efficiency.js`'s revenue-per-click index is
// only valid within one report: every page carries the identical optimism, so
// the ORDER survives it and the LEVEL does not.
//
// WHY NOT A WITHIN-SITE CURVE, which is the obvious alternative. Deriving
// expected CTR from this site's own pages makes the site at par with itself BY
// CONSTRUCTION: fit the curve to a 0.48% corpus and the average page's gap is
// zero, the whole corpus is "fine", and the ranking has nothing to rank. The
// instrument has to come from outside the thing being measured or it measures
// nothing. An external curve is biased; a self-referential one is degenerate.
//
// ────────────────────────────────────────────────────────────────────────────
// IT DEGRADES, IT DOES NOT FAIL SAFE — because it destroys nothing.
//
// Per CLAUDE.md's split: things that block or delete fail safe, things that rank
// or display degrade. A missing `ranking`, an unavailable one, or a page whose
// cluster the ranking has never heard of all take `clusterWeight = 1.0` — full
// weight, never a penalty. Missing data is not evidence against a page, and a
// ranking that quietly demoted everything it could not place would launder the
// legacy corpus (much of which records no cluster at all) straight out of the
// budget. Same fail-safe doctrine as the hold.

/**
 * Conservative organic CTR by position, as CTR FRACTIONS, indexed 1..20.
 * Index 0 is unused and held as `null` so `BENCHMARK_CTR_BY_POSITION[1]` is
 * position one rather than an off-by-one waiting to happen.
 *
 * READ THE HEADER BEFORE USING THIS FOR ANYTHING BUT SORTING. It is deliberately
 * on the low side of the published curves and is still far above every page on
 * this site; the gap it produces is a ranking signal, not a forecast.
 */
export const BENCHMARK_CTR_BY_POSITION = Object.freeze([
  null,
  0.28, 0.15, 0.11, 0.08, 0.06, // 1-5
  0.05, 0.04, 0.033, 0.028, 0.025, // 6-10
  0.018, 0.015, 0.013, 0.011, 0.010, // 11-15
  0.009, 0.008, 0.0075, 0.007, 0.0065, // 16-20
]);

/** The last position the table itself covers. */
export const BENCHMARK_MAX_POSITION = BENCHMARK_CTR_BY_POSITION.length - 1;

/** Per-position decay applied past the table, and the floor it decays toward. */
export const BENCHMARK_DECAY = 0.93;
export const BENCHMARK_FLOOR_CTR = 0.001;

/**
 * The fraction of the theoretical benchmark gap a title/meta rewrite is assumed
 * to actually capture.
 *
 * 0.35 IS A DELIBERATELY CONSERVATIVE, UNVALIDATED PLANNING CONSTANT. Nothing
 * here measured it, and no A/B result on this site supports it. Its only job is
 * to keep the headline figure from being read as a promise — a report that says
 * "recover 1,200 clicks" invites somebody to budget against it, and the number
 * this module can honestly produce is not that number.
 *
 * IT DOES NOT CHANGE THE RANKING AT ALL. It scales every page identically, so
 * the order is invariant to its value; only the reported magnitude moves. That
 * is the whole reason it is safe to pick a number nobody has validated. When
 * `agents/meta-ab-checker` has enough settled outcomes to measure real capture,
 * replace it with the measured rate and the ordering will not budge.
 */
export const CAPTURE_FRACTION = 0.35;

/**
 * Cluster weighting. The best-ranked cluster keeps full weight and each
 * successive rank is multiplied by `CLUSTER_WEIGHT_DECAY`, floored at
 * `CLUSTER_WEIGHT_FLOOR`.
 *
 * THE WEIGHT DEMOTES, IT NEVER DROPS — the same contract
 * `lib/cluster-efficiency.js` states for its own ordering. A floor of 0.15 means
 * a page in the worst cluster still outranks a page in the best one that has
 * under a seventh of its recoverable clicks, so a cluster can never be starved
 * to zero by arithmetic. That is deliberate: starving a cluster is the hard
 * block again under a new name, and this module excludes nothing.
 */
export const CLUSTER_WEIGHT_DECAY = 0.75;
export const CLUSTER_WEIGHT_FLOOR = 0.15;

const ZERO_RECOVERY = Object.freeze({ gapCtr: 0, recoverable: 0, benchmark: 0, ctr: 0 });

/**
 * Expected CTR at an organic position.
 *
 * · Non-finite, or below 1 → treated as position 1. GSC hands back nulls and
 *   the occasional 0; neither is a reason to throw inside a ranking.
 * · Fractional positions — which is what GSC averages ALWAYS are — are linearly
 *   interpolated between the two bracketing integers, so 8.5 sits strictly
 *   between position 8 and position 9 rather than silently rounding a page a
 *   whole position up the curve.
 * · Past the table it decays geometrically toward `BENCHMARK_FLOOR_CTR`. The
 *   decay is continuous at 20 (it starts from position 20's own value), so
 *   there is no step at the seam.
 *
 * @param {number} position
 * @returns {number} CTR as a fraction
 */
export function benchmarkCtr(position) {
  const n = Number(position);
  const p = Number.isFinite(n) && n > 1 ? n : 1;

  if (p >= BENCHMARK_MAX_POSITION) {
    return Math.max(
      BENCHMARK_FLOOR_CTR,
      BENCHMARK_CTR_BY_POSITION[BENCHMARK_MAX_POSITION]
        * Math.pow(BENCHMARK_DECAY, p - BENCHMARK_MAX_POSITION),
    );
  }

  const lo = Math.floor(p);
  const hi = lo + 1;
  const loCtr = BENCHMARK_CTR_BY_POSITION[lo];
  const hiCtr = BENCHMARK_CTR_BY_POSITION[hi];
  if (lo === p) return loCtr;
  return loCtr + (hiCtr - loCtr) * (p - lo);
}

/**
 * How many clicks a CTR fix could plausibly recover on one page.
 *
 * `ctr` is preferred when it is supplied and finite (GSC reports it directly and
 * its rounding is its own), and derived as clicks/impressions otherwise. A page
 * already at or above benchmark has a gap of 0 — never a negative, which would
 * otherwise let an over-performing page score below a page with no traffic at
 * all and read as "actively harmful".
 *
 * @param {{impressions?:number, clicks?:number, ctr?:number, position?:number}} row
 * @returns {{gapCtr:number, recoverable:number, benchmark:number, ctr:number}}
 */
export function recoverableClicks({ impressions, clicks, ctr, position } = {}) {
  const imps = Number(impressions);
  if (!Number.isFinite(imps) || imps <= 0) return { ...ZERO_RECOVERY };

  const explicit = Number(ctr);
  const clickCount = Number(clicks);
  let rate;
  if (Number.isFinite(explicit)) rate = explicit;
  else if (Number.isFinite(clickCount)) rate = clickCount / imps;
  else rate = 0;
  if (!Number.isFinite(rate) || rate < 0) rate = 0;

  const benchmark = benchmarkCtr(position);
  const gapCtr = Math.max(0, benchmark - rate);
  return {
    gapCtr,
    recoverable: imps * gapCtr * CAPTURE_FRACTION,
    benchmark,
    ctr: rate,
  };
}

/**
 * Where a cluster sits in a `lib/cluster-efficiency.js` ranking, or null when
 * the ranking cannot place it.
 *
 * `rankOf` is a Map in the live object and a plain object once anything has been
 * through JSON, so both are read; `ordered[]` is the last resort. Nothing here
 * re-derives an order — it only reads the one the efficiency ranking already
 * computed.
 */
function clusterOrdinal(cluster, ranking) {
  if (!cluster || !ranking || ranking.available === false) return null;

  const { rankOf } = ranking;
  if (rankOf && typeof rankOf.get === 'function') {
    const rank = rankOf.get(cluster);
    if (Number.isFinite(rank)) return rank;
  } else if (rankOf && Object.prototype.hasOwnProperty.call(rankOf, cluster)) {
    const rank = Number(rankOf[cluster]);
    if (Number.isFinite(rank)) return rank;
  }

  if (Array.isArray(ranking.ordered)) {
    const idx = ranking.ordered.findIndex((e) => e?.cluster === cluster);
    if (idx >= 0) {
      const rank = Number(ranking.ordered[idx].rank);
      return Number.isFinite(rank) ? rank : idx;
    }
  }
  return null;
}

/**
 * The multiplier a page inherits from its cluster's efficiency rank.
 *
 * MISSING DATA IS FULL WEIGHT, never a penalty: no ranking, an unavailable
 * ranking, a page with no cluster, or a cluster the ranking has never seen all
 * return 1.0. Demoting what we cannot place would quietly bury the legacy
 * corpus, most of which records no cluster — the same fail-safe reasoning the
 * hold applies to an absent measurement.
 */
export function clusterWeightFor(cluster, ranking) {
  const ordinal = clusterOrdinal(cluster, ranking);
  if (ordinal == null || ordinal <= 0) return 1;
  return Math.max(CLUSTER_WEIGHT_FLOOR, Math.pow(CLUSTER_WEIGHT_DECAY, ordinal));
}

/**
 * Score one page.
 *
 * @param {{url?:string, cluster?:string, impressions?:number, clicks?:number,
 *          ctr?:number, position?:number}} page
 * @param {{ranking?:object}} [opts]
 * @returns {object} the page's own fields plus `gapCtr`, `recoverable`,
 *   `benchmark`, `ctr`, `clusterWeight` and `score`.
 */
export function scoreOpportunity(page, { ranking = null } = {}) {
  const row = page && typeof page === 'object' ? page : {};
  const recovery = recoverableClicks(row);
  const clusterWeight = clusterWeightFor(row.cluster, ranking);
  return {
    ...row,
    ...recovery,
    clusterWeight,
    score: recovery.recoverable * clusterWeight,
  };
}

/**
 * Rank blog pages by revenue-weighted recoverable clicks.
 *
 * DEDUPE FIRST. One page reached through two queries is one page, and the
 * highest-impression row is kept because it is the fuller reading of the same
 * page — this is the concrete fix for query-level ranking letting the tattoo
 * flagship occupy two slots of a cap of five.
 *
 * Ties break by impressions descending then url ascending, so a run is
 * reproducible and a diff between two reports means something.
 *
 * The input array and its rows are never mutated.
 *
 * @param {Array} pages
 * @param {{ranking?:object, limit?:number}} [opts]
 * @returns {Array} scored rows, best first
 */
export function rankOpportunities(pages, { ranking = null, limit = null } = {}) {
  const list = Array.isArray(pages) ? pages : [];

  const byUrl = new Map();
  const unkeyed = [];
  for (const page of list) {
    const row = page && typeof page === 'object' ? page : {};
    const url = typeof row.url === 'string' && row.url ? row.url : null;
    if (!url) {
      unkeyed.push(row);
      continue;
    }
    const seen = byUrl.get(url);
    if (!seen || (Number(row.impressions) || 0) > (Number(seen.impressions) || 0)) {
      byUrl.set(url, row);
    }
  }

  const scored = [...byUrl.values(), ...unkeyed]
    .map((row) => scoreOpportunity(row, { ranking }));

  scored.sort((a, b) => b.score - a.score
    || (Number(b.impressions) || 0) - (Number(a.impressions) || 0)
    || String(a.url ?? '').localeCompare(String(b.url ?? '')));

  const cap = Number(limit);
  return Number.isFinite(cap) && cap > 0 ? scored.slice(0, cap) : scored;
}
