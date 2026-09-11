#!/usr/bin/env node
/**
 * Add real lifestyle photography to the lotion, body cream and bar soap PDPs.
 *
 * Dry by default. --apply to write.
 *
 * ADD-ONLY, like publish-pdp-frames-batch2. Nothing is deleted or replaced.
 * In particular the AI-generated `lotion-lifestyle.png` STAYS on coconut-lotion:
 * assets/digital/image-map.json references its CDN URL for the bundle PDFs, and
 * deleting a product image destroys that file.
 *
 * Source: an operator phone shoot uploaded 2026-09-11 (24 photos, all Pure
 * Unscented). The three chosen are the ones that read as a real product in real
 * use at gallery size; square crops (the galleries are uniformly square, and a
 * portrait frame changes the slider height) with metadata stripped live in
 * data/creatives/lifestyle-photos/ in the MAIN checkout.
 *
 *   coconut-moisturizer  cream being applied to a forearm — the only in-use
 *                        photograph of any product in the catalogue
 *   coconut-soap         the bar held in hand, label legible
 *   coconut-lotion       lotion + cream on the beach
 *
 * Position = directly after the variant shots, i.e. the second frame a shopper
 * sees, which is where the gallery order in
 * .claude/skills/marketing-product-image-stack puts "the product in use".
 * The frames that follow shift down by one; none of them is addressed by index
 * anywhere (digital assets use image=<filename>).
 *
 * Every alt text goes through the SEO-copy health gate first: alt text renders
 * on a page with a buy button, so it is the commercial surface.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getProducts, getAccessToken } from '../lib/shopify.js';
import { API_VERSION } from '../lib/shopify-api-version.js';
import { checkSeoCopyFields } from '../lib/seo-copy-health-gate.js';

const ROOT = process.cwd();
const DIR = '/Users/seanfillmore/Code/Claude/data/creatives/lifestyle-photos';
const APPLY = process.argv.includes('--apply');

export const PLAN = [
  { handle: 'coconut-moisturizer', file: 'cream-in-use-real.jpg', position: 6,
    alt: 'Smoothing Real Skin Care Pure Unscented coconut body cream onto a forearm, the open 4 oz jar beside it' },
  { handle: 'coconut-soap', file: 'bar-soap-in-hand-real.jpg', position: 5,
    alt: 'Real Skin Care Pure Unscented coconut bar soap held in hand with the matching body cream' },
  { handle: 'coconut-lotion', file: 'lotion-beach-real.jpg', position: 6,
    alt: 'Real Skin Care Pure Unscented coconut body lotion and body cream on the sand at the beach' },
];

for (const p of PLAN) {
  const gate = checkSeoCopyFields({ alt: p.alt });
  if (!gate.ok) {
    console.error(`REFUSE ${p.file} — alt text trips the health gate: ${JSON.stringify(gate.blocking)}`);
    process.exit(1);
  }
  if (!existsSync(join(DIR, p.file))) {
    console.error(`REFUSE ${p.file} — source missing at ${DIR}`);
    process.exit(1);
  }
}

const STORE = Object.fromEntries(
  readFileSync(join(ROOT, '.env'), 'utf8').split('\n')
    .filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; })
).SHOPIFY_STORE;
const base = `https://${STORE}/admin/api/${API_VERSION}`;
const headers = { 'X-Shopify-Access-Token': await getAccessToken(), 'Content-Type': 'application/json' };

const stem = (name) => name.replace(/\.[a-z]+$/i, '');

for (const p of PLAN) {
  const product = (await getProducts({ handle: p.handle }))?.[0];
  if (!product) { console.error(`${p.handle} not found`); process.exit(1); }
  // Shopify may suffix an uploaded filename, so match on the stem.
  const already = product.images.find(i => i.src.split('/').pop().split('?')[0].startsWith(stem(p.file)));
  if (already) { console.log(`SKIP  ${p.handle}: ${p.file} already at position ${already.position}`); continue; }
  const bytes = readFileSync(join(DIR, p.file));
  console.log(`${APPLY ? 'POST  ' : 'DRY   '} ${p.handle}: ${p.file} → position ${p.position} of ${product.images.length + 1} (${(bytes.length / 1024).toFixed(0)} KB)`);
  if (!APPLY) continue;
  const res = await fetch(`${base}/products/${product.id}/images.json`, {
    method: 'POST', headers,
    body: JSON.stringify({ image: { attachment: bytes.toString('base64'), filename: p.file, alt: p.alt, position: p.position } }),
  });
  const body = await res.json();
  if (!res.ok || !body.image) { console.error('  FAILED', res.status, JSON.stringify(body).slice(0, 300)); process.exit(1); }
  console.log(`       ✓ id ${body.image.id} position ${body.image.position}`);
  await new Promise(r => setTimeout(r, 1200));
}

if (!APPLY) { console.log('\nDry run. Re-run with --apply to write.'); process.exit(0); }

await new Promise(r => setTimeout(r, 2500));
for (const p of PLAN) {
  const product = (await getProducts({ handle: p.handle }))?.[0];
  console.log(`\nLIVE — ${p.handle} (${product.images.length}):`);
  for (const im of product.images.sort((a, b) => a.position - b.position)) {
    console.log(`  ${String(im.position).padStart(2)}  ${im.src.split('/').pop().split('?')[0].slice(0, 48)}`);
  }
}
