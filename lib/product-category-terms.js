// lib/product-category-terms.js
//
// PRODUCT-CATEGORY ACCURACY. A third copy gate, beside the two in
// `agents/ad-studio/health-claims.js` (may a cosmetic say this at all?) and
// `agents/ad-studio/claims.js` (can this be traced to a source we hold?). This one
// asks a narrower question:
//
//   Does this copy describe OUR product as something it is not?
//
// ── The rule, verbatim from the operator (2026-08-24) ────────────────────────────
//
//   "We should never use the term antiperspirant to describe our product because it
//    is not accurate."
//
// RSC sells an aluminum-free coconut-oil DEODORANT — a cosmetic. An ANTIPERSPIRANT is
// an OTC drug: it reduces sweating through an active ingredient (aluminum salts),
// under the FDA monograph at 21 CFR Part 350, and carries a Drug Facts panel. RSC's
// product has none of that. So the word is wrong twice over:
//
//   - FACTUALLY. Deodorant addresses odor; antiperspirant addresses wetness. They are
//     different jobs, and this catalogue does not do the second one.
//   - AS A REGULATORY CLAIM. Describing a cosmetic with a drug CATEGORY name is the
//     same failure mode as the therapeutic claims cleaned up in PRs #634/#645/#648:
//     FDA reads intended use from marketing material, and intended use is what turns a
//     cosmetic into an unapproved drug. Here the claim is not smuggled in by a verb —
//     the category name IS the claim.
//
// ── THE LINE THIS FILE DRAWS, AND WHY IT IS NARROW ON PURPOSE ────────────────────
//
// RANKING FOR THE QUERY IS FINE. DESCRIBING THE PRODUCT WITH THE WORD IS NOT.
//
// This is the same distinction `lib/seo-copy-health-gate.js` already draws for health
// claims — "the product does X" is a claim, "here is information about X" is not — and
// it matters more here, not less. Measured over the live corpus on 2026-08-24 the word
// appears **539 times in rendered prose across 58 pages** (687 including href/title
// attributes), and essentially all of it is legitimate: FDA monograph explanation,
// deodorant-vs-antiperspirant comparison, aluminum chemistry, the two-to-four-week
// transition, "when was antiperspirant invented". Those pages RANK for that query.
// A page whose ranking query IS "natural antiperspirant" cannot be given copy without
// the word and still match its own query, so a blanket ban would remove them from
// every regeneration path — silently, on unattended cron. That is the exact failure
// PR #633 was built to avoid, wearing the costume of an accuracy fix.
//
// So the rule fires ONLY where RSC's own product is unmistakably the referent, and it
// does so in two arms that fail in opposite directions on purpose:
//
//   ARM A — `findProductCategoryMisnomers` — BLOCKS. Fires in three shapes, all of
//   which require the BRAND to govern the phrase:
//     1. HEAD        — "our antiperspirant", "Real Skin Care's natural antiperspirant"
//     2. ATTRIBUTIVE — "our antiperspirant formula", "Real Skin Care antiperspirant stick"
//     3. RECOMMENDATION — "Our pick for travel size antiperspirant: <product>"
//   Deliberately conservative: it prefers a false negative to a false positive, because
//   a false positive here kills a page's copy and a false negative is caught by Arm B or
//   by a human. MEASURED FALSE-POSITIVE RATE: **0** — see below.
//
//   ARM B — `sanitizeProductCategoryTerm` — REWRITES, and can never block. For copy
//   whose subject is definitionally our product (a CTA headline, a buy-box line, a
//   product title), where the word is wrong whatever the sentence around it says. It
//   substitutes the accurate category rather than refusing, because refusing there
//   would take out the buy box, and a post with traffic and no buy path is a bug.
//
// ── BLAST RADIUS, MEASURED BEFORE THIS SHIPPED (2026-08-24) ──────────────────────
//
// Per the standing rule from the 2026-08-18 vocabulary work. Arm A was run over:
//
//   - 539 rendered-prose occurrences across 204 live articles, 19 products,
//     89 collections and 42 pages (read-only Shopify pull);
//   - every one of the 102 files in this repo that mentions the word, EXCLUDING the
//     eight this change itself authored — the rule's own examples, its test fixtures,
//     the remediation plan's literals and the CLAUDE.md note all quote the forbidden
//     phrasings on purpose, and the rule recognising its own documentation is not a
//     copy defect. They are measured separately and are all expected hits;
//   - the five server-side post mirrors under `data/posts/*antiperspirant*/`.
//
//   ARM A: 4 HITS, ALL TRUE POSITIVES, ZERO FALSE POSITIVES — the two live buy-box
//   lines and their two server mirrors. Against 17 hand-written bad phrasings it
//   misses 0; against 18 hand-written category references and negations it fires 0.
//
// ── THE FIRST VERSION WAS TOO NARROW, AND WHAT FIXED IT ──────────────────────────
//
// Arm A originally required the term to be the HEAD of the possessive's noun phrase.
// That was measured to miss five obvious product descriptions, including the most
// important one: in "Real Skin Care's antiperspirant formula" the term is ATTRIBUTIVE —
// it modifies `formula` — so the head test skipped it, and that is the exact phrasing an
// editor pass flagged as an ingredient-accuracy BLOCKER on `natural-antiperspirant`.
// Three widenings, each with its own guard:
//
//   1. `PRODUCT_NOUNS` lets the term MODIFY a thing we sell ("formula", "stick",
//      "collection"). Still a whitelist, so "our antiperspirant guide" stays a miss.
//   2. `BRAND_BARE` lets the brand govern with no possessive ("Real Skin Care
//      antiperspirant"), which is the shape a product NAME takes.
//   3. `RECOMMENDATION_HEADS` reaches the generated buy-box line.
//
// ── THE FOUR STRINGS THAT CONSTRAIN THE RULE, all pinned as regression tests ─────
//
// Live, and they defeated the obvious first attempt ("the word within N words of a
// brand token"):
//
//   "…in our deep-dive on aluminum-free antiperspirant: what it is and how it works"
//   "check our natural deodorant vs antiperspirant guide"
//
// In both the possessive's head is `deep-dive` / `guide` — an ARTICLE we wrote, not a
// product we sell — so `GAP_STOP_WORDS` (no preposition, conjunction, determiner or
// document-noun in the gap) plus `TERM_TAIL` (the term must END its phrase or modify a
// PRODUCT noun) kill them without touching a true positive.
//
// Found BY the widening, and the sharpest of the four:
//
//   "never call our product, our formula or our collection an antiperspirant"
//
// The rule fired on the sentence that STATES the rule — a negation, in this file's own
// `PRODUCT_CATEGORY_COMPLIANCE_RULE`. A determiner opens a new noun phrase exactly as a
// preposition does, so `a`/`an`/`the` joined `GAP_STOP_WORDS`. Every negation of the
// form "our X is not an antiperspirant" is safe for the same reason.
//
//   "Our pick for antiperspirant quitters: Coconut Oil Deodorant"
//
// A recommendation whose OBJECT is a kind of person, not the term. `TERM_TAIL` applies
// to the recommendation arm too, which is what separates it from the two live lines.
//
// **`PHRASE_END_FOLLOWERS` and `PRODUCT_NOUNS` are WHITELISTS, not blacklists of nouns:
// an unrecognised follower means "not flagged".** That asymmetry is the whole safety
// property — a word this file has never seen can only ever produce a miss, never a
// killed ranking page. Widen either and re-measure, or you re-acquire "our deep-dive".
//
// ── WHY BOTH ARMS COVER THE BUY-BOX LINE ─────────────────────────────────────────
//
// `agents/featured-product-injector` builds its buy-box line as
// `Our pick for ${target_keyword}: ${product}`, so two live articles carried
// "Our pick for travel size antiperspirant: Best Coconut Oil Deodorant" inside the
// conversion path, generated by code that would have regenerated it after any hand fix.
// Arm B sanitizes the keyword so the generator cannot emit it; Arm A blocks the shape if
// any OTHER caller builds it, or if Arm B ever regresses. Deliberately redundant.

