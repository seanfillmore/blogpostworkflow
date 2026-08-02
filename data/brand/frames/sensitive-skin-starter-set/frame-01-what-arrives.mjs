/**
 * Sensitive Skin Set — frame 1 (grid/multi-SKU): what actually arrives.
 *
 * Media plan §6 frame 1, with the 2026-08-01 correction: the spec said "two
 * jars", and it is a bottle and a jar.
 *
 * ── One job, and what it deliberately excludes ──────────────────────────────
 * This frame answers exactly one question — what does $46.80 buy? — so it shows
 * two products and nothing else. The subscription gift is not here. That is not
 * an oversight: the gift is contingent on starting a subscription, and a buyer
 * making a one-time purchase gets these two items. Frame 6 makes the gift offer
 * and states its condition; putting the soap and lip balm in *this* frame would
 * promise a one-time buyer four items, which is the misrepresentation the whole
 * v20.webp review was about.
 *
 * The spec's 1-second read is "two products, clean white, priced", so the price
 * is set large enough to survive a phone-width thumbnail and the frame carries
 * no savings-versus-single figure — docs/bundle-marketing-plan.md rule 1 keeps
 * bundles off per-unit comparison.
 *
 * Pixels are real Pure Unscented photography (the approved Reset cutouts), never
 * generated, so the printed volumes are the ones on the actual bottles.
 */

import { INK, PAPER, money, item, CUTOUT, assertSetIntact, PRICE } from './set-common.mjs';

const PX_PER_CM = 48;

export default {
  product: 'sensitive-skin-starter-set',
  name: 'frame-01-what-arrives',
  width: 2048,
  height: 2048,

  verify(ctx) {
    // Price, contents, quantities and variant — a repack or a reprice stops the build.
    assertSetIntact(ctx);
  },

  alt() {
    return 'What comes in the Sensitive Skin Set — one Pure Unscented Body Lotion, 8 fl. oz, '
      + 'and one Pure Unscented Body Cream, 4 fl. oz.';
  },

  html(ctx) {
    const A = (p) => ctx.asset(p);

    return `<div style="width:100%;height:100%;background:${PAPER};
      display:flex;flex-direction:column;align-items:center;justify-content:space-between;
      padding:104px 88px 96px;box-sizing:border-box;text-align:center;">

      <div>
        <div style="font-family:Outfit;font-weight:300;font-size:34px;letter-spacing:.34em;
                    text-transform:uppercase;color:${INK};opacity:.45;">
          Pure Unscented
        </div>
        <div style="font-family:Cabin;font-weight:700;font-size:112px;line-height:1.04;
                    color:${INK};letter-spacing:-.024em;margin-top:28px;">
          Two products.<br>One routine.
        </div>
      </div>

      <div style="display:flex;align-items:flex-end;justify-content:center;gap:110px;">
        ${item({ src: A(CUTOUT.lotion), cm: 'lotion', pxPerCm: PX_PER_CM,
          name: 'Body Lotion', note: '8 fl. oz · 236ml' })}
        ${item({ src: A(CUTOUT.cream), cm: 'cream', pxPerCm: PX_PER_CM,
          name: 'Body Cream', note: '4 fl. oz · 118ml' })}
      </div>

      <div style="font-family:Cabin;font-weight:700;font-size:88px;color:${INK};letter-spacing:-.01em;">
        ${money(PRICE)}
      </div>
    </div>`;
  },
};
