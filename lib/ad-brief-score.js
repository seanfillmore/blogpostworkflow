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

const MAX = { persona: 30, proof: 25, commercial: 25, headroom: 20 };

/** Neutral commercial score when there is no data. Absence of evidence is not evidence. */
const COMMERCIAL_NEUTRAL = 12;

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
 * Matched loosely against seo-impact's cluster names, which are human phrases ("body
 * lotion") rather than handles. A product with no matching cluster scores NEUTRAL — new
 * products and products the SEO side has never covered must not be ranked last for having
 * no history.
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
  const revenue = matches.reduce((sum, c) => sum + (Number(c.revenue) || 0), 0);
  const growing = matches.some(c => (Number(c.revenueDelta) || 0) > 0);
  // 20 pts of revenue saturating at $200 in the window, 5 for a cluster that is growing.
  return clamp(Math.round(Math.min(revenue, 200) / 10 + (growing ? 5 : 0)), MAX.commercial);
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
