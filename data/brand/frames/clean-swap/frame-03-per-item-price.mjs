/**
 * The Clean Swap — frame 3 (text-only): the price, per item.
 *
 * The media plan calls this "the single highest-leverage frame on the page", and
 * the reason is in the VOC file: this store's buyers carry a hard ~$15 ceiling on
 * a body lotion ("I'm hoping to spend around $15 or less", 4 mentions). $59 reads
 * as expensive right up until it is four things at $14.75 — which lands *under*
 * the ceiling rather than near it.
 *
 * Type only, no product, no ad furniture — the arithmetic is the whole asset.
 *
 * Every figure is derived: the $69 is summed from the value-stack metafield and
 * checked against compare-at, and the per-item number is computed. verify() fails
 * if that number ever stops clearing the ceiling, because a version of this frame
 * printing $15.50 would be arguing against itself.
 */

import { INK, GREEN, PAPER, WASH, RULE, money, assertBundle } from '../90-day-clean-swap/swap-common.mjs';

const PRICE = 59;
const ITEMS = 4;
const CEILING = 15;

const lines = (ctx) => JSON.parse(ctx.need('value_stack')).filter((l) => !/shipping/i.test(l.label));
const total = (ctx) => lines(ctx).reduce((a, l) => a + l.amount, 0);

export default {
  product: 'clean-swap',
  name: 'frame-03-per-item-price-cleanswap',
  width: 2048,
  height: 2048,

  verify(ctx) {
    assertBundle(ctx, { price: PRICE, qtyEach: 1, componentCount: ITEMS });
    const t = total(ctx);
    const compareAt = Number(ctx.variants[0].compareAtPrice);
    if (t !== compareAt) {
      throw new Error(`frame prints ${money(t)} of product against a ${money(compareAt)} compare-at — they must agree`);
    }
    const per = PRICE / ITEMS;
    if (!(per < CEILING)) {
      throw new Error(
        `the entire argument is that each item clears the ~${money(CEILING)} ceiling the VOC file documents, `
        + `but it is now ${money(per)}. Re-spec the frame rather than print a number that argues against itself.`);
    }
    if (Math.round(per * 100) !== per * 100) throw new Error(`per-item price is not a clean figure: ${per}`);
  },

  alt(ctx) {
    return `${money(total(ctx))} of products for ${money(PRICE)} — four full-size items at `
      + `${money(PRICE / ITEMS)} each.`;
  },

  html(ctx) {
    const ls = lines(ctx);
    const t = total(ctx);
    const per = PRICE / ITEMS;

    const row = (l) => `
      <div style="display:flex;justify-content:space-between;align-items:baseline;
                  padding:26px 0;border-bottom:2px solid ${RULE};">
        <div style="font-family:Outfit;font-weight:400;font-size:46px;color:${INK};">${l.label}</div>
        <div style="font-family:Cabin;font-weight:700;font-size:46px;color:${INK};">${money(l.amount)}</div>
      </div>`;

    return `<div style="width:100%;height:100%;background:${PAPER};
      display:flex;flex-direction:column;align-items:center;justify-content:space-between;
      padding:104px 120px 96px;box-sizing:border-box;text-align:center;">

      <div style="font-family:Cabin;font-weight:700;font-size:132px;line-height:1.02;
                  color:${INK};letter-spacing:-.028em;">
        ${money(t)} of products.<br>${money(PRICE)}.
      </div>

      <div style="width:100%;background:${WASH};border-radius:30px;padding:44px 56px 34px;">
        ${ls.map(row).join('')}
        <div style="display:flex;justify-content:space-between;align-items:baseline;padding:30px 0 8px;">
          <div style="font-family:Cabin;font-weight:700;font-size:50px;color:${INK};">Bought separately</div>
          <div style="font-family:Cabin;font-weight:700;font-size:62px;color:${INK};">${money(t)}</div>
        </div>
      </div>

      <div>
        <div style="width:120px;height:6px;background:${GREEN};border-radius:3px;margin:0 auto 30px;"></div>
        <div style="font-family:Cabin;font-weight:700;font-size:92px;color:${INK};">
          Four products — ${money(per)} each
        </div>
      </div>
    </div>`;
  },
};
