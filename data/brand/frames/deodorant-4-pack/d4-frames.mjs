/**
 * Coconut Deodorant 4-Pack — two frame builders, ten media.
 *
 * One option (Scent, five values), so no split-across-options problem: every
 * media is scoped to Scent, and the pack frames lead so the main image tracks
 * the buyer's choice.
 *
 *   frame-01-pack-*   Scent x5   the four sticks that ship — LEADS
 *   frame-02-value-*  Scent x5   $53 against $60, and the per-unit price
 *
 * EVERY media is scoped on purpose. An unscoped media is only safe first
 * (gang_exist is sticky) and a media that is first and unscoped pins the main
 * image for every variant — the mistake the Hand Soap Set shipped and Sean
 * caught. Duplicating the value frame five times costs five identical JPEGs.
 *
 * ── No review frame ─────────────────────────────────────────────────────────
 * This product has 8 reviews. Every other bundle's proof frame refuses under 25,
 * and the rule is not worth bending for the one product that needs it most: a
 * "5.0 stars" frame backed by eight ratings invites the arithmetic rather than
 * settling it.
 *
 * ── No supply-duration claim ────────────────────────────────────────────────
 * lib/supply-duration.js would ALLOW one: deodorant measures ~90 days per unit,
 * so four is ~360 and any claim up to that passes. It is still not made. That
 * rate rests on n=8 reorder intervals, flagged "very weak" in
 * config/consumption-rates.json, and it is an upper bound built from reorder
 * gaps. "A year of deodorant" off eight data points is the shape of the 60-day
 * claim that had to be pulled from Head-to-Toe. The frames argue about reorder
 * FREQUENCY instead, which needs no consumption estimate at all.
 */

