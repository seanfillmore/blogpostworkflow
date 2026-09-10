/**
 * Shared prompt blocks for generated PDP gallery frames.
 *
 * These were written inline in scripts/build-lotion-carousel.mjs and are now
 * shared, because the second product's build script would otherwise have been a
 * hand-copy — the drift this repo already documents for AWARENESS_LEVELS and
 * HEALTH_CLAIM_PATTERNS. The NO_PROPS block in particular is the thing the
 * operator rejected a whole frame set over; a divergent second copy of it is how
 * ivy comes back.
 *
 * What each block owns:
 *   NO_PROPS  — the background/props ban. The v1 lotion frames grew ivy, a wood
 *               slice and a wavy wall because the REFERENCE PHOTOS carried them;
 *               the fix is prop-free references AND this instruction, not either
 *               alone.
 *   IDENTITY  — the house look, so a set holds together without repeating a
 *               composition.
 *   sharedRequirements() — mobile-first legibility, exact-text rendering, and the
 *               anti-fabrication rules (no invented testimonials, review counts,
 *               ratings, press logos, certifications or scarcity) adopted from
 *               the Kenyon article in PR #844.
 *
 * SMALL-PRODUCT RULE: when the product renders small in frame, fine label text
 * cannot be resolved and the model confabulates a plausible substitute — "250ml"
 * and "238ml" both appeared on a 236ml product. `blankFineTextRule()` tells it to
 * leave those regions EMPTY instead. An empty band is right; an invented number
 * is a product-accuracy failure.
 */

export const NO_PROPS = `BACKGROUND AND PROPS — a hard requirement:

Render the product on a PLAIN, SEAMLESS, UNCLUTTERED background — clean white or a very light neutral grey, with a soft realistic contact shadow beneath it.

Do NOT include, anywhere in the frame: house plants, pothos, ivy, trailing vines, leaves or foliage of any kind; wood, wooden slices, wooden risers, tree stumps, bark or cutting boards; wavy, rippled, fluted, panelled or textured walls; stacked stones or pebbles; loofahs, towels, sponges or woven baskets; marble slabs or stone counters. No botanical styling of any kind. The frame contains the product, the typography, and empty space.`;

export const IDENTITY = `VISUAL IDENTITY, identical across the set: bright, even, soft studio daylight; a plain seamless white or very pale neutral ground; a soft grounded contact shadow; near-black clean modern geometric sans-serif typography; generous white space. Consistency comes from this identity and from the product being IDENTICAL in every frame — never from repeating a composition. Each frame is a different layout.`;

export function sharedRequirements() {
  return `${IDENTITY}

${NO_PROPS}

SHARED REQUIREMENTS: One main selling idea. Square 1:1. Mobile-first hierarchy — the largest text must be readable at thumbnail size on a phone. Keep all essential content comfortably inside the edges. Render every text string EXACTLY as written, spelled correctly, with no extra words, no invented copy, no watermark and no signature. Do NOT invent testimonials, review counts, star ratings, press logos, certifications, awards, badges, scarcity or before-and-after evidence. Produce one finished square image, not a collage of alternatives.`;
}

export function blankFineTextRule() {
  return `BECAUSE THE PRODUCT RENDERS SMALL HERE, FINE LABEL TEXT MUST NOT BE INVENTED. At this scale the volume line and the small circular badge cannot be resolved, and previous renders filled them in with values that were simply wrong. So: render the volume band as a PLAIN SOLID BAND WITH NO TEXT IN IT AT ALL, and the small circular badge as a plain thin outline circle with no text inside. The brand name and the product name stay and must be correct. An empty band is right; an invented number is a product-accuracy failure.`;
}
