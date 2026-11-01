#!/usr/bin/env node
/**
 * Publish the nine new frames to the bar soap, foaming hand soap and deodorant PDPs.
 *
 * Dry by default. --apply to write.
 *
 * ADD-ONLY. There is no delete path in this file, because nothing is being
 * replaced — these are three jobs the galleries never had. That is the ordinary
 * case; the two scripts that DO delete (publish-lotion-carousel, publish-howto-fix)
 * each carry an archive precondition precisely because deletion destroys the CDN
 * file. Do not add one here without that guard.
 *
 * Positions mirror the lotion gallery, so all four PDPs read the same way:
 *
 *   1-4  variant shots (variant-attached, one renders at a time)
 *   5    mechanism / one-ingredient        (the benefit headline)
 *   6    OFFER      NEW
 *   7    PROOF      NEW
 *   8    what's not in it
 *   9    benefits
 *   10   COMPARE    NEW
 *   11   how to use
 *   12   trailing shot
 *
 * Each insert shifts the frames below it, so they are posted in ascending
 * position order and the arithmetic above already accounts for the shift.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getProducts, getAccessToken } from '../lib/shopify.js';
import { API_VERSION } from '../lib/shopify-api-version.js';

const ROOT = process.cwd();
const DIR = join(ROOT, 'data', 'creatives', 'pdp-frames-batch2');
const APPLY = process.argv.includes('--apply');

const PLAN = [
  {
    handle: 'coconut-soap',
    frames: [
      { file: 'final-bar-soap-offer.jpg', position: 6,
        alt: 'Coconut bar soap four-pack — $39 for four bars, $9.75 each, saving $5 against four singles' },
      { file: 'final-bar-soap-proof.jpg', position: 7,
        alt: 'Five-star customer review of Real Skin Care coconut bar soap — lathers up very well, the unscented an excellent choice for sensitive skin' },
      { file: 'final-bar-soap-compare.jpg', position: 10,
        alt: 'Real Skin Care coconut bar soap compared with a conventional bar — no SLS or SLES, no rendered animal fat, no EDTA, no dyes' },
    ],
  },
  {
    handle: 'organic-foaming-hand-soap',
    frames: [
      { file: 'final-foaming-offer.jpg', position: 6,
        alt: 'Coconut foaming hand soap four-pack — $44 for four bottles, $11 each, saving $8 against four singles' },
      { file: 'final-foaming-proof.jpg', position: 7,
        alt: 'Five-star customer review of Real Skin Care foaming hand soap — foams up nicely and does not leave hands dry' },
      { file: 'final-foaming-compare.jpg', position: 10,
        alt: 'Real Skin Care foaming hand soap compared with a conventional foaming soap — no SLS or SLES, no cocamidopropyl betaine, no parabens, no dyes' },
    ],
  },
  {
    handle: 'coconut-oil-deodorant',
    frames: [
      { file: 'final-deodorant-offer.jpg', position: 6,
        alt: 'Coconut oil deodorant four-pack — $53 for four bottles, $13.25 each, saving $7 against four singles' },
      { file: 'final-deodorant-proof.jpg', position: 7,
        alt: 'Five-star customer review of Real Skin Care coconut oil deodorant — the scents are enjoyable and not overpowering, it works great' },
      { file: 'final-deodorant-compare.jpg', position: 10,
        alt: 'Real Skin Care coconut oil deodorant compared with a conventional stick — no aluminum, no synthetic fragrance, no propylene glycol, jojoba soaks in' },
    ],
  },
];

const STORE = Object.fromEntries(
  readFileSync(join(ROOT, '.env'), 'utf8').split('\n')
    .filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; })
).SHOPIFY_STORE;
const base = `https://${STORE}/admin/api/${API_VERSION}`;
const headers = { 'X-Shopify-Access-Token': await getAccessToken(), 'Content-Type': 'application/json' };

for (const p of PLAN) {
  const product = (await getProducts({ handle: p.handle }))?.[0];
  if (!product) { console.error(`${p.handle} not found`); process.exit(1); }
  console.log(`\n=== ${p.handle} — ${product.images.length} images currently`);
  for (const f of p.frames) {
    const bytes = readFileSync(join(DIR, f.file));
    console.log(`${APPLY ? 'POST  ' : 'DRY   '} ${f.file} → position ${f.position} (${(bytes.length / 1024).toFixed(0)} KB)`);
    if (!APPLY) continue;
    const res = await fetch(`${base}/products/${product.id}/images.json`, {
      method: 'POST', headers,
      body: JSON.stringify({ image: { attachment: bytes.toString('base64'), filename: f.file, alt: f.alt, position: f.position } }),
    });
    const body = await res.json();
    if (!res.ok || !body.image) { console.error('  FAILED', res.status, JSON.stringify(body).slice(0, 300)); process.exit(1); }
    console.log(`       ✓ id ${body.image.id} position ${body.image.position}`);
    await new Promise(r => setTimeout(r, 1200));
  }
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