import { readFileSync, openSync, readSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const INK = '#1a1b18', GREEN = '#4a8b3c', PAPER = '#ffffff', WASH = '#f7f8f5';
const money = (n) => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`);
const APPARENT_CM = 13.0;                       // established by swap-common.mjs
const HANDLE = 'coconut-deodorant-4-pack';

const cutout = (slug) => `data/brand/cutouts/component-deodorant-${slug}.png`;

/**
 * Artifact slugs are PINNED to the pre-correction spelling. See LEGACY_SLUG.
 */
const slugOf = (scent) => {
  const s = scent.toLowerCase().replace(/\s+/g, '-');
  return LEGACY_SLUG[s] ?? s;
};

function natural(slug) {
  const fd = openSync(join(ROOT, cutout(slug)), 'r');
  const buf = Buffer.alloc(24); readSync(fd, buf, 0, 24, 0); closeSync(fd);
  if (buf.toString('ascii', 1, 4) !== 'PNG') throw new Error(`${cutout(slug)} is not a PNG`);
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

/** The bundle as configured, so contents are never transcribed. */
export function bundle() {
  const { bundles } = JSON.parse(readFileSync(join(ROOT, 'config', 'bundles.json'), 'utf8'));
  const b = bundles.find((x) => x.handle === HANDLE);
  if (!b) throw new Error(`config/bundles.json has no "${HANDLE}"`);
  return b;
}
export const variantFor = (scent) => {
  const v = bundle().variants.find((x) => x.options.Scent === scent);
  if (!v) throw new Error(`no "${scent}" variant of ${HANDLE}`);
  return v;
};

/**
 * Slug pins, NOT label fixes. This map replaced LABEL_FIX on 2026-08-18.
 *
 * History: the Shopify Scent value used to read "Wildcrafted Frankincence" while
 * the product's own label and the source photograph's filename both read
 * "frankincense". LABEL_FIX corrected the option value on its way into a caption,
 * so a frame would not print a misspelling directly beneath a photograph of the
 * correct spelling. The option value has now been corrected in Shopify, so every
 * DISPLAY string is right at source and LABEL_FIX would be a no-op. It is gone.
 *
 * What did NOT get renamed is every ARTIFACT named after the old value:
 *
 *   data/brand/cutouts/component-deodorant-wildcrafted-frankincence.png
 *   data/brand/bundle-images/frame-0{1,2}-*-d4-4x-wildcrafted-frankincence.jpg
 *   the same filenames as uploaded to Shopify, and therefore
 *   the KEYS of data/brand/bundle-images/coconut-deodorant-4-pack.scope.json
 *
 * That chain is load-bearing and it is matched by FILENAME, not by option value.
 * scripts/set-media-variant-scope.mjs keys on a filename fragment, and a fragment
 * matching no media does not fail — the media it should have described is instead
 * left out of the scope file, which STRIPS its suffix and renders it for no
 * variant at all. So the slug must keep the old spelling until a single change
 * re-renders the frames, re-uploads them, and re-keys the scope file together.
 *
 * Hence: display strings follow Shopify; slugs are pinned here. Keep this map
 * tiny — assertOnlySpelling() still holds it to a spelling-only difference, so it
 * can never become a way to point a frame at an unrelated asset.
 */
export const LEGACY_SLUG = {
  'wildcrafted-frankincense': 'wildcrafted-frankincence',
  '4x-wildcrafted-frankincense': '4x-wildcrafted-frankincence',
};

/**
 * A correction may only fix spelling — same words, same order, ignoring case.
 *
 * Hyphens count as word separators, not as letters. This guard used to police
 * space-separated display labels ("Wildcrafted Frankincence"); it now polices
 * hyphenated slugs ("wildcrafted-frankincence"), where splitting on whitespace
 * alone would see one word on both sides and let any replacement of similar
 * LENGTH through — "wildcrafted-frankincense" → "something-else-entirely-here"
 * passed until this was fixed.
 */
export function assertOnlySpelling(from, to) {
  const skeleton = (x) => x.toLowerCase().replace(/[^a-z]/g, '').split('').sort().join('');
  const words = (x) => x.toLowerCase().split(/[\s-]+/).filter(Boolean).length;
  if (words(from) !== words(to)) throw new Error(`"${from}" → "${to}" changes the number of words`);
  if (Math.abs(skeleton(from).length - skeleton(to).length) > 2) {
    throw new Error(`"${from}" → "${to}" is not a spelling correction`);
  }
}

const eyebrow = (t) => `<div style="font-family:Outfit;font-weight:300;font-size:34px;letter-spacing:.34em;
  text-transform:uppercase;color:${INK};opacity:.45;">${t}</div>`;

function stick(src, slug, pxPerCm) {
  const nat = natural(slug);
  const h = Math.round(APPARENT_CM * pxPerCm);
  const w = Math.round((nat.w / nat.h) * h);
  return `<img src="${src}" style="width:${w}px;height:${h}px;display:block;
    filter:drop-shadow(0 12px 18px rgba(26,27,24,.15)) drop-shadow(0 2px 3px rgba(26,27,24,.10));">`;
}

function assertVariant(ctx, scent) {
  const opt = ctx.product.options?.find?.((o) => o.name === 'Scent');
  if (opt && !opt.values.includes(scent)) throw new Error(`"${scent}" is not a Scent value — it has: ${opt.values.join(', ')}`);
  const v = variantFor(scent);
  const live = ctx.variants.find((x) => x.title === scent);
  if (!live) throw new Error(`no live variant titled "${scent}"`);
  if (Number(live.price) !== v.price) throw new Error(`config says ${money(v.price)}, Shopify says ${money(Number(live.price))}`);
  if (Number(live.compareAtPrice) !== v.compareAtPrice) throw new Error(`compare-at drift: ${v.compareAtPrice} vs ${live.compareAtPrice}`);
  const units = v.components.reduce((a, c) => a + c.qty, 0);
  if (units !== 4) throw new Error(`this is a FOUR-pack; the ${scent} variant holds ${units}`);
  return { v, live, units };
}

const alt512 = (t) => { const s = String(t).replace(/\s+/g, ' ').trim();
  if (s.length > 512) throw new Error(`alt ${s.length} chars`); return s; };

// ─────────────────────────────────────────────────────────────────────────────
// Frame 1 — the four sticks that actually ship. Leads, so the main image follows
// the Scent dropdown. Variety draws its four different scents; a single-scent
// variant draws the same stick four times, because that is what arrives.
// ─────────────────────────────────────────────────────────────────────────────
export function packFrame(scent) {
  const PX = 52;
  return {
    product: HANDLE,
    name: `frame-01-pack-d4-${slugOf(scent).replace(/[^a-z0-9-]/g, '')}`,
    width: 2048,
    height: 2048,
    verify(ctx) {
      const { v } = assertVariant(ctx, scent);
      for (const c of v.components) natural(slugOf(c.variant));
      for (const [from, to] of Object.entries(LEGACY_SLUG)) assertOnlySpelling(from, to);
    },
    alt() {
      const v = variantFor(scent);
      const parts = v.components.map((c) => `${c.qty} × ${c.variant}`);
      return alt512(`The Real Skin Care coconut deodorant four-pack, ${scent} — ${parts.join(', ')}, 2 fl. oz. each.`);
    },
    html(ctx) {
      const v = variantFor(scent);
      const sticks = v.components.flatMap((c) => Array.from({ length: c.qty }, () => c.variant));
      const isVariety = new Set(sticks).size > 1;
      return `<div style="width:100%;height:100%;background:${PAPER};
        display:flex;flex-direction:column;align-items:center;justify-content:space-between;
        padding:104px 60px 92px;box-sizing:border-box;text-align:center;">
        <div>
          ${eyebrow('Coconut deodorant')}
          <div style="font-family:Cabin;font-weight:700;font-size:${isVariety ? 128 : 120}px;line-height:1.03;
                      color:${INK};letter-spacing:-.026em;margin-top:24px;">
            ${isVariety ? 'One of each.' : 'Four of the same.'}
          </div>
          ${isVariety ? '' : `<div style="font-family:Outfit;font-weight:400;font-size:50px;color:${INK};opacity:.55;margin-top:22px;">${scent.replace(/^4x /, '')}</div>`}
        </div>
        <div style="display:flex;align-items:flex-end;justify-content:center;gap:26px;
                    background:${WASH};border-radius:34px;padding:74px 52px 60px;">
          ${sticks.map((s) => `<div style="display:flex;flex-direction:column;align-items:center;">
            ${stick(ctx.asset(cutout(slugOf(s))), slugOf(s), PX)}
            ${isVariety ? `<div style="font-family:Cabin;font-weight:700;font-size:34px;color:${INK};margin-top:26px;max-width:300px;line-height:1.2;">${s}</div>` : ''}
          </div>`).join('')}
        </div>
        <div>
          <div style="width:120px;height:6px;background:${GREEN};border-radius:3px;margin:0 auto 28px;"></div>
          <div style="font-family:Cabin;font-weight:700;font-size:62px;color:${INK};">Reorder once, not four times.</div>
        </div>
      </div>`;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Frame 2 — the arithmetic. Derived from the live variant, never typed.
// ─────────────────────────────────────────────────────────────────────────────
const CEILING = 15;
export function valueFrame(scent) {
  return {
    product: HANDLE,
    name: `frame-02-value-d4-${slugOf(scent).replace(/[^a-z0-9-]/g, '')}`,
    width: 2048,
    height: 2048,
    verify(ctx) {
      const { v, units } = assertVariant(ctx, scent);
      const per = v.price / units;
      if (per >= CEILING) throw new Error(`${money(v.price)} over ${units} is $${per.toFixed(2)} each, at or above the $${CEILING} ceiling the VOC file documents`);
      if (v.compareAtPrice <= v.price) throw new Error('no saving to print');
    },
    alt() {
      const v = variantFor(scent);
      const units = v.components.reduce((a, c) => a + c.qty, 0);
      return alt512(`${money(v.price)} for ${units} full-size coconut deodorants — $${(v.price / units).toFixed(2)} each, against ${money(v.compareAtPrice)} bought singly.`);
    },
    html() {
      const v = variantFor(scent);
      const units = v.components.reduce((a, c) => a + c.qty, 0);
      const per = (v.price / units).toFixed(2);
      return `<div style="width:100%;height:100%;background:${PAPER};
        display:flex;flex-direction:column;align-items:center;justify-content:center;
        padding:150px 130px;box-sizing:border-box;text-align:center;">
        ${eyebrow(`${units}-pack`)}
        <div style="font-family:Cabin;font-weight:700;font-size:118px;line-height:1.06;
                    color:${INK};letter-spacing:-.024em;margin-top:32px;">${money(v.price)}.<br>${units} deodorants.</div>
        <div style="width:190px;height:9px;background:${GREEN};margin:62px 0 44px;border-radius:5px;"></div>
        <div style="font-family:Cabin;font-weight:700;font-size:340px;line-height:.9;color:${INK};letter-spacing:-.03em;">$${per}</div>
        <div style="font-family:Outfit;font-weight:300;font-size:64px;letter-spacing:.3em;
                    text-transform:uppercase;color:${INK};opacity:.5;margin-top:30px;">each</div>
        <div style="font-family:Outfit;font-weight:400;font-size:44px;line-height:1.5;
                    color:${INK};opacity:.62;margin-top:72px;max-width:1400px;">
          ${money(v.compareAtPrice)} buying them one at a time.
        </div>
      </div>`;
    },
  };
}
