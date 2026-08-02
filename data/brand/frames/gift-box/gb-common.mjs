/**
 * Gift Box — shared frame furniture.
 *
 * Four products, three kits. Palette, type sizes and the physical-scale basis are
 * the same as h2t-common.mjs and swap-common.mjs on purpose — a shopper who lands
 * on two bundle pages should see one brand.
 *
 * ── What makes this bundle different ────────────────────────────────────────
 * Every other bundle on this template is a shipment to the person who bought it.
 * This one is an OBJECT one person hands to another, and the media plan is blunt
 * that the whole $62 rests on it arriving giftable. That is a photographic claim
 * and no composite can make it: frames 1 and 2 of the spec are MUST-SHOOT and
 * stay unbuilt here. What is built is everything that does NOT depend on
 * photographing a box we have no photograph of.
 *
 * ── Two claims this bundle must never make ──────────────────────────────────
 * Both are live traps recorded in the media plan, and both are enforced in code
 * rather than left to whoever writes the next frame:
 *
 *   · "unscented" — the Gentle and Calm kits both ship a Calming Lavender
 *     deodorant. The site's own FAQ says we do not make an unscented deodorant,
 *     so the box cannot be called unscented. The honest line is that there is no
 *     SYNTHETIC fragrance, and scent where it exists is essential oil.
 *   · "vegan" / "no palm oil" — the lip balm carries organic beeswax and organic
 *     red palm oil. Both claims are false for every kit.
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

/** Apparent height in cm — the values already established by the other bundles' frames. */
export const APPARENT_CM = { lotion: 17.2, deodorant: 13.0, soap: 8.9, lipbalm: 6.8 };
export const scaled = (key, pxPerCm) => Math.round(APPARENT_CM[key] * pxPerCm);

export const cutout = (slug) => `data/brand/cutouts/component-${slug}.png`;
export const kindOf = (slug) => slug.split('-')[0];

