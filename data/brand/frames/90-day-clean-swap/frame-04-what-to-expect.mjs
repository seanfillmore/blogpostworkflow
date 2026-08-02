/**
 * 90-Day Clean Swap — frame 4 (instructional / step-by-step): the switch itself.
 *
 * Replaced the specced shelf before/after on 2026-08-02 — Sean: no transformation
 * frames for now. What went in is the format the rotation was actually missing,
 * and it is grounded entirely in copy already on this lander:
 *
 *   "Do I have to switch everything at once?"  -> "No, but most people find it
 *   easier. Swapping one product at a time drags the adjustment out."
 *   "Is there an adjustment period with natural deodorant?" -> "Often yes —
 *   usually one to two weeks as your body adapts. It passes."
 *
 * Those two answers are the frame. It turns the bundle's biggest objection —
 * four changes at once sounds worse than one — into its argument, by saying the
 * rough patch is short and that doing it all at once shortens it rather than
 * multiplying it.
 *
 * It is also the one frame here that pays twice. marketing-product-image-stack
 * rates a numbered step-by-step highly for this catalogue specifically because
 * quitting during the deodorant transition is a named driver of the repeat rate:
 * a buyer who gives up in week one never reorders, and no gallery work downstream
 * recovers them.
 *
 * ⚠️ Guardrails, both enforced below: no day count beyond "one to two weeks", and
 * no promise about outcome. The FAQ says "often yes" and "it passes"; this frame
 * may not upgrade either into a guarantee.
 */

import { INK, GREEN, PAPER, WASH, assertBundle } from './swap-common.mjs';

const STEPS = [
  { n: '1', head: 'Swap all four at once', body: 'One changeover instead of four. The page FAQ is blunt about why: swapping one product at a time drags the adjustment out.' },
  { n: '2', head: 'Week one to two', body: 'There is often an adjustment period with natural deodorant while your body adapts. It is the normal part, not the failure part.' },
  { n: '3', head: 'It passes', body: 'After that it is just your routine — and you have three months of all four before you think about reordering.' },
];

/** Anything here would over-promise. Checked at build time, not left to review. */
const BANNED = /\b(guarantee[ds]?|cure|eliminat\w*|permanent\w*|\d+\s*days?\b|\d+\s*weeks?\b)/i;

export default {
  product: '90-day-clean-swap',
  name: 'frame-04-what-to-expect-90day',
  width: 2048,
  height: 2048,

  verify(ctx) {
    assertBundle(ctx, { price: 144, qtyEach: 3, componentCount: 4 });
    for (const s of STEPS) {
      const text = `${s.head} ${s.body}`;
      const hit = text.match(BANNED);
      if (hit) {
        throw new Error(
          `step "${s.head}" contains "${hit[0]}" — this frame may not carry a numeric duration or a `
          + `promise about outcome. The FAQ says "often yes" and "it passes"; the frame says no more.`);
      }
    }
  },

  alt() {
    return 'What to expect when switching to the 90-Day Clean Swap: change all four products at once, '
      + 'expect a short adjustment period with natural deodorant, then it passes.';
  },

  html() {
    const card = (s) => `
      <div style="flex:1;background:${WASH};border-radius:28px;padding:52px 44px;text-align:left;">
        <div style="width:78px;height:78px;border-radius:50%;background:${GREEN};color:#fff;
                    font-family:Cabin;font-weight:700;font-size:44px;
                    display:flex;align-items:center;justify-content:center;">${s.n}</div>
        <div style="font-family:Cabin;font-weight:700;font-size:52px;color:${INK};margin-top:30px;line-height:1.12;">
          ${s.head}
        </div>
        <div style="font-family:Outfit;font-weight:400;font-size:34px;line-height:1.45;
                    color:${INK};opacity:.66;margin-top:20px;">${s.body}</div>
      </div>`;

    return `<div style="width:100%;height:100%;background:${PAPER};
      display:flex;flex-direction:column;align-items:center;justify-content:space-between;
      padding:100px 76px 92px;box-sizing:border-box;text-align:center;">

      <div>
        <div style="font-family:Outfit;font-weight:300;font-size:34px;letter-spacing:.34em;
                    text-transform:uppercase;color:${INK};opacity:.45;">Switching everything at once?</div>
        <div style="font-family:Cabin;font-weight:700;font-size:112px;line-height:1.04;
                    color:${INK};letter-spacing:-.024em;margin-top:24px;">Here is what<br>to expect.</div>
      </div>

      <div style="display:flex;gap:34px;width:100%;align-items:stretch;">
        ${STEPS.map(card).join('')}
      </div>

      <div style="font-family:Outfit;font-weight:400;font-size:40px;color:${INK};opacity:.62;max-width:1500px;">
        Nobody tells you this part. We would rather you knew it before you ordered.
      </div>
    </div>`;
  },
};
