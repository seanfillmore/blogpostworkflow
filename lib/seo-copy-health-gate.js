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

/** Categories reported but never blocking. See the header for the measurement. */
export const ADVISORY_CATEGORIES = new Set(['toxicity', 'therapeutic-noun']);

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

  for (const { category, why, pattern } of HEALTH_CLAIM_PATTERNS) {
    const matches = s.match(new RegExp(pattern.source, 'gi'));
    if (!matches) continue;

    for (const match of matches) {
      const demotion = DEMOTED[category];
      if (demotion && demotion.pattern.test(match)) {
        advisory.push({ category: demotion.category, why: demotion.why, match });
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
  PRODUCT_CATEGORY_COMPLIANCE_RULE;

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
