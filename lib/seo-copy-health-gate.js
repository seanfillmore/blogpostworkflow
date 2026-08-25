// lib/seo-copy-health-gate.js
//
// The health-claim gate for SEO COPY — the page title and meta description an
// agent generates and writes to Shopify, which Google then renders as the SERP
// snippet next to the brand name.
//
// ── Why this file exists ────────────────────────────────────────────────────────
//
// On 2026-08-22 `agents/meta-optimizer` generated and published, live:
//
//   title: "Best Soap for Tattoos: Clean Ingredients That Heal"
//   meta:  "…skips harsh chemicals and supports real healing…"
//
// Both are therapeutic claims. A cosmetic may say what it does to the appearance
// and feel of skin; it may not say what it heals. FDA treats marketing material
// as evidence of intended use, and intended use is what turns a cosmetic into an
// unapproved drug. The agent had no gate at all — it did not import
// agents/ad-studio/health-claims.js, which had been guarding ad copy since
// 2026-08-16 against exactly this.
//
// ── Why it is not just `assertNoHealthClaims` ───────────────────────────────────
//
// health-claims.js was built for AD COPY, where the product is unambiguously the
// speaker. A page title is a different surface: much of this site's content is
// ingredient-avoidance editorial ("what to look for, what to avoid"), where the
// headline names a problem in the category rather than a thing the product does.
//
// So the gate was MEASURED before it was applied, per the standing rule from the
// 2026-08-18 vocabulary work: measure blast radius before adding a pattern. Run
// over 684 live strings on 2026-08-23 — 203 article titles, 195 article
// summaries, 37 `description_tag`, 17 `title_tag`, 19 product titles, 89
// collection titles, 82 collection bodies, 42 page titles — plus 208 local
// strings from data/posts/*/meta.json and data/reports/meta-ab/meta-ab-tracker.json,
// `findHealthClaims` unchanged flags 28 distinct live strings:
//
//   toxicity          15   ← the over-restriction
//   therapeutic       11
//   drug               1
//   disease            1
//   substantiation     0
//   systemic-absorption 0
//
// The 15 toxicity hits are things like "Toxic Chemicals In Soap To Keep An Eye
// On", "Zero Toxins", "free from harmful chemicals", "7 harmful ingredients
// hiding in natural toothpaste". None of them says this product treats anything.
// They are category-education headlines and absence-of-ingredient reassurance —
// this brand's central editorial position, and the same generic reassurance the
// operator already ruled acceptable on 2026-08-18 when "non-toxic" was
// deliberately unblocked in health-claims.js. ("Zero Toxins" is that ruling's own
// phrase wearing different words; the lookbehind that spares "non-toxic" cannot
// see it.)
//
// Blocking them would not merely lose a rewrite. A page whose ranking query IS
// "toxic chemicals in soap" cannot be given a title without the word and still
// match its own query, so EVERY regeneration would trip and the page would be
// removed from CTR work permanently — silently, on a weekly unattended cron.
// That is the exact failure this repo spent 2026-08-22 fixing, wearing the
// costume of a safety fix.
//
// ── The line the two tiers draw ─────────────────────────────────────────────────
//
// BLOCKING — "this product is a drug": disease, drug, therapeutic, systemic-
// absorption, substantiation. These convert a cosmetic into an unapproved drug
// under FDA intended-use doctrine, and no editorial framing rescues them on a
// brand's own marketing surface. Every one of the 13 blocking-tier hits in the
// measured corpus is a genuine claim.
//
// ADVISORY — "this is a verdict about the wider category": toxicity, plus the
// therapeutic NOUNS `remedy`/`remedies`. These are FTC substantiation questions
// about ingredients or third-party products, not intended-use claims about this
// catalogue. They are reported — counted and named in the run report, so nothing
// is invisible — and they never block a write.
//
// `remedy`/`remedies` is the one word demoted out of an otherwise-blocking
// category, on the same measured basis: all three live hits are informational
// framing of somebody else's material ("Learn if this natural remedy works" about
// coconut oil, "natural remedies to soothe irritation", "proven remedies" in a
// DIY hair-mask post). The therapeutic VERBS stay blocking, because a verb takes
// the product as its subject and that is the whole distinction: "the product does
// X" is a claim, "here is information about X" is not.
//
// ── "OVER-THE-COUNTER": a conditional third answer, added 2026-08-24 ─────────────
//
// Two correct rules used to contradict each other. `health-claims.js`'s `drug` pattern
// blocks "over-the-counter" / "OTC", which is right for AD COPY — an ad has no
// legitimate reason to reach for a drug-status word, and that behaviour is UNCHANGED
// (pinned by tests/lib/regulatory-otc-phrasing.test.js). But `drug` is in the blocking
// tier here, so the phrase was refused in generated titles and metas too — on pages that
// exist precisely to explain that an ANTIPERSPIRANT is a regulated OTC drug while a
// DEODORANT is a cosmetic. That distinction is the page's whole value and the reason it
// ranks, and it is the same distinction `lib/product-category-terms.js` exists to keep
// accurate. The gate was refusing the accurate version of the rule it enforces.
//
// MEASURED, read-only, over the live corpus on 2026-08-24 (204 articles, 19 products,
// 89 collections, 43 pages, 171 title_tag/description_tag metafields, 94 local
// data/posts/*/meta.json — 1,389 strings):
//
//   66 OTC occurrences, ALL of them in article body_html — and 21 of the 40
//   deodorant-cluster articles (52.5%) carry one, against 7.9% of everything else.
//   The recurring sentence is literally "The FDA classifies antiperspirants as
//   over-the-counter drugs, not cosmetics." Zero occurrences in any title, meta,
//   summary or product/collection body — the surfaces this gate screens.
//
// So it has not yet FIRED on a live string; what it does is make the phrasing
// unreachable going forward. That is not hypothetical pressure: data/briefs/
// best-aluminum-free-deodorant.json instructs the writer verbatim that antiperspirant is
// "regulated as an OTC drug by the FDA", and PRODUCT_CATEGORY_COMPLIANCE_RULE — carried
// into EVERY gated prompt by SEO_COPY_COMPLIANCE_RULE below — tells the model it "MAY and
// SHOULD discuss antiperspirants as a CATEGORY". The gate was instructing a behaviour and
// then refusing its most accurate expression, with `seoCopyConstraint` naming the phrase
// as the offence, which teaches the retry to drop the regulatory fact rather than fix a
// claim. Nine deodorant collections and one live deodorant PDP are the standing targets
// of `collection-content-optimizer` and `product-optimizer`, both of which generate
// 450-650 words of exactly this prose behind this gate.
//
// THE RULE: the same line drawn twice already. "our over-the-counter formula" BLOCKS;
// "Antiperspirants are regulated as over-the-counter drugs" does not. The predicate is
// `findBrandGovernedPhrases` from `lib/product-category-terms.js` — the identical
// machinery, imported and not re-implemented, so the gap rule, the stop words and the
// PRODUCT_NOUNS / PHRASE_END_FOLLOWERS whitelists (and their measured 0 false positives
// across 539 live occurrences) apply here too. Tiering by SPAN, not by whole string: one
// sentence can legitimately carry both shapes.
//
// It stays in this file rather than becoming a fourth `PRODUCT_CATEGORY_MISNOMERS` entry
// because that table's `correct` field is mandatory and feeds Arm B, the rewriter — and
// there is no accurate one-word substitute for "over-the-counter". Arm B would have to
// invent one. This is a TIER decision, and tiering is what this module does.
//
// TWO MISSES ARE ACCEPTED ON PURPOSE, both pinned as tests. "our deodorant is an
// over-the-counter drug" is not caught, because the determiner stop-word that makes the
// NEGATION ("…is NOT an over-the-counter drug") safe cannot tell the two apart — and the
// negation is copy this brand genuinely writes and must never lose, while the positive is
// a sentence no writer produces. "our over-the-counter drug" is not caught, because
// `drug` is not in PRODUCT_NOUNS and adding it would flag "Real Skin Care explains
// over-the-counter drugs". Unknown-means-allow is the safety property, not a gap.
//
// THE REST OF THE `drug` VOCABULARY IS DELIBERATELY UNTOUCHED, having been measured the
// same way. `prescription`/`prescribed` (30 live occurrences) stays fully blocking: a
// cosmetic positioned against a prescription drug is the classic unapproved-drug shape,
// and it is the exact language of the 2026-08-16 incident quote. `medicinal` (23),
// `antifungal` (13), `medication` (17), `antibiotic` (8), `medicated` (5),
// `pharmaceutical` (3) and `hydrocortisone` (2) name drugs or drug classes rather than a
// regulatory STATUS, and only 2 of those occurrences sit on a gated surface at all (both
// in unpublished collection drafts). `FDA`, `monograph`, `active ingredient` and
// `Drug Facts` were checked and do not bite: bare `fda` is not in any pattern (only
// `fda-approved`/`fda cleared`, under `substantiation`), and the other three are not in
// the vocabulary at all. Nothing was widened to make a point.
//
// ── Why the asymmetry is affordable here ────────────────────────────────────────
//
// On this surface a false positive is bounded: the caller regenerates once with
// the offending words named in the prompt, and only skips (visibly, counted) if
// the retry trips too. "Heal" is always replaceable — the operator rewrote the
// incident page by hand in minutes without it. A word the page CANNOT do without
// is what makes a gate lethal, and that is the toxicity vocabulary, which is why
// it is advisory.
//
// ── Single source of truth ──────────────────────────────────────────────────────
//
// The patterns are IMPORTED from agents/ad-studio/health-claims.js and never
// re-declared here. A second copy of a regex is a second copy that drifts — the
// same reason lib/demand-questions.js imports AWARENESS_LEVELS instead of
// restating it. This module only decides which TIER each hit lands in.
//
// It also does its own matching rather than calling `findHealthClaims`, which
// returns the first match per category only. A string carrying "remedy" before
// "heals" would arrive as one therapeutic hit whose match text is "remedy",
// get demoted, and let the verb through. Tested.

