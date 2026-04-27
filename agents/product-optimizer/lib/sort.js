/**
 * Re-rank product candidates using keyword-index signals.
 *
 * Bands (primary key):
 *   0 — Amazon-validated (idx.validationTag === 'amazon')
 *   1 — Cluster-only (mapped to a cluster but no Amazon validation)
 *   2 — No index signal
 *
 * Secondary key:
 *   - Within Amazon band: amazon purchases desc.
 *   - Everywhere else: gsc.impressions desc.
 *
 * Stable for ties.
 */
export function sortProductCandidates(candidates) {
  const band = (c) => {
    if (c.idx?.validationTag === 'amazon') return 0;
    if (c.idx?.cluster) return 1;
    return 2;
  };
  return [...candidates].sort((a, b) => {
    const db = band(a) - band(b);
    if (db !== 0) return db;
    if (band(a) === 0) {
      const ap = (b.idx?.amazonPurchases ?? 0) - (a.idx?.amazonPurchases ?? 0);
      if (ap !== 0) return ap;
    }
    return (b.gsc?.impressions ?? 0) - (a.gsc?.impressions ?? 0);
  });
}
