/**
 * Sensitive Skin Set — shared frame furniture.
 *
 * Three frames (1, 3, 6) draw the same two products, and two of them also draw
 * the gift. Everything that must agree across them lives here: the palette, the
 * physical scale, the caption treatment, and the guard that the set still
 * contains what the frames say it contains.
 *
 * The Reset established this shape with routine-frame.mjs. The reason to repeat
 * it is narrower than "less duplication": if PX_PER_CM or APPARENT_CM were
 * copied into each frame, one frame could be re-tuned and the gallery would then
 * show the same bottle at two different sizes across adjacent slots, which is
 * exactly the cross-panel inconsistency marketing-ai-product-imagery says to
 * reject an asset over.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

export const INK = '#1a1b18';
export const GREEN = '#4a8b3c';
export const PAPER = '#ffffff';
export const RULE = '#e4e8e0';

export const HANDLE = 'sensitive-skin-starter-set';
export const PRICE = 46.8;

export const money = (n) => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`);

/**
 * Every product is drawn to ONE physical scale within a frame, so the frames are
 * honest about relative size — a 0.15 oz lip balm must not read as the size of a
 * 3.4 oz soap bar. The four cutouts come from four shoots at four pixel
 * densities, so their native pixel sizes say nothing about each other; the basis
 * has to be the real object.
 *
 * Values are the *apparent* height of what each cutout depicts. The cream jar and
 * the soap bar are both shot at a slight top angle, so what the image shows is
 * taller than the object's true height.
 */
export const APPARENT_CM = { lotion: 17.2, cream: 6.4, soap: 8.0, balm: 6.8 };

/** Frames with fewer products can afford a larger scale; within a frame it is one number. */
export const scaled = (key, pxPerCm) => Math.round(APPARENT_CM[key] * pxPerCm);

export const CUTOUT = {
  lotion: 'data/brand/cutouts/sensitive-set-lotion.png',
  cream: 'data/brand/cutouts/sensitive-set-cream.png',
  soap: 'data/brand/cutouts/sensitive-set-bar-soap.png',
  balm: 'data/brand/cutouts/sensitive-set-lip-balm.png',
};

export const NATURAL = {
  lotion: { w: 360, h: 1240 },
  cream: { w: 735, h: 670 },
  soap: { w: 1491, h: 1491 },
  balm: { w: 368, h: 1680 },
};

/**
 * A product with its name and a note beneath it.
 *
 * Type sizes are deliberately large. They were set by viewing the frame at 390px
 * — the width a phone gallery actually renders it at — not on the 2048px canvas,
 * per the phone-size rule in marketing-product-image-stack. At the first pass's
 * sizes the volumes and prices were unreadable at that width.
 */
export function item({ src, cm, name, note, count = 1, pxPerCm, onDark = false, boxH }) {
  const { w, h } = NATURAL[cm];
  const targetH = scaled(cm, pxPerCm);
  const width = Math.round((w / h) * targetH);
  // Products of different heights sitting in *different* flex containers (frame 3's
  // two halves) have no common baseline, so their captions land at different
  // heights and the split reads as a mistake. Passing one boxH to every item puts
  // every product on the same floor and every caption on the same line.
  const shelf = boxH ?? targetH;
  const shadow = onDark
    ? 'drop-shadow(0 18px 26px rgba(0,0,0,.55)) drop-shadow(0 3px 5px rgba(0,0,0,.4))'
    : 'drop-shadow(0 14px 20px rgba(26,27,24,.16)) drop-shadow(0 2px 3px rgba(26,27,24,.12))';
  const nameColor = onDark ? '#ffffff' : INK;
  const img = `<img src="${src}" style="width:${width}px;height:${targetH}px;display:block;filter:${shadow};">`;
  return `<div style="display:flex;flex-direction:column;align-items:center;justify-content:flex-end;">
    <div style="height:${shelf}px;display:flex;align-items:flex-end;gap:${count > 1 ? 14 : 0}px;">
      ${img.repeat(count)}
    </div>
    <div style="font-family:Cabin;font-weight:700;font-size:48px;color:${nameColor};margin-top:28px;text-align:center;">${name}</div>
    <div style="font-family:Outfit;font-weight:400;font-size:38px;color:${nameColor};opacity:${onDark ? '.72' : '.6'};margin-top:10px;text-align:center;">${note}</div>
  </div>`;
}

