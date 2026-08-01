/**
 * 90-Day Coconut Reset — frame 6 (us-vs-them), shared builder.
 *
 * Media plan §6: "Win on ingredient list length, not price." Headline: "Same job.
 * Shorter list."
 *
 * ── Two corrections from Sean, 2026-08-01 ───────────────────────────────────
 *
 * 1. **The first version contradicted its own headline.** It put our full list
 *    against a column of six things we exclude — so the "shorter list" on the frame
 *    was *ours*, six items against seven. The visual argument ran backwards.
 *
 * 2. **We contrast list against list, and we do not name them.** The right column is
 *    now a real published panel from a nationally sold coconut oil lotion — 34
 *    ingredients against our 7. The brand is recorded in
 *    `data/brand/reference/comparison-lotion.json` for traceability and is
 *    deliberately absent from the frame: the point is the market, not one rival.
 *
 * Both lists are printed in full. That is the whole argument — the claim is not
 * "theirs is bad", it is "ours is short enough to print, and here it is". The
 * asymmetry does the work, so nothing has to be asserted about what their
 * ingredients do.
 *
 * ⚠️ Two traps walked past in the open rather than avoided, both flagged in the plan:
 *  - It does **not** imply palm-free. `organic red palm oil` is printed in our list.
 *  - It does **not** imply vegan. The Body Cream count is shown rather than quietly
 *    dropped in favour of the shorter lotion, so its beeswax is not hidden.
 * A tidier frame that omitted either would be the dishonest one.
 *
 * The label on the comparison column is deliberately non-superlative. "Leading" or
 * "best-selling" would be a claim we cannot support; "a conventional coconut oil
 * lotion" is accurate and needs no support.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// this module sits at data/brand/frames/<product>/ — four levels below the repo root
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const INGREDIENTS = JSON.parse(readFileSync(join(ROOT, 'config', 'ingredients.json'), 'utf8'));
const COMPARISON = JSON.parse(readFileSync(join(ROOT, 'data', 'brand', 'reference', 'comparison-lotion.json'), 'utf8'));

const BLACK = '#000000';
const SAND = '#EDE5D8';
const GREEN = '#AEDEAC';
const PANEL = '#F6F2EA';

const titleCase = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** The full, real ingredient list for one of our products in one scent. */
function listFor(productKey, variantName) {
  const p = INGREDIENTS[productKey];
  const v = p.variations.find((x) => x.name === variantName);
  if (!v) throw new Error(`config/ingredients.json has no "${variantName}" variation of ${productKey}`);
  return [...p.base_ingredients, ...v.essential_oils];
}

