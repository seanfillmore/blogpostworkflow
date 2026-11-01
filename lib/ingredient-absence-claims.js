/**
 * Does generated copy say a product LACKS an ingredient it CONTAINS?
 *
 * On 2026-09-10 `agents/product-optimizer` published, live, a meta description
 * reading "only 6 ingredients — no water" and a body reading "no water padding"
 * for `coconut-lotion`, whose own Ingredients tab lists purified spring water
 * FIRST. Every gate passed it: the sentence carries no disease, drug or
 * therapeutic word. It is a false product claim with no claim vocabulary in it —
 * the same shape `lib/product-category-terms.js` exists for — and the prompt had
 * given the model no ingredient list at all, only the old description, so "no
 * water" was invented.
 *
 * Two halves, both driven by the product's REAL ingredient list (the one the
 * shopper reads in the PDP's Ingredients tab):
 *
 *   - `ingredientPromptBlock()` tells the FIRST generation what is in the bottle.
 *   - `ingredientAbsenceCheck()` blocks copy that denies any of it, riding the
 *     one-retry budget of `lib/seo-copy-gate-loop.js` via `extraChecks`.
 *
 * THE MATCHER IS DELIBERATELY NARROW. "no mineral oil" must pass on a product
 * containing coconut oil, so a claimed absence contradicts an ingredient only
 * when that ingredient's HEAD noun (its last word — water, oil, wax, extract)
 * appears in the claimed-absent phrase AND every word modifying the head there
 * also appears in the ingredient's own name. "no water padding" → head `water`,
 * no modifier → contradiction. "no mineral oil" → head `oil`, modifier `mineral`
 * is not in "organic virgin coconut oil" → allowed. An unrecognised phrasing can
 * only produce a MISS, never a blocked rewrite — the whitelist doctrine the other
 * copy gates follow. Known, accepted misses: "no emulsifiers" (a different word
 * from "emulsifying"), "no thickeners" (a function, not an ingredient name),
 * "is water-free" when a verb sits directly before the word.
 */

import { plainText } from './seo-copy-health-gate.js';

export const INGREDIENT_CATEGORY = 'contradicts-ingredients';

/** Words that never distinguish one ingredient from another. */
const STOP = new Set([
  'a', 'an', 'the', 'any', 'added', 'extra', 'real', 'is', 'are', 'was',
  'totally', 'completely', 'entirely', 'fully', '100',
]);

/** Where a claimed-absent list ends: a clause word or hard punctuation. */
const CLAUSE_BREAK = /\s+(?:but|just|only|that|which|so|because|instead|while|yet|than|like|to|in|on|for|from|with|at|of|you|we)\b|[.!?:;()—–]/i;

/** Absence frames that introduce a list: "no X", "without X", "zero X", "free of X". */
const LEADS = /\b(?:no|without(?:\s+any)?|zero|free\s+(?:of|from))\s+/gi;

const singular = (t) => (t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t);

function toTokens(phrase) {
  return String(phrase || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !STOP.has(t))
    .map(singular);
}

/**
 * Parse an Ingredients tab into `{ name, tokens }` entries. A line carrying a
 * colon is a label ("Coconut Breeze: organic coconut oil extract"), so only the
 * text after its last colon is read; "none" is not an ingredient.
 */
