/**
 * Consumer-side helpers for reading data/keyword-index.json.
 *
 * Used by the 9 optimizer agents (gsc-opportunity, meta-optimizer, etc.)
 * to look up keyword-level Amazon/GSC validation signals before deciding
 * what to optimize, write, or bid on. All functions are pure; loadIndex
 * caches the parsed file per process to avoid repeated disk reads.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { slug as toSlug } from './normalize.js';

let cached = null;
let cachedRoot = null;

export function loadIndex(rootDir) {
  if (!rootDir) throw new Error('loadIndex requires rootDir');
  if (cached !== null && cachedRoot === rootDir) return cached;
  const path = join(rootDir, 'data', 'keyword-index.json');
  if (!existsSync(path)) {
    cached = null;
    cachedRoot = rootDir;
    return null;
  }
  cached = JSON.parse(readFileSync(path, 'utf8'));
  cachedRoot = rootDir;
  return cached;
}

export function lookupByKeyword(index, keyword) {
  if (!index?.keywords || !keyword) return null;
  const direct = index.keywords[keyword];
  if (direct) return direct;
  const slugKey = toSlug(keyword);
  return index.keywords[slugKey] || null;
}

export function lookupByUrl(index, url) {
  if (!index?.keywords || !url) return null;
  for (const entry of Object.values(index.keywords)) {
    if (entry?.gsc?.top_page === url) return entry;
  }
  return null;
}

export function validationTag(entry) {
  if (!entry) return null;
  if (entry.validation_source === 'amazon') return 'amazon';
  if (entry.validation_source === 'gsc_ga4') return 'gsc_ga4';
  return null;
}

export function clusterMatesFor(index, entry, { limit = 6, excludeSelf = true } = {}) {
  if (!index?.keywords || !entry?.cluster || entry.cluster === 'unclustered') return [];
  const mates = [];
  for (const e of Object.values(index.keywords)) {
    if (!e || e.cluster !== entry.cluster) continue;
    if (excludeSelf && e.slug === entry.slug) continue;
    mates.push(e);
  }
  mates.sort((a, b) => {
    const ap = (a.amazon?.purchases ?? 0) - (b.amazon?.purchases ?? 0);
    if (ap !== 0) return -ap;
    const gi = (a.gsc?.impressions ?? 0) - (b.gsc?.impressions ?? 0);
    return -gi;
  });
  return mates.slice(0, limit);
}

export function entriesForCluster(index, cluster, { limit = 8 } = {}) {
  if (!index?.keywords || !cluster) return [];
  const out = [];
  for (const e of Object.values(index.keywords)) {
    if (e?.cluster === cluster) out.push(e);
  }
  out.sort((a, b) => {
    const ap = (a.amazon?.purchases ?? 0) - (b.amazon?.purchases ?? 0);
    if (ap !== 0) return -ap;
    const gi = (a.gsc?.impressions ?? 0) - (b.gsc?.impressions ?? 0);
    return -gi;
  });
  return out.slice(0, limit);
}

export function loadCategoryCompetitors(rootDir) {
  if (!rootDir) throw new Error('loadCategoryCompetitors requires rootDir');
  const path = join(rootDir, 'data', 'category-competitors.json');
  if (!existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return {}; }
}

/**
 * Build the optional grounding object passed to a Claude rewriter.
 * Returns null when there is no index entry (preserves the original
 * prompt byte-for-byte). When present, surfaces the validation tag,
 * the Amazon conversion share (when available), and up to N cluster-mate
 * keywords.
 *
 * Originally lived in agents/meta-optimizer/lib/grounding.js; moved here
 * so multiple consumers can use it without crossing agent boundaries.
 */
export function buildPromptGrounding(indexEntry, clusterMates) {
  if (!indexEntry) return null;
  return {
    validationTag: indexEntry.validation_source ?? null,
    conversionShare: indexEntry.amazon?.conversion_share ?? null,
    clusterMateKeywords: (clusterMates || []).map((m) => m.keyword).filter(Boolean),
  };
}

/**
 * Filter the index for entries that are NOT yet covered by the inventory
 * (existing briefs + posts) and rank them by validation strength so the
 * strategist gets a "what to write next" queue grounded in real demand.
 *
 * Inventory is a Set<string> of slugs.
 */
export function unmappedIndexEntries(index, inventory, { limit = 20 } = {}) {
  if (!index?.keywords) return [];
  const inv = inventory || new Set();
  const candidates = [];
  for (const e of Object.values(index.keywords)) {
    if (!e?.slug) continue;
    if (inv.has(e.slug)) continue;
    if (e.keyword) {
      const kwSlug = toSlug(e.keyword);
      if (inv.has(kwSlug)) continue;
    }
    candidates.push(e);
  }
  candidates.sort((a, b) => {
    const aBand = a.validation_source === 'amazon' ? 0 : a.validation_source === 'gsc_ga4' ? 1 : 2;
    const bBand = b.validation_source === 'amazon' ? 0 : b.validation_source === 'gsc_ga4' ? 1 : 2;
    if (aBand !== bBand) return aBand - bBand;
    if (aBand === 0) return (b.amazon?.purchases ?? 0) - (a.amazon?.purchases ?? 0);
    if (aBand === 1) return (b.ga4?.conversions ?? 0) - (a.ga4?.conversions ?? 0);
    return 0;
  });
  return candidates.slice(0, limit);
}

export function _resetCacheForTests() {
  cached = null;
  cachedRoot = null;
}
