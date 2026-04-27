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

export function _resetCacheForTests() {
  cached = null;
  cachedRoot = null;
}
