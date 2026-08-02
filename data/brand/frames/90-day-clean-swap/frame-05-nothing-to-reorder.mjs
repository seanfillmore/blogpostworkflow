/**
 * 90-Day Clean Swap — frame 5 (benefit callout): the reordering stops.
 *
 * Media plan §6: "Sell the absence of reordering as the real product." The buyer
 * this is for is the person who runs out of deodorant on a Tuesday. The value is
 * not the discount, it is not thinking about it again for a season.
 *
 * ⚠️ The plan is explicit that this frame may say "months" and must NOT carry a
 * specific day count or a per-day figure. Two other pages had a duration claim
 * removed on 2026-07-27 for exactly that. The bundle is *named* 90-Day and its
 * own FAQ says about 90 days, so a day count would arguably be defensible — but
 * the plan's caution is deliberate and this frame does not relitigate it. The
 * guard below fails the build if a digit-plus-unit ever appears in the copy.
 */

import { INK, GREEN, PAPER, WASH, money, assertBundle } from './swap-common.mjs';

const HEADLINE = 'Nothing to reorder<br>for months.';
const LINES = ['One order, one delivery, and the shelf stays stocked through the season.'];

/** No day counts, no per-day maths, no duration promises. */
const DURATION_CLAIM = /\b\d+\s*(day|days|week|weeks|month|months)\b|\bper day\b|\ba day\b/i;

export default {
  product: '90-day-clean-swap',
  name: 'frame-05-nothing-to-reorder-90day',
  width: 2048,
  height: 2048,

  verify(ctx) {
    assertBundle(ctx, { price: 144, qtyEach: 3, componentCount: 4 });
    for (const text of [HEADLINE, ...LINES]) {
      const hit = text.replace(/<br>/g, ' ').match(DURATION_CLAIM);
      if (hit) {
        throw new Error(
          `copy contains "${hit[0]}". Media plan §6: this frame says "months" and carries no specific `
          + `day count or per-day figure — that claim was removed from two other pages on 2026-07-27.`);
      }
    }
  },

  alt() {
    return 'Three of each product — body lotion, deodorant, toothpaste and bar soap — so there is '
      + 'nothing to reorder for months.';
  },

  html(ctx) {
    const qty = JSON.parse(ctx.need('component_qty'));
    const tile = (n, label) => `
      <div style="flex:1;background:${WASH};border-radius:26px;padding:44px 20px;">
        <div style="font-family:Cabin;font-weight:700;font-size:120px;line-height:1;color:${GREEN};">${n}</div>
        <div style="font-family:Cabin;font-weight:700;font-size:38px;color:${INK};margin-top:14px;">${label}</div>
      </div>`;

    return `<div style="width:100%;height:100%;background:${PAPER};
      display:flex;flex-direction:column;align-items:center;justify-content:space-between;
      padding:110px 96px 100px;box-sizing:border-box;text-align:center;">

      <div style="font-family:Cabin;font-weight:700;font-size:132px;line-height:1.02;
                  color:${INK};letter-spacing:-.028em;">${HEADLINE}</div>

      <div style="display:flex;gap:30px;width:100%;">
        ${tile(qty[0], 'Body Lotions')}
        ${tile(qty[1], 'Deodorants')}
        ${tile(qty[2], 'Toothpastes')}
        ${tile(qty[3], 'Bar Soaps')}
      </div>

      <div>
        <div style="font-family:Outfit;font-weight:400;font-size:46px;line-height:1.45;
                    color:${INK};opacity:.68;max-width:1520px;">${LINES[0]}</div>
        <div style="font-family:Outfit;font-weight:600;font-size:34px;letter-spacing:.2em;
                    text-transform:uppercase;color:${INK};opacity:.45;margin-top:34px;">
          One box · ${money(144)}
        </div>
      </div>
    </div>`;
  },
};