/**
 * The misnomer table. One entry today; the shape exists because "our product is not
 * that category" is a class of error, not a single word (a future entry would be
 * `sunscreen`, `antibacterial soap`, `antiseptic` — every one of them an OTC drug
 * category this catalogue does not qualify for).
 *
 * `correct` is what Arm B substitutes. It is a CATEGORY name, never a marketing
 * phrase: the fix for an inaccurate description is an accurate one.
 */
export const PRODUCT_CATEGORY_MISNOMERS = [
  {
    term: 'antiperspirant',
    correct: 'deodorant',
    pattern: /antiperspirants?/gi,
    why:
      'an antiperspirant is an FDA-regulated OTC drug that reduces sweating through an '
      + 'aluminum-salt active ingredient (21 CFR Part 350); RSC sells an aluminum-free '
      + 'coconut-oil deodorant, which is a cosmetic and addresses odor, not wetness. '
      + 'Describing it with the drug category name is inaccurate and is an intended-use claim.',
  },
];

/**
 * Words that, appearing between the possessive and the term, mean the possessive is
 * NOT attached to the term. Prepositions and conjunctions open a new phrase; the
 * content nouns are the ones this site actually uses to refer to its own writing.
 */
const GAP_STOP_WORDS = [
  'on', 'of', 'about', 'for', 'in', 'into', 'with', 'to', 'from', 'vs', 'versus', 'v',
  'and', 'or', 'between', 'than', 'like', 'over', 'after', 'before', 'at', 'by',
  // Determiners. A determiner opens a NEW noun phrase, exactly as a preposition does,
  // so the possessive before it does not govern the term after it. Added 2026-08-24
  // after the widened rule fired on this very file's own compliance-rule sentence,
  // "never call our product, our formula or our collection an antiperspirant" — a
  // NEGATION, and the clearest possible false positive: the rule flagging the text
  // that states the rule.
  'a', 'an', 'the',
  'guide', 'guides', 'post', 'posts', 'article', 'articles', 'page', 'pages',
  'explainer', 'comparison', 'breakdown', 'piece', 'dive', 'deep-dive', 'review',
  'reviews', 'roundup', 'take', 'thoughts', 'advice', 'blog', 'series', 'primer',
  'faq', 'faqs',
];

