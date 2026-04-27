/**
 * Per-cluster competitor roll-up from the merged keyword-index entries.
 *
 * For each (cluster, competitor ASIN) pair:
 *   weighted_click_share = Σ (entry.amazon.purchases × competitor.click_share)
 *                       / Σ entry.amazon.purchases
 *   weighted_conversion_share is the same with conversion_share.
 *
 * Top N competitors per cluster are kept, sorted by weighted_click_share desc.
 */

const TOP_N_PER_CLUSTER = 10;

export function rollUpCompetitorsByCluster(entries, { topN = TOP_N_PER_CLUSTER } = {}) {
  // Per cluster:
  //   total_purchases (sum across cluster keywords with amazon)
  //   keyword_count (count of cluster keywords with amazon)
  //   per-asin: { numerator_click, numerator_conv, appears_in_keywords, brand }
  const clusterAcc = {};

  for (const entry of Object.values(entries)) {
    if (!entry.amazon) continue;
    const cluster = entry.cluster || 'unclustered';
    const purchases = entry.amazon.purchases ?? 0;
    if (!clusterAcc[cluster]) {
      clusterAcc[cluster] = { total_purchases: 0, keyword_count: 0, byAsin: {} };
    }
    clusterAcc[cluster].total_purchases += purchases;
    clusterAcc[cluster].keyword_count += 1;
    for (const c of entry.amazon.competitors || []) {
      if (!clusterAcc[cluster].byAsin[c.asin]) {
        clusterAcc[cluster].byAsin[c.asin] = {
          asin: c.asin,
          brand: c.brand || null,
          numerator_click: 0,
          numerator_conv: 0,
          appears_in_keywords: 0,
        };
      }
      const acc = clusterAcc[cluster].byAsin[c.asin];
      acc.numerator_click += purchases * (c.click_share ?? 0);
      acc.numerator_conv += purchases * (c.conversion_share ?? 0);
      acc.appears_in_keywords += 1;
    }
  }

  // Finalize: compute weighted shares, sort, top-N
  const out = {};
  for (const [cluster, agg] of Object.entries(clusterAcc)) {
    const denom = agg.total_purchases || 1; // avoid div0 — should not happen since we only count clusters with amazon
    const competitors = Object.values(agg.byAsin)
      .map((c) => ({
        asin: c.asin,
        brand: c.brand,
        weighted_click_share: c.numerator_click / denom,
        weighted_conversion_share: c.numerator_conv / denom,
        appears_in_keywords: c.appears_in_keywords,
      }))
      .sort((a, b) => b.weighted_click_share - a.weighted_click_share)
      .slice(0, topN);
    out[cluster] = {
      total_purchases: agg.total_purchases,
      keyword_count: agg.keyword_count,
      competitors,
    };
  }
  return out;
}
