// lib/cluster-performance.js
// Pure: turn per-post performance buckets (from legacy-triage) into per-cluster
// weight penalties, so the content-strategist deprioritizes clusters that keep
// producing flops. Closes the loop: performance verdicts feed topic weighting.

const FLOP_BUCKETS = new Set(['flop', 'broken']);

/**
 * @param {Array<{cluster:string, bucket:string}>} entries
 * @param {{minPosts?:number, flopRateForMaxPenalty?:number, maxPenalty?:number}} cfg
 * @returns {{ [cluster:string]: { flopRate:number, penalty:number, total:number } }}
 */
export function clusterPenalties(entries, cfg = {}) {
  const minPosts = cfg.minPosts ?? 3;
  const floor = cfg.flopRateForMaxPenalty ?? 0.5; // flopRate at/above this trends toward maxPenalty
  const maxPenalty = cfg.maxPenalty ?? 4;
  const agg = {};
  for (const e of (entries || [])) {
    if (!e || !e.cluster) continue;
    const a = (agg[e.cluster] ||= { total: 0, flops: 0 });
    a.total++;
    if (FLOP_BUCKETS.has(e.bucket)) a.flops++;
  }
  const out = {};
  for (const [cluster, a] of Object.entries(agg)) {
    if (a.total < minPosts) continue; // insufficient data
    const flopRate = a.flops / a.total;
    let penalty = 0;
    if (flopRate >= floor) {
      // scale linearly from 0 at `floor` to maxPenalty at flopRate=1
      penalty = Math.min(maxPenalty, Math.round(((flopRate - floor) / (1 - floor)) * maxPenalty * 100) / 100);
      // ensure a clearly-flopping cluster gets at least a small penalty
      if (penalty === 0) penalty = 1;
    }
    out[cluster] = { flopRate: Math.round(flopRate * 100) / 100, penalty, total: a.total };
  }
  return out;
}
