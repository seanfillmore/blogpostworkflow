#!/usr/bin/env node
/**
 * Add real lifestyle photography to PDP and bundle galleries.
 *
 * Dry by default. --apply to write.
 *
 * ADD-ONLY, like publish-pdp-frames-batch2. Nothing is deleted or replaced.
 * In particular the AI-generated `lotion-lifestyle.png` STAYS on coconut-lotion:
 * assets/digital/image-map.json references its CDN URL for the bundle PDFs, and
 * deleting a product image destroys that file.
 *
 * Source: an operator phone shoot uploaded 2026-09-11 (24 photos, all Pure
 * Unscented lotion, cream and bar soap). Square crops (the galleries are
 * uniformly square, and a portrait frame changes the slider height) with
 * metadata stripped live in data/creatives/lifestyle-photos/ in the MAIN checkout.
 *
 * A photo is placed only where EVERY product in it is in the box, in that
 * scent. Clean Swap, 90-Day Clean Swap and Gift Box contain no body cream, and
 * every photo showing the lotion also shows the cream, so they get nothing.
 *
 * VARIANT SCOPING. Bundle galleries use this theme's alt-text convention,
 * `<alt>#<option-handle>_<value-handle>` (see scripts/set-media-variant-scope.mjs
 * for the Liquid it relies on). `gang_exist` is sticky across the media loop: an
 * UNSCOPED image placed after a scoped one is hidden for EVERY variant. So:
 *   - on a product whose gallery already carries '#' alts, an entry with no
 *     `scope` is refused;
 *   - a `scope` naming an option or value the product does not have is refused,
 *     because the suffix would silently match nothing and hide the image.
 * The health gate checks the VISIBLE alt only (the part before '#').
 *
 * Position = the second frame a shopper sees for that variant, which is where
 * the gallery order in .claude/skills/marketing-product-image-stack puts "the
 * product in use". Entries are posted in PLAN order; within one product they are
 * listed in ascending position so each insert's arithmetic already accounts for
 * the ones before it.
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
  // ── PDPs (PR #876) ────────────────────────────────────────────────────────
  { handle: 'coconut-moisturizer', file: 'cream-in-use-real.jpg', position: 6,
    alt: 'Smoothing Real Skin Care Pure Unscented coconut body cream onto a forearm, the open 4 oz jar beside it' },
  { handle: 'coconut-soap', file: 'bar-soap-in-hand-real.jpg', position: 5,
    alt: 'Real Skin Care Pure Unscented coconut bar soap held in hand with the matching body cream' },
  { handle: 'coconut-lotion', file: 'lotion-beach-real.jpg', position: 6,
    alt: 'Real Skin Care Pure Unscented coconut body lotion and body cream on the sand at the beach' },

  // ── Bundles ───────────────────────────────────────────────────────────────
  // Sensitive Skin Set: 1 Pure Unscented lotion + 1 Pure Unscented cream,
  // single variant, no scoped media — plain images are correct here.
  { handle: 'sensitive-skin-starter-set', file: 'cream-in-use-real.jpg', position: 2,
    alt: 'Smoothing the Pure Unscented Body Cream from the Sensitive Skin Set onto a forearm, the open 4 oz jar beside it' },
  { handle: 'sensitive-skin-starter-set', file: 'lotion-beach-real.jpg', position: 5,
    alt: 'The Pure Unscented Body Lotion and Body Cream from the Sensitive Skin Set on the sand at the beach' },
  // 90-Day Coconut Reset: the Pure Unscented option only — the Coconut Breeze
  // box holds a different label. Position 3 = after both scoped hero shots, so it
  // is the second frame on the Pure Unscented variant.
  { handle: '99-coconut-reset-digital', file: 'lotion-cream-lounge-real.jpg', position: 3,
    scope: 'scent_pure-unscented',
    alt: 'Pure Unscented Body Lotion and Body Cream, the two products in the 90-Day Coconut Reset, on a lounge chair outdoors' },
  // Head-to-Toe: the Gentle kit is the one whose soap, lotion and cream are all
  // Pure Unscented. Position 2 = after the Gentle contents frame.
  { handle: 'head-to-toe', file: 'soap-lotion-cream-bed-real.jpg', position: 2,
    scope: 'kit_gentle',
    alt: 'Pure Unscented Bar Soap, Body Lotion and Body Cream from the Head-to-Toe Gentle kit on a bed' },
];

const handleize = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

for (const p of PLAN) {
  const gate = checkSeoCopyFields({ alt: p.alt });
  if (!gate.ok) {
    console.error(`REFUSE ${p.handle}: ${p.file} — alt text trips the health gate: ${JSON.stringify(gate.blocking)}`);
    process.exit(1);
  }
  if (p.alt.includes('#')) {
    console.error(`REFUSE ${p.handle}: ${p.file} — put the variant token in \`scope\`, not in the alt text`);
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

  const scoped = product.images.some(i => (i.alt || '').includes('#'));
  if (scoped && !p.scope) {
    console.error(`REFUSE ${p.handle}: ${p.file} — this gallery is variant-scoped; an unscoped image would be hidden for every variant`);
    process.exit(1);
  }
  if (p.scope) {
    const [optHandle, ...rest] = p.scope.split('_');
    const valHandle = rest.join('_');
    const opt = (product.options || []).find(o => handleize(o.name) === optHandle);
    if (!opt || !opt.values.some(v => handleize(v) === valHandle)) {
      console.error(`REFUSE ${p.handle}: ${p.file} — scope "${p.scope}" matches no option/value on the product`);
      process.exit(1);
    }
  }

  // Shopify may suffix an uploaded filename, so match on the stem.
  const already = product.images.find(i => i.src.split('/').pop().split('?')[0].startsWith(stem(p.file)));
  if (already) { console.log(`SKIP  ${p.handle}: ${p.file} already at position ${already.position}`); continue; }

  const alt = p.scope ? `${p.alt}#${p.scope}` : p.alt;
  const bytes = readFileSync(join(DIR, p.file));
  console.log(`${APPLY ? 'POST  ' : 'DRY   '} ${p.handle}: ${p.file} → position ${p.position} of ${product.images.length + 1}${p.scope ? ` [${p.scope}]` : ''} (${(bytes.length / 1024).toFixed(0)} KB)`);
  if (!APPLY) continue;
  const res = await fetch(`${base}/products/${product.id}/images.json`, {
    method: 'POST', headers,
    body: JSON.stringify({ image: { attachment: bytes.toString('base64'), filename: p.file, alt, position: p.position } }),
  });
  const body = await res.json();
  if (!res.ok || !body.image) { console.error('  FAILED', res.status, JSON.stringify(body).slice(0, 300)); process.exit(1); }
  console.log(`       ✓ id ${body.image.id} position ${body.image.position}`);
  await new Promise(r => setTimeout(r, 1200));
}

if (!APPLY) { console.log('\nDry run. Re-run with --apply to write.'); process.exit(0); }

await new Promise(r => setTimeout(r, 2500));
for (const h of [...new Set(PLAN.map(p => p.handle))]) {
  const product = (await getProducts({ handle: h }))?.[0];
  console.log(`\nLIVE — ${h} (${product.images.length}):`);
  for (const im of product.images.sort((a, b) => a.position - b.position)) {
    const token = (im.alt || '').includes('#') ? `  #${(im.alt || '').split('#').pop()}` : '';
    console.log(`  ${String(im.position).padStart(2)}  ${im.src.split('/').pop().split('?')[0].slice(0, 48)}${token}`);
  }
}
