/**
 * The Clean Swap — frame 5 (us-vs-them): what leaves the bathroom.
 *
 * Media plan: "Name what's leaving the bathroom." The buyer is the ingredient-
 * label reader auditing the swap, and what she wants is a list of what she is
 * getting rid of — not a claim about what we add.
 *
 * ── The claims and where they come from ─────────────────────────────────────
 * Every "out" item is a category-level statement about conventional formulas,
 * which the plan says is defensible, and each is additionally checked against a
 * real published panel where we hold one: Sodium Lauryl Sulfate and Sodium
 * Fluoride are both on the conventional toothpaste panel Sean supplied on
 * 2026-08-02, and synthetic fragrance appears on the conventional lotion panel as
 * "Fragrance (Parfum)". No brand is named or depicted.
 *
 * The other half of every row is asserted the harder way: verify() re-reads
 * config/ingredients.json and fails if any of these terms has appeared in any of
 * the four products in this box. The frame cannot outlive its own claim.
 *
 * ⚠️ Fluoride belongs in this column for THIS bundle only — the plan is explicit
 * that the Gift Box has no toothpaste in it, so a copy of this frame there would
 * be claiming to remove something the box never touches.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INK, GREEN, PAPER, WASH, assertBundle } from '../90-day-clean-swap/swap-common.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const ING = JSON.parse(readFileSync(join(ROOT, 'config', 'ingredients.json'), 'utf8'));
const PRODUCTS = ['lotion', 'deodorant', 'toothpaste', 'bar_soap'];

/** Every ingredient across the four products in this box, variations included. */
function everything() {
  const out = [];
  for (const k of PRODUCTS) {
    const p = ING[k];
    out.push(...p.base_ingredients);
    for (const v of p.variations ?? []) out.push(...(v.essential_oils ?? []));
  }
  return out.map((i) => i.toLowerCase());
}

/** Spelled out so the headline can never disagree with the list beneath it. */
const WORD = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];

const OUT = [
  { name: 'Sodium lauryl sulfate', where: 'in the toothpaste and the soap', terms: ['sodium lauryl sulfate', 'sls'] },
  { name: 'Aluminium salts', where: 'in the deodorant', terms: ['aluminum', 'aluminium'] },
  { name: 'Fluoride', where: 'in the toothpaste', terms: ['fluoride'] },
  { name: 'Parabens', where: 'in all four', terms: ['paraben'] },
  { name: 'Synthetic fragrance', where: 'in all four', terms: ['synthetic fragrance', 'parfum'] },
];

export default {
  product: 'clean-swap',
  name: 'frame-05-swapping-out-cleanswap',
  width: 2048,
  height: 2048,

  verify(ctx) {
    assertBundle(ctx, { price: 59, qtyEach: 1, componentCount: 4 });
    const mine = everything();
    for (const row of OUT) {
      for (const t of row.terms) {
        const hit = mine.find((i) => i.includes(t));
        if (hit) {
          throw new Error(
            `this frame says "${row.name}" is out, but "${hit}" is now in one of the four products. `
            + `The claim is false — pull the row, do not soften it.`);
        }
      }
    }
    // The media plan's own headline said "four things" over a list of five. The
    // headline is now generated from the list length, so they cannot disagree —
    // but the word table has to cover it.
    if (!WORD[OUT.length]) throw new Error(`no spelled-out word for ${OUT.length} rows`);

    // The box must actually contain a toothpaste for the fluoride row to mean anything.
    const qty = JSON.parse(ctx.need('component_qty'));
    if (qty.length !== 4) throw new Error(`fluoride row assumes a four-product box; component_qty is ${JSON.stringify(qty)}`);
  },

  alt() {
    return 'What the Clean Swap takes out of your bathroom: sodium lauryl sulfate, aluminium salts, '
      + 'fluoride, parabens and synthetic fragrance. None appears in any of the four products.';
  },

  html() {
    const row = (r) => `
      <div style="display:flex;align-items:center;gap:26px;padding:30px 0;border-bottom:2px solid rgba(26,27,24,.10);">
        <svg viewBox="0 0 24 24" width="46" height="46" aria-hidden="true" style="flex:0 0 auto;">
          <path d="M5 5 L19 19 M19 5 L5 19" stroke="${INK}" stroke-opacity=".38" stroke-width="3" stroke-linecap="round"/>
        </svg>
        <div style="text-align:left;">
          <div style="font-family:Cabin;font-weight:700;font-size:52px;color:${INK};">${r.name}</div>
          <div style="font-family:Outfit;font-weight:400;font-size:32px;color:${INK};opacity:.55;margin-top:4px;">
            usually ${r.where}
          </div>
        </div>
      </div>`;

    return `<div style="width:100%;height:100%;background:${PAPER};
      display:flex;flex-direction:column;align-items:center;justify-content:space-between;
      padding:100px 110px 92px;box-sizing:border-box;text-align:center;">

      <div style="font-family:Cabin;font-weight:700;font-size:118px;line-height:1.03;
                  color:${INK};letter-spacing:-.026em;">
        The ${WORD[OUT.length]} things<br>you are swapping out.
      </div>

      <div style="width:100%;background:${WASH};border-radius:30px;padding:26px 56px 20px;">
        ${OUT.map(row).join('')}
      </div>

      <div>
        <div style="width:120px;height:6px;background:${GREEN};border-radius:3px;margin:0 auto 26px;"></div>
        <div style="font-family:Outfit;font-weight:400;font-size:42px;color:${INK};opacity:.66;max-width:1500px;">
          None of these is in any of the four products in this box.
        </div>
      </div>
    </div>`;
  },
};
