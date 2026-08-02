/**
 * Clean Swap — frame 1 (grid/multi-SKU): everything in the box, at once.
 *
 * Media plan §6: "Make twelve units visible at once — the volume argument." It is
 * the frame the plan calls the whole page, because $144 against a ~$47 store AOV
 * is arithmetic the eye can do in a second and the copy cannot make it do.
 *
 * ── Why this is a composite and not a shoot ─────────────────────────────────
 * It was specced MUST-SHOOT on the rule that contents depiction must match what
 * ships. That rule was written against *generated* composites, which redraw
 * labels — the failure that put "0 fl. oz" and "moisturizing broom" on the
 * Sensitive Skin Set's only image. A composite of keyed, unretouched photographs
 * has no such failure mode: every pixel here is the product's own PDP shot, so
 * what is depicted is what ships, down to "2 fl. oz · 60ml" on the deodorant.
 * A real overhead flat-lay is still a better asset and stays on the shoot list.
 *
 * ── Scale ───────────────────────────────────────────────────────────────────
 * All four products are drawn to one physical scale. This bundle spans 8 fl oz
 * to 2 fl oz, a far wider range than the Sensitive Skin Set, so a wrong scale is
 * more visible here rather than less — and "smaller than expected" is a return
 * driver, per marketing-ai-product-imagery.
 *
 * ── Variant accuracy ────────────────────────────────────────────────────────
 * Gentle, Calm and Fresh differ in lotion, deodorant and soap. This builder is
 * called once per kit and each render is scoped to its variant, so a buyer who
 * picks Fresh is never shown the Gentle box. The kit contents are read from
 * config/bundles.json, never transcribed.
 */

import {
  INK, GREEN, PAPER, WASH, money, unit, cutout, kindOf, LABEL, NATURAL,
  kitsFor, assertBundle, scaled,
} from './swap-common.mjs';

const PX_PER_CM = 35;

export function contentsFrame({ handle, name, kitName, price, qtyEach, headline, subline }) {
  return {
    product: handle,
    name,
    width: 2048,
    height: 2048,

    verify(ctx) {
      assertBundle(ctx, { price, qtyEach, componentCount: 4 });
      const kit = kitsFor(handle).find((k) => k.name === kitName);
      if (!kit) throw new Error(`config/bundles.json has no "${kitName}" variant of ${handle}`);
      if (!ctx.variants.some((v) => v.title === kitName)) {
        throw new Error(`no live variant titled "${kitName}" — a frame must depict a kit somebody can buy`);
      }
      for (const c of kit.components) {
        if (!NATURAL[c.slug]) throw new Error(`${kitName} ships ${c.variant} ${c.product}, but there is no cutout for "${c.slug}"`);
        if (c.qty !== qtyEach) throw new Error(`${kitName} ships ${c.qty}x ${c.product}, frame assumes ${qtyEach}x`);
      }
      const total = kit.components.reduce((a, c) => a + c.qty, 0);
      if (total !== qtyEach * 4) throw new Error(`expected ${qtyEach * 4} units, kit holds ${total}`);
    },

    alt() {
      const kit = kitsFor(handle).find((k) => k.name === kitName);
      const parts = kit.components.map((c) => `${c.qty} ${c.variant} ${LABEL[kindOf(c.slug)]}`);
      return `Everything in the ${kitName} kit — ${parts.join(', ')} — ${qtyEach * 4} full-size products in one box.`;
    },

    html(ctx) {
      const kit = kitsFor(handle).find((k) => k.name === kitName);
      const A = (p) => ctx.asset(p);
      // One shelf so every product stands on the same floor regardless of height.
      const shelf = scaled('lotion', PX_PER_CM);

      const column = (c) => `
        <div style="display:flex;flex-direction:column;align-items:center;">
          ${unit({ src: A(cutout(c.slug)), slug: c.slug, pxPerCm: PX_PER_CM, count: c.qty, overlap: 0.45, boxH: shelf })}
          <div style="font-family:Cabin;font-weight:700;font-size:40px;color:${INK};margin-top:26px;">
            ${c.qty} × ${LABEL[kindOf(c.slug)]}
          </div>
          <div style="font-family:Outfit;font-weight:400;font-size:31px;color:${INK};opacity:.55;margin-top:6px;text-align:center;">
            ${c.variant}
          </div>
        </div>`;

      return `<div style="width:100%;height:100%;background:${PAPER};
        display:flex;flex-direction:column;align-items:center;justify-content:space-between;
        padding:84px 64px 76px;box-sizing:border-box;text-align:center;">

        <div>
          <div style="font-family:Outfit;font-weight:300;font-size:34px;letter-spacing:.34em;
                      text-transform:uppercase;color:${INK};opacity:.45;">${kitName} kit</div>
          <div style="font-family:Cabin;font-weight:700;font-size:118px;line-height:1.03;
                      color:${INK};letter-spacing:-.024em;margin-top:24px;">${headline}</div>
        </div>

        <div style="display:flex;align-items:flex-end;justify-content:center;gap:44px;
                    background:${WASH};border-radius:34px;padding:76px 56px 60px;">
          ${kit.components.map(column).join('')}
        </div>

        <div>
          <div style="width:120px;height:6px;background:${GREEN};border-radius:3px;margin:0 auto 30px;"></div>
          <div style="font-family:Cabin;font-weight:700;font-size:62px;color:${INK};">${subline}</div>
          <div style="font-family:Outfit;font-weight:400;font-size:38px;color:${INK};opacity:.6;margin-top:14px;">
            ${money(price)} for the box
          </div>
        </div>
      </div>`;
    },
  };
}
