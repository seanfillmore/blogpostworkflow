/**
 * Sensitive Skin Set — frame 2 (educational infographic): fragrance-free, proved.
 *
 * Media plan §6 frame 2: "Prove 'fragrance-free' means no masking fragrance
 * either." The buyer is the one attribute-filtering on fragrance who has been
 * burned by something labelled gentle, so the job is to remove a doubt, not to
 * excite.
 *
 * ── How it proves rather than asserts ───────────────────────────────────────
 * The spec's headline was *No fragrance. Not even "unscented" fragrance.* — which
 * is a claim about what other brands do, and we have no evidence in this repo for
 * what any of them put in a bottle. So the frame makes the same point using only
 * facts about our own products: it prints the complete list of both, and states
 * that Pure Unscented carries no essential oils at all.
 *
 * A list you can read to the end IS the proof. If nothing on it is a fragrance,
 * there is nowhere for a masking fragrance to hide, and no assertion about the
 * category is needed to land it.
 *
 * ── One job, versus frame 4 ─────────────────────────────────────────────────
 * Frame 4 also prints our list, but its argument is *length* against the market.
 * This frame's argument is *absence of one specific thing* — it never mentions a
 * competitor and never compares. Same raw material, two different jobs, which is
 * what keeps both inside the one-job-per-asset rule.
 *
 * The verify() below is the real content of this frame: it re-derives the lists
 * from config/ingredients.json and refuses to build if anything fragrance-shaped
 * has appeared in either product, or if Pure Unscented ever stops being free of
 * essential oils. The frame cannot outlive the fact it states.
 */

import {
  INK, GREEN, PAPER, RULE,
  ingredientsFor, essentialOilsFor, setIngredientUnion, FRAGRANCE_TERMS, assertSetIntact,
} from './set-common.mjs';

const titleCase = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** What is deliberately absent. Every line here is supported by the component PDPs. */
const ABSENT = [
  'Synthetic fragrance',
  'Parfum, or "aroma"',
  'Essential oils',
  'Masking fragrance',
];

export default {
  product: 'sensitive-skin-starter-set',
  name: 'frame-02-fragrance-free',
  width: 2048,
  height: 2048,

  verify(ctx) {
    assertSetIntact(ctx);

    for (const key of ['lotion', 'cream']) {
      const list = ingredientsFor(key);
      if (list.length < 3) throw new Error(`${key} list looks truncated: ${JSON.stringify(list)}`);

      const offending = list.filter((i) => FRAGRANCE_TERMS.test(i));
      if (offending.length) {
        throw new Error(
          `this frame states the set contains no fragrance of any kind, but ${key} now lists `
          + `${offending.join(', ')}. Pull the frame — do not soften the wording.`);
      }
    }

    // The claim "no essential oils at all" is specifically about Pure Unscented.
    for (const key of ['lotion', 'cream']) {
      const oils = essentialOilsFor(key);
      if (oils.length) {
        throw new Error(`Pure Unscented ${key} now lists essential oils: ${JSON.stringify(oils)}`);
      }
    }
  },

  alt() {
    const lotion = ingredientsFor('lotion');
    const cream = ingredientsFor('cream');
    return `Every ingredient in the Sensitive Skin Set. The Pure Unscented Body Lotion has `
      + `${lotion.length}: ${lotion.join(', ')}. The Pure Unscented Body Cream has ${cream.length}: `
      + `${cream.join(', ')}. No fragrance, parfum or essential oils appear in either.`;
  },

  html(ctx) {
    const lotion = ingredientsFor('lotion');
    const cream = ingredientsFor('cream');
    const union = setIngredientUnion();

    const listCol = (title, count, list) => `
      <div style="flex:1;background:#f7f8f5;border-radius:26px;padding:44px 44px 40px;text-align:left;">
        <div style="font-family:Cabin;font-weight:700;font-size:44px;color:${INK};">${title}</div>
        <div style="font-family:Outfit;font-weight:400;font-size:32px;color:${INK};opacity:.55;margin-top:6px;">
          ${count} ingredients, in full
        </div>
        <div style="height:2px;background:rgba(26,27,24,.12);margin:26px 0;"></div>
        ${list.map((t) => `
          <div style="display:flex;align-items:flex-start;gap:16px;margin-bottom:16px;">
            <div style="width:12px;height:12px;border-radius:50%;background:${GREEN};flex:0 0 auto;margin-top:14px;"></div>
            <div style="font-family:Outfit;font-weight:400;font-size:35px;line-height:1.3;color:${INK};">${titleCase(t)}</div>
          </div>`).join('')}
      </div>`;

    return `<div style="width:100%;height:100%;background:${PAPER};
      display:flex;flex-direction:column;align-items:center;justify-content:space-between;
      padding:96px 80px 88px;box-sizing:border-box;text-align:center;">

      <div>
      <div style="font-family:Outfit;font-weight:300;font-size:34px;letter-spacing:.34em;
                  text-transform:uppercase;color:${INK};opacity:.45;">
        Pure Unscented
      </div>

      <div style="font-family:Cabin;font-weight:700;font-size:104px;line-height:1.04;
                  color:${INK};letter-spacing:-.024em;margin-top:22px;">
        Fragrance-free,<br>and here is the proof.
      </div>

      <div style="font-family:Outfit;font-weight:400;font-size:40px;line-height:1.4;
                  color:${INK};opacity:.62;margin-top:26px;max-width:1400px;">
        ${union.length} ingredients across both products. Short enough to print, so read it to the end.
      </div>
      </div>

      <div style="display:flex;gap:34px;width:100%;align-items:stretch;">
        ${listCol('Body Lotion', lotion.length, lotion)}
        ${listCol('Body Cream', cream.length, cream)}
      </div>

      <div>
      <div style="display:flex;align-items:center;gap:26px;width:100%;">
        <div style="flex:1;height:2px;background:${RULE};"></div>
        <div style="font-family:Outfit;font-weight:600;font-size:30px;letter-spacing:.18em;
                    text-transform:uppercase;color:${INK};opacity:.5;white-space:nowrap;">Not in either</div>
        <div style="flex:1;height:2px;background:${RULE};"></div>
      </div>

      <div style="display:flex;justify-content:center;gap:56px;margin-top:34px;flex-wrap:wrap;">
        ${ABSENT.map((t) => `
          <div style="display:flex;align-items:center;gap:14px;">
            <svg viewBox="0 0 24 24" width="34" height="34" aria-hidden="true">
              <path d="M5 5 L19 19 M19 5 L5 19" stroke="${INK}" stroke-opacity=".38" stroke-width="3" stroke-linecap="round"/>
            </svg>
            <div style="font-family:Cabin;font-weight:700;font-size:38px;color:${INK};opacity:.72;">${t}</div>
          </div>`).join('')}
      </div>
      </div>
    </div>`;
  },
};
