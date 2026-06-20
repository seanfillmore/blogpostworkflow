/**
 * Merge the per-source maps into final keyword-index entries.
 *
 * Qualification:
 *   - amazon: has purchases > 0 OR clicks > 0
 *   - gsc_ga4 (only if no amazon signal): ga4.conversions > 0
 *   - else: drop (no qualifying signal)
 *
 * Cluster assignment: a real (non-'unclustered') cluster carried over from the
 * prior index wins (preserves manual/seed clustering); otherwise the cluster is
 * derived from the keyword text via assignCluster(). We deliberately do NOT copy
 * a prior 'unclustered' forward — doing so let a single bad build collapse every
 * future build to one cluster.
 */

import { normalize, slug as toSlug } from './normalize.js';
import { ga4ForUrl } from './ga4-aggregator.js';
import { assignCluster } from './cluster.js';

export function classifyValidationSource(entry) {
  const amz = entry.amazon;
  if (amz && ((amz.clicks ?? 0) > 0 || (amz.purchases ?? 0) > 0)) return 'amazon';
  const ga = entry.ga4;
  if (!amz && ga && (ga.conversions ?? 0) > 0) return 'gsc_ga4';
  return null;
}

export function mergeSources({ amazon, gsc, ga4Map, clusters }) {
  const allKeys = new Set([...Object.keys(amazon || {}), ...Object.keys(gsc || {})]);
  const out = {};
  for (const key of allKeys) {
    const amz = amazon?.[key] || null;
    const g = gsc?.[key] || null;
    const ga = g?.top_page ? ga4ForUrl(ga4Map, g.top_page) : null;
    const candidate = { amazon: amz, gsc: g, ga4: ga };
    const validation_source = classifyValidationSource(candidate);
    if (!validation_source) continue;

    const slug = toSlug(key);
    const keyword = amz?.query || key;
    const priorCluster = clusters?.[key];
    const cluster = (priorCluster && priorCluster !== 'unclustered')
      ? priorCluster
      : assignCluster(keyword);
    out[slug] = {
      keyword,
      slug,
      cluster,
      validation_source,
      amazon: amz,
      gsc: g,
      ga4: ga,
      market: null,
    };
  }
  return out;
}

/**
 * Build the cluster lookup map from a previously-built keyword-index.json.
 * Used by the orchestrator at start.
 */
export function loadClustersFromPriorIndex(priorIndex) {
  const out = {};
  if (!priorIndex?.keywords) return out;
  for (const entry of Object.values(priorIndex.keywords)) {
    if (entry?.keyword && entry?.cluster) {
      out[normalize(entry.keyword)] = entry.cluster;
    }
  }
  return out;
}
