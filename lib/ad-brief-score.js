// lib/ad-brief-score.js
//
// How good is an ad brief, from data we actually hold?
//
// READ THIS BEFORE CHANGING A WEIGHT. There is NO ad-performance data behind any of
// this — data/meta-ads-insights/ is empty on the production server and nothing this
// pipeline makes has ever run as a paid ad. Every number here is an a-priori judgement
// about evidence, not a measured outcome. That is exactly why the score only ever RANKS
// briefs and never kills one: a guess dressed as a threshold is how good work gets
// thrown away.
//
// TWO objective failures are handled elsewhere as hard floors and are not scores: an
// unsourced claim (claims.js) and a health-claim violation (health-claims.js). Both are
// real, both are wired in, and both stop a run.
//
// A FALSIFIED-TACTIC FLOOR IS NOT BUILT. This comment used to name one alongside those two,
// which was wrong and worth correcting rather than leaving: nothing in agents/ad-studio or
// agents/ad-brief reads `.claude/skills/marketing-*/SKILL.md`'s `## Falsified` sections, and
// nothing checks generated copy against them. `buildCopyPrompt` (copy.js) does accept a
// `tactics` argument, but `buildConcept` never passes one, so the tactic menu is not even
// offered to the copy writer, let alone blocklisted — creative-packager is the only agent
// that reads those skills. Do not read this paragraph as a TODO: it is here so nobody
// relies on a safeguard that does not exist. (Code review, 2026-08-17.)
//
// WHAT ACTUALLY DISCRIMINATES, within the ranking a human sees. Briefs are only ever ranked
// against other briefs FOR THE SAME PRODUCT, and `scoreCommercial` is a function of the
// product handle alone — so its 25 points are a CONSTANT OFFSET in every list anyone looks
// at, contributing nothing to the order. `scorePersona` compresses too: after the ceilings
// below were calibrated to the real data, all five personas on file land between 24 and 30
// of 30. The live signal is therefore mostly `headroom` (5 discrete values) plus `proof`
// (6 or 25). Rebalancing the weights would be guessing a second time with no
// ad-performance data to guess from, so the weights stand until real outcome data exists —
// see agents/ad-brief/README.md's "What the score actually discriminates on".
//
// Imports nothing on purpose, so it can be tested without personas, disk or network.

/**
 * Awareness headroom. Narrow product-aware angles harvest fast and exhaust fast; broad
 * problem-aware and unaware angles convert more slowly and keep running
 * (.claude/skills/marketing-awareness-level-messaging/SKILL.md). Without this component
 * the queue fills with the angles that run dry first.
 */
export const HEADROOM_BY_AWARENESS = {
  'unaware': 20,
  'problem-aware': 20,
  'solution-aware': 13,
  'product-aware': 7,
  'most-aware': 7,
};

import { AOV_TRAILING_90D } from './business-baseline.js';

const MAX = { persona: 30, proof: 25, commercial: 25, headroom: 20 };

/** Neutral commercial score when there is no data. Absence of evidence is not evidence. */
const COMMERCIAL_NEUTRAL = 12;

/**
 * The ceiling, stated in ORDERS so it cannot drift with AOV. See scoreCommercial's
 * docstring for the derivation: a third of the store's 22 all-channel orders per 28 days.
 */
export const CEILING_ORDERS = 7.5;

/** Points the revenue term is worth; the remaining 5 of MAX.commercial are the growth bonus. */
export const REVENUE_POINTS = 20;

/** The ceiling in dollars, resolved through the one measured AOV rather than spelled here. */
export const REVENUE_CEILING_USD = CEILING_ORDERS * AOV_TRAILING_90D;

const clamp = (n, max) => Math.max(0, Math.min(max, n));

/** Strip case, punctuation and whitespace so quote matching survives ordinary drift. */
function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Persona strength: how much real evidence sits behind this buyer, and how hard the
 * feeling runs. voice-of-customer writes both fields with an evidence count per persona.
 * 18 reviews at intensity 9.2 is the strongest persona on file and earns full marks.
 */
export function scorePersona(persona) {
  if (!persona) return 0;
  const evidence = Number(persona.evidence_count) || 0;
  const intensity = Number(persona.emotional_intensity) || 0;
  // 15 pts of evidence saturating at 15 reviews, 15 pts of intensity saturating at 9.0.
  // Both ceilings are set where the real data tops out rather than at the theoretical
  // maximum: the strongest persona on file (18 reviews, intensity 9.2) is what "full
  // marks" is supposed to mean, and a scale that only pays out at a perfect 10 would
  // never award it to anything that actually exists.
  const evidencePts = Math.min(evidence, 15);
  const intensityPts = (Math.min(intensity, 9) / 9) * 15;
  return clamp(Math.round(evidencePts + intensityPts), MAX.persona);
}

