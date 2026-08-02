/**
 * Sensitive Skin Set — frame 5 (text-only): the components' proof.
 *
 * Media plan §6 frame 5. Ported from the Reset's frame-05-reviews.mjs, which
 * shipped 2026-08-01. The set has no reviews of its own; the lotion and cream
 * inside have 135 between them at 4.84.
 *
 * Two constraints carried over unchanged, both enforced below:
 *
 *  - **The figures are read at render time** from bundle.rating_value /
 *    bundle.rating_count. Never hardcoded — that is what makes the frame
 *    re-renderable when the review count moves.
 *
 *  - **"of the lotion and cream inside" is load-bearing.** Without it the frame
 *    implies 135 reviews *of the set*, which has none. It is not a caption; it is
 *    the difference between proof and a misrepresentation. The alt text carries
 *    the same qualifier for the same reason.
 *
 * The partial star is drawn rather than rounded, for the reason the Reset's
 * version documents: a 4.84 rendered as five full stars overstates, and the
 * unfilled remainder has to be visible or the row just reads as five.
 */

import { INK, GREEN, PAPER, assertSetIntact } from './set-common.mjs';

/** One star, filled `pct` of the way across, with the remainder drawn in. */
function star(i, pct) {
  const d = 'M50 4 L61.8 35.9 L96 37.8 L69.2 59.4 L77.9 92.5 L50 73.9 L22.1 92.5 L30.8 59.4 L4 37.8 L38.2 35.9 Z';
  const clip = `starclip${i}`;
  return `<svg viewBox="0 0 100 100" width="176" height="176" aria-hidden="true">
    <defs><clipPath id="${clip}"><rect x="0" y="0" width="${(pct * 100).toFixed(3)}" height="100"/></clipPath></defs>
    <path d="${d}" fill="${INK}" opacity=".16"/>
    <path d="${d}" fill="${INK}" clip-path="url(#${clip})"/>
  </svg>`;
}

export default {
  product: 'sensitive-skin-starter-set',
  name: 'frame-05-reviews-sensitive-set',
  width: 2048,
  height: 2048,

  verify(ctx) {
    assertSetIntact(ctx);

    const value = Number(ctx.need('rating_value'));
    const count = Number(ctx.need('rating_count'));
    if (!Number.isFinite(value) || value <= 0 || value > 5) throw new Error(`rating_value out of range: ${value}`);
    if (!Number.isInteger(count) || count <= 0) throw new Error(`rating_count is not a positive integer: ${count}`);
    // The frame's claim is that the proof is substantial. Below this it is not,
    // and the honest move is to not run the frame rather than to shrink the type.
    if (count < 25) throw new Error(`only ${count} reviews — too thin to carry a proof frame; media plan §4 rule 1`);
  },

  alt(ctx) {
    const value = Number(ctx.need('rating_value')).toFixed(2);
    const count = ctx.need('rating_count');
    return `${value} out of 5 stars from ${count} customer reviews of the Body Lotion and Body Cream `
      + `included in the Sensitive Skin Set.`;
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
        The Sensitive Skin Set
      </div>

      <div style="display:flex;gap:28px;margin-bottom:52px;">${stars}</div>

      <div style="font-family:Cabin;font-weight:700;font-size:380px;line-height:.92;
                  color:${INK};letter-spacing:-.03em;">
        ${value.toFixed(2)}
      </div>

      <div style="width:190px;height:9px;background:${GREEN};margin:70px 0 58px;border-radius:5px;"></div>

      <div style="font-family:Cabin;font-weight:700;font-size:100px;line-height:1.18;color:${INK};max-width:1560px;">
        ${count} reviews of the lotion<br>and cream inside.
      </div>

      <div style="font-family:Outfit;font-weight:400;font-size:44px;line-height:1.5;
                  color:${INK};opacity:.62;margin-top:52px;max-width:1300px;">
        The set is new. The two products in it are not.
      </div>
    </div>`;
  },
};
