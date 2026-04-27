/**
 * Pure helpers used by gsc-query-miner to plug keyword-index data into
 * its analysis. Exported for tests.
 */

import { lookupByKeyword, validationTag } from '../../../lib/keyword-index/consumer.js';

/**
 * Add `validation_source` to every query in `queries`. Uses the keyword
 * field as the lookup key (case-insensitive via consumer.lookupByKeyword's
 * slug normalization). Returns a new array.
 */
export function tagQueries(queries, index) {
  return (queries || []).map((q) => ({
    ...q,
    validation_source: validationTag(lookupByKeyword(index, q?.keyword)),
  }));
}

/**
 * Derive the untapped-candidates set:
 *   - High-impression leaks (impressions ≥ minImpr × 2, clicks = 0) NOT already
 *     in the index.
 *   - Topic clusters with aggregate impressions > minClusterImpr and where the
 *     dominant query has position > 30.
 *
 * Returns an array of { keyword, impressions, position, reason } objects.
 * Dedupes by keyword string (case-insensitive).
 */
export function buildUntappedCandidates(leaks, clusters, index, { minImpr = 50, minClusterImpr = 200 } = {}) {
  const seen = new Set();
  const out = [];

  const inIndex = (kw) => {
    if (!kw) return false;
    return Boolean(lookupByKeyword(index, kw));
  };

  for (const q of leaks || []) {
    if (!q?.keyword) continue;
    if (q.clicks > 0) continue;
    if ((q.impressions ?? 0) < minImpr * 2) continue;
    if (inIndex(q.keyword)) continue;
    const k = q.keyword.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({
      keyword: q.keyword,
      impressions: q.impressions ?? 0,
      position: q.position ?? null,
      reason: 'impression_leak',
    });
  }

  for (const c of clusters || []) {
    if (!c?.keywords?.length) continue;
    const totalImpr = c.keywords.reduce((s, q) => s + (q.impressions ?? 0), 0);
    if (totalImpr < minClusterImpr) continue;
    const top = c.keywords[0];
    if (!top?.keyword) continue;
    if ((top.position ?? 0) <= 30) continue;
    if (inIndex(top.keyword)) continue;
    const k = top.keyword.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({
      keyword: top.keyword,
      impressions: totalImpr,
      position: top.position ?? null,
      reason: 'untapped_cluster',
    });
  }

  return out;
}
