#!/usr/bin/env node
/**
 * One-shot: crop + WebP-convert + upload the new founder landscape image,
 * then update the founder-block image setting across every theme template.
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import sharp from 'sharp';
import { uploadImageToShopifyCDN } from '../lib/shopify.js';

const SRC = '/Users/seanfillmore/Desktop/IMG_9908.jpg';
const OUT = '/tmp/founder-landscape.webp';
const FILENAME = 'founder-landscape.webp';
const ALT = 'California oak savanna — rolling pasture and distant mountains';
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
  // 1. Crop + resize + convert
  console.log(`Processing source ${SRC}...`);
  const info = await sharp(SRC)
    .extract({ left: 0, top: 100, width: 2400, height: 1450 }) // trim top branches
    .resize(1920, 1160, { fit: 'cover' })
    .webp({ quality: 85 })
    .toFile(OUT);
  console.log(`  -> ${OUT} (${info.width}x${info.height}, ${Math.round(info.size / 1024)}KB)`);

  // 2. Upload
  console.log('Uploading to Shopify Files...');
  const url = await uploadImageToShopifyCDN(OUT, ALT);
  console.log(`  -> ${url}`);

  // 3. Patch each template
  const ref = `shopify://shop_images/${FILENAME}`;
  console.log(`Patching ${TEMPLATE_FILES.length} templates with ${ref}...`);
  let patched = 0;
  for (const f of TEMPLATE_FILES) {
    const path = join(TEMPLATES_DIR, f);
    const raw = readFileSync(path, 'utf8');
    const start = raw.indexOf('{');
    const header = raw.slice(0, start);
    const json = JSON.parse(raw.slice(start));
    const fb = json.sections?.['founder-block'];
    if (!fb) {
      console.warn(`  ! ${f}: no founder-block section, skipping`);
      continue;
    }
    const before = fb.settings?.image;
    fb.settings.image = ref;
    writeFileSync(path, header + JSON.stringify(json, null, 2) + '\n');
    console.log(`  ${f}: ${before} -> ${ref}`);
    patched++;
  }
  console.log(`\nPatched ${patched}/${TEMPLATE_FILES.length} templates.`);
  console.log(`CDN URL: ${url}`);
}

main().catch(err => { console.error('FAILED:', err.message); process.exit(1); });
