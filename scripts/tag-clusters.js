#!/usr/bin/env node
/**
 * Backfill a cluster tag onto every post's meta.json so the content-strategist
 * can roll posts up correctly even when slug/title don't reveal the cluster.
 *
 * The cluster set mirrors KNOWN_CLUSTERS in agents/content-strategist/index.js.
 * Posts that fit a single product line (deodorant, toothpaste, lotion, soap,
 * lip balm, coconut oil, shampoo, conditioner, sunscreen, hair care) get that
 * cluster; topical-authority content that doesn't map to a SKU gets `skincare`.
 *
 * Idempotent — leaves existing cluster tags alone.
 *
 * Usage:
 *   node scripts/tag-clusters.js --dry-run
 *   node scripts/tag-clusters.js --apply
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listAllSlugs, getMetaPath } from '../lib/posts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const apply = process.argv.includes('--apply');

const CLUSTERS = [
  'deodorant', 'toothpaste', 'lotion', 'soap', 'lip balm', 'coconut oil',
  'shampoo', 'conditioner', 'sunscreen', 'hair care', 'skincare',
];

// Slugs whose surface text doesn't reveal the cluster — antiperspirant maps
// to deodorant, brand-alternatives map to the brand's product line, etc.
const MANUAL_OVERRIDES = {
  'aluminum-free-antiperspirant': 'deodorant',
  'aluminum-free-antiperspirant-what-it-is-does-it-work': 'deodorant',
  'best-boka-alternatives-2025': 'toothpaste',
  'best-dr-bronners-alternatives-2025': 'soap',
  'best-hair-mask-for-dry-hair': 'hair care',
  'best-hair-mask-for-dry-hair-diy-natural-options': 'hair care',
  'best-risewell-alternatives-2025': 'toothpaste',
  'best-tom-s-of-maine-alternatives-2025': 'toothpaste',
  'definitive-guide-to-clean-skin-care-products': 'skincare',
  'discover-the-best-organic-skincare-products-for-2024-at-real-skin-care': 'skincare',
  'dry-brushing-skin-benefits-technique-guide': 'skincare',
  'dry-brushing-skin-benefits-technique-what-to-expect': 'skincare',
  'embrace-natural-beauty-with-real-skin-cares-organic-products': 'skincare',
  'how-to-choose-the-right-body-cream': 'lotion',
  'how-to-do-a-skin-care-patch-test': 'skincare',
  'how-to-dry-brush': 'skincare',
  'how-to-dry-brush-your-body-step-by-step-guide': 'skincare',
  'how-to-remove-sweat-stains': 'deodorant',
  'how-to-remove-sweat-stains-the-complete-guide': 'deodorant',
  'incorporating-vanilla-skin-care-into-your-beauty-regimen': 'skincare',
  'itchy-armpits-causes-and-how-to-stop-them': 'deodorant',
  'sugar-scrub-recipe': 'skincare',
  'the-best-homemade-sugar-scrub-recipe-easy-natural': 'skincare',
  'the-ultimate-guide-to-moisturizing-your-skin': 'lotion',
  'what-is-natural-skincare-benefits-myths-how-to-start': 'skincare',
  'why-choose-coconut-skin-care-products': 'coconut oil',
  'why-use-unscented-skincare-products': 'skincare',
};

// Cluster priority — must match the iteration order of KNOWN_CLUSTERS in
// agents/content-strategist/index.js#clusterFor so the tag a post receives
// matches the cluster the strategist will count it under. Order matters:
// a post about "coconut oil body lotion" hits 'lotion' before 'coconut oil'.
const PRIORITY = [
  'deodorant', 'toothpaste', 'lotion', 'soap', 'lip balm',
  'coconut oil', 'shampoo', 'conditioner', 'sunscreen',
  'hair care', 'skincare',
];

function determineCluster(slug, meta) {
  if (MANUAL_OVERRIDES[slug]) return MANUAL_OVERRIDES[slug];

  const tags = (meta.tags || []).map((t) => t.toLowerCase());
  const surface = [slug, meta.title || '', meta.target_keyword || ''].join(' ').toLowerCase();

  // Tag-based match (highest signal — explicit categorization).
  for (const c of PRIORITY) {
    if (tags.some((t) => t.includes(c))) return c;
  }

  // Surface-based match for slug/title/keyword. Hair-mask / shampoo / conditioner
  // all roll up into 'hair care' since RSC treats them as one product line.
  if (/\b(hair[\s-]mask|shampoo|conditioner)\b/.test(surface)) return 'hair care';
  for (const c of PRIORITY) {
    if (surface.includes(c) || surface.includes(c.replace(' ', '-'))) return c;
  }

  // Default for general topical-authority posts (skincare guides, scrubs, dry brushing).
  return 'skincare';
}

const summary = {};
let alreadyTagged = 0;
let tagged = 0;
const samples = [];

for (const slug of listAllSlugs()) {
  const metaPath = getMetaPath(slug);
  let meta;
  try { meta = JSON.parse(readFileSync(metaPath, 'utf8')); } catch { continue; }

  const cluster = determineCluster(slug, meta);
  summary[cluster] = (summary[cluster] || 0) + 1;

  const existingTags = meta.tags || [];
  const existingTagsLower = existingTags.map((t) => t.toLowerCase());
  if (existingTagsLower.includes(cluster)) { alreadyTagged++; continue; }

  if (samples.length < 15) samples.push({ slug, cluster });
  tagged++;

  if (apply) {
    meta.tags = [cluster, ...existingTags];
    writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  }
}

console.log(`Mode:           ${apply ? 'APPLY' : 'DRY-RUN'}`);
console.log(`Already tagged: ${alreadyTagged}`);
console.log(`Newly tagged:   ${tagged}`);
console.log('');
console.log('Cluster distribution:');
for (const [name, count] of Object.entries(summary).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${name.padEnd(14)} ${count}`);
}
console.log('');
console.log('Sample (first 15 newly tagged):');
for (const s of samples) console.log(`  ${s.slug.padEnd(70)} → ${s.cluster}`);
