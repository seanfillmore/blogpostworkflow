/**
 * ctr-copy-distinctness — is a proposed title/meta rewrite a MATERIAL change,
 * or a synonym shuffle wearing the costume of one?
 *
 * WHY THIS EXISTS. Measured, from data/reports/meta-ab/meta-ab-tracker.json on
 * the 2026-08-24 run:
 *
 *   "Best Soap for Tattoos: Clean, Gentle, Fragrance-Free"
 *     → "Best Soap for Tattoos: Gentle, Clean & Fragrance-Free"
 *
 * That is the same three adjectives reordered. It consumed a live Shopify
 * mutation, an A/B tracker slot and 28 days of measurement capacity, and it
 * cannot move CTR, because nothing changed. A second one went the wrong way
 * on purpose-free instinct:
 *
 *   "Coconut Oil Deodorant That Actually Works"
 *     → "Coconut Oil Deodorant: Does It Actually Work?"
 *
 * — an assertion turned into a question, which is plausibly worse for a
 * commercial query.
 *
 * Across 8 recent rewrites, NOT ONE introduced a number, a year, a count, a
 * bracketed qualifier, or any other new concrete specific. The measurement
 * problem in the A/B loop is real, but it is secondary: even a perfect
 * instrument reads nothing when the treatment is a paraphrase. So the gate
 * here is deliberately two-sided — a rewrite must be materially DIFFERENT
 * (low token overlap with the original) AND must CARRY at least one
 * CTR-bearing element the original lacked. Passing one and failing the other
 * is the shape every one of those 8 rewrites had.
 *
 * WHAT THIS IS NOT. It is not a quality judgement and it never claims a
 * passing rewrite will win — only that it is a real treatment worth spending
 * a live mutation and a measurement window on. Dropping an element the
 * original had (a superlative, an audience qualifier) is reported as
 * ADVISORY, never as a failure: narrowing a title is a legitimate move and a
 * gate that blocked it would just be a different way of forbidding change.
 *
 * PURE MODULE. No I/O, no imports, no .env. Every detector is a documented,
 * deterministic regex, so a verdict can be re-derived by hand from the two
 * strings that produced it.
 */

/** Jaccard ceiling over content tokens. Above this, the rewrite is a paraphrase. */
export const DEFAULT_MAX_TOKEN_OVERLAP = 0.7;

/** A title with fewer content tokens than this is not a title. */
export const DEFAULT_MIN_TITLE_TOKENS = 3;

/**
 * Stopwords dropped for OVERLAP purposes only. Deliberately narrow: 'best',
 * 'without', 'no' and 'free' are KEPT as content tokens, because they are
 * load-bearing CTR words in this catalogue's copy ("SLS-free", "without
 * aluminum") and dropping them would make two titles that differ on exactly
 * that word look identical. Brand tokens are dropped because "Real Skin Care"
 * appearing in both titles is not evidence that the titles are the same.
 */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'the', 'or', 'of', 'for', 'to', 'in', 'on', 'with',
  'your', 'you', 'it', 'is', 'are', 'what', 'how', 'why', 'that', 'this', 'be',
  // brand tokens
  'real', 'skin', 'care', 'realskincare',
]);

/**
 * The order element names are reported in. Fixed so two runs over the same
 * input produce byte-identical arrays and a report diff means something.
 */
const ELEMENT_ORDER = [
  'number',
  'year',
  'bracket',
  'question',
  'superlative',
  'audience',
  'negation',
  'timeframe',
];

// --- detectors -------------------------------------------------------------
// Each answers presence only. Whether a present element is NEW is decided in
// assessDistinctness, which is the only function that sees both strings.

/**
 * A 4-digit year, 2000-2099. Two spellings on purpose: the /g one is only ever
 * fed to matchAll (which does not advance lastIndex), the plain one is what
 * .test() sees, because a /g regex carries lastIndex between calls and would
 * make ctrElements() return different answers for the same string.
 */
const YEAR_RE_G = /\b20\d{2}\b/g;
const YEAR_RE = /\b20\d{2}\b/;

/** Any digit run. A run that IS a year is not counted as a 'number'. */
const DIGITS_RE = /\d+/g;

/** Parenthetical, bracketed, pipe-separated, or em/en-dash trailing qualifier. */
const BRACKET_RE = /\([^)]*\)|\[[^\]]*\]|\|\s*\S|[—–]\s*\S/;

const SUPERLATIVE_RE =
  /\b(best|top|ultimate|complete|definitive|safest|gentlest|strongest|cheapest)\b/i;

/** "for <someone>" — presence only; newness is decided by phrase, see below. */
const AUDIENCE_RE = /\bfor\s+\w+/i;
const AUDIENCE_PHRASE_RE = /\bfor\s+\w+/gi;

/** without / no / free of / -free / skip / avoid / never */
const NEGATION_RE = /\bwithout\b|\bno\b|\bfree\s+of\b|-free\b|\bskip\b|\bavoid\b|\bnever\b/i;

/** days, weeks, minutes, overnight, in N hours, per day, a week */
const TIMEFRAME_RE =
  /\bdays?\b|\bweeks?\b|\bminutes?\b|\bovernight\b|\bin\s+\d+\s+hours?\b|\bper\s+day\b/i;

function isString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

/** True when the text carries a digit run that is not part of a 4-digit year. */
function hasNonYearNumber(text) {
  const yearStarts = new Set();
  for (const m of text.matchAll(YEAR_RE_G)) yearStarts.add(m.index);
  for (const m of text.matchAll(DIGITS_RE)) {
    if (!yearStarts.has(m.index)) return true;
  }
  return false;
}

