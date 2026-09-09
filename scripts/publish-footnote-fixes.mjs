#!/usr/bin/env node
/**
 * Swap the two corrected how-to frames onto their live PDPs.
 *
 * Dry by default. --apply to write.
 *
 * Same delete discipline as scripts/publish-howto-fix.mjs, and for the same
 * reason: Shopify cannot replace an image's bytes, and DELETE destroys the CDN
 * file even for a /files/ path. Preconditions, all verified before this was
 * written and RE-CHECKED at run time for the archive:
 *   1. full-resolution originals archived under data/archive/<handle>/ — this
 *      script REFUSES to delete when one is missing;
 *   2. the only repo reference to either filename is the index entry in
 *      assets/digital/image-map.json, updated here in the same change;
 *   3. nothing under assets/digital/ consumes either entry, so no PDF build
 *      breaks.
 * Both corrected frames are composed FROM those archived originals by
 * scripts/compose-footnote-fixes.sh, so the pairs are recoverable from each
 * other.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getProducts, getAccessToken } from '../lib/shopify.js';
import { API_VERSION } from '../lib/shopify-api-version.js';

const ROOT = process.cwd();
const APPLY = process.argv.includes('--apply');
const MAP = join(ROOT, 'assets', 'digital', 'image-map.json');
const OUT = join(ROOT, 'data', 'creatives', 'howto-footnotes');

const JOBS = [
  {
    handle: 'coconut-soap',
    old: 'bar-soap-how-to-use.png',
    neu: 'bar-soap-how-to-use-v2.png',
    archive: join(ROOT, 'data', 'archive', 'coconut-soap', 'bar-soap-how-to-use.ORIGINAL.png'),
    alt: 'How to make coconut bar soap last — lather in wet hands, rinse the bar, drain it between uses',
    why: 'cut an unsubstantiated comparative claim ("outlasts tallow bars at twice the price")',
  },
  {
    handle: 'coconut-moisturizer',
    old: 'body-cream-how-to-use.png',
    neu: 'body-cream-how-to-use-v2.png',
    archive: join(ROOT, 'data', 'archive', 'coconut-moisturizer', 'body-cream-how-to-use.ORIGINAL.png'),
    alt: 'How to use coconut body cream — scoop a small amount, warm between fingers, massage in',
    why: 'removed "pump" — RSC\'s lotion is a squeeze bottle, so "a pump lotion" implied a product we do not sell',
  },
];

const STORE = Object.fromEntries(
  readFileSync(join(ROOT, '.env'), 'utf8').split('\n')
    .filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; })
).SHOPIFY_STORE;
const base = `https://${STORE}/admin/api/${API_VERSION}`;
const headers = { 'X-Shopify-Access-Token': await getAccessToken(), 'Content-Type': 'application/json' };

for (const j of JOBS) {
  console.log(`\n=== ${j.handle} — ${j.why}`);
  if (!existsSync(j.archive)) {
    console.error(`REFUSE: no archived original at ${j.archive}. Deleting would destroy the CDN file.`);
    process.exit(1);
  }
  const product = (await getProducts({ handle: j.handle }))?.[0];
  if (!product) { console.error(`  ${j.handle} not found`); process.exit(1); }
  const old = product.images.find(i => i.src.split('/').pop().split('?')[0] === j.old);
  if (!old) { console.log(`  SKIP — ${j.old} is not on the product`); continue; }

  const bytes = readFileSync(join(OUT, j.neu));
  console.log(`${APPLY ? 'POST  ' : 'DRY   '} ${j.neu} → position ${old.position} (${(bytes.length / 1024).toFixed(0)} KB)`);
  console.log(`${APPLY ? 'DELETE' : 'DRY   '} ${j.old} (id ${old.id}) — archive OK`);
  if (!APPLY) continue;

  const res = await fetch(`${base}/products/${product.id}/images.json`, {
    method: 'POST', headers,
    body: JSON.stringify({ image: { attachment: bytes.toString('base64'), filename: j.neu, alt: j.alt, position: old.position } }),
  });
  const body = await res.json();
  if (!res.ok || !body.image) { console.error('  upload FAILED', res.status, JSON.stringify(body).slice(0, 300)); process.exit(1); }
  console.log(`       ✓ uploaded id ${body.image.id} position ${body.image.position}`);
  const newUrl = body.image.src.split('?')[0];

  await new Promise(r => setTimeout(r, 1500));
  const del = await fetch(`${base}/products/${product.id}/images/${old.id}.json`, { method: 'DELETE', headers });
  if (!del.ok) { console.error('  delete FAILED', del.status); process.exit(1); }
  console.log('       ✓ old frame removed');

  const map = JSON.parse(readFileSync(MAP, 'utf8'));
  delete map[`${j.handle}:${j.old}`];
  map[`${j.handle}:${j.neu}`] = newUrl;
  writeFileSync(MAP, JSON.stringify(map, null, 2) + '\n');
  console.log(`       ✓ image-map.json → ${j.handle}:${j.neu}`);
  await new Promise(r => setTimeout(r, 1200));
}

if (!APPLY) console.log('\nDry run. Re-run with --apply to write.');
