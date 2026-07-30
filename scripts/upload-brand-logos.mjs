#!/usr/bin/env node
/**
 * Upload the brand logo PNGs to the Shopify CDN and record their URLs in
 * data/brand/brand-kit.json.
 *
 *   node scripts/upload-brand-logos.mjs            # upload anything not already recorded
 *   node scripts/upload-brand-logos.mjs --force    # re-upload everything
 *   node scripts/upload-brand-logos.mjs --dry-run  # list what would upload
 *
 * WHY PNG ONLY: these URLs exist so Klaviyo templates can reference the logo, and
 * email clients do not render SVG — Gmail strips it and Outlook ignores it. The SVGs
 * stay in the repo for web and print, where they belong. Uploading them here would
 * also mislabel their MIME type, since uploadImageToShopifyCDN maps any non-png/webp
 * extension to image/jpeg.
 *
 * Idempotent: a file already carrying a cdn_url in brand-kit.json is skipped unless
 * --force. Shopify does not de-duplicate uploads, so re-running without that guard
 * would litter the Files library with copies.
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { uploadImageToShopifyCDN } from '../lib/shopify.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOGO_DIR = join(ROOT, 'data/brand/logo');
const KIT = join(ROOT, 'data/brand/brand-kit.json');

const args = new Set(process.argv.slice(2));
const force = args.has('--force');
const dryRun = args.has('--dry-run');

const kit = JSON.parse(readFileSync(KIT, 'utf8'));
kit.logo.cdn_urls ??= {};

const pngs = readdirSync(LOGO_DIR).filter((f) => f.endsWith('.png')).sort();
const todo = pngs.filter((f) => force || !kit.logo.cdn_urls[f]);

console.log(`${pngs.length} PNGs, ${todo.length} to upload${force ? ' (--force)' : ''}`);
if (dryRun) {
  for (const f of todo) console.log(`  would upload ${f}`);
  process.exit(0);
}

/** Alt text a screen reader would actually want, not the filename. */
function altFor(name) {
  const colour = name.match(/(black|white|sand|green|grey)/i)?.[1] ?? '';
  const mark = name.startsWith('monogram') ? 'monogram' : 'logo';
  return `Real Skin Care ${mark}${colour ? ` — ${colour}` : ''}`;
}

let ok = 0;
let failed = 0;
for (const name of todo) {
  try {
    const url = await uploadImageToShopifyCDN(join(LOGO_DIR, name), altFor(name));
    kit.logo.cdn_urls[name] = url;
    console.log(`  ✓ ${name}`);
    console.log(`    ${url}`);
    ok++;
  } catch (err) {
    console.error(`  ✗ ${name}: ${err.message}`);
    failed++;
  }
}

// Write after every attempt rather than at the end, so a mid-run failure does not
// throw away the URLs of everything that already succeeded.
kit.logo.cdn_hosted = ok > 0 || Object.keys(kit.logo.cdn_urls).length > 0;
writeFileSync(KIT, `${JSON.stringify(kit, null, 2)}\n`);

console.log(`\n${ok} uploaded, ${failed} failed. URLs recorded in data/brand/brand-kit.json`);
if (failed) process.exit(1);