import { HEALTH_CLAIM_PATTERNS } from '../agents/ad-studio/health-claims.js';
import {
  findProductCategoryMisnomers,
  findBrandGovernedPhrases,
  PRODUCT_CATEGORY_COMPLIANCE_RULE,
} from './product-category-terms.js';

/**
 * Which HEALTH-CLAIM categories stop a write.
 *
 * This set describes the tiering of `HEALTH_CLAIM_PATTERNS` and nothing else. It is
 * deliberately NOT the complete list of things that can block: since 2026-08-24 the
 * gate has a second, independent source of blocking hits — product-category accuracy,
 * below — which is not a health claim and does not belong in this taxonomy. Read
 * `result.blocking` to know whether a write is refused; read this set only to ask how
 * a health-claim category is tiered.
 */
export const BLOCKING_CATEGORIES = new Set([
  'disease',
  'drug',
  'therapeutic',
  'systemic-absorption',
  'substantiation',
]);

/**
 * The category a demoted OTC occurrence carries — a statement about how the WIDER
 * CATEGORY is regulated, not about this product. See the header's OTC section.
 */
export const REGULATORY_REFERENCE_CATEGORY = 'regulatory-reference';

/** Categories reported but never blocking. See the header for the measurement. */
export const ADVISORY_CATEGORIES = new Set([
  'toxicity',
  'therapeutic-noun',
  REGULATORY_REFERENCE_CATEGORY,
]);

