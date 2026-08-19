#!/usr/bin/env node
/**
 * Upload the component cutouts to the live theme as assets.
 *
 *   node scripts/upload-cutouts-to-theme.mjs [--apply]
 *
 * The "What's in the box" grid used to render `component.featured_image` — the
 * component PRODUCT's primary image. That is variant-blind, so the Head-to-Toe
 * grid showed a Coconut Breeze lotion inside the Pure Unscented kit, and a
 * Wildcrafted Frankincense deodorant that ships in neither kit. There is no
 * Liquid fix for it: the grid is driven by product references, and a product
 * reference has no idea which of its variants this bundle happens to contain.
 *
 * The cutouts do know, because they are named per component AND variant. Putting
 * them in the theme means the grid can name the exact file for the exact unit
 * that ships: `{{ row.img | asset_url }}`.
 *
 * ── Why theme assets rather than Shopify Files ──────────────────────────────
 * A theme asset is addressable by a NAME we choose, so the row's `img` field and
 * the file are keyed by the same string and a missing one is obvious. Files gives
 * opaque CDN URLs that would need a mapping table — one more thing to drift.
 *
 * The cost is losing Shopify's image CDN transforms, so these are resized here to
 * what the grid actually paints (~190px tall, so 420px covers 2x) instead of
 * shipping 1800px masters. That is the difference between ~1.4 MB and ~180 KB of
 * images on a lander that is already at mobile PSI 40.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { getMainThemeId, getAccessToken } from '../lib/shopify.js';
import { API_VERSION } from '../lib/shopify-api-version.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APPLY = process.argv.includes('--apply');
const TARGET_H = 420;

const env = Object.fromEntries(
  readFileSync(join(ROOT, '.env'), 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
const token = await getAccessToken();
const themeId = await getMainThemeId();

const dir = join(ROOT, 'data', 'brand', 'cutouts');
const files = readdirSync(dir).filter((f) => f.startsWith('component-') && f.endsWith('.png')).sort();
if (!files.length) { console.error('no component-*.png cutouts found'); process.exit(1); }

console.log(`theme ${themeId} — ${files.length} cutouts, resizing to ${TARGET_H}px tall\n`);

let totalBefore = 0, totalAfter = 0;
const payloads = [];
for (const f of files) {
  const src = readFileSync(join(dir, f));
  // `fit: inside` so a wide soap and a tall bottle both fit the box without
  // distortion, and without being padded to a common canvas — the grid's
  // object-fit does the centring, and padding here would bake in whitespace that
  // makes every product look a different size.
  const out = await sharp(src).resize({ height: TARGET_H, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82, effort: 6, alphaQuality: 90 }).toBuffer();
  totalBefore += src.length; totalAfter += out.length;
  const key = `assets/${f.slice(0, -4)}.webp`;
  payloads.push({ key, attachment: out.toString('base64'), bytes: out.length });
  console.log(`  ${f.padEnd(42)} ${String(Math.round(src.length / 1024)).padStart(5)} KB → ${String(Math.round(out.length / 1024)).padStart(4)} KB`);
}
console.log(`\n  total ${Math.round(totalBefore / 1024)} KB → ${Math.round(totalAfter / 1024)} KB`);

if (!APPLY) { console.log('\ndry run — pass --apply'); process.exit(0); }

for (const p of payloads) {
  const r = await fetch(`https://${env.SHOPIFY_STORE}/admin/api/${API_VERSION}/themes/${themeId}/assets.json`, {
    method: 'PUT',
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ asset: { key: p.key, attachment: p.attachment } }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!r.ok) { console.error(`✗ ${p.key}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`); process.exit(1); }
  console.log(`  ✓ ${p.key}`);
}
console.log(`\n✓ uploaded ${payloads.length} cutouts to the theme`);
