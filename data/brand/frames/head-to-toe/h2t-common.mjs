/**
 * Head-to-Toe — shared frame furniture.
 *
 * Seven products, two kits, six frames. Everything the frames must agree about
 * lives here: the palette, the physical scale, the display orders, and the guard
 * that the box still holds what the frames say it holds.
 *
 * Palette and type sizes match swap-common.mjs and set-common.mjs on purpose. A
 * shopper who lands on two bundle pages should see one brand, and those sizes
 * were already tuned against the 390px phone-width test.
 *
 * ── Why this bundle is the awkward one ──────────────────────────────────────
 * The Clean Swaps span 8 fl oz to 2 fl oz. This one spans a 21.5cm foaming pump
 * to a 6.4cm cream jar — the widest size range in the roster — so a frame that
 * draws all seven at one honest scale has a lip balm one twelfth the height of
 * the hand soap in it. That is a real fact about the box and the frames show it,
 * but it is also why only ONE frame here draws all seven at once: at seven
 * products the per-unit labels stop being legible before the products do.
 */

import { readFileSync, openSync, readSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

export const INK = '#1a1b18';
export const GREEN = '#4a8b3c';
export const PAPER = '#ffffff';
export const RULE = '#e4e8e0';
export const WASH = '#f7f8f5';

export const money = (n) => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`);

/**
 * Apparent height in cm of what each cutout depicts — the basis for drawing every
 * product in a frame to one scale. The cutouts come from seven shoots at seven
 * pixel densities, so their native sizes say nothing about each other.
 *
 * lotion / cream / soap / lipbalm carry the values already established by
 * swap-common.mjs and set-common.mjs, so the same bottle is never a different
 * size on two bundle pages.
 *
 * `handsoap` is the one value in this file that no earlier frame had established,
 * and it is deliberately not a guess. Two independent routes agree:
 *   · the "8 fl. oz · 236ml" line is printed on both the lotion and the hand soap
 *     from the same label template, and measures 22px on the lotion shot against
 *     17px on the hand soap shot — so the hand soap is photographed at 0.77x the
 *     lotion's magnification, putting its 1836px cutout at ~22.5cm;
 *   · working back from the fill: the cutout's body is 1226px of its 1836px
 *     height, so at 21.5cm the body is 14.4cm at 5.2cm across, a 303ml cylinder
 *     holding a 236ml fill. At the 18.5cm a pump bottle "looks like", the same
 *     body computes to 194ml and could not hold the 236ml the label states.
 * 21.5 is the value taken. It is the one number here worth checking with a ruler.
 */
export const APPARENT_CM = {
  handsoap: 21.5,
  lotion: 17.2,
  toothpaste: 15.5,
  deodorant: 13.0,
  soap: 8.9,
  lipbalm: 6.8,
  cream: 6.4,
};

export const scaled = (key, pxPerCm) => Math.round(APPARENT_CM[key] * pxPerCm);

export const cutout = (slug) => `data/brand/cutouts/component-${slug}.png`;
export const kindOf = (slug) => slug.split('-')[0];

/**
 * Natural pixel size of a cutout, read from the PNG header rather than
 * transcribed into a table.
 *
 * swap-common.mjs keeps a hand-written NATURAL map, and it had to be corrected in
 * two of the three cutout rebuilds because re-cutting a product changes its
 * dimensions and the table did not follow. Since scripts/rebuild-cutouts.mjs can
 * now regenerate the whole library from a manifest, a transcribed size is a
 * staleness bug waiting to happen. The IHDR chunk is at a fixed offset, so this
 * costs 24 bytes and removes the failure mode.
 */
const sizeCache = new Map();
export function natural(slug) {
  if (sizeCache.has(slug)) return sizeCache.get(slug);
  const path = join(ROOT, cutout(slug));
  const fd = openSync(path, 'r');
  const buf = Buffer.alloc(24);
  readSync(fd, buf, 0, 24, 0);
  closeSync(fd);
  if (buf.toString('ascii', 1, 4) !== 'PNG') throw new Error(`${path} is not a PNG`);
  const dim = { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  sizeCache.set(slug, dim);
  return dim;
}

const PRODUCT_SLUG = {
  'coconut-lotion': 'lotion',
  'coconut-moisturizer': 'cream',
  'coconut-oil-deodorant': 'deodorant',
  'coconut-oil-toothpaste': 'toothpaste',
  'coconut-soap': 'soap',
  'coconut-oil-lip-balm': 'lipbalm',
  'organic-foaming-hand-soap': 'handsoap',
};

export const LABEL = {
  lotion: 'Body Lotion',
  cream: 'Body Cream',
  deodorant: 'Deodorant',
  toothpaste: 'Toothpaste',
  soap: 'Bar Soap',
  lipbalm: 'Lip Balm',
  handsoap: 'Hand Soap',
};

/**
 * The bundle's name, made literal. This is the mapping frame 2 exists to show —
 * "seven products" is a number, "teeth, lips, underarms, hands, shower, body,
 * overnight" is a shelf the buyer recognises as their own.
 */
export const BODY_PART = {
  toothpaste: 'Teeth',
  lipbalm: 'Lips',
  deodorant: 'Underarms',
  handsoap: 'Hands',
  soap: 'Shower',
  lotion: 'Body',
  cream: 'Overnight',
};

/** Head to toe, top down. Frame 2's order. */
export const BODY_ORDER = ['toothpaste', 'lipbalm', 'deodorant', 'handsoap', 'soap', 'lotion', 'cream'];

/** Tallest to shortest, derived from APPARENT_CM rather than typed out. Frame 1's order. */
export const HEIGHT_ORDER = Object.keys(APPARENT_CM).sort((a, z) => APPARENT_CM[z] - APPARENT_CM[a]);

/**
 * The two kits as they actually ship, read from config/bundles.json rather than
 * transcribed — frame 4's entire job is that the differences between them are
 * true, and a transcribed list is exactly how that stops being true.
 */
export function kitsFor(handle = 'head-to-toe') {
  const { bundles } = JSON.parse(readFileSync(join(ROOT, 'config', 'bundles.json'), 'utf8'));
  const b = bundles.find((x) => x.handle === handle);
  if (!b) throw new Error(`config/bundles.json has no bundle "${handle}"`);
  return b.variants.map((v) => ({
    name: Object.values(v.options)[0],
    price: Number(v.price),
    compareAt: Number(v.compareAtPrice),
    components: v.components.map((c) => {
      const kind = PRODUCT_SLUG[c.product];
      if (!kind) throw new Error(`no cutout naming for component product "${c.product}"`);
      return { product: c.product, variant: c.variant, qty: c.qty, kind, slug: `${kind}-${c.variant.toLowerCase().replace(/\s+/g, '-')}` };
    }),
  }));
}

/** A kit's components in a stated display order, so no two frames disagree about sequence. */
export const inOrder = (kit, order) => order.map((k) => {
  const c = kit.components.find((x) => x.kind === k);
  if (!c) throw new Error(`the ${kit.name} kit has no ${k}`);
  return c;
});

/** One product image at the frame's scale. */
export function unit({ src, slug, pxPerCm, boxH }) {
  const nat = natural(slug);
  const h = scaled(kindOf(slug), pxPerCm);
  const w = Math.round((nat.w / nat.h) * h);
  return `<div style="height:${boxH ?? h}px;display:flex;align-items:flex-end;">
    <img src="${src}" style="width:${w}px;height:${h}px;display:block;
      filter:drop-shadow(0 12px 18px rgba(26,27,24,.15)) drop-shadow(0 2px 3px rgba(26,27,24,.10));"></div>`;
}