/**
 * What may FOLLOW the term for it to count as the head of the phrase. A whitelist:
 * anything not here (a noun such as `guide`, `brands`, `aisle`) means the term is a
 * modifier of something else and is NOT flagged. Unknown → not flagged, always.
 */
const PHRASE_END_FOLLOWERS = [
  'is', 'are', 'was', 'were', "isn't", "aren't", 'works', 'work', 'worked', 'working',
  'uses', 'use', 'used', 'contains', 'contain', 'has', 'have', 'had', 'comes', 'come',
  'costs', 'cost', 'smells', 'smell', 'keeps', 'keep', 'stops', 'stop', 'blocks',
  'block', 'and', 'or', 'but', 'because', 'so', 'that', 'which', 'who', 'to', 'in',
  'into', 'on', 'at', 'for', 'with', 'from', 'without', 'after', 'before', 'since',
  'as', 'than', 'while', 'when', 'if', 'will', 'would', 'can', 'could', 'does', 'do',
  'did', 'now', 'today', 'instead', 'yet', 'here',
  // Interrogatives and relatives. None of these can be the head NOUN of a phrase, so
  // one following the term proves the term heads its own. Added 2026-08-24 to reach the
  // second generated buy-box line, "Our pick for aluminum free antiperspirant what it
  // is does it work: …", where the raw target keyword makes the sentence ungrammatical
  // and no head-noun test could parse it.
  'what', 'why', 'how', 'where', 'whether', 'whose', 'whom',
];

