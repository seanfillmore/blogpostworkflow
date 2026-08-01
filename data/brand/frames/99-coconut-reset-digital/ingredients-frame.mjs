/**
 * 90-Day Coconut Reset — frame 6 (us-vs-them), shared builder.
 *
 * Media plan §6: "Win on ingredient list length, not price." Sean's direction
 * 2026-08-01: **this is not us against a named product, it is us against the lotion
 * market in general.** That resolves what had been blocking the frame — the plan
 * asked for "the comparison from an actual published INCI panel", which a
 * category-level comparison does not need — and it also makes the frame safer,
 * because it removes any assertion about what a particular competitor contains.
 *
 * The honest shape that leaves:
 *
 *  - **Our column is the complete, real list**, imported from config/ingredients.json
 *    rather than retyped. Six ingredients in the Pure Unscented lotion, seven in
 *    Coconut Breeze. The asymmetry does the arguing; nothing has to be claimed.
 *  - **The other column names what the category commonly adds, and is a claim about
 *    OUR formula, not theirs** — every item is an absence the live lander already
 *    states ("No synthetic fragrance, no petrolatum, no dimethicone, no lanolin" and
 *    "no fragrance, parabens, or mineral oil"). No brand is named, no packaging is
 *    depicted, and no specific product is said to contain anything.
 *
 * ⚠️ Two traps this frame walks past deliberately, both flagged in the plan:
 *  - It does **not** imply palm-free. The lotion contains organic red palm oil and
 *    the cream adds palm stearic — and both are printed on the frame, in the list.
 *  - It does **not** imply vegan. The cream contains beeswax, which is why the cream
 *    count is shown rather than quietly omitted in favour of the shorter lotion.
 *
 * Showing the full list including the palm and beeswax entries is the point. A
 * "clean" frame that hid them would be the dishonest version of this frame.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// this module sits at data/brand/frames/<product>/ — four levels below the repo root
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const INGREDIENTS = JSON.parse(readFileSync(join(ROOT, 'config', 'ingredients.json'), 'utf8'));

const BLACK = '#000000';
const SAND = '#EDE5D8';
const GREEN = '#AEDEAC';
const PANEL = '#F6F2EA';

/**
 * Every item here is an absence the live lander already claims, so the frame states
 * nothing the product page does not. Sourced 2026-08-01 from the lander metaobject:
 *   bullets:        "no fragrance, parabens, or mineral oil"
 *   buybox_bullets: "No synthetic fragrance, no petrolatum, no dimethicone, no lanolin"
 * Do not add to this list without adding it to the lander first.
 */
const COMMONLY_ADDED = [
  'Mineral oil',
  'Petrolatum',
  'Dimethicone',
  'Parabens',
  'Synthetic fragrance',
  'Lanolin',
];

