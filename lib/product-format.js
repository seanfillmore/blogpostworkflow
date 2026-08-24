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
 * Did the text ACTUALLY say which format, or did we fall back to the default?
 *
 * "natural bar soap for men" asserts bar. "best soap to use on new tattoo" says
 * only "soap" and gets bar_soap because that is the safe default — it is not a
 * claim about format. Treating a default as an assertion is what made the tattoo
 * winner report a permanent "content reads as bar_soap, but the CTA sells
 * liquid_soap" mismatch on a post whose copy is entirely about foaming liquid
 * soap and whose only product link is the foaming SKU. A disagreement with a
 * guess is not a finding.
 */
export function soapFormatIsExplicit(text) {
  const t = normalizeText(text);
  return BAR_SIGNAL.test(t) || LIQUID_SIGNAL.test(t);
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
    // The real field in config/ingredients.json is `shopify_handle` on all seven
    // products; `handle` is accepted only as a tolerated alias. The first cut of
    // this function read `p.handle` alone and therefore matched NOTHING in
    // production — a silent no-op that looked like working code, because the
    // probe that "confirmed" the field name printed it through a
    // `handle || product_handle || shopify_handle` fallback and the real key was
    // never visible. Pinned by a test that loads the actual config.
    const handle = p?.shopify_handle || p?.handle;
    if (handle) byHandle.set(String(handle).toLowerCase(), key);
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
export function resolveProductKey({ textKey, linkKey, textIsExplicit = true }) {
  // Only an EXPLICIT text signal can disagree with the CTA. A defaulted key
  // (generic "soap" -> bar_soap) is a guess, and a guess losing to the actual
  // buy button is the system working, not a mismatch worth reporting.
  const mismatch = textKey && linkKey && textKey !== linkKey && textIsExplicit
    ? { fromText: textKey, fromLink: linkKey }
    : null;
  if (linkKey) return { key: linkKey, source: 'link', mismatch };
  if (textKey) return { key: textKey, source: 'text', mismatch };
  return { key: null, source: 'none', mismatch };
}

/**
 * The ingredient-config key for a SHOPIFY PRODUCT, via its handle.
 *
 * The inverse of productKeyFromLinks: that maps a link to a key, this maps a
 * catalogue product to one. Returns null for anything not in the config (e.g.
 * `foam-soap-refill-32oz`, a refill with no ingredient spec of its own) — which
 * is deliberate, so a refill can never win a category tie against the actual
 * product.
 */
export function productKeyForProduct(product, ingredients) {
  const handle = String(product?.handle || '').toLowerCase();
  if (!handle) return null;
  for (const [key, p] of Object.entries(ingredients || {})) {
    const h = String(p?.shopify_handle || p?.handle || '').toLowerCase();
    if (h && h === handle) return key;
  }
  return null;
}

/**
 * Fold a trailing plural so "lips" matches "lip" and "soaps" matches "soap".
 *
 * `petroleum jelly for LIPS` scored 0 against `... LIP Balm` and the injector
 * therefore declined to give that post any buy box at all. Same class of bug as
 * the documented `\bsoap\b` vs "soaps" gap in the cluster taxonomy: an English
 * plural is not a different topic.
 *
 * Deliberately naive — strip a single trailing "s" from words of 4+ letters, and
 * never from words ending "ss" (so "gloss" survives). Anything cleverer needs a
 * stemmer, and a stemmer would change matching across the whole fleet.
 */
export function singularize(token) {
  const t = String(token || '');
  if (t.length < 4) return t;
  if (t.endsWith('ss')) return t;
  return t.endsWith('s') ? t.slice(0, -1) : t;
}