/**
 * Shared guard. Every frame here states the price and the fact that the box holds
 * seven products, so a reprice or a repack must stop the build rather than ship a
 * stale claim.
 *
 * This bundle has already done exactly that once: it repriced from $105 to $87 on
 * 2026-07-31 and its own SEO title still said $105 two days later, because that
 * figure was typed rather than derived.
 */
export function assertBundle(ctx, { price, componentCount = 7 }) {
  const prices = ctx.variants.map((v) => Number(v.price));
  if (!prices.length) throw new Error('no variants returned');
  if (prices.some((p) => p !== price)) {
    throw new Error(`this frame prints ${money(price)}, but variants now sell for ${[...new Set(prices)].map(money).join(', ')}.`);
  }
  const qty = JSON.parse(ctx.need('component_qty'));
  if (qty.length !== componentCount || qty.some((q) => q !== 1)) {
    throw new Error(`this frame shows ${componentCount} products at 1x each, but component_qty is now ${JSON.stringify(qty)}.`);
  }
  for (const kit of kitsFor()) {
    if (kit.components.length !== componentCount) {
      throw new Error(`the ${kit.name} kit lists ${kit.components.length} components, frame assumes ${componentCount}`);
    }
    for (const c of kit.components) natural(c.slug);   // throws if the cutout is missing
  }
}

/** Shopify rejects alt text over 512 characters, mid-gallery, after four images are already live. */
export function altWithin512(text) {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length > 512) throw new Error(`alt text is ${t.length} characters; Shopify's ceiling is 512. Shorten it here, not at upload.`);
  return t;
}