/** Natural size read from the PNG header, never transcribed. */
const sizeCache = new Map();
export function natural(slug) {
  if (sizeCache.has(slug)) return sizeCache.get(slug);
  const fd = openSync(join(ROOT, cutout(slug)), 'r');
  const buf = Buffer.alloc(24);
  readSync(fd, buf, 0, 24, 0);
  closeSync(fd);
  if (buf.toString('ascii', 1, 4) !== 'PNG') throw new Error(`${cutout(slug)} is not a PNG`);
  const dim = { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  sizeCache.set(slug, dim);
  return dim;
}

const PRODUCT_SLUG = {
  'coconut-lotion': 'lotion',
  'coconut-oil-deodorant': 'deodorant',
  'coconut-soap': 'soap',
  'coconut-oil-lip-balm': 'lipbalm',
};

export const LABEL = {
  lotion: 'Body Lotion',
  deodorant: 'Deodorant',
  soap: 'Bar Soap',
  lipbalm: 'Lip Balm',
};

/**
 * How many physical units one purchased unit of each component IS.
 *
 * The lip balm is the only component where this is not 1: its SKU is "Natural
 * Coconut Oil Lip Balm | 0.15oz | Four Pack", so one unit is four tubes, and the
 * media plan is explicit that a single-tube photo understates the box.
 *
 * Read out of the product title in data/brand/product-catalog.json rather than
 * typed, on the same principle as every other figure in these frames: the frame
 * draws four tubes because the SKU says four, not because somebody once knew it
 * did. If the pack size changes, the title changes and the drawing follows.
 */
function packSizeOf(handle) {
  const { products } = JSON.parse(readFileSync(join(ROOT, 'data', 'brand', 'product-catalog.json'), 'utf8'));
  const title = products[handle]?.title;
  if (!title) throw new Error(`data/brand/product-catalog.json has no product "${handle}"`);
  const WORD = { two: 2, three: 3, four: 4, five: 5, six: 6, eight: 8, ten: 10, twelve: 12 };
  const m = title.match(/(\d+)[\s-]?pack/i) ?? title.match(/\b(two|three|four|five|six|eight|ten|twelve)[\s-]?pack\b/i);
  if (!m) return 1;
  return Number(m[1]) || WORD[m[1].toLowerCase()];
}

export const UNITS_PER = {
  lotion: packSizeOf('coconut-lotion'),
  deodorant: packSizeOf('coconut-oil-deodorant'),
  soap: packSizeOf('coconut-soap'),
  lipbalm: packSizeOf('coconut-oil-lip-balm'),
};

/** Fixed left-to-right order, tallest first, derived rather than typed. */
export const DISPLAY_ORDER = Object.keys(APPARENT_CM).sort((a, z) => APPARENT_CM[z] - APPARENT_CM[a]);

export function kitsFor(handle = 'gift-box') {
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

export const inOrder = (kit, order = DISPLAY_ORDER) => order.map((k) => {
  const c = kit.components.find((x) => x.kind === k);
  if (!c) throw new Error(`the ${kit.name} kit has no ${k}`);
  return c;
});

/**
 * One product at the frame's scale, repeated where a single purchased unit is
 * physically several things. Repeats overlap so four lip balm tubes read as a
 * four-pack rather than as four separate line items.
 */
export function unit({ src, slug, pxPerCm, count = 1, overlap = 0.55, boxH }) {
  const nat = natural(slug);
  const h = scaled(kindOf(slug), pxPerCm);
  const w = Math.round((nat.w / nat.h) * h);
  const shift = Math.round(w * overlap);
  const imgs = Array.from({ length: count }, (_, i) => `<img src="${src}" style="width:${w}px;height:${h}px;
    display:block;${i ? `margin-left:-${shift}px;` : ''}position:relative;z-index:${count - i};
    filter:drop-shadow(0 12px 18px rgba(26,27,24,.15)) drop-shadow(0 2px 3px rgba(26,27,24,.10));">`).join('');
  return `<div style="height:${boxH ?? h}px;display:flex;align-items:flex-end;">${imgs}</div>`;
}

/** The four components' base ingredients, unioned. The evidence for the ingredient frame. */
export function ingredientUnion() {
  const ing = JSON.parse(readFileSync(join(ROOT, 'config', 'ingredients.json'), 'utf8'));
  const keys = { lotion: 'lotion', soap: 'bar_soap', deodorant: 'deodorant', lipbalm: 'lip_balm' };
  const set = new Set();
  for (const k of Object.values(keys)) {
    const p = ing[k];
    if (!p) throw new Error(`config/ingredients.json has no "${k}"`);
    for (const i of p.base_ingredients) set.add(i);
  }
  return [...set].sort();
}

/**
 * Assert an absence claim against config/ingredients.json rather than trusting it.
 * Searches the four components' whole records, so an ingredient hiding in a
 * variation's essential-oil list counts as present.
 */
export function assertAbsent(terms) {
  const ing = JSON.parse(readFileSync(join(ROOT, 'config', 'ingredients.json'), 'utf8'));
  const keys = ['lotion', 'bar_soap', 'deodorant', 'lip_balm'];
  const ingredients = [];
  for (const k of keys) {
    const p = ing[k];
    ingredients.push(...p.base_ingredients);
    for (const v of p.variations ?? []) ingredients.push(...(v.essential_oils ?? []));
  }
  const hay = ingredients.join(' | ').toLowerCase();
  for (const t of terms) {
    if (hay.includes(t.toLowerCase())) {
      throw new Error(`this frame claims the box contains no "${t}", but config/ingredients.json lists it in one of the four components`);
    }
  }
  return ingredients.length;
}

export function assertBundle(ctx, { price, componentCount = 4 }) {
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
    for (const c of kit.components) natural(c.slug);
  }
}

/**
 * The word "unscented" must never reach a Gift Box frame. Two of the three kits
 * ship a Calming Lavender deodorant, and the site's FAQ says we do not make an
 * unscented deodorant — so the BOX is not unscented even when most of it is.
 * Individual component variant names ("Pure Unscented") are exempt: naming the
 * lotion's actual variant is a fact, calling the box unscented is a claim.
 */
export function assertNoUnscentedClaim(text) {
  const stripped = String(text).replace(/Pure Unscented/g, '');
  if (/unscented/i.test(stripped)) {
    throw new Error('a Gift Box frame used the word "unscented" outside a component variant name. '
      + 'Two of three kits contain a Calming Lavender deodorant; the box is not unscented. '
      + 'Say "no synthetic fragrance" instead.');
  }
  return text;
}

export function altWithin512(text) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  if (t.length > 512) throw new Error(`alt text is ${t.length} characters; Shopify's ceiling is 512.`);
  return t;
}