/**
 * Matches demoted out of an otherwise-blocking category, by the matched TEXT.
 * Keyed by category so a word can be demoted in one place without being demoted
 * everywhere. Each entry needs a measured justification in the header.
 */
const DEMOTED = {
  therapeutic: {
    pattern: /^remed(?:y|ies)$/i,
    category: 'therapeutic-noun',
    why: 'names a remedy in an informational frame — reported, not blocked: it describes an ingredient or a third-party product rather than claiming this product treats anything',
  },
};

/**
 * Matches whose tier depends on the SENTENCE AROUND THEM, not on the matched text.
 *
 * `DEMOTED` above is unconditional — "remedy" is advisory wherever it appears. This table
 * is the third answer: blocking when the brand governs the phrase, advisory when it is a
 * reference to how the wider category is regulated. Keyed by category, matched by text,
 * and resolved per OCCURRENCE against the spans `governedBy` returns, because one string
 * can carry both shapes.
 *
 * `termSource` is handed to `findBrandGovernedPhrases` unchanged — the SAME matcher Arm A
 * of `lib/product-category-terms.js` uses, imported rather than restated.
 */
const CONDITIONAL = {
  drug: {
    pattern: /^(?:over[- ]the[- ]counter|otc)$/i,
    termSource: String.raw`(?:over[-\s]the[-\s]counter|otc)`,
    category: REGULATORY_REFERENCE_CATEGORY,
    whyAdvisory:
      'states how a product CATEGORY is regulated (an antiperspirant is an FDA OTC drug; a '
      + 'deodorant is a cosmetic) — reported, not blocked: it describes the category, not this '
      + 'product, and it is the distinction these pages exist to explain',
    whyBlocking:
      'describes OUR product as an over-the-counter drug. RSC sells a cosmetic. The phrase is '
      + 'fine — and is what these pages rank for — when it describes the CATEGORY; it is an '
      + 'intended-use claim when the brand governs it',
  },
};

