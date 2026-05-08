#!/usr/bin/env node
/**
 * One-shot: process + upload the founder image, then update the founder-block
 * image setting across every theme template that has one.
 *
 * Configurable via env vars:
 *   FOUNDER_SRC      absolute path to source image (default: latest still-life)
 *   FOUNDER_OUT      absolute path for processed output (default: /tmp/...)
 *   FOUNDER_FILENAME final filename uploaded to Shopify Files
 *   FOUNDER_ALT      alt text for the upload
 *
 * To run with the previous landscape source, set the env vars to override.
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import sharp from 'sharp';
import { uploadImageToShopifyCDN } from '../lib/shopify.js';

const SRC      = process.env.FOUNDER_SRC      || '/Users/seanfillmore/Desktop/v29.jpg';
const OUT      = process.env.FOUNDER_OUT      || '/tmp/founder-ingredient-stilllife.webp';
const FILENAME = process.env.FOUNDER_FILENAME || 'founder-ingredient-stilllife.webp';
const ALT      = process.env.FOUNDER_ALT      || 'Cold-pressed coconut oil, raw beeswax, jojoba seeds, and fresh coconut on a wooden workshop table — RSC ingredient still life';

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
  console.log(`Processing ${SRC}...`);
  const info = await sharp(SRC)
    .resize(1920, 1280, { fit: 'cover', position: 'center' })
    .webp({ quality: 85 })
    .toFile(OUT);
  console.log(`  -> ${OUT} (${info.width}x${info.height}, ${Math.round(info.size / 1024)}KB)`);

  console.log('Uploading to Shopify Files...');
  const url = await uploadImageToShopifyCDN(OUT, ALT);
  console.log(`  -> ${url}`);

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
