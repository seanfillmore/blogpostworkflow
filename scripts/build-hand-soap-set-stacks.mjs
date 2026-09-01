#!/usr/bin/env node
/**
 * Give every Hand Soap Set variant the `bundle.value_stack` it has never had.
 *
 *   node scripts/build-hand-soap-set-stacks.mjs            # dry
 *   node scripts/build-hand-soap-set-stacks.mjs --apply    # writes 12 metafields
 *
 * ── WHY ─────────────────────────────────────────────────────────────────────
 * `hand-soap-set` is a live bundle-landing product and NONE of its 12 variants
 * carries a value_stack, so `whats-in-it` renders nothing — its "What's in the
 * box" was an empty padded band on a published page until the empty-section
 * guard hid it. Hiding it was the right immediate fix; the real fix is that the
 * box has contents and the page should show them.
 *
 * ── CONTENTS COME FROM config/bundles.json, NOT FROM THE VARIANT TITLE ───────
 * The titles are misleading in one place that matters: "3 pumps + body lotion /
 * Orange Zest" does NOT contain an orange zest lotion — no such lotion exists.
 * The roster says the lotion is Pure Unscented in every tier except Coconut
 * Breeze, which takes a Coconut Breeze lotion. Reading the scent off the variant
 * title would have put a scent on the page that RSC does not sell.
 *
 * ── THE ARITHMETIC IS CHECKED, NOT ASSERTED ─────────────────────────────────
 * Amounts are the components' real single prices ($13 hand soap, $30 lotion) and
 * every stack is run through `checkStackConsistency` against the variant's LIVE
 * compare-at before anything is written. That is the invariant `npm run
 * check-value-stacks` enforces store-wide, and the three tiers land on it
 * exactly: 4x13=52, 3x13+30=69, 4x13+30=82.
 *
 * ── TWO COMPONENT IMAGES HAD TO BE MADE ─────────────────────────────────────
 * The theme carried `component-handsoap-{orange-zest,pure-unscented}.webp` and
 * nothing for Calming Lavender or Coconut Breeze. They were cut from the real
 * PDP variant photographs rather than substituted, because showing an unscented
 * bottle over a "Calming Lavender" caption is precisely the image/label pairing
 * drift this repo already has a rule about. See `--build-images`.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isDirectRun } from '../lib/is-direct-run.js';
import { checkStackConsistency } from '../lib/bundle-value-stack.js';

const ROOT = process.env.SEO_CLAUDE_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');
export const HANDLE = 'hand-soap-set';

/** Single-unit list price of each component, from the live PDPs. */
export const UNIT_PRICE = Object.freeze({
  'organic-foaming-hand-soap': 13,
  'coconut-lotion': 30,
});

export const LABEL = Object.freeze({
  'organic-foaming-hand-soap': 'Foaming Hand Soap (8oz)',
  'coconut-lotion': 'Body Lotion (8oz)',
});

export const IMG_PREFIX = Object.freeze({
  'organic-foaming-hand-soap': 'component-handsoap-',
  'coconut-lotion': 'component-lotion-',
});

export const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * The bottle's column band inside the PDP studio shot, in 800px-wide coordinates.
 *
 * Measured, not eyeballed: the near-black cap and bottom label band give a bbox
 * of x[313..488] y[50..763] on ALL FOUR scent photographs — they are the same
 * shot with a different label. (Three of the four also return x1=629 because the
 * "MADE IN THE USA" badge carries dark navy; the badge sits outside the bottle's
 * band, which is why the band is taken from the narrowest reading.)
 *
 * The band is what excludes the badge, the foam-splash graphic and the reflection
 * without having to recognise any of them.
 */
export const BOTTLE_BAND = Object.freeze({ left: 305, right: 492, top: 40, bottom: 790, refWidth: 800 });

