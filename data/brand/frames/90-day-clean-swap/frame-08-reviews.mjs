/**
 * 90-Day Clean Swap — frame 8 (text-only): proof at the price objection.
 *
 * Media plan §6. The bundle has no reviews of its own; the four products inside
 * have 205 between them at 4.64. The qualifier "of the products in this box" is
 * load-bearing in both the headline and the alt text — without it the frame
 * implies 205 reviews of a bundle that has none, which is the difference between
 * proof and a misrepresentation. Same rule the Reset and the Sensitive Skin Set
 * frames carry.
 *
 * Figures are read from bundle.rating_value / rating_count at render time, never
 * hardcoded, so the frame stays correct as reviews accumulate.
 */

import { INK, GREEN, PAPER, assertBundle } from './swap-common.mjs';

/** One star, filled `pct` across, remainder drawn so a 4.64 cannot read as five. */
function star(i, pct) {
  const d = 'M50 4 L61.8 35.9 L96 37.8 L69.2 59.4 L77.9 92.5 L50 73.9 L22.1 92.5 L30.8 59.4 L4 37.8 L38.2 35.9 Z';
  return `<svg viewBox="0 0 100 100" width="176" height="176" aria-hidden="true">
    <defs><clipPath id="cs${i}"><rect x="0" y="0" width="${(pct * 100).toFixed(3)}" height="100"/></clipPath></defs>
    <path d="${d}" fill="${INK}" opacity=".16"/>
    <path d="${d}" fill="${INK}" clip-path="url(#cs${i})"/>
  </svg>`;
}

export default {
  product: '90-day-clean-swap',
  name: 'frame-08-reviews-90day',
  width: 2048,
  height: 2048,

  verify(ctx) {
    assertBundle(ctx, { price: 144, qtyEach: 3, componentCount: 4 });
    const value = Number(ctx.need('rating_value'));
    const count = Number(ctx.need('rating_count'));
    if (!Number.isFinite(value) || value <= 0 || value > 5) throw new Error(`rating_value out of range: ${value}`);
    if (!Number.isInteger(count) || count <= 0) throw new Error(`rating_count is not a positive integer: ${count}`);
    if (count < 25) throw new Error(`only ${count} reviews — too thin to carry a proof frame; media plan §4 rule 1`);
  },

  alt(ctx) {
    return `${Number(ctx.need('rating_value')).toFixed(2)} out of 5 stars from ${ctx.need('rating_count')} `
      + `customer reviews of the four products included in the 90-Day Clean Swap.`;
  },

  html(ctx) {
    const value = Number(ctx.need('rating_value'));
    const count = Number(ctx.need('rating_count'));
    const stars = Array.from({ length: 5 }, (_, i) => star(i, Math.min(1, Math.max(0, value - i)))).join('');

    return `<div style="width:100%;height:100%;background:${PAPER};
      display:flex;flex-direction:column;align-items:center;justify-content:center;
      padding:150px 130px;box-sizing:border-box;text-align:center;">

      <div style="font-family:Outfit;font-weight:300;font-size:42px;letter-spacing:.34em;
                  text-transform:uppercase;color:${INK};opacity:.5;margin-bottom:88px;">
        The 90-Day Clean Swap
      </div>

      <div style="display:flex;gap:28px;margin-bottom:52px;">${stars}</div>

      <div style="font-family:Cabin;font-weight:700;font-size:380px;line-height:.92;
                  color:${INK};letter-spacing:-.03em;">${value.toFixed(2)}</div>

      <div style="width:190px;height:9px;background:${GREEN};margin:70px 0 58px;border-radius:5px;"></div>

      <div style="font-family:Cabin;font-weight:700;font-size:96px;line-height:1.18;color:${INK};max-width:1600px;">
        ${count} reviews of the four<br>products in this box.
      </div>

      <div style="font-family:Outfit;font-weight:400;font-size:44px;line-height:1.5;
                  color:${INK};opacity:.62;margin-top:52px;max-width:1300px;">
        The box is new. What is in it is not.
      </div>
    </div>`;
  },
};
