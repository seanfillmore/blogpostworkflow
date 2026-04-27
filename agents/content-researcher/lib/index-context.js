/**
 * Helpers used by the content-researcher to enrich briefs with keyword-index
 * signals. Pure — exported for tests.
 */

import { lookupByKeyword, entriesForCluster, loadCategoryCompetitors } from '../../../lib/keyword-index/consumer.js';
import { clusterForCollection } from '../../collection-content-optimizer/lib/cluster-mapper.js';

/**
 * Merge live DataForSEO related keywords with cluster-mate keyword strings,
 * dedupe case-insensitively while preserving order. Cap at maxLen.
 */
export function mergeRelatedKeywords(live, clusterMates, maxLen = 50) {
  const seen = new Set();
  const out = [];
  const push = (s) => {
    if (!s) return;
    const k = String(s).toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(s);
    return out.length >= maxLen;
  };
  for (const entry of live || []) {
    if (push(entry?.keyword ?? entry)) return out;
  }
  for (const m of clusterMates || []) {
    if (push(m?.keyword)) return out;
  }
  return out;
}

/**
 * Build the index context bundle for a keyword. Returns null when index is
 * missing OR when neither a direct entry nor a cluster heuristic matches.
 */
export function buildResearchIndexContext(idx, keyword, rootDir) {
  if (!idx) return null;
  const entry = lookupByKeyword(idx, keyword);
  let cluster = entry?.cluster && entry.cluster !== 'unclustered' ? entry.cluster : null;
  if (!cluster) {
    cluster = clusterForCollection({ handle: keyword, title: keyword }, idx);
  }
  if (!entry && !cluster) return null;
  const clusterMates = cluster ? entriesForCluster(idx, cluster, { limit: 8 }) : [];
  const competitors = (loadCategoryCompetitors(rootDir)[cluster] || []).slice(0, 5);
  return {
    validation_source: entry?.validation_source ?? null,
    cluster,
    amazon_purchases: entry?.amazon?.purchases ?? null,
    conversion_share: entry?.amazon?.conversion_share ?? null,
    cluster_mates: clusterMates,
    competitors,
  };
}
