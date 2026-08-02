/**
 * The Clean Swap — frame 8 (benefit callout): the components' proof.
 *
 * The media plan makes this optional and attaches one condition to it, which is
 * the whole reason it is written the way it is:
 *
 *   "the qualifier is not a footnote, it is part of the headline; there is no
 *   review count on the bundle SKU itself and an unqualified '4.64 (205)'
 *   on-image would misrepresent that."
 *
 * So "of the four products inside this box" sits in the headline, not under it,
 * and the same qualifier carries into the alt text. Figures are read live.
 */

import { INK, GREEN, PAPER, assertBundle } from '../90-day-clean-swap/swap-common.mjs';

function star(i, pct) {
  const d = 'M50 4 L61.8 35.9 L96 37.8 L69.2 59.4 L77.9 92.5 L50 73.9 L22.1 92.5 L30.8 59.4 L4 37.8 L38.2 35.9 Z';
  return `<svg viewBox="0 0 100 100" width="168" height="168" aria-hidden="true">
    <defs><clipPath id="c${i}"><rect x="0" y="0" width="${(pct * 100).toFixed(3)}" height="100"/></clipPath></defs>
    <path d="${d}" fill="${INK}" opacity=".16"/><path d="${d}" fill="${INK}" clip-path="url(#c${i})"/></svg>`;
}

export default {
  product: 'clean-swap',
  name: 'frame-08-reviews-cleanswap',
  width: 2048,
  height: 2048,

  verify(ctx) {
    assertBundle(ctx, { price: 59, qtyEach: 1, componentCount: 4 });
    const v = Number(ctx.need('rating_value'));
    const c = Number(ctx.need('rating_count'));
    if (!Number.isFinite(v) || v <= 0 || v > 5) throw new Error(`rating_value out of range: ${v}`);
    if (!Number.isInteger(c) || c <= 0) throw new Error(`rating_count is not a positive integer: ${c}`);
    if (c < 25) throw new Error(`only ${c} reviews — too thin to carry a proof frame; media plan §4 rule 1`);
  },

  alt(ctx) {
    return `${Number(ctx.need('rating_value')).toFixed(2)} out of 5 stars from ${ctx.need('rating_count')} `
      + `customer reviews of the four products inside the Clean Swap.`;
  },

  html(ctx) {
    const v = Number(ctx.need('rating_value'));
    const c = Number(ctx.need('rating_count'));
    const stars = Array.from({ length: 5 }, (_, i) => star(i, Math.min(1, Math.max(0, v - i)))).join('');

    return `<div style="width:100%;height:100%;background:${PAPER};
      display:flex;flex-direction:column;align-items:center;justify-content:center;
      padding:150px 120px;box-sizing:border-box;text-align:center;">

      <div style="display:flex;gap:26px;margin-bottom:48px;">${stars}</div>

      <div style="font-family:Cabin;font-weight:700;font-size:360px;line-height:.92;
                  color:${INK};letter-spacing:-.03em;">${v.toFixed(2)}</div>

      <div style="width:180px;height:9px;background:${GREEN};margin:64px 0 54px;border-radius:5px;"></div>

      <div style="font-family:Cabin;font-weight:700;font-size:92px;line-height:1.18;color:${INK};max-width:1640px;">
        from ${c} reviews of the four<br>products inside this box.
      </div>

      <div style="font-family:Outfit;font-weight:400;font-size:42px;line-height:1.5;
                  color:${INK};opacity:.6;margin-top:48px;max-width:1300px;">
        The box is new. What is in it is not.
      </div>
    </div>`;
  },
};
