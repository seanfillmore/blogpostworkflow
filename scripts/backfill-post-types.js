#!/usr/bin/env node
/**
 * Backfill the `post_type` field on every existing post.
 *
 * `post_type` is either `'product'` (post maps to a SKU we sell) or
 * `'topical_authority'` (off-product content — DIY tutorials, ingredient
 * education, generic explainers). Used by the editor to skip its
 * INGREDIENT ACCURACY check on topical posts (where comparing against a
 * product spec produces meaningless false-positive blockers) and by the
 * dashboard to filter blocker views by commercial intent.
 *
 * Idempotent — re-running is safe. Reports the breakdown at the end so
 * you can see how the catalog splits.
 *
 * Usage:
 *   node scripts/backfill-post-types.js              # apply
 *   node scripts/backfill-post-types.js --dry-run    # report only
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { POSTS_DIR, classifyPostType, classifyPostProduct } from '../lib/posts.js';

const dryRun = process.argv.includes('--dry-run');

let updated = 0, unchanged = 0, noMeta = 0;
const productCounts = {};
const topicalSamples = [];

for (const slug of readdirSync(POSTS_DIR)) {
  const metaPath = join(POSTS_DIR, slug, 'meta.json');
  if (!existsSync(metaPath)) { noMeta++; continue; }

  let meta;
  try { meta = JSON.parse(readFileSync(metaPath, 'utf8')); } catch { continue; }

  const newType = classifyPostType(meta.target_keyword, slug);
  const product = classifyPostProduct(meta.target_keyword, slug);
  productCounts[product || 'topical_authority'] = (productCounts[product || 'topical_authority'] || 0) + 1;

  if (newType === 'topical_authority' && topicalSamples.length < 10) {
    topicalSamples.push({ slug, title: meta.title, keyword: meta.target_keyword });
  }

  if (meta.post_type === newType) { unchanged++; continue; }

  if (!dryRun) {
    meta.post_type = newType;
    writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  }
  updated++;
}

console.log(`Posts scanned:        ${updated + unchanged + noMeta}`);
console.log(`Already had post_type: ${unchanged}`);
console.log(`${dryRun ? 'Would update' : 'Updated'}:   ${updated}`);
if (noMeta) console.log(`Skipped (no meta):    ${noMeta}`);
console.log();
console.log('Breakdown by classification:');
const sorted = Object.entries(productCounts).sort((a, b) => b[1] - a[1]);
for (const [k, v] of sorted) console.log(`  ${v.toString().padStart(3)} × ${k}`);
console.log();
console.log('Sample topical-authority posts (first 10):');
for (const s of topicalSamples) {
  console.log(`  ${s.slug}`);
  console.log(`    title:   ${s.title || '(empty)'}`);
  console.log(`    keyword: ${s.keyword || '(empty)'}`);
}