/**
 * Nouns that, when the term MODIFIES one of them, still make the phrase a description
 * of a product rather than of a document. `our antiperspirant formula` is our product;
 * `our antiperspirant guide` is our article.
 *
 * This is the ATTRIBUTIVE half of the rule, added 2026-08-24 after the head-of-phrase
 * requirement alone was measured to miss `Real Skin Care's antiperspirant formula` —
 * the single most important string to catch, and the exact phrasing an editor pass
 * flagged as an ingredient-accuracy BLOCKER on `natural-antiperspirant`.
 *
 * A WHITELIST, for the same reason `PHRASE_END_FOLLOWERS` is one: a noun this list has
 * never seen produces a miss, never a killed page. Everything here is a thing RSC
 * physically sells or a container for one — nothing here can denote a piece of writing.
 */
const PRODUCT_NOUNS = [
  'formula', 'formulas', 'formulation', 'formulations', 'stick', 'sticks', 'spray',
  'sprays', 'bar', 'bars', 'roll-on', 'rollon', 'deodorant', 'deodorants', 'product',
  'products', 'line', 'lineup', 'range', 'blend', 'blends', 'balm', 'balms', 'cream',
  'creams', 'lotion', 'paste', 'gel', 'jar', 'jars', 'tube', 'tubes', 'tin', 'tins',
  'refill', 'refills', 'collection', 'collections', 'bundle', 'bundles', 'kit', 'kits',
  'set', 'sets', 'variant', 'variants', 'scent', 'scents', 'sku', 'skus',
];

/**
 * Heads of a RECOMMENDATION phrase — "our pick for X", "our top choice for X". These
 * take a PRODUCT as their object by construction, which is what separates them from
 * "our deep-dive on X" or "our guide to X", whose object is a document.
 *
 * This exists because the generated buy-box headline `Our pick for travel size
 * antiperspirant: <product>` is grammatically "Our" heading "pick", with `for` opening
 * a new phrase — so no amount of tightening the possessive-attachment rule reaches it,
 * and loosening the gap to allow `for` immediately re-acquires the "our deep-dive on
 * aluminum-free antiperspirant" false positive. Naming the recommendation idioms is
 * the narrow way in.
 */
const RECOMMENDATION_HEADS = [
  'pick', 'picks', 'choice', 'choices', 'recommendation', 'recommendations',
  'favorite', 'favourite', 'favorites', 'favourites', 'go-to', 'winner', 'winners',
];

/** Optional intensifier between `our` and the recommendation head: "our TOP pick for". */
const RECOMMENDATION_MODS = ['top', 'best', 'number\\s+one', '#1', 'favorite', 'favourite'];

const BRAND_POSSESSIVE =
  String.raw`(?:\bour\b|\bReal\s+Skin\s+Care(?:'|’)s\b|\bRSC(?:'|’)s\b|\brealskincare(?:'|’)s\b)`;

/**
 * The brand named WITHOUT a possessive — "Real Skin Care antiperspirant", which is the
 * shape a product name takes. `our` is deliberately absent here: bare `our` with no
 * possessive marker is not a thing, and `\bour\b` already lives in BRAND_POSSESSIVE.
 */
const BRAND_BARE = String.raw`(?:\bReal\s+Skin\s+Care\b|\bRSC\b|\brealskincare\b)`;

const BRAND_GOVERNOR = String.raw`(?:${BRAND_POSSESSIVE}|${BRAND_BARE})`;

const GAP = String.raw`(?:\s+(?!(?:${GAP_STOP_WORDS.join('|')})\b)[A-Za-z0-9][A-Za-z0-9-]*){0,3}`;

/**
 * The gap inside a recommendation phrase, AFTER `for`. Wider than `GAP` (4 tokens, to
 * reach "aluminum free antiperspirant what it is does it work") but stop-word-filtered
 * identically, so a preposition still breaks it.
 */
const RECOMMENDATION_GAP =
  String.raw`(?:(?!(?:${GAP_STOP_WORDS.join('|')})\b)[A-Za-z0-9][A-Za-z0-9-]*\s+){0,4}`;

const PHRASE_END =
  String.raw`\s*(?:[.,;:!?)\]…—–"'”’]|$)`
  + String.raw`|\s+(?:${PHRASE_END_FOLLOWERS.join('|')})\b`;

/**
 * What must follow the term for the match to stand: the term either HEADS the phrase
 * (nothing re-heads it) or MODIFIES a product noun. Both are lookaheads, so the match
 * text stays the phrase itself.
 */
