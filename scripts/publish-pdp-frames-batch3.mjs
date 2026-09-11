#!/usr/bin/env node
/**
 * Publish the batch-3 PDP gallery frames: offer / proof / compare for the coconut
 * body cream and the lip balm four-pack, plus one CORRECTION to an existing frame.
 *
 * Dry by default. --apply to write.
 *
 * ADD-ONLY for the six new frames. Shopify's POST .../images.json with a
 * `position` inserts and shifts everything below it, so nothing is deleted and
 * nothing can be destroyed — the rule that cost three bundle photos on
 * 2026-08-12 does not come near this path.
 *
 * THE ONE REPLACEMENT: body-cream-benefits.png carried a callout reading
 * "Thicker than a pump lotion". The RSC lotion is a squeeze bottle with a
 * flip-top cap; the only product with a pump is the foaming hand soap. PR #859
 * fixed this exact wording on the cream HOW-TO frame and on the PDP body, and
 * missed this frame. The replacement is the original pixels with the word "pump"
 * excised and "lotion" moved to the block's left edge — the title, the other
 * callouts, the jar and the leader lines are untouched, verified by a diff
 * bounded to x405-781 / y156-227. Its alt text carried the same error and is
 * rewritten. The original is archived before the delete, and the script REFUSES
 * to delete anything whose archive it cannot find.
 *
 * Resulting galleries, both the same shape as the lotion, soap and deodorant:
 *   coconut-moisturizer (13): 1-5 variant jars · 6 mechanism · 7 OFFER · 8 PROOF ·
 *     9 not-in-it · 10 benefits (corrected) · 11 COMPARE · 12 how-to · 13 Amazon hero
 *   coconut-oil-lip-balm (12): 1-5 variant tubes · 6 mechanism · 7 OFFER · 8 PROOF ·
 *     9 not-in-it · 10 benefits · 11 COMPARE · 12 variety pack
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getProducts, getAccessToken } from '../lib/shopify.js';
import { API_VERSION } from '../lib/shopify-api-version.js';

const ROOT = process.cwd();
const APPLY = process.argv.includes('--apply');
const DIR = join(ROOT, 'data', 'creatives', 'pdp-frames-batch3');
const ARCHIVE = join(ROOT, 'data', 'archive', 'pump-lotion-callout-2026-09-11');
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

const PLAN = {
  'coconut-moisturizer': [
    { file: 'cream-offer.jpg', position: 7,
      alt: 'The Sensitive Skin Set — Real Skin Care coconut body lotion plus this body cream for $46.80, saving $11.20 against buying both, with free shipping on orders over $45' },
    { file: 'cream-proof.jpg', position: 8,
      alt: 'Five-star verified review of Real Skin Care coconut body cream — the moisturizer for Wisconsin winters for the whole family, long lasting and not greasy' },
    { file: 'cream-compare.jpg', position: 11,
      alt: 'Real Skin Care coconut body cream compared with conventional body cream — no synthetic fragrance, no parabens, no lanolin, and it works in without leaving a slick film' },
  ],
  'coconut-oil-lip-balm': [
    { file: 'lip-balm-offer.jpg', position: 7,
      alt: 'Real Skin Care natural coconut oil lip balm four-pack — four tubes for $15, $3.75 a tube, one scent or the variety pack, three ingredients in every tube' },
    { file: 'lip-balm-proof.jpg', position: 8,
      alt: 'Five-star verified review of Real Skin Care coconut oil lip balm — smooth texture that glides right on and leaves lips soft without any sticky feeling' },
    { file: 'lip-balm-compare.jpg', position: 11,
      alt: 'Real Skin Care coconut oil lip balm compared with conventional lip balm — no paraffin, no lanolin, no menthol and no synthetic flavoring' },
  ],
};

const REPLACE = [
  { handle: 'coconut-moisturizer', old: 'body-cream-benefits.png', file: 'body-cream-benefits-v2.png',
    alt: 'Coconut body cream — thicker than a lotion, unrefined red palm oil, sensitive-skin formulated' },
];

// ── Preflight ────────────────────────────────────────────────────────────────
for (const [, items] of Object.entries(PLAN)) {
  for (const it of items) {
    if (RULED.test(it.alt)) throw new Error(`alt text for ${it.file} contains a ruled word`);
    if (!existsSync(join(DIR, it.file))) throw new Error(`missing ${join(DIR, it.file)}`);
  }
}
for (const r of REPLACE) {
  if (RULED.test(r.alt)) throw new Error(`alt text for ${r.file} contains a ruled word`);
  if (!existsSync(join(DIR, r.file))) throw new Error(`missing ${join(DIR, r.file)}`);
  if (!existsSync(join(ARCHIVE, r.handle, r.old))) throw new Error(`REFUSE: no archived original at ${join(ARCHIVE, r.handle, r.old)}`);
}

const touched = new Map();

// ── The correction first, so the new frames are positioned against the final set ──
for (const r of REPLACE) {
  const product = (await getProducts({ handle: r.handle }))?.[0];
  if (!product) throw new Error(`${r.handle} not found`);
  touched.set(r.handle, product.id);
  const oldImg = product.images.find(i => fileOf(i.src) === r.old);
  const already = product.images.find(i => fileOf(i.src).startsWith(r.file.replace(/\.\w+$/, '')));
  console.log(`\n${r.handle} — REPLACE ${r.old} → ${r.file}`);
  if (!oldImg && already) { console.log(`  SKIP  already applied (id ${already.id}, pos ${already.position})`); continue; }
  if (!oldImg) { console.log('  SKIP  old frame not on the product — investigate'); continue; }
  const bytes = readFileSync(join(DIR, r.file));
  console.log(`  ${APPLY ? 'POST  ' : 'DRY   '} at position ${oldImg.position} (${(bytes.length / 1024).toFixed(0)} KB), variants ${JSON.stringify(oldImg.variant_ids)}`);
  console.log(`  ${APPLY ? 'DELETE' : 'DRY   '} ${r.old} (id ${oldImg.id}) — archive OK`);
  if (!APPLY) continue;
  const res = await fetch(`${base}/products/${product.id}/images.json`, {
    method: 'POST', headers,
    body: JSON.stringify({ image: { attachment: bytes.toString('base64'), filename: r.file, alt: r.alt, position: oldImg.position, variant_ids: oldImg.variant_ids } }),
  });
  const body = await res.json();
  if (!res.ok || !body.image) { console.error('  FAILED add', res.status, JSON.stringify(body).slice(0, 300)); process.exit(1); }
  console.log(`         ✓ added id ${body.image.id} at position ${body.image.position}`);
  await sleep(1200);
  const del = await fetch(`${base}/products/${product.id}/images/${oldImg.id}.json`, { method: 'DELETE', headers });
  if (!del.ok) { console.error(`  FAILED delete ${del.status}`); process.exit(1); }
  console.log('         ✓ removed old frame');
  await sleep(1200);
}

// ── The six new frames, add-only, lowest position first so later inserts land right ──
for (const [handle, items] of Object.entries(PLAN)) {
  const product = (await getProducts({ handle }))?.[0];
  if (!product) throw new Error(`${handle} not found`);
  touched.set(handle, product.id);
  console.log(`\n${handle} — ${product.images.length} images currently`);
  for (const it of [...items].sort((a, b) => a.position - b.position)) {
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
}

if (!APPLY) { console.log('\nDry run. Re-run with --apply to write.'); process.exit(0); }

await sleep(2500);
for (const [handle, id] of touched) {
  const { images } = await (await fetch(`${base}/products/${id}/images.json`, { headers })).json();
  console.log(`\nLIVE ${handle} (${images.length} images):`);
  for (const im of images.sort((a, b) => a.position - b.position)) {
    const bad = RULED.test(im.alt || '') ? '   <<< ALT NAMES A RULED WORD' : '';
    console.log(`  ${String(im.position).padStart(2)}  ${fileOf(im.src).slice(0, 46).padEnd(46)}${bad}`);
  }
}
