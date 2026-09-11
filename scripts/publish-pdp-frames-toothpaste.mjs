#!/usr/bin/env node
/**
 * Publish the toothpaste offer / proof / compare frames. ADD-ONLY.
 *
 * Dry by default. --apply to write.
 *
 * Shopify's POST .../images.json with a `position` inserts and shifts everything
 * below, so nothing is deleted and nothing can be destroyed here.
 *
 * Resulting gallery (11), the same shape as the other six PDPs:
 *   1-3 variant bottles · 4 mechanism · 5 OFFER · 6 PROOF · 7 not-in-it ·
 *   8 benefits · 9 COMPARE · 10 how-to · 11 Amazon hero
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getProducts, getAccessToken } from '../lib/shopify.js';
import { API_VERSION } from '../lib/shopify-api-version.js';

const ROOT = process.cwd();
const APPLY = process.argv.includes('--apply');
const DIR = join(ROOT, 'data', 'creatives', 'pdp-frames-toothpaste');
const RULED = /mineral oil|petrolatum|dimethicone|petroleum|\bpump\b/i;

const STORE = Object.fromEntries(
  readFileSync(join(ROOT, '.env'), 'utf8').split('\n')
    .filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; })
).SHOPIFY_STORE;
const base = `https://${STORE}/admin/api/${API_VERSION}`;
const headers = { 'X-Shopify-Access-Token': await getAccessToken(), 'Content-Type': 'application/json' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fileOf = src => src.split('/').pop().split('?')[0];

const HANDLE = 'coconut-oil-toothpaste';
const PLAN = [
  { file: 'toothpaste-offer.jpg', position: 5,
    alt: 'Real Skin Care coconut oil toothpaste 3-pack — three tubes for $34, $11.33 a tube, saving $5 against three singles, one flavor or one of each' },
  { file: 'toothpaste-proof.jpg', position: 6,
    alt: 'Five-star customer review of Real Skin Care coconut oil toothpaste — first time trying natural toothpaste and impressed, cinnamon taste pleasant, teeth feeling clean' },
  { file: 'toothpaste-compare.jpg', position: 9,
    alt: 'Real Skin Care coconut oil toothpaste compared with conventional toothpaste — no fluoride, no SLS, no titanium dioxide and no synthetic sweeteners' },
];

for (const it of PLAN) {
  if (RULED.test(it.alt)) throw new Error(`alt text for ${it.file} contains a ruled word`);
  if (!existsSync(join(DIR, it.file))) throw new Error(`missing ${join(DIR, it.file)}`);
}

const product = (await getProducts({ handle: HANDLE }))?.[0];
if (!product) throw new Error(`${HANDLE} not found`);
console.log(`${HANDLE} — ${product.images.length} images currently\n`);

for (const it of [...PLAN].sort((a, b) => a.position - b.position)) {
  const already = product.images.find(i => fileOf(i.src).startsWith(it.file.replace(/\.\w+$/, '')));
  if (already) { console.log(`  SKIP  ${it.file} already at position ${already.position}`); continue; }
  const bytes = readFileSync(join(DIR, it.file));
  console.log(`  ${APPLY ? 'POST  ' : 'DRY   '} ${it.file} → position ${it.position} (${(bytes.length / 1024).toFixed(0)} KB)`);
  if (!APPLY) continue;
  const res = await fetch(`${base}/products/${product.id}/images.json`, {
    method: 'POST', headers,
    body: JSON.stringify({ image: { attachment: bytes.toString('base64'), filename: it.file, alt: it.alt, position: it.position } }),
  });
  const body = await res.json();
  if (!res.ok || !body.image) { console.error('  FAILED', res.status, JSON.stringify(body).slice(0, 300)); process.exit(1); }
  console.log(`         ✓ id ${body.image.id} at position ${body.image.position}`);
  await sleep(1200);
}

if (!APPLY) { console.log('\nDry run. Re-run with --apply to write.'); process.exit(0); }

await sleep(2500);
const { images } = await (await fetch(`${base}/products/${product.id}/images.json`, { headers })).json();
console.log(`\nLIVE ${HANDLE} (${images.length} images):`);
for (const im of images.sort((a, b) => a.position - b.position)) {
  const bad = RULED.test(im.alt || '') ? '   <<< ALT NAMES A RULED WORD' : '';
  console.log(`  ${String(im.position).padStart(2)}  ${fileOf(im.src).slice(0, 46).padEnd(46)}${bad}`);
}
