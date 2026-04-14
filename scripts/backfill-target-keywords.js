#!/usr/bin/env node
/**
 * Backfill target_keyword on posts where it's empty.
 *
 * Pre-fix, sync-legacy-posts.js wrote target_keyword: '' for every legacy
 * post imported from Shopify. Empty strings broke product-spec
 * classification in the editor (the kw.includes('toothpaste') checks all
 * fail on '', falling through to a union-of-everything spec that produces
 * false-positive INGREDIENT ACCURACY blockers).
 *
 * Mirrors the keyword derivation in scripts/sync-legacy-posts.js so future
 * syncs and historical posts share the same logic:
 *   1. First clause of the title (before the first : – — , or |)
 *   2. Slug with hyphens as spaces, when title is unusable
 *
 * Idempotent — leaves non-empty target_keywords alone.
 *
 * Usage:
 *   node scripts/backfill-target-keywords.js            # apply
 *   node scripts/backfill-target-keywords.js --dry-run  # report only
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { POSTS_DIR } from '../lib/posts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dryRun = process.argv.includes('--dry-run');

function deriveKeyword(title, slug) {
  const titleHead = (title || '').split(/[:–—,|]/)[0].trim();
  const slugAsKeyword = slug.replace(/-/g, ' ');
  return titleHead || slugAsKeyword;
}

let updated = 0, alreadySet = 0, noMeta = 0;
const samples = [];

for (const slug of readdirSync(POSTS_DIR)) {
  const metaPath = join(POSTS_DIR, slug, 'meta.json');
  if (!existsSync(metaPath)) { noMeta++; continue; }

  let meta;
  try { meta = JSON.parse(readFileSync(metaPath, 'utf8')); } catch { continue; }
  if ((meta.target_keyword || '').trim()) { alreadySet++; continue; }

  const newKeyword = deriveKeyword(meta.title, slug);
  if (samples.length < 10) samples.push({ slug, title: meta.title, target_keyword: newKeyword });

  if (!dryRun) {
    meta.target_keyword = newKeyword;
    writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  }
  updated++;
}

console.log(`Posts scanned:        ${updated + alreadySet + noMeta}`);
console.log(`Already had keyword:  ${alreadySet}`);
console.log(`Backfilled:           ${updated}${dryRun ? ' (dry-run, nothing written)' : ''}`);
if (noMeta) console.log(`Skipped (no meta):    ${noMeta}`);
console.log();
console.log('Sample (first 10):');
for (const s of samples) {
  console.log(`  ${s.slug}`);
  console.log(`    title:          ${s.title || '(empty)'}`);
  console.log(`    target_keyword: ${s.target_keyword}`);
}