export function ingredientsFrame({ name, variant }) {
  return {
    product: '99-coconut-reset-digital',
    name,
    width: 2048,
    height: 2048,
    reads: [],

    /**
     * The plan calls an invented number here "the single most damaging frame in
     * either stack", so every figure is derived rather than typed, and the headline
     * is made self-verifying: if our list is ever not the shorter one, the frame
     * stops building instead of shipping a claim that reads backwards. That is
     * exactly the failure the first version shipped past.
     */
    verify(ctx) {
      const ours = listFor('lotion', variant);
      const theirs = COMPARISON.ingredients;

      if (ours.length < 3) throw new Error(`our list looks truncated: ${JSON.stringify(ours)}`);
      if (theirs.length < 3) throw new Error('comparison list looks truncated');
      if (theirs.some((i) => !i || !i.trim())) throw new Error('comparison list has an empty entry');

      if (!(ours.length < theirs.length)) {
        throw new Error(`the headline says "Shorter list" but ours is ${ours.length} and the comparison `
          + `is ${theirs.length}. Fix the frame, not the headline.`);
      }
      if (/leading|best.?selling|number one|#1/i.test(COMPARISON.labelOnFrame)) {
        throw new Error(`comparison label "${COMPARISON.labelOnFrame}" makes a ranking claim we cannot support`);
      }
      if (!ctx.variants.some((v) => v.title === variant)) {
        throw new Error(`no variant titled "${variant}" — a frame must describe a kit somebody can buy`);
      }
    },

    alt() {
      const ours = listFor('lotion', variant);
      const cream = listFor('cream', variant);
      return `An ingredient comparison. The ${variant} Body Lotion has ${ours.length} ingredients: `
        + `${ours.join(', ')}. The Body Cream has ${cream.length}. Beside it, the published list of a `
        + `conventional coconut oil lotion, which has ${COMPARISON.ingredients.length}.`;
    },

    html() {
      const ours = listFor('lotion', variant);
      const cream = listFor('cream', variant);
      const theirs = COMPARISON.ingredients;

      const ourRow = (text) => `
        <div style="display:flex;align-items:flex-start;gap:18px;margin-bottom:18px;">
          <div style="width:13px;height:13px;border-radius:50%;background:${GREEN};
                      border:2.5px solid ${BLACK};box-sizing:border-box;flex:0 0 auto;margin-top:13px;"></div>
          <div style="font-family:Outfit;font-weight:400;font-size:38px;line-height:1.3;color:${BLACK};">${titleCase(text)}</div>
        </div>`;

      // Their list is set smaller and in two sub-columns because it has to be — that
      // is the argument made typographically rather than asserted.
      const theirRow = (text) => `
        <div style="font-family:Outfit;font-weight:400;font-size:21px;line-height:1.5;
                    color:${BLACK};opacity:.62;margin-bottom:7px;break-inside:avoid;">${text}</div>`;

      return `<div style="
        width:100%;height:100%;background:${SAND};
        display:flex;flex-direction:column;align-items:center;justify-content:center;
        padding:70px 84px;text-align:center;">

        <div style="font-family:Outfit;font-weight:300;font-size:34px;letter-spacing:.34em;
                    text-transform:uppercase;color:${BLACK};opacity:.45;margin-bottom:24px;">
          ${variant}
        </div>

        <div style="font-family:Cabin;font-weight:700;font-size:112px;line-height:1.04;
                    color:${BLACK};letter-spacing:-.022em;">
          Same job.<br>Shorter list.
        </div>

        <div style="width:132px;height:6px;background:${GREEN};border-radius:3px;margin:28px 0 40px;"></div>

        <div style="display:flex;gap:40px;width:100%;align-items:stretch;">

          <div style="flex:1;background:${PANEL};border-radius:22px;padding:42px 40px;text-align:left;">
            <div style="font-family:Cabin;font-weight:700;font-size:92px;line-height:1;color:${BLACK};">${ours.length}</div>
            <div style="font-family:Cabin;font-weight:700;font-size:40px;color:${BLACK};margin-top:6px;">
              ingredients — our Body Lotion
            </div>
            <div style="height:2px;background:rgba(0,0,0,.12);margin:26px 0 26px;"></div>
            ${ours.map(ourRow).join('')}
            <div style="font-family:Outfit;font-weight:400;font-size:32px;color:${BLACK};opacity:.55;
                        margin-top:22px;padding-top:22px;border-top:2px solid rgba(0,0,0,.12);">
              Our Body Cream: ${cream.length} ingredients
            </div>
          </div>

          <div style="flex:1;background:rgba(246,242,234,.5);border-radius:22px;padding:42px 40px;text-align:left;">
            <div style="font-family:Cabin;font-weight:700;font-size:92px;line-height:1;color:${BLACK};opacity:.62;">${theirs.length}</div>
            <div style="font-family:Cabin;font-weight:700;font-size:40px;color:${BLACK};opacity:.62;margin-top:6px;">
              ingredients — ${COMPARISON.labelOnFrame.replace(/^A /, '')}
            </div>
            <div style="height:2px;background:rgba(0,0,0,.1);margin:26px 0 26px;"></div>
            <div style="column-count:2;column-gap:30px;">
              ${theirs.map(theirRow).join('')}
            </div>
          </div>
        </div>

        <div style="font-family:Outfit;font-weight:400;font-size:38px;color:${BLACK};opacity:.6;margin-top:38px;">
          Both lists in full. Ours fits on the label.
        </div>
      </div>`;
    },
  };
}