const TERM_TAIL =
  String.raw`(?=${PHRASE_END}|\s+(?:${PRODUCT_NOUNS.join('|')})\b)`;

/**
 * The BRAND-GOVERNANCE MATCHER, generalised over the term — the reusable half of Arm A.
 *
 * Two compiled matchers for any term source:
 *
 * `attached`      — a brand or first-person possessive, or the bare brand name,
 *                   governing the term (as head OR attributively).
 * `recommendation`— "our pick for <…> <term>", the generated buy-box shape.
 *
 * `termSource` is a regex FRAGMENT, not a term string: it may be a bare noun
 * (`antiperspirants?`) or an alternation (`(?:over[-\s]the[-\s]counter|otc)`). A `\b` is
 * appended here, never by the caller, so every consumer gets the same word-boundary
 * behaviour. Everything else — the gap rule, the stop words, the phrase-end and
 * product-noun whitelists — is shared verbatim, which is the point: a second copy of this
 * machinery would drift from the 0-false-positive measurement that justifies it.
 *
 * Exported since 2026-08-24 so `lib/seo-copy-health-gate.js` can ask the same question
 * about `over-the-counter` / `OTC`. See that file's OTC section for why the answer there
 * is a TIER decision rather than a new entry in `PRODUCT_CATEGORY_MISNOMERS` (there is no
 * accurate one-word substitute, so Arm B would have to invent one).
 *
 * @param {string} termSource regex fragment matching the term
 * @returns {RegExp[]} fresh, `gi`-flagged, safe to `exec` against
 */
export function buildBrandGovernedPatterns(termSource) {
  return [
    new RegExp(`${BRAND_GOVERNOR}${GAP}\\s+${termSource}\\b${TERM_TAIL}`, 'gi'),
    new RegExp(
      `\\bour\\s+(?:(?:${RECOMMENDATION_MODS.join('|')})\\s+)?`
      + `(?:${RECOMMENDATION_HEADS.join('|')})\\s+for\\s+`
      + `${RECOMMENDATION_GAP}${termSource}\\b${TERM_TAIL}`,
      'gi',
    ),
  ];
}

/**
 * Every brand-governed occurrence of `termSource`, with its span.
 *
 * The span matters to a caller that is tiering INDIVIDUAL matches rather than judging a
 * whole string: `lib/seo-copy-health-gate.js` has to decide, occurrence by occurrence,
 * whether a given "over-the-counter" sits inside a brand-governed phrase, because one
 * sentence can legitimately carry both shapes.
 *
 * @param {string} text
 * @param {string} termSource
 * @returns {{match:string, index:number, end:number}[]} sorted by index
 */
export function findBrandGovernedPhrases(text, termSource) {
  const s = String(text ?? '');
  if (!s.trim()) return [];
  const spans = [];
  const seen = new Set();
  for (const pattern of buildBrandGovernedPatterns(termSource)) {
    let m;
    while ((m = pattern.exec(s)) !== null) {
      const key = `${m.index}:${m[0].length}`;
      if (!seen.has(key)) {
        seen.add(key);
        spans.push({ match: m[0], index: m.index, end: m.index + m[0].length });
      }
      if (m.index === pattern.lastIndex) pattern.lastIndex++;
    }
  }
  return spans.sort((a, b) => a.index - b.index);
}

const ARM_A = PRODUCT_CATEGORY_MISNOMERS.map((m) => ({
  ...m,
  patterns: buildBrandGovernedPatterns(`${m.term}s?`),
}));

/**
 * ARM A. Every place a brand possessive names our product with a category it is not.
 *
 * Runs on prose. Callers on markup should pass it through `plainText` first, exactly
 * as `lib/seo-copy-health-gate.js` does — a regex over raw markup matches attribute
 * values (every internal link to these posts carries the word in its href and title)
 * and misses words split by an inline tag.
 *
 * Returns EVERY occurrence, not the first per term: a string carrying the phrase twice
 * must report twice, or a caller naming the offending words in a retry prompt names
 * only half of them.
 *
 * @param {string} text
 * @returns {{term:string, correct:string, why:string, match:string, index:number}[]}
 */
