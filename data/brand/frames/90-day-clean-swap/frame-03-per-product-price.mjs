/**
 * 90-Day Clean Swap — frame 3 (educational infographic): the price, per product.
 *
 * Media plan §6: "Break the ~$15 ceiling by pricing per product instead of per
 * box." The buyer balks at $144 because they are comparing it to one bottle. The
 * frame does the division for them: twelve products, $12.00 each — which lands
 * *below* the ~$15 ceiling the VOC file documents rather than beside it.
 *
 * ⚠️ Every figure here is derived at render time, and that is the whole point of
 * this module. The media plan bound these numbers to `price: 159` in config and
 * asked for "a flag in whatever tracks bundle price changes". The price moved to
 * $144, nothing flagged it, and the spec sat there telling anyone who built it to
 * print $159 on a customer-facing image. So: the per-unit line is computed, the
 * value stack is summed from the metafield, and verify() fails if the arithmetic
 * stops working rather than letting a stale number ship.
 */

import { INK, GREEN, PAPER, WASH, RULE, money, assertBundle } from './swap-common.mjs';

const UNITS = 12;

const stackOf = (ctx) => JSON.parse(ctx.need('value_stack'));
const productLines = (ctx) => stackOf(ctx).filter((l) => !/shipping/i.test(l.label));
const productTotal = (ctx) => productLines(ctx).reduce((a, l) => a + l.amount, 0);

export default {
  product: '90-day-clean-swap',
  name: 'frame-03-per-product-price-90day',
  width: 2048,
  height: 2048,

  verify(ctx) {
    assertBundle(ctx, { price: 144, qtyEach: 3, componentCount: 4 });

    const total = productTotal(ctx);
    const compareAt = Number(ctx.variants[0].compareAtPrice);
    if (total !== compareAt) {
      throw new Error(
        `this frame prints ${money(total)} of product against a ${money(compareAt)} compare-at price. `
        + `They must agree — one of the two is wrong.`);
    }
    const per = 144 / UNITS;
    if (!Number.isInteger(per * 100)) throw new Error(`$144 / ${UNITS} is not a clean figure: ${per}`);
    if (per >= 15) {
      throw new Error(
        `the whole argument is that a product here costs less than the ~$15 ceiling, but it is now `
        + `${money(per)}. Re-spec the frame rather than printing a number that loses its own point.`);
    }
    const qty = JSON.parse(ctx.need('component_qty')).reduce((a, b) => a + b, 0);
    if (qty !== UNITS) throw new Error(`frame divides by ${UNITS}, but the box holds ${qty} units`);
  },

  alt(ctx) {
    return `${money(productTotal(ctx))} of products for ${money(144)} — twelve full-size items at `
      + `${money(144 / UNITS)} each.`;
  },

  html(ctx) {
    const lines = productLines(ctx);
    const total = productTotal(ctx);
    const per = 144 / UNITS;

    const row = (l) => `
      <div style="display:flex;justify-content:space-between;align-items:baseline;
                  padding:22px 0;border-bottom:2px solid ${RULE};">
        <div style="font-family:Outfit;font-weight:400;font-size:42px;color:${INK};">${l.label}</div>
        <div style="font-family:Cabin;font-weight:700;font-size:42px;color:${INK};">${money(l.amount)}</div>
      </div>`;

    return `<div style="width:100%;height:100%;background:${PAPER};
      display:flex;flex-direction:column;align-items:center;justify-content:space-between;
      padding:96px 110px 88px;box-sizing:border-box;text-align:center;">

      <div>
        <div style="font-family:Cabin;font-weight:700;font-size:126px;line-height:1.02;
                    color:${INK};letter-spacing:-.026em;">
          ${money(total)} of products.<br>${money(144)}.
        </div>
      </div>

      <div style="width:100%;background:${WASH};border-radius:30px;padding:40px 52px 30px;">
        ${lines.map(row).join('')}
        <div style="display:flex;justify-content:space-between;align-items:baseline;padding:28px 0 6px;">
          <div style="font-family:Cabin;font-weight:700;font-size:46px;color:${INK};">Bought separately</div>
          <div style="font-family:Cabin;font-weight:700;font-size:56px;color:${INK};">${money(total)}</div>
        </div>
      </div>

      <div>
        <div style="width:120px;height:6px;background:${GREEN};border-radius:3px;margin:0 auto 30px;"></div>
        <div style="font-family:Cabin;font-weight:700;font-size:78px;color:${INK};">
          ${UNITS} products — ${money(per)} each
        </div>
        <div style="font-family:Outfit;font-weight:400;font-size:40px;color:${INK};opacity:.6;margin-top:16px;">
          That is division, not a promise about how long anything lasts.
        </div>
      </div>
    </div>`;
  },
};
