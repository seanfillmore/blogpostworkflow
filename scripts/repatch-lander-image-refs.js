#!/usr/bin/env node
/**
 * Re-patch the lander template's image_picker settings to use
 * `shopify://shop_images/<filename>` references instead of full CDN URLs.
 *
 * Why: image_picker settings in Shopify section JSON are object references,
 * not URL strings. Storing a raw https:// URL produces "Setting does not
 * point to an applicable resource" on theme push.
 *
 * Reads data/landers/lander-image-urls.json (written by upload-lander-images.js)
 * and rewrites each jsonSet target's value. The inline <img> in stats-hero's
 * custom_liquid is left as a full CDN URL — that's HTML, not a picker.
 */

import { readFileSync, writeFileSync } from 'fs';

const TEMPLATE_PATH = '/Users/seanfillmore/Code/realskincare-theme/templates/product.landing-page-sensitive-skin-set-lander.json';
const URL_MAP_PATH  = '/Users/seanfillmore/Code/Claude/data/landers/lander-image-urls.json';

const urlMap = JSON.parse(readFileSync(URL_MAP_PATH, 'utf8'));
const raw = readFileSync(TEMPLATE_PATH, 'utf8');
const jsonStart = raw.indexOf('{');
const header = raw.slice(0, jsonStart);
const json = JSON.parse(raw.slice(jsonStart));

let patched = 0;
for (const [filename, entry] of Object.entries(urlMap)) {
  const t = entry.target;
  if (t.kind !== 'jsonSet') continue;
  const section = json.sections[t.sectionKey];
  if (!section) throw new Error(`Section not found: ${t.sectionKey}`);
  const host = t.blockKey ? section.blocks[t.blockKey]?.settings : section.settings;
  if (!host) throw new Error(`Settings host missing: ${t.sectionKey}.${t.blockKey || ''}`);
  const ref = `shopify://shop_images/${filename}`;
  console.log(`${t.sectionKey}.${t.blockKey ? t.blockKey + '.' : ''}${t.settingKey}: ${ref}`);
  host[t.settingKey] = ref;
  patched++;
}

writeFileSync(TEMPLATE_PATH, header + JSON.stringify(json, null, 2) + '\n');
console.log(`\nPatched ${patched} image_picker settings.`);
