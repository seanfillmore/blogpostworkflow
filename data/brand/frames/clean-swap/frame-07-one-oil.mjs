/**
 * The Clean Swap — frame 7 (educational infographic): one oil, four products.
 *
 * Media plan: "Explain why one oil runs the whole routine", for the label reader
 * who distrusts the word natural. The answer is not a slogan — it is that the
 * same ingredient is genuinely the base of all four, saponified in the bar and
 * unrefined in the other three.
 *
 * The plan asks for this to look diagrammatic and undesigned, borrowing the
 * credibility of an organic panel rather than an ad.
 *
 * Everything is read from config/ingredients.json. verify() fails if coconut oil
 * stops being present in any of the four, which is the only thing the frame
 * actually claims.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INK, GREEN, PAPER, WASH, assertBundle } from '../90-day-clean-swap/swap-common.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const ING = JSON.parse(readFileSync(join(ROOT, 'config', 'ingredients.json'), 'utf8'));

const ROWS = [
  { key: 'toothpaste', label: 'Toothpaste' },
  { key: 'bar_soap', label: 'Bar Soap' },
  { key: 'lotion', label: 'Body Lotion' },
  { key: 'deodorant', label: 'Deodorant' },
];

const coconutIn = (key) => ING[key].base_ingredients.find((i) => i.toLowerCase().includes('coconut'));

export default {
  product: 'clean-swap',
  name: 'frame-07-one-oil-cleanswap',
  width: 2048,
  height: 2048,

  verify(ctx) {
    assertBundle(ctx, { price: 59, qtyEach: 1, componentCount: 4 });
    for (const r of ROWS) {
      const found = coconutIn(r.key);
      if (!found) {
        throw new Error(
          `this frame claims one oil runs all four, but ${r.key} no longer lists a coconut oil. `
          + `That is the only claim the frame makes — pull it rather than reword it.`);
      }
    }
  },

  alt() {
    return 'One oil across all four products: ' + ROWS.map((r) => `${r.label} — ${coconutIn(r.key)}`).join(', ') + '.';
  },

  html() {
    const row = (r) => `
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:30px;
                  padding:32px 0;border-bottom:2px solid rgba(26,27,24,.10);">
        <div style="font-family:Cabin;font-weight:700;font-size:50px;color:${INK};white-space:nowrap;">${r.label}</div>
        <div style="font-family:Outfit;font-weight:400;font-size:38px;color:${INK};opacity:.66;text-align:right;">
          ${coconutIn(r.key)}
        </div>
      </div>`;

    return `<div style="width:100%;height:100%;background:${PAPER};
      display:flex;flex-direction:column;align-items:center;justify-content:space-between;
      padding:104px 110px 96px;box-sizing:border-box;text-align:center;">

      <div>
        <div style="font-family:Cabin;font-weight:700;font-size:130px;line-height:1.02;
                    color:${INK};letter-spacing:-.028em;">One oil.<br>Four products.</div>
        <div style="font-family:Outfit;font-weight:400;font-size:42px;color:${INK};opacity:.62;margin-top:26px;">
          The same base ingredient in every one of them.
        </div>
      </div>

      <div style="width:100%;background:${WASH};border-radius:30px;padding:26px 56px 22px;">
        ${ROWS.map(row).join('')}
      </div>

      <div>
        <div style="width:120px;height:6px;background:${GREEN};border-radius:3px;margin:0 auto 26px;"></div>
        <div style="font-family:Outfit;font-weight:400;font-size:40px;color:${INK};opacity:.66;max-width:1500px;">
          Saponified in the bar, unrefined in the other three. Not four formulas with a word in common.
        </div>
      </div>
    </div>`;
  },
};