export function parseIngredientList(text) {
  const plain = String(text || '')
    .replace(/<br\s*\/?>|<\/(?:p|li|div|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ');
  const items = [];
  for (let line of plain.split('\n')) {
    if (line.includes(':')) line = line.slice(line.lastIndexOf(':') + 1);
    // Sentence ends split too: the Sensitive Skin Set lander closes each list
    // with "organic red palm oil. No essential oils." — without the split the
    // parser invented an ingredient called "organic red palm oil no essential
    // oils". An absence sentence is never itself an ingredient.
    for (const raw of line.split(/[,;]|\.(?:\s+|$)|\s+and\s+/i)) {
      const name = raw.replace(/\([^)]*\)/g, ' ').replace(/[.*]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
      if (!name || name === 'none' || /^(?:no|without|zero|free\s+(?:of|from))\b/.test(name)) continue;
      const tokens = toTokens(name);
      if (tokens.length) items.push({ name, tokens });
    }
  }
  return items;
}

/** Every phrase that claims something is absent, with the item it names. */
export function absencePhrases(text) {
  const s = String(text || '');
  const out = [];
  for (const m of s.matchAll(LEADS)) {
    const start = m.index + m[0].length;
    let tail = s.slice(start, start + 160);
    const br = tail.search(CLAUSE_BREAK);
    if (br >= 0) tail = tail.slice(0, br);
    for (const raw of tail.split(/,|\s+(?:or|and|nor)\s+/i)) {
      const item = raw.replace(/^\s*no\s+/i, '').trim();
      if (item) out.push({ phrase: `${m[0].trim()} ${item}`, item });
    }
  }
  // "water-free" / "palm oil-free". Up to two words, so "mineral oil-free" keeps
  // its modifier and stays allowed; a verb caught as the first word only ever
  // costs a miss.
  for (const m of s.matchAll(/\b([a-z0-9]+(?:\s+[a-z0-9]+)?)-free\b/gi)) {
    out.push({ phrase: m[0], item: m[1] });
  }
  return out;
}

/**
 * Absence claims in `text` that deny an ingredient in `ingredients` (the output
 * of parseIngredientList). One hit per distinct phrase.
 */
export function findContradictedAbsences(text, ingredients) {
  // A head noun that names a whole CLASS is only a contradiction with a modifier
  // that picks out our ingredient. Found by the zero-false-positive test on the
  // committed bar-soap template: "Pure Unscented: no oils added" means no SCENT
  // oils, on a soap made of saponified coconut oil. So bare "no oil" is an
  // accepted miss; "no coconut oil" is still caught.
  const GENERIC_HEADS = new Set(['oil', 'extract', 'butter', 'blend']);
  const hits = [];
  const seen = new Set();
  for (const { phrase, item } of absencePhrases(text)) {
    const tokens = toTokens(item);
    for (const ing of ingredients) {
      const head = ing.tokens[ing.tokens.length - 1];
      const h = tokens.indexOf(head);
      if (h < 0) continue;
      const mods = tokens.slice(0, h);
      if (GENERIC_HEADS.has(head) && mods.length === 0) continue;
      if (!mods.every((t) => ing.tokens.includes(t))) continue;
      const key = phrase.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        hits.push({ phrase, ingredient: ing.name });
      }
      break;
    }
  }
  return hits;
}

/**
 * A gate-loop check (see `extraChecks` in lib/seo-copy-gate-loop.js), or null
 * when there is no ingredient list to hold the copy to — no list, no check.
 */
export function ingredientAbsenceCheck(ingredientText) {
  const ingredients = parseIngredientList(ingredientText);
  if (!ingredients.length) return null;
  return {
    name: 'ingredient-accuracy',
    check(fields) {
      const violations = [];
      for (const [field, value] of Object.entries(fields || {})) {
        for (const hit of findContradictedAbsences(plainText(value), ingredients)) {
          violations.push({
            field,
            category: INGREDIENT_CATEGORY,
            match: hit.phrase,
            why: `says "${hit.phrase}", but the product's ingredient list includes "${hit.ingredient}"`,
          });
        }
      }
      return violations;
    },
    constraint(violations) {
      if (!violations?.length) return '';
      return [
        'INGREDIENT ACCURACY — your previous attempt was rejected.',
        ...[...new Set(violations.map((v) => v.why))].map((w) => `- It ${w}.`),
        'Never say the product has no X, is free of X, or is X-free when X is on its ingredient list.',
        'Describe what IS in the product instead.',
      ].join('\n');
    },
  };
}

/** The prompt half: the real list, or an instruction not to guess. */
export function ingredientPromptBlock(ingredientText) {
  if (!parseIngredientList(ingredientText).length) {
    return 'INGREDIENTS: no ingredient list is available for this product. Do not claim it contains or lacks any specific ingredient beyond what the current description already states.';
  }
  return [
    'INGREDIENTS (authoritative — the list shoppers read on the live product page):',
    plainText(ingredientText),
    'Only describe ingredients on this list. Never say or imply the product has "no", is "free of", or is "-free" of anything on it — a lotion that contains water must never be called water-free.',
  ].join('\n');
}

/**
 * The Ingredients tab text out of a product template (a parsed object or the raw
 * asset string). Prefers the `tab-ingredients` block the PDP templates use and
 * falls back to any collapsible tab headed "Ingredients". Null when absent.
 */
export function ingredientTextFromTemplate(template) {
  let parsed = template;
  if (typeof template === 'string') {
    try {
      parsed = JSON.parse(template.replace(/^\s*\/\*[\s\S]*?\*\//, ''));
    } catch {
      return null;
    }
  }
  const blocks = parsed?.sections?.main?.blocks || {};
  const block = blocks['tab-ingredients']
    || Object.values(blocks).find((b) => b?.type === 'collapsible_tab'
      && /^ingredients$/i.test(String(b.settings?.heading || '').trim()));
  const text = block?.settings?.content || block?.settings?.custom_liquid || '';
  return String(text).trim() || null;
}
