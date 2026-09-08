// lib/product-variant.js
//
// "WHICH VARIANT IS THIS POST ABOUT?" — and therefore which ingredient list may
// legitimately be fact-checked against it.
//
// THE BUG THIS EXISTS TO END. `agents/editor`'s flattenProduct did:
//
//     const oils = (p.variations || []).flatMap((v) => v.essential_oils || []);
//     ingredients: [...new Set([...base, ...oils])]
//
// — the union of EVERY variant's essential oils, presented to the reviewer as
// "the product's ingredients". `config/ingredients.json` is correct and always
// was: `lotion` carries a 6-ingredient base and five `variations`, of which
// `Pure Unscented` has `essential_oils: []` and the four scented ones each add
// their own. Flattening throws that structure away.
//
// The consequence is a post that CANNOT PASS however well it is written. On
// 2026-09-06 `best-unscented-lotion-clean-fragrance-free-picks` was blocked for
// "ingredient accuracy: product contains 5 essential oils but is marketed as
// zero fragrance compounds". It was redrafted on 2026-09-08 against a new
// standing rule, correctly, naming `Pure Unscented` five times and listing zero
// oils — and was blocked AGAIN, this time for "7 essential oils", because the
// reviewer was still reading the union. That is a refused-rebuild loop: paid
// generation, every time, against a check the content can never satisfy.
//
// THE DIRECTION OF THE FIX IS DELIBERATELY "LESS AGGRESSIVE". Scoping to a
// matched variant can only ever REMOVE ingredients from the comparison list, so
// it can only ever turn a blocker into a pass — never the reverse. That is the
// safe direction here for the reason CLAUDE.md gives repeatedly: an ingredient
// check that over-fires silently kills correct content, and this project has
// already destroyed paid work by letting a gate decide something was worthless.
//
// UNMATCHED FALLS BACK TO THE UNION, which is exactly today's behaviour. A post
// about "body lotion" in general genuinely could be about any variant, and
// narrowing it on a guess would be inventing a scope the post never claimed.

/**
 * Resolve which variant of a product a post is about, from the text signals the
 * editor already has (target keyword, slug, and optionally the body).
 *
 * Matching is on `variations[].keywords`, which the config already carries for
 * this purpose — no keyword list is re-declared here.
 *
 * LONGEST KEYWORD WINS. "lavender rose" and "lavender" both match a post about
 * Lavender & Rose; taking the first match would resolve it to Calming Lavender
 * and then fault the post for naming rose. Specificity is the whole signal.
 *
 * @param {object|null} product  an entry from config/ingredients.json
 * @param {string} text          keyword + slug (+ body), matched case-insensitively
 * @returns {object|null}        the matching variation, or null when none/ambiguous
 */
export function resolveVariant(product, text) {
  const variations = product?.variations;
  if (!Array.isArray(variations) || !variations.length) return null;

  const haystack = ` ${String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  if (haystack.trim() === '') return null;

  let best = null;
  let bestLen = 0;
  for (const v of variations) {
    for (const kw of v.keywords || []) {
      const needle = String(kw).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (!needle) continue;
      if (!haystack.includes(` ${needle} `)) continue;
      if (needle.length > bestLen) { best = v; bestLen = needle.length; }
      // A tie between two DIFFERENT variants is genuine ambiguity — a post
      // comparing them, most likely — so refuse to pick one. Falling back to
      // the union is the honest answer there.
      else if (needle.length === bestLen && best && best.id !== v.id) { best = null; }
    }
  }
  return best;
}

/**
 * The ingredient list a post may be fact-checked against.
 *
 * With a resolved variant: the base plus THAT variant's oils. Without one: the
 * base plus every variant's oils, which is the pre-existing behaviour and is
 * kept deliberately (see the header).
 *
 * @returns {{ingredients: string[], variant: object|null, scoped: boolean}}
 */
export function variantIngredients(product, text) {
  const base = product?.base_ingredients || product?.ingredients || [];
  const variant = resolveVariant(product, text);
  const oils = variant
    ? (variant.essential_oils || [])
    : (product?.variations || []).flatMap((v) => v.essential_oils || []);
  return {
    ingredients: [...new Set([...base, ...oils])],
    variant: variant || null,
    scoped: Boolean(variant),
  };
}