/** Lowercased "for X" phrases, so a CHANGE of audience is visible. */
function audiencePhrases(text) {
  if (!isString(text)) return [];
  return [...text.matchAll(AUDIENCE_PHRASE_RE)].map((m) =>
    m[0].toLowerCase().replace(/\s+/g, ' '),
  );
}

/**
 * Lowercase, strip punctuation, drop stopwords and brand tokens.
 * Apostrophes are removed rather than split on, so "it's" is one token.
 * Hyphens split, so "Fragrance-Free" contributes 'fragrance' and 'free'.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function contentTokens(text) {
  if (typeof text !== 'string') return [];
  return text
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

/**
 * Jaccard similarity (0..1) over the two texts' content-token SETS.
 * Two empty inputs are treated as identical (1); one empty and one not is 0.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function tokenOverlap(a, b) {
  const setA = new Set(contentTokens(a));
  const setB = new Set(contentTokens(b));
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const t of setA) if (setB.has(t)) shared += 1;
  const union = setA.size + setB.size - shared;
  return shared / union;
}

/**
 * Names of the CTR-bearing elements present in the text, in ELEMENT_ORDER.
 * Presence only — this function never sees the original, so it cannot and
 * does not decide whether an element is new.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function ctrElements(text) {
  if (!isString(text)) return [];
  const found = [];
  if (hasNonYearNumber(text)) found.push('number');
  if (YEAR_RE.test(text)) found.push('year');
  if (BRACKET_RE.test(text)) found.push('bracket');
  if (text.trim().endsWith('?')) found.push('question');
  if (SUPERLATIVE_RE.test(text)) found.push('superlative');
  if (AUDIENCE_RE.test(text)) found.push('audience');
  if (NEGATION_RE.test(text)) found.push('negation');
  if (TIMEFRAME_RE.test(text)) found.push('timeframe');
  return ELEMENT_ORDER.filter((name) => found.includes(name));
}

function pct(x) {
  return Math.round(x * 100);
}

/**
 * Element-set difference, with 'audience' decided by PHRASE rather than by
 * presence: "for men" → "for women" is a new audience even though both titles
 * carry a "for X". Symmetric, so the same swap also registers as a loss.
 */
function elementDiff(fromText, toText) {
  const from = ctrElements(fromText);
  const to = ctrElements(toText);
  const gained = to.filter((e) => e !== 'audience' && !from.includes(e));
  const fromPhrases = new Set(audiencePhrases(fromText));
  const audienceIsNew = audiencePhrases(toText).some((p) => !fromPhrases.has(p));
  if (audienceIsNew) gained.push('audience');
  return ELEMENT_ORDER.filter((name) => gained.includes(name));
}

/**
 * @param {{originalTitle?: string, proposedTitle?: string, originalMeta?: string, proposedMeta?: string}} input
 * @param {{maxTokenOverlap?: number, minTitleTokens?: number}} [opts]
 * @returns {{ok: boolean, titleOverlap: number, metaOverlap: number|null,
 *            newElements: string[], lostElements: string[],
 *            reasons: string[], advisory: string[]}}
 */
export function assessDistinctness(input, opts = {}) {
  const {
    originalTitle = '',
    proposedTitle = '',
    originalMeta = '',
    proposedMeta = '',
  } = input || {};
  const maxTokenOverlap =
    typeof opts.maxTokenOverlap === 'number' ? opts.maxTokenOverlap : DEFAULT_MAX_TOKEN_OVERLAP;
  const minTitleTokens =
    typeof opts.minTitleTokens === 'number' ? opts.minTitleTokens : DEFAULT_MIN_TITLE_TOKENS;

  const proposedTokens = contentTokens(proposedTitle);
  const titleOverlap = tokenOverlap(originalTitle, proposedTitle);
  const metaOverlap =
    isString(originalMeta) && isString(proposedMeta)
      ? tokenOverlap(originalMeta, proposedMeta)
      : null;

  const newElements = elementDiff(originalTitle, proposedTitle);
  const lostElements = elementDiff(proposedTitle, originalTitle);

  const reasons = [];

  // 1. There has to be a title at all.
  if (!isString(proposedTitle) || proposedTokens.length < minTitleTokens) {
    reasons.push('proposed title is empty or too short');
  }

  // 2. A no-op rewrite still costs a live mutation and a measurement window.
  if (
    isString(proposedTitle) &&
    String(proposedTitle).trim().toLowerCase() === String(originalTitle || '').trim().toLowerCase()
  ) {
    reasons.push('proposed title is identical to the original');
  }

  // 3. The tattoo-soap case: same words, new order.
  if (titleOverlap > maxTokenOverlap) {
    reasons.push(
      `title is a paraphrase (token overlap ${pct(titleOverlap)}% > ${pct(maxTokenOverlap)}%)`,
    );
  }

  // 4. Different words are not enough — the rewrite has to CARRY something.
  if (newElements.length < 1) {
    reasons.push(
      'rewrite introduces no new CTR-bearing element (number, year, bracket, question, superlative, audience, negation, timeframe)',
    );
  }

  const advisory = [];
  if (lostElements.length > 0) {
    advisory.push(
      `rewrite drops CTR-bearing element(s) the original had: ${lostElements.join(', ')} — may be deliberate`,
    );
  }

  return {
    ok: reasons.length === 0,
    titleOverlap,
    metaOverlap,
    newElements,
    lostElements,
    reasons,
    advisory,
  };
}