export function findProductCategoryMisnomers(text) {
  const s = String(text ?? '');
  if (!s.trim()) return [];
  const hits = [];
  const seen = new Set();
  for (const { term, correct, why, patterns } of ARM_A) {
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let m;
      while ((m = pattern.exec(s)) !== null) {
        // The two patterns overlap by design ("our pick for … antiperspirant" can match
        // both), so one occurrence must not be reported twice — a retry prompt that
        // names the same phrase twice reads as two separate problems.
        const key = `${term}@${m.index}:${m[0].length}`;
        if (!seen.has(key)) {
          seen.add(key);
          hits.push({ term, correct, why, match: m[0], index: m.index });
        }
        if (m.index === pattern.lastIndex) pattern.lastIndex++;
      }
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}

/** True when any brand-attached misnomer is present. */
export function hasProductCategoryMisnomer(text) {
  return findProductCategoryMisnomers(text).length > 0;
}

/**
 * ARM B. Replace the misnomer with the accurate category, for copy whose subject IS
 * our product — a CTA headline, a buy-box line, a product title.
 *
 * It never throws and never refuses. `agents/featured-product-injector` builds its
 * buy-box headline from the post's target keyword, and several of those keywords are
 * legitimately "travel size antiperspirant" — that is the query the page ranks for.
 * Blocking there would mean the page loses its buy box, which by the Prime Directive
 * is a worse outcome than the inaccuracy: a page with traffic and no purchase path is
 * a bug. Rewriting the one word keeps the specificity, keeps the conversion path, and
 * says something true.
 *
 * Case is preserved per occurrence (`Antiperspirant` → `Deodorant`, `ANTIPERSPIRANT` →
 * `DEODORANT`) so the substitution never disturbs a title or a heading's own casing.
 * Idempotent: the output contains no misnomer, so a second pass is a no-op.
 *
 * @param {string} text
 * @returns {string}
 */
export function sanitizeProductCategoryTerm(text) {
  let out = String(text ?? '');
  for (const { pattern, correct } of PRODUCT_CATEGORY_MISNOMERS) {
    out = out.replace(new RegExp(pattern.source, 'gi'), (found) => matchCase(found, correct));
  }
  return out;
}

/**
 * Carry the found token's casing onto the replacement, and its plural.
 * ALL CAPS → ALL CAPS; Leading capital → Leading capital; otherwise lower.
 */
function matchCase(found, replacement) {
  const plural = /s$/i.test(found);
  const base = plural ? `${replacement}s` : replacement;
  if (found === found.toUpperCase() && /[A-Z]/.test(found)) return base.toUpperCase();
  if (/^[A-Z]/.test(found)) return base.charAt(0).toUpperCase() + base.slice(1);
  return base.toLowerCase();
}

/**
 * The standing instruction for a FIRST generation, so most runs never reach a retry —
 * the same prevention-beats-detection posture as `SEO_COPY_COMPLIANCE_RULE` and
 * `selectQuotableReviews`.
 *
 * It states BOTH halves. Stating only the prohibition is what produces the
 * over-correction: a model told "never write antiperspirant" will strip the word out
 * of the FDA explanation that is the whole reason the page ranks.
 */
export const PRODUCT_CATEGORY_COMPLIANCE_RULE =
  'PRODUCT CATEGORY ACCURACY (hard rule): Real Skin Care sells an aluminum-free coconut-oil '
  + 'DEODORANT, which is a cosmetic. It is NOT an antiperspirant — an antiperspirant is an '
  + 'FDA-regulated OTC drug that reduces sweating with an aluminum-salt active ingredient. '
  + 'Never call our product, our formula or our collection an antiperspirant, and never write '
  + '"our antiperspirant" or "Real Skin Care\'s antiperspirant". '
  + 'You MAY and SHOULD discuss antiperspirants as a CATEGORY — what they are, how they differ '
  + 'from deodorant, what aluminum does, why someone switches. That is accurate, useful, and it '
  + 'is what these pages rank for. The line is: describing the category is fine; describing OUR '
  + 'product with the word is not.';