/**
 * Cut a component image from a PDP photograph.
 *
 * The background is removed by flooding INWARD from the border rather than by
 * thresholding, because the bottle body is white on a white backdrop: a plain
 * "near-white is background" rule eats the product. Flooding only reaches white
 * that is connected to the edge, so white enclosed by the bottle's own outline
 * survives.
 *
 * @returns {Promise<Buffer>} a webp, 420px tall, transparent background
 */
export async function cutComponent(sourceBuffer, sharp, band = BOTTLE_BAND) {
  const meta = await sharp(sourceBuffer).metadata();
  const S = meta.width / band.refWidth;
  const { data, info } = await sharp(sourceBuffer)
    .extract({
      left: Math.round(band.left * S),
      top: Math.round(band.top * S),
      width: Math.round((band.right - band.left) * S),
      height: Math.round((band.bottom - band.top) * S),
    })
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  const W = info.width, H = info.height, C = info.channels;
  const nearWhite = (i) => data[i] >= 242 && data[i + 1] >= 242 && data[i + 2] >= 242;
  const outside = new Uint8Array(W * H);
  const stack = [];
  const push = (x, y) => {
    const p = y * W + x;
    if (!outside[p] && nearWhite(p * C)) { outside[p] = 1; stack.push(p); }
  };
  for (let x = 0; x < W; x += 1) { push(x, 0); push(x, H - 1); }
  for (let y = 0; y < H; y += 1) { push(0, y); push(W - 1, y); }
  while (stack.length) {
    const p = stack.pop(); const x = p % W; const y = (p - x) / W;
    if (x > 0) push(x - 1, y);
    if (x < W - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < H - 1) push(x, y + 1);
  }
  for (let p = 0; p < W * H; p += 1) if (outside[p]) data[p * C + 3] = 0;

  const png = await sharp(data, { raw: { width: W, height: H, channels: C } }).png().toBuffer();
  return sharp(png).trim({ threshold: 1 }).resize({ height: 420 }).webp({ quality: 90 }).toBuffer();
}

/**
 * Build one variant's stack from its ROSTER components.
 * @returns {{label:string, qty:number, scent:string, amount:number, img:string}[]}
 */
export function stackFor(variant, unitPrice = UNIT_PRICE) {
  return variant.components.map((c) => {
    const unit = unitPrice[c.product];
    if (unit === undefined) throw new Error(`no unit price for component: ${c.product}`);
    return {
      label: LABEL[c.product],
      qty: c.qty,
      scent: c.variant,
      amount: unit * c.qty,
      img: `${IMG_PREFIX[c.product]}${slugify(c.variant)}.webp`,
    };
  });
}

export function loadVariants(root = ROOT) {
  const roster = JSON.parse(readFileSync(join(root, 'config', 'bundles.json'), 'utf8'));
  const b = roster.bundles.find((x) => x.handle === HANDLE);
  if (!b) throw new Error(`${HANDLE} is not in config/bundles.json`);
  return b.variants;
}

/** Roster variant -> the Shopify variant title Shopify actually stores. */
export const shopifyTitle = (v) => `${v.options.Configuration} / ${v.options.Scent}`;

/**
 * Upload the component images the theme is missing, cut from the real PDP
 * photographs. Additive only — an asset that already exists is left alone, so
 * this can never overwrite artwork somebody made by hand.
 */
