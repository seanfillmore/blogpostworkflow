#!/usr/bin/env node
/**
 * One-shot: process Sensitive Skin Set Lander images and upload to Shopify Files.
 *
 * - Reads source JPGs from realskincare-theme/assets/Lander Images/
 * - Resizes / converts each per the image manifest (WebP / JPG / PNG)
 * - Uploads via lib/shopify.js's uploadImageToShopifyCDN (staged + fileCreate + poll)
 * - Writes the resulting URL map to data/landers/lander-image-urls.json
 * - Patches templates/product.landing-page-sensitive-skin-set-lander.json with the URLs
 *
 * Usage: node scripts/upload-lander-images.js [--dry-run]
 *   --dry-run   processes images locally but skips upload + template patch
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, join } from 'path';
import sharp from 'sharp';
import { uploadImageToShopifyCDN } from '../lib/shopify.js';

const THEME_REPO       = '/Users/seanfillmore/Code/realskincare-theme';
const SRC_DIR          = join(THEME_REPO, 'assets', 'Lander Images');
const TEMPLATE_PATH    = join(THEME_REPO, 'templates', 'product.landing-page-sensitive-skin-set-lander.json');
const PROCESSED_DIR    = '/tmp/lander-processed';
const URL_MAP_OUT      = '/Users/seanfillmore/Code/Claude/data/landers/lander-image-urls.json';

const DRY_RUN = process.argv.includes('--dry-run');

// Map: source file -> processed filename, dimensions, format, alt, target setting path.
// `target` describes where to patch the URL into the JSON template:
//   { kind: 'jsonSet', sectionKey, settingKey }                   - top-level section setting
//   { kind: 'jsonSet', sectionKey, blockKey, settingKey }         - block setting
//   { kind: 'inlineImg', sectionKey, settingKey }                 - replace placeholder comment in custom_liquid
const SHOTS = [
  { src: '1. Hero desktop.jpg',                  out: 'hero-desktop.webp',           w: 2400, h: 1200, fmt: 'webp', alt: 'Pure Unscented Body Lotion bottle and Pure Unscented Body Cream jar on a sage-green surface in soft daylight', target: { kind: 'jsonSet', sectionKey: 'hero', settingKey: 'bg_image_desktop' } },
  { src: '2. Hero mobile.jpg',                   out: 'hero-mobile.webp',            w: 750,  h: 1000, fmt: 'webp', alt: 'Pure Unscented Body Lotion and Body Cream on a sage-green surface, soft daylight',                          target: { kind: 'jsonSet', sectionKey: 'hero', settingKey: 'bg_image_mobile' } },
  { src: '3. Why It Works — lotion alone.jpg',   out: 'why-1-lotion.webp',           w: 800,  h: 800,  fmt: 'webp', alt: 'Pure Unscented Body Lotion bottle',                                                                          target: { kind: 'jsonSet', sectionKey: 'why-it-works', settingKey: 'image_1' } },
  { src: '4. Why It Works — cream alone.jpg',    out: 'why-2-cream.webp',            w: 800,  h: 800,  fmt: 'webp', alt: 'Pure Unscented Body Cream jar',                                                                              target: { kind: 'jsonSet', sectionKey: 'why-it-works', settingKey: 'image_2' } },
  { src: '5. Why It Works — set together .jpg',  out: 'why-3-set.webp',              w: 800,  h: 800,  fmt: 'webp', alt: 'Sensitive Skin Set components together',                                                                    target: { kind: 'jsonSet', sectionKey: 'why-it-works', settingKey: 'image_3' } },
  { src: '6. Stats hero — hand applying.jpg',    out: 'stats-hand-applying.webp',    w: 1600, h: 1600, fmt: 'webp', alt: 'Hand applying Pure Unscented Body Lotion to a forearm in soft daylight',                                    target: { kind: 'inlineImg', sectionKey: 'stats-hero', settingKey: 'custom_liquid' } },
  { src: '7. UGC-1 — Morgan K..jpg',             out: 'ugc-1-bathroom-counter.jpg',  w: 800,  h: 800,  fmt: 'jpg',  alt: 'Customer photo of Pure Unscented Body Lotion on a bathroom counter',                                        target: { kind: 'jsonSet', sectionKey: 'ugc-photos', blockKey: 'ugc-1', settingKey: 'image' } },
  { src: '8. UGC-2 — Casey R..jpg',              out: 'ugc-2-cream-in-hand.jpg',     w: 800,  h: 800,  fmt: 'jpg',  alt: 'Customer photo of Pure Unscented Body Cream jar in hand',                                                   target: { kind: 'jsonSet', sectionKey: 'ugc-photos', blockKey: 'ugc-2', settingKey: 'image' } },
  { src: '9. UGC-3 — Jordan T..jpg',             out: 'ugc-3-nightstand-tray.jpg',   w: 800,  h: 800,  fmt: 'jpg',  alt: 'Customer photo of Pure Unscented Body Lotion and Cream on a wooden tray',                                   target: { kind: 'jsonSet', sectionKey: 'ugc-photos', blockKey: 'ugc-3', settingKey: 'image' } },
  { src: '10. UGC-4 — Alex M..jpg',              out: 'ugc-4-unboxing.jpg',          w: 800,  h: 800,  fmt: 'jpg',  alt: 'Customer photo of the Sensitive Skin Set with free Pure Unscented Lip Balm and Bar Soap',                   target: { kind: 'jsonSet', sectionKey: 'ugc-photos', blockKey: 'ugc-4', settingKey: 'image' } },
  { src: '11. Compare-table thumbnail.jpg',      out: 'compare-thumb.png',           w: 512,  h: 512,  fmt: 'png',  alt: 'Sensitive Skin Set',                                                                                         target: { kind: 'jsonSet', sectionKey: 'compare-table', settingKey: 'us_image' } },
  { src: "12. Don't Fumble CTA — bathroom shelf.jpg", out: 'dont-fumble-shelf.webp', w: 1600, h: 1600, fmt: 'webp', alt: 'A bathroom shelf cleared of half-empty lotion bottles, with the Sensitive Skin Set in their place',         target: { kind: 'jsonSet', sectionKey: 'dont-fumble-cta', settingKey: 'image' } },
];

async function processOne(shot) {
  const srcPath = join(SRC_DIR, shot.src);
  if (!existsSync(srcPath)) throw new Error(`Source not found: ${srcPath}`);
  const outPath = join(PROCESSED_DIR, shot.out);
  let pipeline = sharp(srcPath).resize(shot.w, shot.h, { fit: 'cover', position: 'attention' });
  if (shot.fmt === 'webp') pipeline = pipeline.webp({ quality: 85 });
  else if (shot.fmt === 'jpg') pipeline = pipeline.jpeg({ quality: 85, mozjpeg: true });
  else if (shot.fmt === 'png') pipeline = pipeline.png({ compressionLevel: 9 });
  const info = await pipeline.toFile(outPath);
  return { outPath, sizeKB: Math.round(info.size / 1024), w: info.width, h: info.height };
}

function patchTemplate(template, shot, url) {
  if (shot.target.kind === 'jsonSet') {
    const section = template.sections[shot.target.sectionKey];
    if (!section) throw new Error(`Section not found: ${shot.target.sectionKey}`);
    const settingsHost = shot.target.blockKey
      ? section.blocks[shot.target.blockKey]?.settings
      : section.settings;
    if (!settingsHost) throw new Error(`Settings host not found for ${shot.target.sectionKey}.${shot.target.blockKey || ''}`);
    settingsHost[shot.target.settingKey] = url;
  } else if (shot.target.kind === 'inlineImg') {
    const section = template.sections[shot.target.sectionKey];
    if (!section) throw new Error(`Section not found: ${shot.target.sectionKey}`);
    const placeholder = '<!-- Image goes here once Task 6 manifest fills it. Drop in: <img src=\\"...\\" alt=\\"Hand applying Pure Unscented Body Lotion\\"> -->';
    const tag = `<img src="${url}" alt="${shot.alt.replace(/"/g, '&quot;')}" loading="lazy" style="width:100%;height:100%;object-fit:cover;">`;
    const before = section.settings[shot.target.settingKey];
    if (!before.includes(placeholder)) throw new Error(`Inline placeholder not found in ${shot.target.sectionKey}.${shot.target.settingKey}`);
    section.settings[shot.target.settingKey] = before.replace(placeholder, tag);
  }
}

function readTemplate() {
  const raw = readFileSync(TEMPLATE_PATH, 'utf8');
  // Strip the auto-generated /* ... */ header before parsing
  const jsonStart = raw.indexOf('{');
  if (jsonStart < 0) throw new Error('Could not find { in template');
  const header = raw.slice(0, jsonStart);
  const body   = raw.slice(jsonStart);
  return { header, json: JSON.parse(body) };
}

