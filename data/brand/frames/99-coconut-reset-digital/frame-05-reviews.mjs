/**
 * 90-Day Coconut Reset — frame 5 (text-only).
 *
 * Media plan §6: "Transfer the components' proof to the bundle." The bundle has
 * no reviews of its own; the lotion and cream inside have 135 between them at
 * 4.84. The whole frame turns on that being stated precisely.
 *
 * Two constraints the plan is explicit about, both enforced in verify():
 *  - The figures come from bundle.rating_value / bundle.rating_count at render
 *    time. Never hardcode them — that is what makes this frame re-renderable
 *    when the review count moves.
 *  - The qualifier "of the lotion and cream inside" is load-bearing. Without it
 *    the frame implies 135 reviews *of the bundle*, which has none. It is not a
 *    caption; it is the difference between proof and a misrepresentation.
 *
 * The lander's rating_caption says "Rated 4.9 by Real Customers" — 4.84 rounds
 * to 4.8, so that copy overstates. This frame deliberately does not inherit it.
 */

const BLACK = '#000000';
const SAND = '#EDE5D8';
const GREEN = '#AEDEAC';

/**
 * One star, filled `pct` of the way across.
 *
 * The unfilled remainder is drawn in a mid grey rather than left as background.
 * A star clipped at 84% loses only its right-hand tip — against bare sand that
 * notch is nearly invisible and the row reads as five full stars, which
 * overstates a 4.84. Filling the remainder makes the shortfall legible, which is
 * the whole reason to draw a partial star instead of rounding up to five.
 */
function star(i, pct) {
  const d = 'M50 4 L61.8 35.9 L96 37.8 L69.2 59.4 L77.9 92.5 L50 73.9 L22.1 92.5 L30.8 59.4 L4 37.8 L38.2 35.9 Z';
  const clip = `starclip${i}`;
  return `<svg viewBox="0 0 100 100" width="188" height="188" aria-hidden="true">
    <defs><clipPath id="${clip}"><rect x="0" y="0" width="${(pct * 100).toFixed(3)}" height="100"/></clipPath></defs>
    <path d="${d}" fill="${BLACK}" opacity=".18"/>
    <path d="${d}" fill="${BLACK}" clip-path="url(#${clip})"/>
  </svg>`;
}

export default {
  product: '99-coconut-reset-digital',
  name: 'frame-05-reviews',
  width: 2048,
  height: 2048,
  reads: ['rating_value', 'rating_count'],

  verify(ctx) {
    const value = Number(ctx.need('rating_value'));
    const count = Number(ctx.need('rating_count'));
    if (!Number.isFinite(value) || value <= 0 || value > 5) throw new Error(`rating_value out of range: ${value}`);
    if (!Number.isInteger(count) || count <= 0) throw new Error(`rating_count is not a positive integer: ${count}`);
    // The frame's whole claim is that the proof is substantial. Below this it isn't,
    // and the honest move is to not run the frame rather than to shrink the type.
    if (count < 25) throw new Error(`only ${count} reviews — too thin to carry a proof frame; media plan §4 rule 1`);
  },

  alt(ctx) {
    const value = Number(ctx.need('rating_value')).toFixed(2);
    const count = ctx.need('rating_count');
    return `${value} out of 5 stars from ${count} customer reviews of the Body Lotion and Body Cream `
      + `included in the 90-Day Coconut Reset.`;
  },

  html(ctx) {
    const value = Number(ctx.need('rating_value'));
    const count = Number(ctx.need('rating_count'));
    // Fill each star by how much of it the score earns, so the mark is the datum
    // rather than a decoration rounded up to five.
    const stars = Array.from({ length: 5 }, (_, i) => star(i, Math.min(1, Math.max(0, value - i)))).join('');

    return `<div style="
      width:100%;height:100%;background:${SAND};
      display:flex;flex-direction:column;align-items:center;justify-content:center;
      padding:150px 130px;text-align:center;">

      <div style="font-family:Outfit;font-weight:300;font-size:44px;letter-spacing:.34em;
                  text-transform:uppercase;color:${BLACK};opacity:.55;margin-bottom:96px;">
        The 90-Day Coconut Reset
      </div>

      <div style="display:flex;gap:30px;margin-bottom:56px;">${stars}</div>

      <div style="font-family:Cabin;font-weight:700;font-size:400px;line-height:.92;
                  color:${BLACK};letter-spacing:-.03em;">
        ${value.toFixed(2)}
      </div>

      <div style="width:190px;height:9px;background:${GREEN};margin:74px 0 62px;border-radius:5px;"></div>

      <div style="font-family:Cabin;font-weight:700;font-size:104px;line-height:1.18;color:${BLACK};max-width:1560px;">
        ${count} reviews of the lotion<br>and cream inside.
      </div>

      <div style="font-family:Outfit;font-weight:400;font-size:46px;line-height:1.5;
                  color:${BLACK};opacity:.62;margin-top:56px;max-width:1300px;">
        The bundle is new. The two products in it are not.
      </div>
    </div>`;
  },
};
