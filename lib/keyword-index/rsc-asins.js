/**
 * RSC ASIN list extraction from Amazon listings dumps.
 *
 * `scripts/amazon/explore-listings.mjs` writes
 *   data/amazon-explore/<date>-listings-<env>.json
 * with shape `{ sellerId, marketplaceId, items: [{sku, summaries: [{asin, itemName, ...}], attributes: {...}}, ...] }`.
 *
 * This module reads the latest such dump, classifies each item via
 * asin-classifier (RSC vs Culina), and returns the RSC ASINs only.
 * Used by the keyword-index-builder orchestrator's Stage 1 (Amazon ingest).
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isRsc } from './asin-classifier.js';

const EXPLORE_DIR_REL = 'data/amazon-explore';

export function findLatestListingsDump(rootDir = process.cwd()) {
  const dir = join(rootDir, EXPLORE_DIR_REL);
  if (!existsSync(dir)) return null;
  const candidates = readdirSync(dir)
    .filter((f) => /-listings-.*\.json$/.test(f))
    .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return candidates[0] ? join(dir, candidates[0].f) : null;
}

export function listRscAsinsFromDump(filePath) {
  if (!filePath || !existsSync(filePath)) return [];
  let dump;
  try { dump = JSON.parse(readFileSync(filePath, 'utf8')); } catch { return []; }
  const products = (dump.items || [])
    .map((item) => {
      const summary = item.summaries?.[0] || {};
      return { asin: summary.asin, title: summary.itemName || '' };
    })
    .filter((p) => p.asin);
  return products.filter((p) => isRsc(p)).map((p) => p.asin);
}
