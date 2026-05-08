#!/usr/bin/env node
/**
 * One-shot fix: the still-life image was placed in the founder-block by
 * mistake — it actually belongs in the free-from-block ("What's NOT in the jar").
 *
 * - Re-uploads the processed still-life as free-from-ingredients.webp
 *   (cleaner filename matching its actual role)
 * - Reverts founder-block.image -> shopify://shop_images/founder-landscape.webp
 * - Sets free-from-block.image -> shopify://shop_images/free-from-ingredients.webp
 *
 * Note: founder-ingredient-stilllife.webp will become an orphan on Shopify Files
 * — delete via Settings > Files manually.
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { uploadImageToShopifyCDN } from '../lib/shopify.js';

const PROCESSED = '/tmp/founder-ingredient-stilllife.webp';
const NEW_FILENAME = 'free-from-ingredients.webp';
const NEW_ALT = 'Cold-pressed coconut oil, raw beeswax, jojoba seeds, and fresh coconut on a wooden workshop table — what RSC formulas are made from';

const FOUNDER_REF = 'shopify://shop_images/founder-landscape.webp';
const FREEFROM_REF = `shopify://shop_images/${NEW_FILENAME}`;

const TEMPLATES_DIR = '/Users/seanfillmore/Code/realskincare-theme/templates';
const TEMPLATE_FILES = [
  'product.landing-page-deodorant.json',
  'product.landing-page-bar-soap.json',
  'product.landing-page-cream.json',
  'product.landing-page-sensitive-skin-set-lander.json',
  'product.landing-page-liquid-soap.json',
  'product.landing-page-sensitive-skin-set.json',
  'product.landing-page-lotion.json',
  'product.landing-page-toothpaste.json',
  'product.landing-page-lip-balm.json',
];

async function main() {
  // 1. Re-upload as the cleaner filename
  console.log(`Uploading ${PROCESSED} as ${NEW_FILENAME}...`);
  // We need to upload with the desired filename. uploadImageToShopifyCDN reads
  // basename(imagePath), so copy/rename the file first.
  const { copyFileSync } = await import('fs');
  const renamedPath = `/tmp/${NEW_FILENAME}`;
  copyFileSync(PROCESSED, renamedPath);
  const url = await uploadImageToShopifyCDN(renamedPath, NEW_ALT);
  console.log(`  -> ${url}`);

  // 2. Patch all 9 templates: revert founder, set free-from
  console.log(`\nPatching ${TEMPLATE_FILES.length} templates...`);
  for (const f of TEMPLATE_FILES) {
    const path = join(TEMPLATES_DIR, f);
    const raw = readFileSync(path, 'utf8');
    const start = raw.indexOf('{');
    const header = raw.slice(0, start);
    const json = JSON.parse(raw.slice(start));

    const fb = json.sections?.['founder-block'];
    const ff = json.sections?.['free-from-block'];

    if (fb?.settings) {
      const before = fb.settings.image;
      fb.settings.image = FOUNDER_REF;
      console.log(`  ${f}: founder ${before} -> ${FOUNDER_REF}`);
    }
    if (ff?.settings) {
      const before = ff.settings.image;
      ff.settings.image = FREEFROM_REF;
      console.log(`  ${f}: free-from ${before} -> ${FREEFROM_REF}`);
    }
    writeFileSync(path, header + JSON.stringify(json, null, 2) + '\n');
  }
  console.log(`\nDone. Orphan to delete from Shopify Files: founder-ingredient-stilllife.webp`);
}

main().catch(err => { console.error('FAILED:', err.message); process.exit(1); });
