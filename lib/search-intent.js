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
 * The three types are the writer's own: a `diy` or `informational` reader came to LEARN
 * or MAKE something and gets a light-touch CTA; `product` is the default and carries the
 * heavier CTAs. Read commercially, `product` is the buying-intent bucket and the other
 * two are not — someone searching "coconut oil soap recipe" is sourcing lye, not soap.
 */

/** DIY / how-to / tutorial signals. First bucket checked, so it beats `informational`. */
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
 * @param {string} text lowercased free text (a keyword, a title, or both joined)
 * @returns {'diy'|'informational'|'product'}
 */
export function classifySearchIntent(text) {
  const t = String(text || '').toLowerCase();
  if (DIY_PATTERNS.some((p) => p.test(t))) return 'diy';
  if (INFO_PATTERNS.some((p) => p.test(t))) return 'informational';
  return 'product';
}

/**
 * The commercial read of the same taxonomy: `product` is the buying bucket.
 * Kept as a named function so callers state intent rather than comparing strings.
 */
export function isCommercialIntent(text) {
  return classifySearchIntent(text) === 'product';
}
