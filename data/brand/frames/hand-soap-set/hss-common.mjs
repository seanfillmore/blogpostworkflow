/**
 * Hand Soap Set — shared frame furniture.
 *
 * ── Why this bundle is the fiddliest in the roster ──────────────────────────
 * It has TWO options — Configuration (4 pumps / 3 pumps + body lotion / 4 pumps
 * + body lotion) and Scent (Variety + four scents) — and 15 variants. The
 * theme's gang convention scopes a media to exactly ONE option/value pair:
 * `gang_option_name` is parsed from that media's own alt suffix and matched
 * against whichever product option shares the name. There is no way to say "this
 * image is for 4 pumps AND Orange Zest", so fifteen fully-specific contents
 * frames cannot exist.
 *
 * The way out is to stop trying to put both facts in one frame:
 *
 *   · Configuration frames carry the COUNT and the price. Typographic, because
 *     the scent is unknown at that point and drawing a Pure Unscented bottle for
 *     a buyer who picked Orange Zest is exactly the variant-blindness that was
 *     just removed from the "What's in the box" grid.
 *   · Scent frames carry the SCENT. One bottle, large, with its real oil list.
 *     True for every configuration, because it says nothing about how many.
 *   · Two unscoped frames lead, and they must lead: `gang_exist` is assigned
 *     once before the media loop and only ever set true, so any unscoped media
 *     rendered after a scoped one is hidden for EVERY variant.
 *
 * A buyer who has chosen both sees four images: the range, the proof, their
 * configuration's count and price, and their scent's bottle. Between them that
 * is the whole purchase.
 *
 * ── One more thing this product does not have ───────────────────────────────
 * It sits on the DEFAULT PDP template, not `bundle-landing`, so it has no
 * per-variant value panel and no "What's in the box" grid. The gallery is the
 * only thing on the page that says what you get. That is why the configuration
 * frames carry the price as well as the count.
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

/** Apparent heights already established by the other bundles' frames. */
export const APPARENT_CM = { handsoap: 21.5, lotion: 17.2 };
export const scaled = (key, pxPerCm) => Math.round(APPARENT_CM[key] * pxPerCm);

export const cutout = (slug) => `data/brand/cutouts/component-${slug}.png`;
export const kindOf = (slug) => slug.split('-')[0];

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

const PRODUCT_SLUG = { 'organic-foaming-hand-soap': 'handsoap', 'coconut-lotion': 'lotion' };
export const LABEL = { handsoap: 'Foaming Hand Soap', lotion: 'Body Lotion (8oz)' };

/** The four scents, in the order the option lists them after Variety. */
export const SCENTS = ['Calming Lavender', 'Orange Zest', 'Coconut Breeze', 'Pure Unscented'];
export const scentSlug = (s) => `handsoap-${s.toLowerCase().replace(/\s+/g, '-')}`;

/** Every variant of the set, grouped by Configuration. */
export function configurations(handle = 'hand-soap-set') {
  const { bundles } = JSON.parse(readFileSync(join(ROOT, 'config', 'bundles.json'), 'utf8'));
  const b = bundles.find((x) => x.handle === handle);
  if (!b) throw new Error(`config/bundles.json has no bundle "${handle}"`);
  const byConfig = new Map();
  for (const v of b.variants) {
    const cfg = v.options.Configuration;
    const scent = v.options.Scent;
    if (!byConfig.has(cfg)) {
      byConfig.set(cfg, { name: cfg, price: Number(v.price), compareAt: Number(v.compareAtPrice), scents: [], byScent: new Map() });
    }
    const g = byConfig.get(cfg);
    if (Number(v.price) !== g.price || Number(v.compareAtPrice) !== g.compareAt) {
      throw new Error(`configuration "${cfg}" is not one price across scents — ${g.price}/${g.compareAt} vs ${v.price}/${v.compareAtPrice}. `
        + 'The configuration frames print one price for the whole configuration.');
    }
    g.scents.push(scent);
    g.byScent.set(scent, v.components.map((c) => ({
      product: c.product, variant: c.variant, qty: c.qty, kind: PRODUCT_SLUG[c.product],
    })));
  }
  return [...byConfig.values()];
}

