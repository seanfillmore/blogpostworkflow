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
//   ARM A — `findProductCategoryMisnomers` — BLOCKS. A first-person-plural or brand
//   POSSESSIVE attaches to the term and the term is the HEAD of that noun phrase.
//   "our antiperspirant", "Real Skin Care's natural antiperspirant". Deliberately
//   conservative: it prefers a false negative to a false positive, because a false
//   positive here kills a page's copy and a false negative is caught by Arm B or by a
//   human. MEASURED FALSE-POSITIVE RATE: **0** — see below.
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
//   - every one of the 101 files in this repo that mentions the word;
//   - the five server-side post mirrors under `data/posts/*antiperspirant*/`.
//
//   ARM A HITS: 0.  ZERO FALSE POSITIVES, and zero true positives — nothing in the
//   live corpus currently says "our antiperspirant". Arm A is therefore pure
//   prevention: it costs nothing today and stops the sentence being written tomorrow.
//
// Two live strings defeated the obvious first attempt ("the word within N words of a
// brand token") and are pinned as regression cases in the tests:
//
//   "read more about the deodorant vs. antiperspirant distinction in our deep-dive on
//    aluminum-free antiperspirant: what it is and how it works"
//   "check our natural deodorant vs antiperspirant guide"
//
// In both, the possessive's head noun is `deep-dive` / `guide` — an ARTICLE we wrote,
// not a product we sell. Two constraints kill them without touching the true positives:
// the modifier gap may not contain a preposition, conjunction or content-noun
// (`GAP_STOP_WORDS`), and the term must be followed by something that ENDS the noun
// phrase (`PHRASE_END`) rather than by a noun that re-heads it. `PHRASE_END` is a
// WHITELIST of followers, not a blacklist of nouns: an unrecognised follower means "not
// flagged". That asymmetry is the whole safety property — a word this file has never
// seen can only ever produce a miss, never a killed page.
//
// The real live defect this work fixed was found by Arm B's question, not Arm A's:
// `agents/featured-product-injector` builds its buy-box line as
// `Our pick for ${target_keyword}: ${product}`, so two live articles carried
// "Our pick for travel size antiperspirant: Best Coconut Oil Deodorant" inside the
// conversion path — RSC's deodorant named as an antiperspirant, in the buy box,
// generated by code that would have regenerated it after any hand fix.

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
];

const BRAND_POSSESSIVE =
  String.raw`(?:\bour\b|\bReal\s+Skin\s+Care(?:'|’)s\b|\bRSC(?:'|’)s\b|\brealskincare(?:'|’)s\b)`;

const GAP = String.raw`(?:\s+(?!(?:${GAP_STOP_WORDS.join('|')})\b)[A-Za-z0-9][A-Za-z0-9-]*){0,3}`;

const PHRASE_END =
  String.raw`(?=\s*(?:[.,;:!?)\]…—–"'”’]|$)`
  + String.raw`|\s+(?:${PHRASE_END_FOLLOWERS.join('|')})\b)`;

/** One compiled Arm A matcher per misnomer, built once. */
const ARM_A = PRODUCT_CATEGORY_MISNOMERS.map((m) => ({
  ...m,
  attached: new RegExp(`${BRAND_POSSESSIVE}${GAP}\\s+${m.term}s?\\b${PHRASE_END}`, 'gi'),
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
  for (const { term, correct, why, attached } of ARM_A) {
    attached.lastIndex = 0;
    let m;
    while ((m = attached.exec(s)) !== null) {
      hits.push({ term, correct, why, match: m[0], index: m.index });
      if (m.index === attached.lastIndex) attached.lastIndex++;
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
