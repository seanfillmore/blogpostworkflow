#!/usr/bin/env node
/**
 * Replace the rejected v1 lotion carousel frames with the clean prop-free set.
 *
 * Dry by default. --apply to write.
 *
 * WHY THIS ONE DELETES, when the v1 script had no delete path at all.
 * Shopify has no API to replace an image's bytes in place, so swapping a frame
 * means remove + add. That is normally forbidden here, because
 * DELETE /products/{id}/images/{id}.json destroys the underlying CDN file and
 * three bundle photos were lost that way on 2026-08-12. It is permitted in this
 * one case, and only because every precondition holds:
 *   - the four targets are files THIS PROJECT generated on 2026-09-08, not
 *     product photography and not anything a photographer shot;
 *   - full-resolution originals are archived at
 *     data/creatives/lotion-carousel/final-*.jpg in the MAIN checkout;
 *   - a repo-wide grep for the four filenames returns nothing, so no blog post,
 *     Klaviyo flow or image-map references them.
 * The script re-checks the archive on disk and REFUSES to delete anything whose
 * backup it cannot find. Do not generalise this to product photography.
 *
 * TRANSFORM IS DELETED AND NOT REPLACED. It failed four generation attempts on
 * four different defects (a "to to" headline typo; a bottle enlarged until it
 * covered the scene; an invented "250ml" on a 236ml product; three bottles in
 * one frame). The live v1 transform carries the ivy and wood-slice props the
 * operator rejected, so it cannot stay — but a frame that fails product
 * accuracy must not ship either. The gallery is better with nine honest frames
 * than with ten and a wrong volume on the label.
 *
 * Resulting gallery (13):
 *   1-5 variant bottle shots · 6 mechanism · 7 OFFER · 8 PROOF ·
 *   9 not-in-it · 10 benefits · 11 COMPARE · 12 how-to · 13 lifestyle
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getProducts, getAccessToken } from '../lib/shopify.js';
import { API_VERSION } from '../lib/shopify-api-version.js';

const ROOT = process.cwd();
const DIR = join(ROOT, 'data', 'creatives', 'lotion-carousel');
const ARCHIVE = '/Users/seanfillmore/Code/Claude/data/creatives/lotion-carousel';
const APPLY = process.argv.includes('--apply');

const STORE = Object.fromEntries(
  readFileSync(join(ROOT, '.env'), 'utf8').split('\n')
    .filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; })
).SHOPIFY_STORE;
const base = `https://${STORE}/admin/api/${API_VERSION}`;
const headers = { 'X-Shopify-Access-Token': await getAccessToken(), 'Content-Type': 'application/json' };

const REMOVE = ['final-offer.jpg', 'final-proof.jpg', 'final-transform.jpg', 'final-compare.jpg'];

const ADD = [
  { file: 'clean-offer.jpg', position: 7,
    alt: 'Subscribe and save 15% on Real Skin Care coconut body lotion — $25.50 per 8 oz bottle, free shipping on every subscription order, pause, skip or cancel anytime' },
  { file: 'clean-proof.jpg', position: 8,
    alt: 'Five-star customer review of Real Skin Care coconut body lotion — the perfect moisturizer for kids in the summer, absorbs quickly yet is effective all day' },
  { file: 'clean-compare.jpg', position: 11,
    alt: 'Real Skin Care coconut body lotion compared with conventional lotion — six readable ingredients and no mineral oil, petrolatum, silicones or parabens' },
];

const product = (await getProducts({ handle: 'coconut-lotion' }))?.[0];
if (!product) throw new Error('coconut-lotion not found');
console.log(`Product ${product.id} — ${product.images.length} images currently.\n`);

// ── Remove, only where a full-resolution backup is on disk ───────────────────
for (const name of REMOVE) {
  const img = product.images.find(i => i.src.split('/').pop().split('?')[0] === name);
  if (!img) { console.log(`SKIP  ${name} — not on the product`); continue; }
  const backup = join(ARCHIVE, name);
  if (!existsSync(backup)) {
    console.error(`REFUSE ${name} — no archived original at ${backup}. Deleting would destroy the CDN file.`);
    process.exit(1);
  }
  console.log(`${APPLY ? 'DELETE' : 'DRY   '} ${name} (id ${img.id}, pos ${img.position}) — backup OK`);
  if (!APPLY) continue;
  const res = await fetch(`${base}/products/${product.id}/images/${img.id}.json`, { method: 'DELETE', headers });
  if (!res.ok) { console.error(`  FAILED ${res.status}`); process.exit(1); }
  console.log('       ✓ removed');
  await new Promise(r => setTimeout(r, 1200));
}

// ── Add the clean set ────────────────────────────────────────────────────────
for (const f of ADD) {
  const bytes = readFileSync(join(DIR, f.file));
  console.log(`\n${APPLY ? 'POST  ' : 'DRY   '} ${f.file} → position ${f.position} (${(bytes.length / 1024).toFixed(0)} KB)`);
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

await new Promise(r => setTimeout(r, 2500));
const after = await (await fetch(`${base}/products/${product.id}/images.json`, { headers })).json();
console.log(`\nLIVE GALLERY (${after.images.length} images):`);
for (const im of after.images.sort((a, b) => a.position - b.position)) {
  console.log(`  ${String(im.position).padStart(2)}  ${im.src.split('/').pop().split('?')[0].slice(0, 52)}`);
}
