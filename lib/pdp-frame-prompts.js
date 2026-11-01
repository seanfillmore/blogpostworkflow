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

// ── Frame builders: OFFER, PROOF, COMPARE ────────────────────────────────────
// Moved here from scripts/build-pdp-frames-batch2.mjs when the third batch needed
// them, rather than copied. Each takes a product config (offer / proof / compare
// copy, all pre-gated) and the product description to render — which defaults to
// `p.product` but can differ per frame, because a four-pack's offer frame shows
// four units while its proof frame shows one.

export function offerPrompt(p, product = p.product) {
  const checks = p.offer.checks.map(c => `"${c}"`).join(' and ');
  return `Create a premium ecommerce carousel frame whose single job is to state the OFFER.

${product}

LAYOUT: The product sits in the right third of the frame on a plain seamless white ground with a soft contact shadow. The left two thirds carry the offer as clean typography on the same white ground.

EXACT TEXT, rendered precisely and spelled correctly:
- Large bold headline, the biggest element in the frame: "${p.offer.headline}"
- Beneath it, very large: "${p.offer.price}"
- Directly under that, small: "${p.offer.sub}"
- Two short supporting lines lower down, each with a simple thin check mark: ${checks}

No other text anywhere. No sale starbursts, no percentage badges, no urgency banners, no countdown.

${sharedRequirements()}`;
}

// `fineText` overrides blankFineTextRule() for a product whose label does not match
// its assumptions. The default rule tells the model to draw the small circular badge
// as an empty outline — correct for the lotion, soap and deodorant, and WRONG for the
// body cream, which has no badge at all: it duly invented one on the proof frame.
export function proofPrompt(p, product = p.product, fineText = blankFineTextRule()) {
  const attribution = p.proof.label
    ? `- Beneath the quote, smaller: "${p.proof.who}"\n- Directly beneath that, smallest: "${p.proof.label}"`
    : `- Beneath the quote, smaller: "${p.proof.who}" — and NOTHING else. Do not add a verification line, a date, a location or a star count anywhere near it.`;
  return `Create a premium ecommerce carousel frame whose single job is TRUST, built around one real customer quote.

${product}

LAYOUT: A clean editorial layout on a plain seamless white ground. The quote is the hero and sits across the upper two thirds, set large. The product sits smaller in the lower right with a soft contact shadow. Quiet and typographic — no styling props whatsoever.

EXACT TEXT, rendered precisely and spelled correctly:
- A row of exactly five small filled black stars, above the quote.
- The quote, large, in matching curly typographic quotation marks at BOTH ends: "${p.proof.quote}"
${attribution}

THE QUOTE IS A REAL CUSTOMER'S WORDS AND MUST BE REPRODUCED EXACTLY — every word, in order, none dropped, none repeated, none substituted. It is ${p.proof.quote.split(/\s+/).length} words long. Earlier attempts at this frame DROPPED a word ("The unscented an excellent choice" for "The unscented is an excellent choice") and REPEATED one ("The scents are enjoyable enjoyable and not over powering"). Set the quote, then read it back word by word against the line above before finishing. Altering a customer's words is the worst defect this frame can have.

${fineText}

No other text anywhere. Do NOT add a review count, a numeric rating, an average score, a press logo or any badge. Do NOT show a person — no human face or body — because the reviewer must never be portrayed by a generated model.

${sharedRequirements()}`;
}

export function comparePrompt(p, product = p.product, fineText = blankFineTextRule()) {
  const rows = p.compare.rows.map(([a, b], i) => `${i + 1}. "${a}" / "${b}"`).join('\n');
  return `Create a premium ecommerce carousel frame that is a clean two-column comparison chart.

${product}

LAYOUT: A simple, uncluttered two-column table occupying the UPPER TWO THIRDS of the frame on a plain seamless white ground, mobile-optimized, generous spacing, thin light rules only — no heavy boxes, no drop shadows on the table. The product sits small in the BOTTOM THIRD, centred, with a soft contact shadow.

The product must sit ENTIRELY BELOW the table with clear empty space between the table's lowest rule and the top of the product. It must NOT overlap, intersect or sit behind the table. An earlier attempt placed the bottle in the MIDDLE of the table, so the centre column divider ran down through it and it covered the text of the lower rows — never do that. Shrink the product and move it down until the whole table is clear of it.

Left column header: "Real Skin Care". Right column header: "${p.compare.them}".
Left column cells each carry a small green check mark. Right column cells each carry a small grey cross.

EXACT TEXT for the ${p.compare.rows.length === 4 ? 'four' : p.compare.rows.length} rows, rendered precisely and spelled correctly, left cell then right cell:
${rows}

No other text anywhere. Do NOT name, show or imply any competitor brand, logo or packaging. Do NOT add a headline, footnote or call to action.

${fineText}

${sharedRequirements()}`;
}

export const FRAME_BUILDERS = { offer: offerPrompt, proof: proofPrompt, compare: comparePrompt };
