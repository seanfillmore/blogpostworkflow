/**
 * Ad 1 — the angle, product-led.
 *
 * Headline carries the objection ("runs out faster than they expect", 4 mentions
 * in data/context/voice-of-customer.md); the pills carry the answer. Quantity is
 * stated in text rather than shown, per Sean — one bottle and one jar hero-sized
 * reads as skincare faster than six containers shrunk to fit.
 */
import { INK, GREEN, MINT, PAPER, LOTION, JAR, pill, shell } from './ad-common.mjs';

export default {
  product: '99-coconut-reset-digital',
  name: 'ad-01-runs-out',
  width: 1080,
  height: 1350,

  verify(ctx) {
    const days = Number(ctx.need('duration_days'));
    if (days !== 90) throw new Error(`headline pill says ninety days; duration_days is ${days}`);
    const qty = JSON.parse(ctx.need('component_qty'));
    if (JSON.stringify(qty) !== JSON.stringify([3, 3])) {
      throw new Error(`pill says three of each; component_qty is ${JSON.stringify(qty)}`);
    }
  },

  alt: () =>
    'A bottle of Real Skin Care Coconut Breeze body lotion and an open jar of body cream on a green '
    + 'background, with the words: still buying one bottle at a time? Ninety days of both formulas.',

  html: (ctx) => shell({
    bg: MINT,
    disc: 'rgba(255,255,255,.55)',
    headline: 'Still buying one<br>bottle at a time?',
    sub: 'It runs out right about the time your skin settles down.',
    body: `
      <div style="display:flex;align-items:flex-end;justify-content:center;height:100%;">
        <img src="${ctx.asset(LOTION)}" style="height:100%;width:auto;object-fit:contain;display:block;">
        <img src="${ctx.asset(JAR)}" style="height:44%;width:auto;object-fit:contain;display:block;
                                            margin-left:-40px;">
      </div>`,
    footer: `
      <div style="display:flex;gap:14px;justify-content:center;flex-wrap:wrap;margin-bottom:26px;">
        ${pill('90 days of both')}${pill('3 bottles + 3 jars')}${pill('8 ingredients')}
      </div>
      <div style="font-family:Cabin;font-weight:700;font-size:38px;color:${GREEN};">
        The 90-Day Coconut Reset
      </div>`,
  }),
};