/**
 * The standing instruction for the OTC carve-out, stated in BOTH directions.
 *
 * Stating only the prohibition is what produces the over-correction — exactly the lesson
 * `PRODUCT_CATEGORY_COMPLIANCE_RULE` records. A model told "never write over-the-counter"
 * strips the phrase out of the FDA explanation that is the whole reason the page ranks.
 */
export const REGULATORY_PHRASING_RULE =
  'REGULATORY PHRASING (hard rule): you MAY and SHOULD write that an antiperspirant is an '
  + 'FDA-regulated over-the-counter (OTC) drug under 21 CFR Part 350 while a deodorant is a '
  + 'cosmetic — that is accurate, it is the distinction these pages exist to explain, and it is '
  + 'what they rank for. What you must never do is apply it to OUR product: no "our '
  + 'over-the-counter formula", no "Real Skin Care\'s OTC deodorant". Real Skin Care sells a '
  + 'cosmetic. Describing the CATEGORY as over-the-counter is fine; describing OUR product that '
  + 'way is a drug claim.';

/**
 * The category name carried by a product-category-accuracy hit.
 *
 * Always blocking, and it is not a health claim — see `lib/product-category-terms.js`
 * for the rule and for the 0-false-positive measurement across 539 live occurrences.
 * It sits here rather than in its own gate because every unattended SEO-copy writer is
 * already wired through `checkSeoCopyFields`, and a second gate nobody calls is a gate
 * that does not exist.
 */
export const PRODUCT_CATEGORY_CATEGORY = 'product-category';

/**
 * Every disallowed occurrence in one string, split into the two tiers.
 *
 * TWO sources feed `blocking`: the health-claim patterns tiered by
 * `BLOCKING_CATEGORIES`, and product-category misnomers from
 * `findProductCategoryMisnomers`. Neither substitutes for the other — "our
 * antiperspirant" carries no health-claim vocabulary at all, and "heals eczema"
 * describes the product's category correctly while making a drug claim.
 *
 * @param {string} text
 * @returns {{blocking: Array<{category:string, why:string, match:string}>,
 *            advisory: Array<{category:string, why:string, match:string}>}}
 */
export function findSeoCopyClaims(text) {
  const s = String(text ?? '');
  const blocking = [];
  const advisory = [];
  if (!s.trim()) return { blocking, advisory };

  for (const hit of findProductCategoryMisnomers(s)) {
    blocking.push({ category: PRODUCT_CATEGORY_CATEGORY, why: hit.why, match: hit.match });
  }

  // Computed at most once per conditional category per call, and only when one of its
  // matches actually turns up — the brand-governance scan is two regexes over the string
  // and most strings never reach it.
  const governedSpans = new Map();
  const governedBy = (key, termSource) => {
    if (!governedSpans.has(key)) governedSpans.set(key, findBrandGovernedPhrases(s, termSource));
    return governedSpans.get(key);
  };

  for (const { category, why, pattern } of HEALTH_CLAIM_PATTERNS) {
    // `matchAll` rather than `match`, because a conditional tier needs each occurrence's
    // INDEX to know whether it sits inside a brand-governed phrase. Same matches either
    // way; `match` merely throws the positions away.
    for (const m of s.matchAll(new RegExp(pattern.source, 'gi'))) {
      const match = m[0];

      const demotion = DEMOTED[category];
      if (demotion && demotion.pattern.test(match)) {
        advisory.push({ category: demotion.category, why: demotion.why, match });
        continue;
      }

      const conditional = CONDITIONAL[category];
      if (conditional && conditional.pattern.test(match)) {
        const inside = governedBy(category, conditional.termSource)
          .some((span) => m.index >= span.index && m.index < span.end);
        if (inside) blocking.push({ category, why: conditional.whyBlocking, match });
        else advisory.push({ category: conditional.category, why: conditional.whyAdvisory, match });
        continue;
      }

      if (BLOCKING_CATEGORIES.has(category)) blocking.push({ category, why, match });
      else advisory.push({ category, why, match });
    }
  }

  return { blocking, advisory };
}

