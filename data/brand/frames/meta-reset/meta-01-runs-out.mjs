/**
 * Meta static 1 of 5 — the headliner. Carries the angle and nothing else.
 *
 * Angle (fixed by docs/superpowers/specs/2026-08-04-coconut-reset-offer-lander-design.md
 * and binding on every asset here): you keep running out, and you have already
 * spent more than this on lotions that did not work.
 *
 * Sourced from data/context/voice-of-customer.md, not invented:
 *   "Bottle size feels short ... people run out faster than they expect"  — 4 mentions
 *   "sunk-cost fatigue after spending hundreds trying organic lotions"     — 3 mentions
 *
 * One job, one buyer (marketing-product-image-stack). No price, no discount, no
 * ingredient claim — those are other frames. Type is oversized because the rule
 * is a 1-second read at phone size, not at canvas size.
 */
const INK = '#1a1b18';
const GREEN = '#4a8b3c';
const CREAM = '#f6f8f3';

export default {
  product: '99-coconut-reset-digital',
  name: 'meta-01-runs-out',
  width: 1080,
  height: 1350,

  verify(ctx) {
    const qty = JSON.parse(ctx.need('component_qty'));
    if (JSON.stringify(qty) !== JSON.stringify([3, 3])) {
      throw new Error(`frame says three of each; component_qty is ${JSON.stringify(qty)}`);
    }
    const days = Number(ctx.need('duration_days'));
    if (days !== 90) throw new Error(`frame says ninety days; duration_days is ${days}`);
  },

  alt: () =>
    'Text reading: you always run out. Then: ninety days of lotion and cream, three bottles and '
    + 'three jars, from Real Skin Care.',

  html: () => `
    <div style="width:100%;height:100%;background:${CREAM};box-sizing:border-box;
                padding:96px 84px;display:flex;flex-direction:column;justify-content:center;">

      <div style="font-family:Outfit;font-weight:400;font-size:30px;letter-spacing:.28em;
                  text-transform:uppercase;color:${INK};opacity:.45;margin-bottom:36px;">
        The 90-Day Coconut Reset
      </div>

      <div style="font-family:Cabin;font-weight:700;font-size:132px;line-height:.98;
                  letter-spacing:-.03em;color:${INK};">
        You always<br>run out.
      </div>

      <div style="width:150px;height:8px;background:${GREEN};border-radius:4px;margin:46px 0;"></div>

      <div style="font-family:Outfit;font-weight:400;font-size:46px;line-height:1.35;color:${INK};opacity:.8;">
        So this is ninety days of both —<br>three bottles, three jars.
      </div>

      <div style="font-family:Outfit;font-weight:400;font-size:31px;line-height:1.45;
                  color:${INK};opacity:.5;margin-top:56px;">
        Not a bigger bottle. Enough of the same one<br>to find out whether it works.
      </div>
    </div>`,
};