/**
 * Proof: does this angle's claim trace to something a customer actually said?
 *
 * An angle with no `source_quotes` AT ALL scores ZERO, not a default — the persona file is
 * generated, and an angle asserting a benefit no reviewer voiced is precisely the kind of
 * confident-sounding fiction the claim gate exists to stop. Scoring it neutral would let
 * it outrank a corroborated angle on the other three components.
 *
 * An angle that HAS quotes but whose quotes match no review scores 6, not 0 — and in
 * practice that is the only low outcome this component ever produces, because
 * agents/voice-of-customer writes `source_quotes` for every angle, making the zero branch
 * unreachable on real data. Note also what `reviews` is: Judge.me reviews for THIS handle
 * only (fetchAdReviews). A genuine quote sourced from Reddit therefore scores 6 as well, so
 * this component partly measures which SOURCE a quote came from rather than whether it is
 * real. Documented rather than changed — the claim gate, not the score, is what decides
 * whether a quote may be used.
 */
export function scoreProof(angle, reviews = []) {
  const quotes = (angle?.source_quotes || []).map(normalize).filter(Boolean);
  if (!quotes.length) return 0;
  // Joined with three spaces, not one: normalize() collapses whitespace WITHIN each
  // review, so a single-space join would let an 8-word head match span the boundary
  // between two adjacent reviews — crediting a sentence no single customer ever said.
  // Three spaces can never collapse into a plausible mid-sentence gap, so a head can
  // only match if it survives inside one review.
  const corpus = reviews.map(r => normalize(r?.body ?? r)).join('   ');
  // A quote counts when a substantial run of it survives into a real review. Full quotes
  // are often lightly trimmed by the persona writer, so match on the first 8 words.
  const hit = quotes.some(q => {
    const head = q.split(' ').slice(0, 8).join(' ');
    return head.length > 12 && corpus.includes(head);
  });
  return hit ? MAX.proof : 6;
}

