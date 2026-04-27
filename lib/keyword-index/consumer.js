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

export function _resetCacheForTests() {
  cached = null;
  cachedRoot = null;
}
