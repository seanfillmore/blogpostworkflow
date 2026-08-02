/**
 * 90-Day Clean Swap — frame 2 (headliner): the switch, not the box.
 *
 * Media plan §6: "Frame the purchase as finishing the switch, not buying a box."
 * The buyer is mid-changeover — they have replaced one or two things, their shelf
 * is half clean and half drugstore, and they are tired of doing it a bottle at a
 * time. They are not price-shopping a lotion; they are buying the end of a
 * project.
 *
 * So this frame deliberately shows ONE of each rather than all twelve. Frame 1
 * owns the volume argument; repeating it here would put two jobs in one image and
 * blur both. What this one has to communicate is *coverage* — that these four
 * are the whole daily routine, with nothing left on the shelf to replace later.
 */

import { INK, GREEN, PAPER, unit, cutout, kindOf, LABEL, kitsFor, assertBundle, scaled } from './swap-common.mjs';

const PX_PER_CM = 40;

const USE = {
  lotion: 'after every shower',
  deodorant: 'every morning',
  toothpaste: 'twice a day',
  soap: 'every wash',
};

export default {
  product: '90-day-clean-swap',
  name: 'frame-02-whole-routine-90day',
  width: 2048,
  height: 2048,

  verify(ctx) {
    assertBundle(ctx, { price: 144, qtyEach: 3, componentCount: 4 });
    const kit = kitsFor('90-day-clean-swap').find((k) => k.name === 'Gentle');
    if (kit.components.length !== 4) throw new Error(`expected 4 distinct products, got ${kit.components.length}`);
    for (const c of kit.components) {
      if (!USE[kindOf(c.slug)]) throw new Error(`no usage line recorded for ${kindOf(c.slug)}`);
    }
  },

  alt() {
    return 'The four daily products in the 90-Day Clean Swap — body lotion, deodorant, toothpaste and '
      + 'bar soap — the whole routine swapped in one order.';
  },

  html(ctx) {
    const kit = kitsFor('90-day-clean-swap').find((k) => k.name === 'Gentle');
    const A = (p) => ctx.asset(p);
    const shelf = scaled('lotion', PX_PER_CM);

    const col = (c) => `
      <div style="display:flex;flex-direction:column;align-items:center;">
        ${unit({ src: A(cutout(c.slug)), slug: c.slug, pxPerCm: PX_PER_CM, boxH: shelf })}
        <div style="font-family:Cabin;font-weight:700;font-size:44px;color:${INK};margin-top:30px;">
          ${LABEL[kindOf(c.slug)]}
        </div>
        <div style="font-family:Outfit;font-weight:400;font-size:33px;color:${INK};opacity:.55;margin-top:8px;">
          ${USE[kindOf(c.slug)]}
        </div>
      </div>`;

    return `<div style="width:100%;height:100%;background:${PAPER};
      display:flex;flex-direction:column;align-items:center;justify-content:space-between;
      padding:96px 80px 88px;box-sizing:border-box;text-align:center;">

      <div style="font-family:Cabin;font-weight:700;font-size:124px;line-height:1.02;
                  color:${INK};letter-spacing:-.026em;">
        Swap your whole<br>routine at once.
      </div>

      <div style="display:flex;align-items:flex-end;justify-content:center;gap:70px;">
        ${kit.components.map(col).join('')}
      </div>

      <div>
        <div style="width:120px;height:6px;background:${GREEN};border-radius:3px;margin:0 auto 28px;"></div>
        <div style="font-family:Outfit;font-weight:400;font-size:44px;line-height:1.45;
                    color:${INK};opacity:.66;max-width:1450px;">
          Everything you put on your body daily — and nothing left on the shelf to replace next month.
        </div>
      </div>
    </div>`;
  },
};
