/**
 * Text-level search-intent taxonomy — the fleet's single definition.
 *
 * Extracted verbatim from `detectPostType` in agents/blog-post-writer/index.js on
 * 2026-08-18, for the same reason lib/ad-brief-plan.js was extracted from
 * agents/ad-brief: a second consumer needed the rule, and importing an agent in this
 * repo RUNS it. The patterns below are unchanged from the originals — this is a move,
 * not a rewrite, so the writer's CTA weighting behaves exactly as before.
 *
 * Why this is the intent rule and not a new one:
 *
 *   data/keyword-index.json decides commercial intent BEHAVIOURALLY, not from text —
 *   `classifyValidationSource` in lib/keyword-index/merge.js asks for Amazon
 *   purchases/clicks, GA4 conversions, or membership of the untapped feed. That is the
 *   right bar for a keyword the index already holds, and it is unusable for a query
 *   from a channel with no Amazon and no GA4 join: every Bing query would classify
 *   `null`. So the index answers "is this query already validated and targeted"
 *   (membership) and this module answers "does the wording read as a buyer" — the two
 *   halves are complementary and neither is a second copy of the other.
 *
 * Three of the four types are the writer's own: a `diy` or `informational` reader came to
 * LEARN or MAKE something and gets a light-touch CTA; `product` is the default and carries
 * the heavier CTAs. Read commercially, `product` is the buying-intent bucket and the
 * others are not — someone searching "coconut oil soap recipe" is sourcing lye, not soap.
 *
 * `supply` was added on 2026-08-18 to close a hole the Bing corpus exposed: queries like
 * "coconut oil soap base", "base oils for soap making", "lye calculator" and "cold process
 * soap" carry none of the DIY tokens (`how to make`, `recipe`, `diy`), so they fell to
 * `product` and were read as buying intent. They are the opposite of buying intent — that
 * searcher is sourcing a RAW MATERIAL to make the product themselves, and Real Skin Care
 * sells no raw materials.
 *
 * Why `supply` is its own bucket and not folded into `diy`. The two audiences differ in
 * what they want to buy, which is exactly what the classification is used to decide:
 *
 *   - a `diy` reader wants the OUTCOME (natural deodorant, a moisturiser) and is making it
 *     because making it is one route there. A finished product is a genuine shortcut for
 *     them, which is why the writer's one light-touch CTA — "prefer a shortcut?" — is
 *     honest and can convert.
 *   - a `supply` reader wants an INPUT (lye, a melt-and-pour base, base oils) that we do
 *     not stock. There is no shortcut to offer: the finished bar is not a substitute for
 *     the ingredient they came to buy. Pointing them at a PDP is wasted CTA real estate
 *     on an auto-published page.
 *
 * Same commercial answer (`isCommercialIntent` is false for both), different CTA treatment
 * — folding them together would have gotten the first right and the second wrong.
 */

/**
 * Raw-material / maker-process signals: the searcher is sourcing INPUTS to make the
 * product themselves. Checked FIRST because it is the narrowest, highest-confidence
 * signal — these tokens name a material or a maker's process rather than a topic — and
 * because when a query carries both ("cold process soap recipe") the supply reading is
 * the correct one.
 */
export const SUPPLY_PATTERNS = [
  /\b(soap|lotion|cream|balm|butter|candle|shampoo)\s+base\b/,
  /\bmelt[-\s]and[-\s]pour\b/,
  /\bbase oils?\b/,
  /\blye\b/, /\bsodium hydroxide\b/, /\bpotassium hydroxide\b/,
  /\bsaponif/,
  /\b(cold|hot)[-\s]process\b/,
  /\bsuperfat/,
  /\b(soap|candle|lotion|balm|cosmetic)[-\s]?making\b/,
  /\bmaking supplies\b/,
  /\bsoap (mold|mould)s?\b/,
];

/** DIY / how-to / tutorial signals. Checked after `supply`, so it beats `informational`. */
export const DIY_PATTERNS = [
  /\bhow to make\b/, /\bhow to\s+(do|apply|use)\b/, /\brecipe\b/,
  /\bdiy\b/, /\bat home\b/, /\bhomemade\b/, /\btutorial\b/,
  /\bstep-by-step\b/, /\bguide to (making|building|creating)\b/,
];

/** Concept / definition / question signals. */
export const INFO_PATTERNS = [
  /^why\b/, /^what (is|are|does)\b/, /^when (was|did|is)\b/,
  /^is\b.*\?/, /^are\b.*\?/, /^can\b.*\?/, /^should\b.*\?/,
  /\bbenefits of\b/, /\bhow does\b/,
];

/**
 * Every value this can return. Consumers that branch on the type must handle all of
 * these explicitly — a `default:` that lands on `product` is the bug `supply` was added
 * to fix, and it would reintroduce it silently for the next type anyone adds.
 */
export const SEARCH_INTENT_TYPES = ['supply', 'diy', 'informational', 'product'];

/**
 * @param {string} text lowercased free text (a keyword, a title, or both joined)
 * @returns {'supply'|'diy'|'informational'|'product'}
 */
export function classifySearchIntent(text) {
  const t = String(text || '').toLowerCase();
  if (SUPPLY_PATTERNS.some((p) => p.test(t))) return 'supply';
  if (DIY_PATTERNS.some((p) => p.test(t))) return 'diy';
  if (INFO_PATTERNS.some((p) => p.test(t))) return 'informational';
  return 'product';
}

/**
 * The commercial read of the same taxonomy: `product` is the buying bucket, and it is
 * the ONLY one. `supply` is deliberately false — a raw-material sourcer is not a buyer
 * of anything we sell, so counting them as commercial demand overstates the opportunity.
 * Kept as a named function so callers state intent rather than comparing strings.
 */
export function isCommercialIntent(text) {
  return classifySearchIntent(text) === 'product';
}