function writeTemplate(header, json) {
  writeFileSync(TEMPLATE_PATH, header + JSON.stringify(json, null, 2) + '\n');
}

async function main() {
  if (!existsSync(PROCESSED_DIR)) mkdirSync(PROCESSED_DIR, { recursive: true });

  console.log(`\n=== Sensitive Skin Set lander image upload ===`);
  console.log(`Source: ${SRC_DIR}`);
  console.log(`Mode: ${DRY_RUN ? 'DRY-RUN (no upload, no patch)' : 'LIVE'}\n`);

  const results = [];
  for (const shot of SHOTS) {
    process.stdout.write(`[${shot.out.padEnd(32)}] resize ${shot.w}x${shot.h} ${shot.fmt}... `);
    const proc = await processOne(shot);
    process.stdout.write(`${proc.sizeKB}KB. `);

    if (DRY_RUN) {
      console.log('(skip upload)');
      results.push({ ...shot, ...proc, url: null });
      continue;
    }

    process.stdout.write('uploading... ');
    const url = await uploadImageToShopifyCDN(proc.outPath, shot.alt);
    console.log('OK');
    results.push({ ...shot, ...proc, url });
  }

  if (!DRY_RUN) {
    // Persist URL map
    const urlMap = Object.fromEntries(results.map(r => [r.out, { url: r.url, alt: r.alt, target: r.target }]));
    writeFileSync(URL_MAP_OUT, JSON.stringify(urlMap, null, 2) + '\n');
    console.log(`\nURL map -> ${URL_MAP_OUT}`);

    // Patch the template
    const { header, json } = readTemplate();
    for (const r of results) patchTemplate(json, r, r.url);
    writeTemplate(header, json);
    console.log(`Template patched: ${TEMPLATE_PATH}`);
  }

  console.log(`\nDone: ${results.length} images`);
}

main().catch(err => { console.error('FAILED:', err.message); process.exit(1); });
