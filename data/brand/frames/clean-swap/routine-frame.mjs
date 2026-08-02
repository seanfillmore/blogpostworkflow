/**
 * The Clean Swap — frame 1 (headliner): four categories, one routine.
 *
 * Media plan: "Make four categories read as one routine." Lotion, deodorant,
 * toothpaste and soap live in four different aisles in every store this buyer has
 * shopped — nothing in her experience says they belong together, and a list will
 * not fix that. Only seeing all four in one moment will.
 *
 * ⚠️ NOT the specced frame. The spec asks for these on a real bathroom counter in
 * morning light, hand mid-pour, towel in frame — and says explicitly "not a
 * white-background product shot, the whole point is the counter". That needs a
 * shoot and is on the list. What this does instead is carry the same argument
 * with the moment of day beside each product, so the four read as one morning
 * rather than four purchases. It is a stand-in for a better asset, not a
 * substitute for one.
 */

import { INK, GREEN, PAPER, unit, cutout, kindOf, LABEL, kitsFor, assertBundle, scaled, money }
  from '../90-day-clean-swap/swap-common.mjs';

const PX_PER_CM = 40;
const WHEN = {
  toothpaste: 'first thing',
  soap: 'in the shower',
  lotion: 'straight after',
  deodorant: 'before you dress',
};
/** Order of the morning, not the order of the roster. */
const SEQUENCE = ['toothpaste', 'soap', 'lotion', 'deodorant'];

export function routineFrame({ kitName, name }) {
  return {
    product: 'clean-swap',
    name,
    width: 2048,
    height: 2048,

    verify(ctx) {
      assertBundle(ctx, { price: 59, qtyEach: 1, componentCount: 4 });
      const kit = kitsFor('clean-swap').find((k) => k.name === kitName);
      if (!kit) throw new Error(`config/bundles.json has no "${kitName}" variant of clean-swap`);
      if (!ctx.variants.some((v) => v.title === kitName)) {
        throw new Error(`no live variant titled "${kitName}"`);
      }
      const kinds = kit.components.map((c) => kindOf(c.slug)).sort();
      if (kinds.join() !== [...SEQUENCE].sort().join()) {
        throw new Error(`the morning sequence covers ${SEQUENCE.join(', ')} but the kit holds ${kinds.join(', ')}`);
      }
    },

    alt() {
      const kit = kitsFor('clean-swap').find((k) => k.name === kitName);
      return `The ${kitName} kit as one morning routine — `
        + SEQUENCE.map((k) => {
          const c = kit.components.find((x) => kindOf(x.slug) === k);
          return `${LABEL[k]} ${WHEN[k]}`;
        }).join(', ') + '.';
    },

    html(ctx) {
      const kit = kitsFor('clean-swap').find((k) => k.name === kitName);
      const A = (p) => ctx.asset(p);
      const shelf = scaled('lotion', PX_PER_CM);

      const col = (k) => {
        const c = kit.components.find((x) => kindOf(x.slug) === k);
        return `
          <div style="display:flex;flex-direction:column;align-items:center;">
            ${unit({ src: A(cutout(c.slug)), slug: c.slug, pxPerCm: PX_PER_CM, boxH: shelf })}
            <div style="font-family:Outfit;font-weight:600;font-size:28px;letter-spacing:.16em;
                        text-transform:uppercase;color:${GREEN};margin-top:28px;">${WHEN[k]}</div>
            <div style="font-family:Cabin;font-weight:700;font-size:44px;color:${INK};margin-top:10px;">${LABEL[k]}</div>
          </div>`;
      };

      return `<div style="width:100%;height:100%;background:${PAPER};
        display:flex;flex-direction:column;align-items:center;justify-content:space-between;
        padding:96px 72px 88px;box-sizing:border-box;text-align:center;">

        <div>
          <div style="font-family:Outfit;font-weight:300;font-size:34px;letter-spacing:.34em;
                      text-transform:uppercase;color:${INK};opacity:.45;">${kitName} kit</div>
          <div style="font-family:Cabin;font-weight:700;font-size:124px;line-height:1.02;
                      color:${INK};letter-spacing:-.026em;margin-top:24px;">
            Everything you touch<br>before 8am.
          </div>
        </div>

        <div style="display:flex;align-items:flex-end;justify-content:center;gap:64px;">
          ${SEQUENCE.map(col).join('')}
        </div>

        <div>
          <div style="width:120px;height:6px;background:${GREEN};border-radius:3px;margin:0 auto 26px;"></div>
          <div style="font-family:Outfit;font-weight:400;font-size:44px;color:${INK};opacity:.66;">
            Four aisles at the store. One box here. ${money(59)}.
          </div>
        </div>
      </div>`;
    },
  };
}