/**
 * The set's contents, from config/bundles.json — the documented source of truth
 * for what is in a bundle. Shopify does not carry it: this product has no
 * component metafield, only rating fields (checked 2026-08-01).
 */
export function setComponents() {
  const { bundles } = JSON.parse(readFileSync(join(ROOT, 'config', 'bundles.json'), 'utf8'));
  if (!Array.isArray(bundles)) throw new Error('config/bundles.json no longer has a top-level "bundles" array');
  const set = bundles.find((b) => b.handle === HANDLE);
  if (!set) throw new Error(`config/bundles.json no longer has a bundle with handle "${HANDLE}"`);
  if (set.variants.length !== 1) {
    throw new Error(`the set now has ${set.variants.length} variants; these frames assume one and carry no variant scoping`);
  }
  return set.variants[0].components;
}

/**
 * The real, full ingredient list for one of the set's products, from
 * config/ingredients.json. Both products in this set are Pure Unscented, whose
 * `essential_oils` is an empty array — which is the fact frame 2 is built on.
 */
export function ingredientsFor(productKey, variantName = 'Pure Unscented') {
  const ing = JSON.parse(readFileSync(join(ROOT, 'config', 'ingredients.json'), 'utf8'));
  const p = ing[productKey];
  if (!p) throw new Error(`config/ingredients.json has no "${productKey}"`);
  const v = p.variations.find((x) => x.name === variantName);
  if (!v) throw new Error(`config/ingredients.json has no "${variantName}" variation of ${productKey}`);
  return [...p.base_ingredients, ...(v.essential_oils ?? [])];
}

/**
 * The unique ingredients across the whole set — the number frame 4 prints.
 *
 * It is EIGHT: the lotion's six and the cream's seven share five, the lotion
 * alone brings jojoba, and the cream alone brings palm stearic and beeswax. The
 * media plan originally specced "nine", from a stale config that listed the
 * cream's grapefruit seed extract without "organic" and so counted it twice.
 * Derived here rather than typed, so it cannot go stale the same way again.
 */
export function setIngredientUnion() {
  const seen = new Set();
  const out = [];
  for (const key of ['lotion', 'cream']) {
    for (const i of ingredientsFor(key)) {
      const k = i.toLowerCase().trim();
      if (!seen.has(k)) { seen.add(k); out.push(i); }
    }
  }
  return out;
}

/**
 * The essential oils declared for one variant. Pure Unscented is defined by this
 * being empty, which is the fact frame 2's headline rests on — so it is read
 * rather than assumed.
 */
export function essentialOilsFor(productKey, variantName = 'Pure Unscented') {
  const ing = JSON.parse(readFileSync(join(ROOT, 'config', 'ingredients.json'), 'utf8'));
  const v = ing[productKey]?.variations?.find((x) => x.name === variantName);
  if (!v) throw new Error(`config/ingredients.json has no "${variantName}" variation of ${productKey}`);
  return v.essential_oils ?? [];
}

/** Anything that would make "fragrance-free" untrue if it appeared in a list. */
export const FRAGRANCE_TERMS = /fragrance|parfum|perfume|aroma|essential oil/i;

/**
 * Shared guard: the set still costs what the frames print, and still contains
 * exactly one lotion and one cream. A repack is the thing that would quietly
 * falsify every frame in this directory at once, so each one asserts it.
 */
export function assertSetIntact(ctx) {
  const price = Number(ctx.variants.find((v) => v.title === 'Default Title')?.price);
  if (price !== PRICE) {
    throw new Error(`these frames print ${money(PRICE)}, but the set now sells for ${money(price)}.`);
  }

  const components = setComponents();
  const want = [
    { product: 'coconut-lotion', qty: 1 },
    { product: 'coconut-moisturizer', qty: 1 },
  ];
  if (components.length !== want.length) {
    throw new Error(
      `these frames show ${want.length} products, but the set now ships ${components.length}: `
      + `${components.map((c) => `${c.qty}x ${c.product}`).join(', ')}. Re-spec the frames before re-rendering.`);
  }
  for (const { product, qty } of want) {
    const got = components.find((c) => c.product === product);
    if (!got) throw new Error(`the set no longer contains ${product}; these frames depict it.`);
    if (got.qty !== qty) throw new Error(`the set now ships ${got.qty}x ${product}, not ${qty}x.`);
    if (got.variant !== 'Pure Unscented') {
      throw new Error(`the set's ${product} is now "${got.variant}"; every cutout here is Pure Unscented.`);
    }
  }
}
