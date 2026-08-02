/**
 * Sensitive Skin Set — frame 4 (us-vs-them): list against list.
 *
 * Ported from the Reset's ingredients-frame.mjs, which shipped 2026-08-01, with
 * the corrections that frame already absorbed. Two are worth restating because
 * they are the reason it looks like this:
 *
 * 1. **We do not name anyone.** Sean, 2026-08-01: we contrast against the lotion
 *    market in general. The right-hand column is a real published panel from a
 *    nationally sold coconut oil lotion, recorded in
 *    `data/brand/reference/comparison-lotion.json` for traceability and
 *    deliberately unnamed on the frame. The label is non-superlative on purpose —
 *    "leading" or "best-selling" would be a claim we cannot support.
 *
 * 2. **Both lists print in full.** The argument is not "theirs is bad", it is
 *    "ours is short enough to print, and here it is". The asymmetry does the
 *    work, so nothing has to be asserted about what their ingredients do.
 *
 * ── What differs from the Reset's version ───────────────────────────────────
 * The Reset's frame compares one product. This is a two-product set, so the left
 * column is the **union across both** — the number the handoff settled at EIGHT
 * after Sean confirmed the grapefruit seed extract is the organic one in every
 * product. It is derived by setIngredientUnion(), never typed: the original
 * "nine" in the media plan came from a stale config that counted that extract
 * twice, and deriving it is what stops that recurring.
 *
 * ⚠️ Two traps walked past in the open rather than avoided:
 *  - It does **not** imply palm-free. `organic red palm oil` is printed in our list.
 *  - It does **not** imply vegan. `organic beeswax` is printed too, via the cream.
 * A tidier frame that dropped either would be the dishonest one.
 *
 * marketing-product-image-stack caps us-vs-them at three or four attributes won
 * on. This carries one — list length — so there is headroom, but any attribute
 * added has to come from real competitor complaints and be true of both products.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INK, GREEN, PAPER, setIngredientUnion, assertSetIntact } from './set-common.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const COMPARISON = JSON.parse(
  readFileSync(join(ROOT, 'data', 'brand', 'reference', 'comparison-lotion.json'), 'utf8'));

const titleCase = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export default {
  product: 'sensitive-skin-starter-set',
  name: 'frame-04-list-length',
  width: 2048,
  height: 2048,

  /**
   * The media plan calls an invented number here "the single most damaging frame
   * in either stack". So every figure is derived, and the headline is made
   * self-verifying: if our list ever stops being the shorter one, the frame stops
   * building rather than shipping a claim that reads backwards.
   */
  verify(ctx) {
    assertSetIntact(ctx);

    const ours = setIngredientUnion();
    const theirs = COMPARISON.ingredients;

    if (ours.length < 3) throw new Error(`our union looks truncated: ${JSON.stringify(ours)}`);
    if (!Array.isArray(theirs) || theirs.length < 3) throw new Error('comparison list looks truncated');
    if (theirs.some((i) => !i || !i.trim())) throw new Error('comparison list has an empty entry');

    if (!(ours.length < theirs.length)) {
      throw new Error(
        `the whole frame is that ours is the shorter list, but ours is ${ours.length} and the `
        + `comparison is ${theirs.length}. Fix the frame, not the headline.`);
    }
    if (/leading|best.?selling|number one|#1/i.test(COMPARISON.labelOnFrame)) {
      throw new Error(`comparison label "${COMPARISON.labelOnFrame}" makes a ranking claim we cannot support`);
    }
    // The frame prints these two in our column; a "clean" frame that hid them
    // would be implying palm-free and vegan, neither of which is true.
    for (const must of ['red palm oil', 'beeswax']) {
      if (!ours.some((i) => i.toLowerCase().includes(must))) {
        throw new Error(`"${must}" is no longer in the set's ingredients — re-check before re-rendering`);
      }
    }
  },

  alt() {
    const ours = setIngredientUnion();
    return `An ingredient comparison. The Sensitive Skin Set uses ${ours.length} ingredients across both `
      + `products: ${ours.join(', ')}. Beside it, the published list of a conventional coconut oil lotion, `
      + `which has ${COMPARISON.ingredients.length}.`;
  },

  html() {
    const ours = setIngredientUnion();
    const theirs = COMPARISON.ingredients;

    const ourRow = (text) => `
      <div style="display:flex;align-items:flex-start;gap:18px;margin-bottom:18px;">
        <div style="width:13px;height:13px;border-radius:50%;background:${GREEN};flex:0 0 auto;margin-top:14px;"></div>
        <div style="font-family:Outfit;font-weight:400;font-size:38px;line-height:1.3;color:${INK};">${titleCase(text)}</div>
      </div>`;

    // Their list is set smaller and in two sub-columns because it has to be —
    // the argument made typographically rather than asserted.
    const theirRow = (text) => `
      <div style="font-family:Outfit;font-weight:400;font-size:21px;line-height:1.5;
                  color:${INK};opacity:.62;margin-bottom:7px;break-inside:avoid;">${text}</div>`;

    return `<div style="width:100%;height:100%;background:${PAPER};
      display:flex;flex-direction:column;align-items:center;justify-content:center;
      padding:70px 84px;box-sizing:border-box;text-align:center;">

      <div style="font-family:Outfit;font-weight:300;font-size:34px;letter-spacing:.34em;
                  text-transform:uppercase;color:${INK};opacity:.45;margin-bottom:24px;">
        Pure Unscented
      </div>

      <div style="font-family:Cabin;font-weight:700;font-size:112px;line-height:1.04;
                  color:${INK};letter-spacing:-.022em;">
        Same job.<br>Shorter list.
      </div>

      <div style="width:132px;height:6px;background:${GREEN};border-radius:3px;margin:28px 0 40px;"></div>

      <div style="display:flex;gap:40px;width:100%;align-items:stretch;">

        <div style="flex:1;background:#f7f8f5;border-radius:22px;padding:42px 40px;text-align:left;">
          <div style="font-family:Cabin;font-weight:700;font-size:92px;line-height:1;color:${INK};">${ours.length}</div>
          <div style="font-family:Cabin;font-weight:700;font-size:40px;color:${INK};margin-top:6px;">
            ingredients — the whole set
          </div>
          <div style="height:2px;background:rgba(26,27,24,.12);margin:26px 0;"></div>
          ${ours.map(ourRow).join('')}
          <div style="font-family:Outfit;font-weight:400;font-size:32px;color:${INK};opacity:.55;
                      margin-top:22px;padding-top:22px;border-top:2px solid rgba(26,27,24,.12);">
            Both products. Nothing held back.
          </div>
        </div>

        <div style="flex:1;background:rgba(247,248,245,.5);border-radius:22px;padding:42px 40px;text-align:left;">
          <div style="font-family:Cabin;font-weight:700;font-size:92px;line-height:1;color:${INK};opacity:.62;">${theirs.length}</div>
          <div style="font-family:Cabin;font-weight:700;font-size:40px;color:${INK};opacity:.62;margin-top:6px;">
            ingredients — ${COMPARISON.labelOnFrame.replace(/^A /, '')}
          </div>
          <div style="height:2px;background:rgba(26,27,24,.1);margin:26px 0;"></div>
          <div style="column-count:2;column-gap:30px;">
            ${theirs.map(theirRow).join('')}
          </div>
        </div>
      </div>

      <div style="font-family:Outfit;font-weight:400;font-size:38px;color:${INK};opacity:.6;margin-top:38px;">
        Both lists in full. Ours fits on the label.
      </div>
    </div>`;
  },
};
