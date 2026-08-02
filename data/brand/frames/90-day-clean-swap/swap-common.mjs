/**
 * Clean Swap — shared frame furniture, for BOTH bundles.
 *
 * The 90-Day Clean Swap ($144) and The Clean Swap ($59) are the same four
 * products at 3x and 1x. Everything except the multiplier is identical, so the
 * frames are written once here and each bundle's modules pass their own handle
 * and quantity. That is also why the cutouts are named component-<product>-
 * <variant> rather than per-bundle: Head-to-Toe and the Gift Box draw from the
 * same eight files.
 *
 * Palette and type sizes match the Sensitive Skin Set's set-common.mjs on
 * purpose — a shopper who sees both galleries should see one brand, and the type
 * sizes there were already tuned against the 390px phone-width test.
 */

import { readFileSync } from 'node:fs';
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
 * One physical scale for every product in a frame.
 *
 * This bundle spans a much wider size range than the Sensitive Skin Set did — an
 * 8 fl oz lotion bottle against a 2 fl oz deodorant — so getting it wrong is more
 * visible, not less. Values are the apparent height of what each cutout depicts;
 * the soaps are shot face-on so their apparent height is the bar's diameter.
 */
export const APPARENT_CM = { lotion: 17.2, deodorant: 13.0, toothpaste: 15.5, soap: 8.9 };
export const scaled = (key, pxPerCm) => Math.round(APPARENT_CM[key] * pxPerCm);

/** Natural pixel dimensions of each cutout, so aspect is never guessed. */
export const NATURAL = {
  'lotion-pure-unscented': { w: 530, h: 1850 },
  'lotion-coconut-breeze': { w: 530, h: 1850 },
  'deodorant-calming-lavender': { w: 609, h: 1700 },
  'deodorant-geranium-flower': { w: 609, h: 1700 },
  'toothpaste-fresh-mint': { w: 501, h: 1865 },
  'soap-pure-unscented': { w: 1401, h: 1401 },
  'soap-calming-lavender': { w: 1401, h: 1401 },
  'soap-nourishing-tea-tree': { w: 1401, h: 1401 },
};

export const cutout = (slug) => `data/brand/cutouts/component-${slug}.png`;
export const kindOf = (slug) => slug.split('-')[0];

/**
 * The three kits, as they actually ship. Read from config/bundles.json rather
 * than transcribed — the whole point of frame 7 is that these differences are
 * true, and the media plan's own note is that toothpaste is Fresh Mint in all
 * three and must appear as a constant rather than as a difference.
 */
export function kitsFor(handle) {
  const { bundles } = JSON.parse(readFileSync(join(ROOT, 'config', 'bundles.json'), 'utf8'));
  const b = bundles.find((x) => x.handle === handle);
  if (!b) throw new Error(`config/bundles.json has no bundle "${handle}"`);
  return b.variants.map((v) => ({
    name: Object.values(v.options)[0],
    // Sorted into a fixed product order, NOT the order config/bundles.json happens
    // to list them in. That order differs per variant — Gentle lists soap third and
    // Calm lists it fourth — and rendering it verbatim put the same four products in
    // two different sequences across three frames of one gallery, which reads as a
    // mistake rather than as a variant difference.
    components: v.components
      .map((c) => ({
        product: c.product,
        variant: c.variant,
        qty: c.qty,
        slug: `${PRODUCT_SLUG[c.product]}-${c.variant.toLowerCase().replace(/\s+/g, '-')}`,
      }))
      .sort((a, z) => DISPLAY_ORDER.indexOf(a.product) - DISPLAY_ORDER.indexOf(z.product)),
  }));
}

/** Fixed left-to-right order for every frame in this directory. */
const DISPLAY_ORDER = ['coconut-lotion', 'coconut-oil-deodorant', 'coconut-oil-toothpaste', 'coconut-soap'];

const PRODUCT_SLUG = {
  'coconut-lotion': 'lotion',
  'coconut-oil-deodorant': 'deodorant',
  'coconut-oil-toothpaste': 'toothpaste',
  'coconut-soap': 'soap',
};

export const LABEL = {
  lotion: 'Body Lotion',
  deodorant: 'Deodorant',
  toothpaste: 'Toothpaste',
  soap: 'Bar Soap',
};

/** A product image at the frame's scale, optionally repeated. */
export function unit({ src, slug, pxPerCm, count = 1, overlap = 0, boxH }) {
  const nat = NATURAL[slug];
  if (!nat) throw new Error(`no natural size recorded for cutout "${slug}"`);
  const h = scaled(kindOf(slug), pxPerCm);
  const w = Math.round((nat.w / nat.h) * h);
  // Repeated units overlap rather than sitting apart. Twelve products at a scale
  // big enough to read would otherwise be ~2,500px wide in a 2,048px frame, and
  // shrinking them to fit defeats the only job this frame has. Overlapping reads
  // as a lineup and keeps every label legible.
  const shift = Math.round(w * overlap);
  const imgs = Array.from({ length: count }, (_, i) => `<img src="${src}" style="width:${w}px;height:${h}px;
    display:block;${i ? `margin-left:-${shift}px;` : ''}position:relative;z-index:${count - i};
    filter:drop-shadow(0 12px 18px rgba(26,27,24,.15)) drop-shadow(0 2px 3px rgba(26,27,24,.10));">`).join('');
  return `<div style="height:${boxH ?? h}px;display:flex;align-items:flex-end;">${imgs}</div>`;
}

/**
 * Shared guard. Every frame in this directory states the price and what the box
 * holds, so a reprice or a repack must stop the build rather than ship a stale
 * claim — which is exactly what the media plan did for weeks when it kept saying
 * $159 after the bundle moved to $144.
 */
export function assertBundle(ctx, { price, qtyEach, componentCount }) {
  const prices = ctx.variants.map((v) => Number(v.price));
  if (!prices.length) throw new Error('no variants returned');
  if (prices.some((p) => p !== price)) {
    throw new Error(`this frame prints ${money(price)}, but variants now sell for ${[...new Set(prices)].map(money).join(', ')}.`);
  }
  const qty = JSON.parse(ctx.need('component_qty'));
  if (qty.length !== componentCount || qty.some((q) => q !== qtyEach)) {
    throw new Error(
      `this frame shows ${componentCount} products at ${qtyEach}x each, but component_qty is now `
      + `${JSON.stringify(qty)}. Re-spec the frame before re-rendering.`);
  }
}