/** Counts for one configuration, taken from a single-scent variant so quantities are unambiguous. */
export function countsFor(config) {
  const single = config.scents.find((s) => s !== 'Variety') ?? config.scents[0];
  const comps = config.byScent.get(single);
  const pumps = comps.filter((c) => c.kind === 'handsoap').reduce((a, c) => a + c.qty, 0);
  const lotions = comps.filter((c) => c.kind === 'lotion').reduce((a, c) => a + c.qty, 0);
  // Variety must hold the same TOTAL, or the configuration frame's count is only
  // true for some of its variants.
  for (const s of config.scents) {
    const cs = config.byScent.get(s);
    const p = cs.filter((c) => c.kind === 'handsoap').reduce((a, c) => a + c.qty, 0);
    const l = cs.filter((c) => c.kind === 'lotion').reduce((a, c) => a + c.qty, 0);
    if (p !== pumps || l !== lotions) {
      throw new Error(`"${config.name}" holds ${pumps} pumps / ${lotions} lotions for ${single} but ${p}/${l} for ${s} — `
        + 'a Configuration-scoped frame cannot state one count.');
    }
  }
  return { pumps, lotions };
}

/** The real oil list for a scent, from config/ingredients.json. Never transcribed. */
export function oilsFor(scent) {
  const { liquid_soap: soap } = JSON.parse(readFileSync(join(ROOT, 'config', 'ingredients.json'), 'utf8'));
  const v = (soap.variations ?? []).find((x) => x.shopify_option === scent);
  if (!v) throw new Error(`config/ingredients.json has no liquid_soap variation "${scent}"`);
  return { base: soap.base_ingredients, oils: v.essential_oils ?? [] };
}

export function unit({ src, slug, pxPerCm, count = 1, overlap = 0, boxH }) {
  const nat = natural(slug);
  const h = scaled(kindOf(slug), pxPerCm);
  const w = Math.round((nat.w / nat.h) * h);
  const shift = Math.round(w * overlap);
  const imgs = Array.from({ length: count }, (_, i) => `<img src="${src}" style="width:${w}px;height:${h}px;
    display:block;${i ? `margin-left:-${shift}px;` : ''}position:relative;z-index:${count - i};
    filter:drop-shadow(0 12px 18px rgba(26,27,24,.15)) drop-shadow(0 2px 3px rgba(26,27,24,.10));">`).join('');
  return `<div style="height:${boxH ?? h}px;display:flex;align-items:flex-end;">${imgs}</div>`;
}

export function assertLivePrice(ctx, { configName, price, compareAt }) {
  // Shopify joins a multi-option variant title as "Option1 / Option2", so the
  // Configuration is the first segment and must be compared EXACTLY. startsWith
  // is wrong and quietly so: "4 pumps + body lotion / Variety" starts with
  // "4 pumps", so the $44 frame matched the $72 variants and asserted itself
  // into a price mismatch. It failed loudly here only because the prices differ —
  // had they matched, it would have silently validated the wrong rows.
  const first = (t) => t.split(' / ')[0].trim();
  const matching = ctx.variants.filter((v) => first(v.title) === configName);
  if (!matching.length) {
    throw new Error(`no live variant whose Configuration is exactly "${configName}" — titles are: ${ctx.variants.map((v) => v.title).join(' | ')}`);
  }
  for (const v of matching) {
    if (Number(v.price) !== price) throw new Error(`this frame prints ${money(price)} for "${configName}", but ${v.title} sells for ${money(Number(v.price))}`);
    if (Number(v.compareAtPrice) !== compareAt) throw new Error(`this frame prints a ${money(compareAt)} compare-at for "${configName}", but ${v.title} has ${money(Number(v.compareAtPrice))}`);
  }
  return matching.length;
}

export function altWithin512(text) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  if (t.length > 512) throw new Error(`alt text is ${t.length} characters; Shopify's ceiling is 512.`);
  return t;
}
