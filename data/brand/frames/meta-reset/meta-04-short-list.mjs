/**
 * Meta static 4 of 5 — us-vs-them, and nobody is named.
 *
 * Sean, 2026-08-01: we contrast against the lotion market in general, never a
 * named brand. The right column is a real published panel from a nationally
 * sold coconut oil lotion, recorded in data/brand/reference/comparison-lotion.json
 * and deliberately unlabelled beyond a non-superlative description.
 *
 * The count is DERIVED from config/ingredients.json, never typed. This frame
 * exists partly because a typed count was wrong: the lander shipped saying "6
 * ingredients", which is true of the lotion alone and false of this bundle. The
 * union across lotion and cream is 8, and two of those eight are palm.
 *
 * Two things this frame refuses to do, because the tidier version would be the
 * dishonest one:
 *   - it does not imply palm-free — organic red palm oil is printed
 *   - it does not imply vegan     — organic beeswax is printed
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const INGREDIENTS = JSON.parse(readFileSync(join(ROOT, 'config', 'ingredients.json'), 'utf8'));
const COMPARISON = JSON.parse(
  readFileSync(join(ROOT, 'data', 'brand', 'reference', 'comparison-lotion.json'), 'utf8'));

const INK = '#1a1b18';
const GREEN = '#4a8b3c';
const PAPER = '#ffffff';

/** Union across both formulas, derived — the number that was typed wrong once. */
export function union() {
  const out = [];
  for (const key of ['lotion', 'cream']) {
    for (const i of INGREDIENTS[key].base_ingredients) {
      if (!out.some((x) => x.toLowerCase() === i.toLowerCase())) out.push(i);
    }
  }
  return out;
}

const titleCase = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export default {
  product: '99-coconut-reset-digital',
  name: 'meta-04-short-list',
  width: 1080,
  height: 1350,

  verify() {
    const ours = union();
    const theirs = COMPARISON.ingredients;
    if (ours.length < 3) throw new Error(`our union looks truncated: ${JSON.stringify(ours)}`);
    if (!Array.isArray(theirs) || theirs.length < 3) throw new Error('comparison list looks truncated');
    if (!(ours.length < theirs.length)) {
      throw new Error(`the whole frame is that ours is the shorter list, but ours is ${ours.length} `
        + `and the comparison is ${theirs.length}. Fix the frame, not the headline.`);
    }
    if (/leading|best.?selling|number one|#1/i.test(COMPARISON.labelOnFrame)) {
      throw new Error(`comparison label "${COMPARISON.labelOnFrame}" makes a ranking claim we cannot support`);
    }
    for (const must of ['red palm oil', 'beeswax']) {
      if (!ours.some((i) => i.toLowerCase().includes(must))) {
        throw new Error(`"${must}" is no longer in the union — this frame prints it on purpose`);
      }
    }
  },

  alt: () => {
    const ours = union();
    return `An ingredient comparison. The 90-Day Coconut Reset uses ${ours.length} ingredients across both `
      + `formulas: ${ours.join(', ')}. Beside it, the published list of a conventional coconut oil lotion, `
      + `which has ${COMPARISON.ingredients.length}.`;
  },

  html: () => {
    const ours = union();
    const theirs = COMPARISON.ingredients;
    const mine = (t) => `<div style="font-family:Outfit;font-size:27px;line-height:1.42;color:${INK};
      margin-bottom:11px;">${titleCase(t)}</div>`;
    const other = (t) => `<div style="font-family:Outfit;font-size:15px;line-height:1.5;color:${INK};
      opacity:.55;margin-bottom:5px;break-inside:avoid;">${t}</div>`;
    return `
    <div style="width:100%;height:100%;background:${PAPER};box-sizing:border-box;
                padding:78px 66px;display:flex;flex-direction:column;">

      <div style="font-family:Cabin;font-weight:700;font-size:96px;line-height:1;
                  letter-spacing:-.03em;color:${INK};text-align:center;">
        ${ours.length} ingredients.
      </div>
      <div style="font-family:Outfit;font-size:36px;color:${INK};opacity:.55;
                  text-align:center;margin-top:16px;">Both formulas. The whole list.</div>

      <div style="width:130px;height:7px;background:${GREEN};border-radius:4px;margin:34px auto 40px;"></div>

      <div style="display:flex;gap:30px;flex:1;align-items:stretch;">
        <div style="flex:1;background:#f7f8f5;border-radius:20px;padding:34px 30px;">
          <div style="font-family:Cabin;font-weight:700;font-size:60px;color:${INK};line-height:1;">${ours.length}</div>
          <div style="font-family:Cabin;font-weight:700;font-size:26px;color:${INK};margin:6px 0 20px;">
            the Reset
          </div>
          ${ours.map(mine).join('')}
        </div>
        <div style="flex:1;background:rgba(247,248,245,.5);border-radius:20px;padding:34px 30px;">
          <div style="font-family:Cabin;font-weight:700;font-size:60px;color:${INK};opacity:.55;line-height:1;">${theirs.length}</div>
          <div style="font-family:Cabin;font-weight:700;font-size:26px;color:${INK};opacity:.55;margin:6px 0 20px;">
            ${COMPARISON.labelOnFrame.replace(/^A /, '')}
          </div>
          <div style="column-count:2;column-gap:20px;">${theirs.map(other).join('')}</div>
        </div>
      </div>

      <div style="font-family:Outfit;font-size:29px;color:${INK};opacity:.55;
                  text-align:center;margin-top:30px;">
        Both lists in full. Ours fits on the label.
      </div>
    </div>`;
  },
};