async function buildImages(themes, apply) {
  const sharp = (await import('sharp')).default;
  const { shopifyGraphQL, listThemeAssets, getAccessToken } = await import('../lib/shopify.js');
  const { API_VERSION } = await import('../lib/shopify-api-version.js');
  const store = readFileSync(join(ROOT, '.env'), 'utf8').match(/^SHOPIFY_STORE=(.*)$/m)[1].replace(/["']/g, '').trim();

  const r = await shopifyGraphQL(
    '{ productByIdentifier(identifier:{handle:"organic-foaming-hand-soap"}){ variants(first:20){ nodes{ title image{ url } } } } }',
  );
  for (const theme of themes) {
    const have = new Set((await listThemeAssets(theme)).map((a) => a.key));
    for (const v of r.productByIdentifier.variants.nodes) {
      const key = `assets/component-handsoap-${slugify(v.title)}.webp`;
      if (have.has(key)) { console.log(`  present  ${theme}  ${key}`); continue; }
      if (!v.image?.url) { console.log(`  NO PHOTO ${theme}  ${key}`); continue; }
      const src = Buffer.from(await (await fetch(`${v.image.url}&width=2000`)).arrayBuffer());
      const out = await cutComponent(src, sharp);
      const m = await sharp(out).metadata();
      console.log(`  ${apply ? 'upload ' : 'WOULD  '} ${theme}  ${key}  ${m.width}x${m.height}`);
      if (!apply) continue;
      const res = await fetch(`https://${store}/admin/api/${API_VERSION}/themes/${theme}/assets.json`, {
        method: 'PUT',
        headers: { 'X-Shopify-Access-Token': await getAccessToken(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ asset: { key, attachment: out.toString('base64') } }),
      });
      if (!res.ok) { console.error(`    failed: HTTP ${res.status}`); return 1; }
    }
  }
  return 0;
}

async function main(argv) {
  const apply = argv.includes('--apply');
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('Usage: node scripts/build-hand-soap-set-stacks.mjs [--build-images --theme <id>...] [--apply]');
    return 0;
  }
  if (argv.includes('--build-images')) {
    const themes = argv.reduce((a, t, i) => (t === '--theme' ? [...a, argv[i + 1]] : a), []);
    if (!themes.length) { console.error('--build-images needs at least one --theme <id>'); return 64; }
    return buildImages(themes, apply);
  }
  const { shopifyGraphQL } = await import('../lib/shopify.js');

  const live = await shopifyGraphQL(
    `{ productByIdentifier(identifier:{handle:"${HANDLE}"}){ id title
         variants(first:50){ nodes{ id title price compareAtPrice
           metafield(namespace:"bundle", key:"value_stack"){ value } } } } }`,
  );
  const p = live.productByIdentifier;
  if (!p) { console.error(`${HANDLE} not found on this store`); return 1; }
  const byTitle = new Map(p.variants.nodes.map((v) => [v.title, v]));

  const writes = [];
  let problems = 0;
  for (const rv of loadVariants()) {
    const title = shopifyTitle(rv);
    const lv = byTitle.get(title);
    if (!lv) { console.log(`  NO SUCH VARIANT  ${title}`); problems += 1; continue; }

    const stack = stackFor(rv);
    const check = checkStackConsistency({
      stack, compareAtPrice: lv.compareAtPrice, price: lv.price,
    });
    const total = check.total;
    if (!check.ok) {
      console.log(`  INCONSISTENT  ${title}`);
      for (const pr of check.problems) console.log(`      ${pr}`);
      problems += 1;
      continue;
    }
    const had = lv.metafield?.value ? 'REPLACE' : 'ADD    ';
    console.log(`  ${had}  ${title.padEnd(38)} $${total} vs compare-at $${lv.compareAtPrice}, saves $${check.savings}`);
    for (const r of stack) console.log(`            ${r.qty} x ${r.label} — ${r.scent} ($${r.amount})  ${r.img}`);
    writes.push({ ownerId: lv.id, namespace: 'bundle', key: 'value_stack', type: 'json', value: JSON.stringify(stack) });
  }

  if (problems) { console.error(`\n${problems} variant(s) failed — nothing written.`); return 1; }
  if (!apply) { console.log(`\n${writes.length} variant(s) would get a value_stack. Re-run with --apply.`); return 0; }

  // metafieldsSet takes at most 25 per call; 12 fits in one.
  const res = await shopifyGraphQL(
    `mutation($m:[MetafieldsSetInput!]!){ metafieldsSet(metafields:$m){ userErrors{ field message } } }`,
    { m: writes },
  );
  if (res.metafieldsSet.userErrors.length) { console.error('FAILED:', res.metafieldsSet.userErrors); return 1; }
  console.log(`\nwrote ${writes.length} value_stack metafields. Verify the rendered page before calling this done.`);
  return 0;
}

if (isDirectRun(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