/**
 * The prose a reader actually sees, for matching purposes.
 *
 * Callers on this surface hand over three shapes — a bare title, a meta
 * description, and a `body_html` that is real markup — and a regex run against
 * raw markup matches attribute values and misses words split by an inline tag.
 * Tags become a SPACE, never nothing, so `<p>heal</p><p>ing</p>` cannot be
 * glued into a word that was never written. A string with no tags in it comes
 * back unchanged, so this is safe to apply to every field uniformly.
 */
export function plainText(value) {
  return String(value ?? '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Check an arbitrary named set of copy fields.
 *
 * `checkSeoCopy` below is the two-field special case this repo started with.
 * The other writers do not have a title/meta shape — `product-optimizer` writes
 * a live product TITLE (`new_title`), a product `body_html` and FAQ answers;
 * `collection-content-optimizer` writes a 450-650 word collection `body_html`.
 * Passing any of those in as `meta` would be a lie in the report and, worse,
 * passing a bare STRING to `checkSeoCopy` returns `ok: true` with empty arrays,
 * because there is no `.title`/`.meta` on it to read. That silent free pass is
 * exactly the shape of failure this gate exists to prevent, so every caller
 * names its fields and the name is what appears in the digest.
 *
 * @param {Record<string, string|undefined|null>} fields
 * @returns {{ok: boolean,
 *             blocking: Array<{field:string, category:string, why:string, match:string}>,
 *             advisory: Array<{field:string, category:string, why:string, match:string}>}}
 */
export function checkSeoCopyFields(fields) {
  const blocking = [];
  const advisory = [];
  for (const [field, value] of Object.entries(fields || {})) {
    const hits = findSeoCopyClaims(plainText(value));
    for (const h of hits.blocking) blocking.push({ field, ...h });
    for (const h of hits.advisory) advisory.push({ field, ...h });
  }
  return { ok: blocking.length === 0, blocking, advisory };
}

/**
 * Check a proposed title + meta description pair.
 *
 * Both fields, always — the 2026-08-22 incident had a violation in each, and a
 * gate on the title alone would have published the meta unchanged.
 *
 * @param {{title?: string, meta?: string}} copy
 * @returns {{ok: boolean,
 *             blocking: Array<{field:string, category:string, why:string, match:string}>,
 *             advisory: Array<{field:string, category:string, why:string, match:string}>}}
 */
export function checkSeoCopy(copy) {
  return checkSeoCopyFields({ title: copy?.title, meta: copy?.meta });
}

/**
 * The constraint to add to a regeneration prompt.
 *
 * Names the exact words that tripped, because "avoid health claims" is advice a
 * model can satisfy while writing "heals" again — it does not know which word was
 * the problem. Prevention beats detection, and the retry is the only prevention
 * this surface gets before the candidate is dropped.
 *
 * @param {Array<{field:string, match:string, why:string}>} violations
 * @returns {string} empty when there is nothing to constrain
 */
export function seoCopyConstraint(violations) {
  if (!violations?.length) return '';
  const words = [...new Set(violations.map((v) => v.match))];
  const reasons = [...new Set(violations.map((v) => v.why))];
  const lines = [
    'COSMETIC COMPLIANCE — your previous attempt was rejected.',
    `It used: ${words.map((w) => `"${w}"`).join(', ')}.`,
    ...reasons.map((r) => `- ${r}`),
    'This is a cosmetic, not a drug. Describe what it does to the appearance and feel of skin.',
    'Do not say it heals, cures, treats or prevents anything, do not name a disease or a',
    'medication, and do not claim clinical or regulatory backing. Rewrite without those words.',
  ];
  // A product-category miss needs the opposite of "drop the word": the word is fine as
  // a category reference and is what the page ranks for. Say so explicitly, or the
  // retry strips it out of the FDA explanation and the rewrite is worse than the miss.
  if (violations.some((v) => v.category === PRODUCT_CATEGORY_CATEGORY)) {
    lines.push(PRODUCT_CATEGORY_COMPLIANCE_RULE);
  }
  // Same shape, same reason, for a brand-governed OTC phrase: the blanket instruction
  // above ("do not mention a medication") would have the retry delete the FDA sentence
  // this page ranks for. Say which half is wrong.
  if (violations.some((v) => CONDITIONAL.drug.pattern.test(v.match))) {
    lines.push(REGULATORY_PHRASING_RULE);
  }
  return lines.join('\n');
}

/**
 * The standing instruction for the FIRST generation, so most runs never need the
 * retry at all. Detection without prevention burns retries — the same lesson
 * selectQuotableReviews encodes in health-claims.js.
 */
export const SEO_COPY_COMPLIANCE_RULE =
  'COSMETIC COMPLIANCE (hard rule): this is a cosmetic, not a drug. Say what the product does ' +
  'to the appearance and feel of skin. Never say it heals, cures, treats, remedies or prevents ' +
  'anything; never name a skin disease (eczema, psoriasis, dermatitis, acne, infection, wounds); ' +
  'never mention prescriptions, steroids or medications; never claim it is absorbed into the body; ' +
  'never claim clinical, dermatologist or FDA backing. Ingredient-avoidance language ' +
  '("no SLS", "fragrance-free", "clean ingredients") is fine.\n' +
  PRODUCT_CATEGORY_COMPLIANCE_RULE + '\n' +
  REGULATORY_PHRASING_RULE;

/**
 * One-line digest fragments for the run report. Empty array on a clean run, so a
 * normal run gains no noise — same posture as renderHoldLines.
 *
 * @param {Array<{keyword?:string, pageUrl?:string, violations?:Array}>} skipped
 * @returns {string[]}
 */
export function renderGateSkipLines(skipped) {
  if (!skipped?.length) return [];
  const lines = [
    `${skipped.length} candidate(s) skipped by the health-claim gate — the rewrite made a claim a ` +
    `cosmetic may not make, and the one permitted retry made it again. The page is unchanged; ` +
    `nothing was written to Shopify.`,
  ];
  for (const s of skipped) lines.push(gateSkipLine(s));
  return lines;
}

/** One `"label" (where) — field: "word"` line. Shared by both renderers. */
function gateSkipLine(s) {
  const words = [...new Set((s.violations || []).map((v) => `${v.field}: "${v.match}"`))].join(', ');
  const label = s.label ?? s.keyword ?? s.slug ?? '(unnamed)';
  const where = s.pageUrl ?? s.resource ?? '';
  return `"${label}"${where ? ` (${where})` : ''} — ${words}`;
}

/**
 * The digest lines for a gate hit at a point where REGENERATION IS IMPOSSIBLE.
 *
 * `lib/queue-apply.js` and the two `--publish-approved` drains apply copy some
 * other run generated, possibly days earlier. There is no prompt at that layer,
 * so there is no retry to spend and the sentence above ("the one permitted
 * retry made it again") would simply be false. Two renderers rather than one
 * with a flag, because the two say genuinely different things about what
 * happened and what a human should do next.
 *
 * The wording is deliberate about what did NOT happen: the item is refused, not
 * dismissed and not deleted. This repo destroyed three paid-for content briefs
 * on 2026-08-19 by letting an automated verdict remove work outright; a gate is
 * allowed to refuse a write and is not allowed to decide the work is worthless.
 *
 * @param {Array<{label?:string, slug?:string, resource?:string, violations?:Array}>} refused
 * @returns {string[]}
 */
export function renderGateRefusalLines(refused) {
  if (!refused?.length) return [];
  const lines = [
    `${refused.length} queued item(s) REFUSED by the health-claim gate — the stored copy makes a ` +
    `claim a cosmetic may not make. This layer applies copy generated by an earlier run and cannot ` +
    `regenerate, so nothing was written to Shopify and the item was left in place (not dismissed, ` +
    `not deleted). Re-run the producing agent to regenerate it, or edit and re-approve it by hand.`,
  ];
  for (const r of refused) lines.push(gateSkipLine(r));
  return lines;
}

/**
 * Subject-line fragment, matching holdSummaryFragment's shape so the two compose.
 * @param {Array} skipped
 */
export function gateSkipSummaryFragment(skipped) {
  const n = skipped?.length || 0;
  return n ? `, ${n} gated` : '';
}
