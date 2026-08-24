// lib/product-format.js
//
// Which SKU is a post actually about — the bar, or the foaming pump?
//
// RSC sells BOTH: `bar_soap` (Bar Soap, coconut-soap, format "bar") and
// `liquid_soap` (Foaming Liquid Soap, organic-foaming-hand-soap, format
// "foaming pump bottle"). They are different products with different formats and
// different use cases, and until 2026-08-24 nothing in the fleet could tell them
// apart: `classifyPostProduct` mapped ANY text containing "soap" to `bar_soap`
// and could never return `liquid_soap` at all.
//
// The visible cost was on the tattoo-soap winner. That post correctly recommends
// a foaming liquid soap (you do not share a bar over a healing tattoo) and CTAs
// to the foaming SKU — but its keyword, "best soap to use on new tattoo", made
// the editor validate it against the BAR spec, which reported a format mismatch
// and blocked the post. The post was right; the classification was wrong.
//
// Two signals, and they answer different questions:
//   - the post's TEXT (keyword/slug) says what it is ABOUT
//   - the post's product CTA says what it SELLS
// They usually agree. When they disagree that is a finding worth surfacing, not
// something to paper over — a "goat milk soap" post whose only buy button is
// foaming hand soap is a real mismatch, and silently validating it against
// whichever spec happens to be convenient hides it.

/** Hyphens and underscores are word separators. Slugs are hyphenated and
 *  keywords are spaced, so a multi-word phrase like "hand soap" can never match
 *  a raw slug — the original bug in this area. */
export function normalizeText(s) {
  return String(s || '').toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const LIQUID_SIGNAL = /\b(foaming|liquid soap|hand soap|hand wash|handwash|soap dispenser|pump soap)\b/;
const BAR_SIGNAL = /\b(bar soap|soap bar)\b/;

/**
 * Soap FORMAT from free text, or null when the text is not soap-specific.
 *
 * An explicit bar signal wins when BOTH appear, because a comparison post
 * ("bar soap vs liquid hand soap") is primarily about the bar and because bar is
 * the safer default: it is the flagship SKU, and mislabelling a bar post as
 * liquid would flag a correct post. Text with only the generic word "soap"
 * returns `bar_soap` — unchanged from the old behaviour, deliberately, so this
 * change moves nothing that was previously classified correctly.
 */
export function soapFormatFromText(text) {
  const t = normalizeText(text);
  if (!/\bsoaps?\b/.test(t) && !LIQUID_SIGNAL.test(t)) return null;
  if (BAR_SIGNAL.test(t)) return 'bar_soap';
  if (LIQUID_SIGNAL.test(t)) return 'liquid_soap';
  return 'bar_soap';
}

/**
 * The ingredient-config key for whichever product the post LINKS to.
 *
 * `config/ingredients.json` already carries a `handle` per product; this reads
 * it rather than hardcoding a second mapping. Returns null when the post links
 * to no known product, or to more than one (ambiguous — do not guess).
 *
 * @param {string[]} hrefs      product link hrefs from the post
 * @param {object} ingredients  config/ingredients.json
 */
export function productKeyFromLinks(hrefs, ingredients) {
  const byHandle = new Map();
  for (const [key, p] of Object.entries(ingredients || {})) {
    if (p?.handle) byHandle.set(String(p.handle).toLowerCase(), key);
  }
  const found = new Set();
  for (const href of hrefs || []) {
    const m = String(href || '').match(/\/products\/([a-z0-9-]+)/i);
    if (!m) continue;
    const key = byHandle.get(m[1].toLowerCase());
    if (key) found.add(key);
  }
  return found.size === 1 ? [...found][0] : null;
}

/**
 * Reconcile the two signals.
 *
 * The LINKED product wins for spec validation — it is what the page actually
 * sells, so validating copy against anything else produces false format
 * mismatches like the tattoo one. But a disagreement is reported rather than
 * discarded, so "this soap post sells the other soap" stays visible.
 *
 * @returns {{key: string|null, source: 'link'|'text'|'none', mismatch: null|{fromText: string, fromLink: string}}}
 */
export function resolveProductKey({ textKey, linkKey }) {
  const mismatch = textKey && linkKey && textKey !== linkKey
    ? { fromText: textKey, fromLink: linkKey }
    : null;
  if (linkKey) return { key: linkKey, source: 'link', mismatch };
  if (textKey) return { key: textKey, source: 'text', mismatch };
  return { key: null, source: 'none', mismatch };
}
