#!/usr/bin/env node
/**
 * Publish the four new lotion carousel frames to the live coconut-lotion PDP.
 *
 * Dry by default. --apply to write.
 *
 * SAFETY: this script only ever ADDS images. It never deletes one, because
 * DELETE /products/{id}/images/{id}.json destroys the underlying CDN file
 * (three bundle photos were lost that way on 2026-08-12 and are unrecoverable).
 * There is no delete path here at all.
 *
 * The four frames are inserted UNATTACHED to any variant, so they render for
 * every scent — the same as the five existing infographic frames. Positions are
 * chosen so the finished gallery follows the seven-frame Shopify gallery order
 * in marketing-product-image-stack, with the offer frame adopted in PR #844:
 *
 *   1-5  variant bottle shots (variant-attached, one renders at a time)
 *   6    mechanism — SIX INGREDIENTS (the benefit headline)
 *   7    offer          NEW
 *   8    proof          NEW
 *   9    not-in-it
 *   10   benefits
 *   11   transform      NEW
 *   12   compare        NEW
 *   13   how-to-use
 *   14   lifestyle
 *
 * Each insert shifts the frames below it, so they are posted in ascending
 * position order and the arithmetic above already accounts for the shift.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getProducts, getAccessToken } from '../lib/shopify.js';
import { API_VERSION } from '../lib/shopify-api-version.js';

const ROOT = process.cwd();
const DIR = join(ROOT, 'data', 'creatives', 'lotion-carousel');
const APPLY = process.argv.includes('--apply');

const STORE = Object.fromEntries(
  readFileSync(join(ROOT, '.env'), 'utf8').split('\n')
    .filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; })
).SHOPIFY_STORE;
const base = `https://${STORE}/admin/api/${API_VERSION}`;
const token = await getAccessToken();
const headers = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };

const FRAMES = [
  { file: 'final-offer.jpg', position: 7,
    alt: 'Subscribe and save 15% on Real Skin Care coconut body lotion — $25.50 per 8 oz bottle, free shipping on every subscription order, pause, skip or cancel anytime' },
  { file: 'final-proof.jpg', position: 8,
    alt: 'Five-star customer review of Real Skin Care coconut body lotion — the perfect moisturizer for kids in the summer, absorbs quickly yet is effective all day' },
  { file: 'final-transform.jpg', position: 11,
    alt: 'Coconut body lotion absorbs fast enough to get dressed and out the door instead of waiting for lotion to sink in' },
  { file: 'final-compare.jpg', position: 12,
    alt: 'Real Skin Care coconut body lotion compared with conventional lotion — six readable ingredients and no mineral oil, petrolatum, silicones or parabens' },
];

const product = (await getProducts({ handle: 'coconut-lotion' }))?.[0];
if (!product) throw new Error('coconut-lotion not found');
console.log(`Product ${product.id} — ${product.title}`);
console.log(`Currently ${product.images.length} images.\n`);

for (const f of FRAMES) {
  const bytes = readFileSync(join(DIR, f.file));
  console.log(`${APPLY ? 'POST ' : 'DRY  '} ${f.file} → position ${f.position} (${(bytes.length / 1024).toFixed(0)} KB)`);
  console.log(`       alt: ${f.alt}`);
  if (!APPLY) continue;
  const res = await fetch(`${base}/products/${product.id}/images.json`, {
    method: 'POST', headers,
    body: JSON.stringify({ image: { attachment: bytes.toString('base64'), filename: f.file, alt: f.alt, position: f.position } }),
  });
  const body = await res.json();
  if (!res.ok || !body.image) { console.error('  FAILED', res.status, JSON.stringify(body).slice(0, 300)); process.exit(1); }
  console.log(`       ✓ id ${body.image.id}  position ${body.image.position}`);
  await new Promise(r => setTimeout(r, 1200));
}

if (!APPLY) { console.log('\nDry run. Re-run with --apply to write.'); process.exit(0); }

// Verify against live rather than trusting the write responses.
await new Promise(r => setTimeout(r, 2500));
const after = await (await fetch(`${base}/products/${product.id}/images.json`, { headers })).json();
console.log(`\nLIVE GALLERY (${after.images.length} images):`);
for (const im of after.images.sort((a, b) => a.position - b.position)) {
  const name = im.src.split('/').pop().split('?')[0];
  console.log(`  ${String(im.position).padStart(2)}  ${name.slice(0, 52).padEnd(54)} ${im.variant_ids?.length ? 'variant-attached' : ''}`);
}
