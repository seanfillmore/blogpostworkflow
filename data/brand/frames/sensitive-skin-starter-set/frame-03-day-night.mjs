/**
 * Sensitive Skin Set — frame 3 (benefit callout): why it is two products.
 *
 * Media plan §6 frame 3. The buyer's unspoken objection is not "is this good?"
 * but "why am I being sold two moisturisers?" — the same objection the Reset's
 * frame 2 answers for six vessels. Frame 1 shows what arrives; this one gives
 * the two items different jobs so the second stops looking like an upsell.
 *
 * ── Why a hard light/dark split ─────────────────────────────────────────────
 * The 1-second read specced for this frame is "day / night split", and at phone
 * width no caption is legible fast enough to carry that on its own. A tonal
 * split does it before any word is read: the eye gets "two halves, one bright,
 * one dark" instantly and the labels only confirm it. It also gives the white
 * bottle and white jar something to separate from, which a white-on-white frame
 * cannot.
 *
 * ── The positioning is inherited, not invented ──────────────────────────────
 * "Daily lotion / overnight cream" is what shipped on the Reset's frame 2 and is
 * how §6 specs this one. Keeping the same split across both bundles matters more
 * than the wording of either: a buyer who meets the Reset and this set should not
 * be told two different stories about what the cream is for.
 *
 * Both products are drawn at the shared physical scale, so the 8 fl. oz bottle
 * and the 4 fl. oz jar stay in true proportion across the seam.
 *
 * ── The two body lines are lifted, not written ──────────────────────────────
 * A first pass had "Light enough to dress over" and "Richer, for the hours you
 * are not touching anything". Both read well and neither was sourced — the first
 * is a claim about absorption speed nobody has made, the second is invented
 * framing. On a branch whose entire subject is a frame that printed figures no
 * product ever carried, inventing product claims in the replacement is the same
 * mistake in a different medium. Both lines now come from the component PDPs:
 *
 *   day   — coconut-lotion: "six ingredients that actually absorb into skin
 *           instead of sitting on top of it"
 *   night — coconut-moisturizer: "For skin that needs more than a lotion" and
 *           "organic beeswax ... locks moisture in"
 *
 * If either PDP is rewritten, re-source these rather than keeping them because
 * they scan nicely.
 */

import { INK, GREEN, money, item, CUTOUT, assertSetIntact, PRICE } from './set-common.mjs';

const DAY_BG = '#f7f5f0';
const NIGHT_BG = '#191d19';
const PX_PER_CM = 34;
/** One shelf height for both halves, set by the taller product. */
const SHELF = Math.round(17.2 * PX_PER_CM);

/**
 * Both halves use identical fixed offsets rather than centring their own content,
 * so the kickers, the headlines, the products and the captions each sit on one
 * line across the seam. Centring each half independently put "Day lotion." and
 * "Night cream." at visibly different heights, because the bottle is nearly three
 * times the jar — the split then read as a layout error instead of a comparison.
 */
function half({ bg, onDark, kicker, kickerColor, product, headline, sub }) {
  return `<div style="flex:1;height:100%;background:${bg};
    display:flex;flex-direction:column;align-items:center;justify-content:flex-start;
    padding:260px 64px 0;box-sizing:border-box;text-align:center;">

    <div style="font-family:Outfit;font-weight:600;font-size:38px;letter-spacing:.3em;
                text-transform:uppercase;color:${kickerColor};">
      ${kicker}
    </div>

    <div style="font-family:Cabin;font-weight:700;font-size:82px;line-height:1.06;
                color:${onDark ? '#ffffff' : INK};letter-spacing:-.02em;margin:24px 0 0;">
      ${headline}
    </div>

    <div style="margin-top:86px;">${product}</div>

    <div style="font-family:Outfit;font-weight:400;font-size:40px;line-height:1.35;
                color:${onDark ? '#ffffff' : INK};opacity:${onDark ? '.75' : '.62'};margin-top:52px;max-width:660px;">
      ${sub}
    </div>
  </div>`;
}

export default {
  product: 'sensitive-skin-starter-set',
  name: 'frame-03-day-night',
  width: 2048,
  height: 2048,

  verify(ctx) {
    // The whole frame rests on the set containing one lotion AND one cream. If a
    // repack drops either, a day/night split is no longer a true description.
    assertSetIntact(ctx);
  },

  alt() {
    return 'The Sensitive Skin Set as a two-step routine — Pure Unscented Body Lotion every morning, '
      + 'Pure Unscented Body Cream at night.';
  },

  html(ctx) {
    const A = (p) => ctx.asset(p);

    return `<div style="width:100%;height:100%;display:flex;position:relative;">

      ${half({
        bg: DAY_BG,
        onDark: false,
        kicker: 'Morning',
        kickerColor: GREEN,
        headline: 'Day lotion.',
        product: item({ src: A(CUTOUT.lotion), cm: 'lotion', pxPerCm: PX_PER_CM, boxH: SHELF,
          name: 'Body Lotion', note: '8 fl. oz · 236ml' }),
        sub: 'Absorbs into skin instead of sitting on top of it.',
      })}

      ${half({
        bg: NIGHT_BG,
        onDark: true,
        kicker: 'Night',
        kickerColor: '#9ecb92',
        headline: 'Night cream.',
        product: item({ src: A(CUTOUT.cream), cm: 'cream', pxPerCm: PX_PER_CM, onDark: true, boxH: SHELF,
          name: 'Body Cream', note: '4 fl. oz · 118ml' }),
        sub: 'For skin that needs more than a lotion. Beeswax locks moisture in.',
      })}

      <div style="position:absolute;left:50%;bottom:88px;transform:translateX(-50%);
                  background:${INK};color:#ffffff;border-radius:999px;
                  padding:26px 62px;font-family:Cabin;font-weight:700;font-size:46px;white-space:nowrap;">
        Both in the set · ${money(PRICE)}
      </div>
    </div>`;
  },
};