/**
 * Commercial: is this product's cluster actually earning?
 *
 * IT READS `product_revenue_all_channels` — what the CATEGORY SOLD. Migrated 2026-09-21
 * from `c.revenue`, the 28-day entry-page figure, which was a stated deferral from
 * 2026-08-23 rather than an oversight. The deferral named two conditions and both are met
 * here: the field moves AND the ceiling is re-derived in the same change, below.
 *
 * WHY ALL-CHANNEL RATHER THAN ORGANIC. This score decides whether to spend on an AD for a
 * product, and an ad is not organic search. The question is whether the category sells at
 * all, which is what the all-channel figure means; judging an ad brief on organic-only
 * revenue is the same category error that had `soap` read $0 while it was selling.
 *
 * THE WINDOW IS UNCHANGED, DELIBERATELY. This still reads `clusters[]`, the report's own
 * 28-day view, not the 90-day `clusters_product_wide[]` the $0-cluster gate judges on. One
 * axis per change: the gate needs 90 days because a $0 at 28 is noise (a genuinely selling
 * category records zero 37% of the time at 28 days), but this never produces a $0 VERDICT
 * — it produces an ordering, and an ordering may be noisy without destroying anything.
 * Moving the window as well would make the ceiling re-derivation below unattributable.
 * That said, at ~22 all-channel orders per 28 days a category's slice is a handful of
 * orders, so treat a single report's ordering as directional.
 *
 * MOMENTUM IS A SIGN TEST ON THE ORGANIC SUB-SERIES, and that mismatch is deliberate.
 * `product_organic_revenue_delta` is the ONLY product-basis delta the report emits, so
 * pairing it with an all-channel level is the only option that stays on the product basis
 * at all. It is safe because nothing reads its MAGNITUDE — `growing` asks `> 0` and
 * `hasMomentum` asks `!== 0`. Reading the entry-page `revenueDelta` instead would put the
 * momentum term back on the basis this change exists to leave.
 *
 * THE CEILING IS DERIVED IN ORDERS, NOT DOLLARS, so it survives an AOV re-measurement and
 * a change of basis without silently re-tuning itself. Measured on the live 2026-09-20
 * report (28 days, all channels): the store took **22 orders** across 6 clusters —
 * lotion 8, toothpaste 6, soap 5, deodorant 3, lip balm 0, coconut oil 0.
 *
 * The floor is already fixed elsewhere: CLAUDE.md derives "one average order per 28 days"
 * as the materiality rate below which a category is not yet a channel. The ceiling is the
 * other end — where MORE revenue should stop buying rank, because the category is already
 * unambiguously the leading one. **A category taking a THIRD of the store's orders in the
 * window is that category**, which at 22 orders is 7.3; `CEILING_ORDERS` is 7.5, the
 * nearest clean number. Re-derive it if store volume moves materially, the same way
 * `MIN_WINDOW_ORDERS` is re-derived.
 *
 * Why a share rather than the observed maximum: the top cluster today sits at 8 orders, so
 * a ceiling fitted to it would be overfitted to one report and would saturate the leader
 * every time by construction. A share says something durable about what the ceiling MEANS.
 *
 * BLAST RADIUS, computed on that report — and the middle column is the one that vindicates
 * the deferral, so read all three. Revenue-term points out of 20, before the growth bonus:
 *
 *                  OLD ($200, entry-page)   NAIVE SWAP ($200, product)   NEW ($410, product)
 *   lotion              10.7                    20.0  SATURATED              16.7
 *   soap                20.0  SATURATED         20.0  SATURATED             16.0
 *   toothpaste          11.7                     9.3                         4.5
 *   deodorant            0.0                     3.4                         1.7
 *   lip balm             0.0                     0.0                         0.0
 *   saturated            1 of 5                  2 of 5                      0 of 5
 *
 * So migrating the FIELD ALONE would have doubled saturation and made the store's two
 * leading categories indistinguishable at 20/20 — exactly the flattening the 2026-08-23
 * deferral predicted, which is why it insisted the ceiling move in the same change. With
 * the ceiling re-derived nothing saturates and the spread is monotone in what the category
 * actually sold. Final scores including the +5 growth bonus: soap 21, lotion 17,
 * toothpaste 10, deodorant 2, lip balm 0.
 *
 * Matched loosely against seo-impact's cluster names, which are human phrases ("body
 * lotion") rather than handles. A product with no matching cluster scores NEUTRAL — new
 * products and products the SEO side has never covered must not be ranked last for having
 * no history.
 *
 * NO MATCH AND A MATCH THAT CARRIES NO SIGNAL SCORE THE SAME, AND MUST. A matched cluster
 * set with zero total revenue AND no momentum in either direction is treated as NO-SIGNAL
 * and scores the same neutral as no match: $0 attributed revenue means the attribution has
 * nothing to say, not that the product is commercially worthless. `coconut oil` is the
 * live example — RSC ships no coconut-oil product, so its product revenue is structurally
 * absent forever and every product field on that row is `undefined`.
 *
 * GENUINE NEGATIVE MOMENTUM IS NOT COVERED BY THAT AND MUST NOT BE. A cluster can carry $0
 * revenue in the window and still report a real delta — `lip balm` on the live report is
 * exactly this: all-channel $0 with an organic delta of -60, meaning the window that just
 * closed earned less than the one before it. That is evidence, not silence, and laundering
 * it into the same neutral as "we have no idea" would hide a real decline behind a shrug.
 * So the NO-SIGNAL branch fires only when NOTHING moved; the moment any match carries a
 * nonzero delta, control falls through and it scores at the bottom of the range, distinctly
 * below the neutral. Ranked low, not laundered.
 *
 * `tests/lib/ad-brief-score.test.js` pins the basis, the derivation and the blast radius,
 * so a later field rename cannot quietly move it back.
 */
export function scoreCommercial(productHandle, seoImpact) {
  const clusters = seoImpact?.clusters;
  if (!Array.isArray(clusters) || !clusters.length) return COMMERCIAL_NEUTRAL;
  const words = normalize(productHandle).split(' ').filter(w => w.length > 3);
  const matches = clusters.filter(c => {
    const name = normalize(c.cluster);
    return words.some(w => name.includes(w));
  });
  if (!matches.length) return COMMERCIAL_NEUTRAL;
  const revenue = matches.reduce((sum, c) => sum + (Number(c.product_revenue_all_channels) || 0), 0);
  const delta = c => Number(c.product_organic_revenue_delta) || 0;
  const growing = matches.some(c => delta(c) > 0);
  const hasMomentum = matches.some(c => delta(c) !== 0);
  if (revenue === 0 && !hasMomentum) return COMMERCIAL_NEUTRAL;
  // 20 pts of revenue saturating at the ceiling, 5 for a cluster that is growing.
  const earned = Math.min(revenue, REVENUE_CEILING_USD) / REVENUE_CEILING_USD * REVENUE_POINTS;
  return clamp(Math.round(earned + (growing ? 5 : 0)), MAX.commercial);
}

export function scoreHeadroom(awareness) {
  return HEADROOM_BY_AWARENESS[awareness] ?? 0;
}

/** Every component is returned, never just the total — a score with hidden parts is a black box. */
export function scoreBrief({ persona, angle, reviews = [], productHandle, seoImpact } = {}) {
  const parts = {
    persona: scorePersona(persona),
    proof: scoreProof(angle, reviews),
    commercial: scoreCommercial(productHandle, seoImpact),
    headroom: scoreHeadroom(angle?.awareness),
  };
  return { ...parts, total: parts.persona + parts.proof + parts.commercial + parts.headroom };
}