const titleCase = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** The full, real ingredient list for one product in one scent. */
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
     * The frame prints an ingredient list and a count. Both come from
     * config/ingredients.json, which the plan names as the source of truth, so the
     * only way they go wrong is if that file changes shape — checked here. The plan
     * calls an invented number on this frame "the single most damaging frame in
     * either stack".
     */
    verify(ctx) {
      for (const key of ['lotion', 'cream']) {
        const list = listFor(key, variant);
        if (list.length < 3) throw new Error(`${key} list looks truncated: ${JSON.stringify(list)}`);
        if (list.some((i) => !i || !i.trim())) throw new Error(`${key} list has an empty entry`);
      }
      if (!ctx.variants.some((v) => v.title === variant)) {
        throw new Error(`no variant titled "${variant}" — a frame must describe a kit somebody can buy`);
      }
      // The right-hand column may only restate absences the lander already claims.
      const allowed = new Set(COMMONLY_ADDED.map((s) => s.toLowerCase()));
      if (allowed.size !== COMMONLY_ADDED.length) throw new Error('duplicate entry in COMMONLY_ADDED');
      // Nothing in our own list may also appear as an absence — that would be a lie
      // in both directions at once.
      const ours = [...listFor('lotion', variant), ...listFor('cream', variant)].map((s) => s.toLowerCase());
      for (const absent of allowed) {
        if (ours.some((o) => o.includes(absent))) {
          throw new Error(`"${absent}" is claimed as absent but appears in our own ingredient list`);
        }
      }
    },

    alt() {
      const lotion = listFor('lotion', variant);
      const cream = listFor('cream', variant);
      return `The ${variant} Body Lotion's complete ingredient list, ${lotion.length} ingredients: `
        + `${lotion.join(', ')}. The Body Cream has ${cream.length}. Alongside, six ingredients commonly `
        + `added to conventional lotions that are not in either: ${COMMONLY_ADDED.join(', ').toLowerCase()}.`;
    },

    html() {
      const lotion = listFor('lotion', variant);
      const cream = listFor('cream', variant);

      const row = (text) => `
        <div style="display:flex;align-items:flex-start;gap:20px;margin-bottom:20px;">
          <div style="width:14px;height:14px;border-radius:50%;background:${GREEN};
                      border:2.5px solid ${BLACK};box-sizing:border-box;flex:0 0 auto;margin-top:14px;"></div>
          <div style="font-family:Outfit;font-weight:400;font-size:42px;line-height:1.34;color:${BLACK};">${titleCase(text)}</div>
        </div>`;

      const absent = (text) => `
        <div style="display:flex;align-items:flex-start;gap:20px;margin-bottom:20px;">
          <div style="font-family:Outfit;font-weight:400;font-size:38px;line-height:1.32;color:${BLACK};
                      opacity:.34;flex:0 0 auto;margin-top:1px;">&#10005;</div>
          <div style="font-family:Outfit;font-weight:400;font-size:42px;line-height:1.34;color:${BLACK};opacity:.55;">${text}</div>
        </div>`;

      return `<div style="
        width:100%;height:100%;background:${SAND};
        display:flex;flex-direction:column;align-items:center;justify-content:center;
        padding:72px 92px;text-align:center;">

        <div style="font-family:Outfit;font-weight:300;font-size:34px;letter-spacing:.34em;
                    text-transform:uppercase;color:${BLACK};opacity:.45;margin-bottom:26px;">
          ${variant}
        </div>

        <div style="font-family:Cabin;font-weight:700;font-size:110px;line-height:1.04;
                    color:${BLACK};letter-spacing:-.022em;margin-bottom:16px;">
          Same job.<br>Shorter list.
        </div>

        <div style="width:132px;height:6px;background:${GREEN};border-radius:3px;margin:28px 0 40px;"></div>

        <div style="display:flex;gap:44px;width:100%;align-items:stretch;">

          <div style="flex:1;background:${PANEL};border-radius:22px;padding:46px 44px;text-align:left;">
            <div style="font-family:Cabin;font-weight:700;font-size:46px;color:${BLACK};margin-bottom:8px;">
              Body Lotion — ${lotion.length} ingredients
            </div>
            <div style="font-family:Outfit;font-weight:400;font-size:32px;color:${BLACK};opacity:.5;margin-bottom:30px;">
              The whole list, in order
            </div>
            ${lotion.map(row).join('')}
            <div style="font-family:Outfit;font-weight:400;font-size:34px;color:${BLACK};opacity:.55;
                        margin-top:26px;padding-top:26px;border-top:2px solid rgba(0,0,0,.12);">
              Body Cream: ${cream.length} ingredients
            </div>
          </div>

          <div style="flex:1;background:rgba(246,242,234,.55);border-radius:22px;padding:46px 44px;text-align:left;">
            <div style="font-family:Cabin;font-weight:700;font-size:46px;color:${BLACK};opacity:.75;margin-bottom:8px;">
              Not in either one
            </div>
            <div style="font-family:Outfit;font-weight:400;font-size:32px;color:${BLACK};opacity:.5;margin-bottom:30px;">
              Common in conventional lotions
            </div>
            ${COMMONLY_ADDED.map(absent).join('')}
          </div>
        </div>

        <div style="font-family:Outfit;font-weight:400;font-size:42px;color:${BLACK};opacity:.6;margin-top:44px;">
          The whole formula, printed in order. Nothing held back for the small print.
        </div>
      </div>`;
    },
  };
}
