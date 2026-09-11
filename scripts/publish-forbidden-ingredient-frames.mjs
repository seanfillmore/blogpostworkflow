#!/usr/bin/env node
/**
 * Replace the five live PDP gallery frames whose PIXELS name mineral oil,
 * petrolatum or dimethicone.
 *
 * Dry by default. --apply to write.
 *
 * WHY. Operator ruling, Sean 2026-09-09: "I have never heard a human being say
 * petrolatum or dimethicone" → "Do not use those words." It covers the words
 * even when negated ("No petrolatum"), because the avoidance claim is unsourced,
 * the implied harm has no backing, and 0 of 3,841 customer search terms use them
 * (see FORBIDDEN_EVEN_NEGATED in agents/pdp-builder/lib/validators.js). PRs #865
 * and #866 cleaned the lotion description and the landing templates; the gallery
 * frames were never swept.
 *
 * THE ALT TEXT UNDERSTATED IT. Read by alt text alone, three of these looked
 * like "petroleum jelly" frames — a word Sean has NOT ruled on. Opened, their
 * pixels say "No petrolatum" / "No dimethicone". Always open the image.
 *
 *   coconut-lotion         lotion-not-in-it.png   mineral oil, petrolatum, dimethicone (3 of 4 rows)
 *   coconut-lotion         clean-compare.jpg      "No mineral oil or petrolatum" row
 *   coconut-moisturizer    body-cream-not-in-it   petrolatum, dimethicone (2 of 4 rows)
 *   coconut-oil-deodorant  deodorant-not-in-it    "No petrolatum or dimethicone"
 *   coconut-oil-lip-balm   lip-balm-not-in-it     "No petrolatum"
 *
 * HELD, NOT IN THIS SCRIPT: final-deodorant-compare.jpg's "Petroleum jelly,
 * silicones" row. It names none of the three ruled words; Sean has been asked
 * whether "petroleum jelly" is covered.
 *
 * HOW THE REPLACEMENTS WERE MADE — surgically, from the original pixels, never
 * regenerated (scripts/compose-forbidden-ingredient-frames.sh). Removed rows are
 * erased and the survivors re-spaced. Where too few rows survived, replacement
 * rows use ONLY claims the live product body already makes and that are not in
 * the ruled vocabulary ("no silicones", "no synthetic fragrance"), typeset in a
 * face measured to match: Inter ExtraBold for the lotion rows (±1% on "No
 * parabens"), Outfit 500 + 2.3px tracking / Outfit 700 for the cream rows (exact
 * on "lanolin" and "parabens"). The product itself is byte-identical in every
 * frame.
 *
 * WHY THIS ONE DELETES. Shopify cannot replace an image's bytes in place, and
 * DELETE /products/{id}/images/{id}.json destroys the CDN file (three bundle
 * photos were lost that way on 2026-08-12). It is permitted here because every
 * old file is archived at full resolution in
 * data/archive/forbidden-ingredient-frames-2026-09-10/, the script REFUSES any
 * delete whose archive it cannot find, and a repo grep shows the only other
 * reference is assets/digital/image-map.json, which no build reads for these
 * keys and which is updated in the same change.
 *
 * ORDER: add the new frame at the old frame's position FIRST, then delete the
 * old one, so a failure part-way leaves a duplicate frame rather than a gap.
 * Variant attachments are carried across (the theme scopes media by variant on
 * some templates).
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getProducts, getAccessToken } from '../lib/shopify.js';
import { API_VERSION } from '../lib/shopify-api-version.js';

const ROOT = process.cwd();
const APPLY = process.argv.includes('--apply');
const NEW_DIR = join(ROOT, 'data', 'creatives', 'forbidden-ingredient-frames');
const ARCHIVE = join(ROOT, 'data', 'archive', 'forbidden-ingredient-frames-2026-09-10');
const FORBIDDEN = /mineral oil|petrolatum|dimethicone|petroleum/i;

const STORE = Object.fromEntries(
  readFileSync(join(ROOT, '.env'), 'utf8').split('\n')
    .filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; })
).SHOPIFY_STORE;
const base = `https://${STORE}/admin/api/${API_VERSION}`;
const headers = { 'X-Shopify-Access-Token': await getAccessToken(), 'Content-Type': 'application/json' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fileOf = src => src.split('/').pop().split('?')[0];

const PLAN = [
  { handle: 'coconut-lotion', old: 'lotion-not-in-it.png', file: 'lotion-not-in-it-v2.png',
    alt: 'Coconut body lotion with no silicones, no synthetic fragrance and no parabens' },
  { handle: 'coconut-lotion', old: 'clean-compare.jpg', file: 'clean-compare-v2.jpg',
    alt: 'Real Skin Care coconut body lotion compared with conventional lotion — six ingredients you can read, no silicones or parabens, and it absorbs in without leaving a film' },
  { handle: 'coconut-moisturizer', old: 'body-cream-not-in-it.png', file: 'body-cream-not-in-it-v2.png',
    alt: 'Coconut body cream with no synthetic fragrance, no lanolin and no parabens' },
  { handle: 'coconut-oil-deodorant', old: 'deodorant-not-in-it.png', file: 'deodorant-not-in-it-v2.png',
    alt: 'Natural deodorant with no aluminum, no propylene glycol and no synthetic fragrance' },
  { handle: 'coconut-oil-lip-balm', old: 'lip-balm-not-in-it.png', file: 'lip-balm-not-in-it-v2.png',
    alt: 'Natural lip balm with no paraffin, no lanolin and no menthol' },
];

// ── Preflight: every replacement exists, every alt is clean, every original is archived ──
for (const p of PLAN) {
  if (FORBIDDEN.test(p.alt)) throw new Error(`alt text for ${p.file} contains a ruled word`);
  if (!existsSync(join(NEW_DIR, p.file))) throw new Error(`missing replacement ${join(NEW_DIR, p.file)}`);
  if (!existsSync(join(ARCHIVE, p.handle, p.old))) throw new Error(`REFUSE: no archived original at ${join(ARCHIVE, p.handle, p.old)}`);
}

const touched = new Map();
for (const p of PLAN) {
  const product = (await getProducts({ handle: p.handle }))?.[0];
  if (!product) throw new Error(`${p.handle} not found`);
  touched.set(p.handle, product.id);
  const oldImg = product.images.find(i => fileOf(i.src) === p.old);
  const already = product.images.find(i => fileOf(i.src).startsWith(p.file.replace(/\.\w+$/, '')));
  console.log(`\n${p.handle} — ${p.old} → ${p.file}`);

  if (!oldImg && already) { console.log(`  SKIP  already applied (id ${already.id}, pos ${already.position})`); continue; }
  if (!oldImg) { console.log('  SKIP  old frame not on the product and no replacement found — investigate'); continue; }

  const bytes = readFileSync(join(NEW_DIR, p.file));
  console.log(`  ${APPLY ? 'POST  ' : 'DRY   '} ${p.file} → position ${oldImg.position} (${(bytes.length / 1024).toFixed(0)} KB), variants ${JSON.stringify(oldImg.variant_ids)}`);
  console.log(`  ${APPLY ? 'DELETE' : 'DRY   '} ${p.old} (id ${oldImg.id}) — archive OK`);
  if (!APPLY) continue;

  if (!already) {
    const res = await fetch(`${base}/products/${product.id}/images.json`, {
      method: 'POST', headers,
      body: JSON.stringify({ image: { attachment: bytes.toString('base64'), filename: p.file, alt: p.alt, position: oldImg.position, variant_ids: oldImg.variant_ids } }),
    });
    const body = await res.json();
    if (!res.ok || !body.image) { console.error('  FAILED add', res.status, JSON.stringify(body).slice(0, 300)); process.exit(1); }
    console.log(`         ✓ added id ${body.image.id} at position ${body.image.position}`);
    await sleep(1200);
  }
  const del = await fetch(`${base}/products/${product.id}/images/${oldImg.id}.json`, { method: 'DELETE', headers });
  if (!del.ok) { console.error(`  FAILED delete ${del.status}`); process.exit(1); }
  console.log('         ✓ removed old frame');
  await sleep(1200);
}

if (!APPLY) { console.log('\nDry run. Re-run with --apply to write.'); process.exit(0); }

await sleep(2500);
for (const [handle, id] of touched) {
  const { images } = await (await fetch(`${base}/products/${id}/images.json`, { headers })).json();
  console.log(`\nLIVE ${handle} (${images.length} images):`);
  for (const im of images.sort((a, b) => a.position - b.position)) {
    const bad = FORBIDDEN.test(im.alt || '') ? '   <<< ALT STILL NAMES A RULED WORD' : '';
    console.log(`  ${String(im.position).padStart(2)}  ${fileOf(im.src).slice(0, 48).padEnd(48)} ${im.src.split('?')[0]}${bad}`);
  }
}
