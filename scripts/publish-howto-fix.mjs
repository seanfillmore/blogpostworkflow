#!/usr/bin/env node
/**
 * Swap the corrected how-to frame onto the live lotion PDP.
 *
 * Dry by default. --apply to write.
 *
 * The old frame drew a pump dispenser for a product that has no pump. Shopify
 * cannot replace an image's bytes, so this uploads the corrected file and
 * removes the old one.
 *
 * DELETING THIS ONE IS RISKIER THAN THE FRAMES THIS PROJECT GENERATED ITSELF,
 * because lotion-how-to-use.png is pre-existing brand artwork and
 * DELETE /products/{id}/images/{id}.json destroys the underlying CDN file even
 * for a /files/ path. Three preconditions were established before writing this:
 *   1. the full-resolution original is archived at
 *      data/archive/coconut-lotion/lotion-how-to-use.ORIGINAL.png — and this
 *      script REFUSES to delete if that file is missing;
 *   2. a repo-wide grep found exactly one reference, the index entry in
 *      assets/digital/image-map.json, which this change updates;
 *   3. no digital asset actually consumes that entry — nothing under
 *      assets/digital/ references the filename, so no PDF build breaks.
 * The corrected frame is built by scripts/compose-howto-fix.sh from that same
 * archived original, so the two are recoverable from each other.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getProducts, getAccessToken } from '../lib/shopify.js';
import { API_VERSION } from '../lib/shopify-api-version.js';

const ROOT = process.cwd();
const APPLY = process.argv.includes('--apply');
const OLD = 'lotion-how-to-use.png';
const NEW = 'lotion-how-to-use-v2.png';
const NEW_PATH = join(ROOT, 'data', 'creatives', 'lotion-howto', NEW);
const ARCHIVE = join(ROOT, 'data', 'archive', 'coconut-lotion', 'lotion-how-to-use.ORIGINAL.png');
const MAP = join(ROOT, 'assets', 'digital', 'image-map.json');

const ALT = 'How to use coconut body lotion — shake the bottle, squeeze a small amount, massage in';

if (!existsSync(ARCHIVE)) {
  console.error(`REFUSE: no archived original at ${ARCHIVE}. Deleting would destroy the CDN file.`);
  process.exit(1);
}

const STORE = Object.fromEntries(
  readFileSync(join(ROOT, '.env'), 'utf8').split('\n')
    .filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; })
).SHOPIFY_STORE;
const base = `https://${STORE}/admin/api/${API_VERSION}`;
const headers = { 'X-Shopify-Access-Token': await getAccessToken(), 'Content-Type': 'application/json' };

const product = (await getProducts({ handle: 'coconut-lotion' }))?.[0];
if (!product) throw new Error('coconut-lotion not found');
const old = product.images.find(i => i.src.split('/').pop().split('?')[0] === OLD);
if (!old) { console.error(`${OLD} is not on the product — nothing to do.`); process.exit(1); }
console.log(`Product ${product.id} — ${product.images.length} images. Old frame at position ${old.position}.\n`);

const bytes = readFileSync(NEW_PATH);
console.log(`${APPLY ? 'POST  ' : 'DRY   '} ${NEW} → position ${old.position} (${(bytes.length / 1024).toFixed(0)} KB)`);
console.log(`       alt: ${ALT}`);
console.log(`${APPLY ? 'DELETE' : 'DRY   '} ${OLD} (id ${old.id}) — archive OK`);

if (!APPLY) { console.log('\nDry run. Re-run with --apply to write.'); process.exit(0); }

const res = await fetch(`${base}/products/${product.id}/images.json`, {
  method: 'POST', headers,
  body: JSON.stringify({ image: { attachment: bytes.toString('base64'), filename: NEW, alt: ALT, position: old.position } }),
});
const body = await res.json();
if (!res.ok || !body.image) { console.error('  upload FAILED', res.status, JSON.stringify(body).slice(0, 300)); process.exit(1); }
console.log(`       ✓ uploaded id ${body.image.id} position ${body.image.position}`);
const newUrl = body.image.src.split('?')[0];

await new Promise(r => setTimeout(r, 1500));
const del = await fetch(`${base}/products/${product.id}/images/${old.id}.json`, { method: 'DELETE', headers });
if (!del.ok) { console.error('  delete FAILED', del.status); process.exit(1); }
console.log('       ✓ old frame removed');

// Keep the digital-asset index honest in the same change.
const map = JSON.parse(readFileSync(MAP, 'utf8'));
delete map[`coconut-lotion:${OLD}`];
map[`coconut-lotion:${NEW}`] = newUrl;
writeFileSync(MAP, JSON.stringify(map, null, 2) + '\n');
console.log(`       ✓ image-map.json → coconut-lotion:${NEW}`);

await new Promise(r => setTimeout(r, 2500));
const after = await (await fetch(`${base}/products/${product.id}/images.json`, { headers })).json();
console.log(`\nLIVE GALLERY (${after.images.length}):`);
for (const im of after.images.sort((a, b) => a.position - b.position)) {
  console.log(`  ${String(im.position).padStart(2)}  ${im.src.split('/').pop().split('?')[0].slice(0, 52)}`);
}
