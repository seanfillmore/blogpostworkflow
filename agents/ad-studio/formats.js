// agents/ad-studio/formats.js
//
// The v1 ad-format rotation. A batch renders one concept per format so it cannot
// collapse into six variants of one idea.
//
// This table is DATA. Adding a seventh format is a new entry plus its layoutBrief and its
// plateBrief — never a code change anywhere else.
//
// pairsImagesWithLabels drives the verification gate: layouts that sit a picture
// beside a word can render every word correctly and still caption jojoba oil as
// coconut oil, so those get a semantic pairing check on top of the text diff.
//
// productProminent answers ONE question: does this layout render the product large
// enough that a vision model can read the text printed on its label?
//
// It is a LEGIBILITY declaration, not a statement about how much the product matters.
// index.js folds product.labelStrings (the brand mark, the product type, the variant
// name) into the verify gate's expected-text list, and the gate fails — and retries, at
// ~$0.13 a render — whenever an expected string cannot be transcribed. Two of these
// layouts put the product on screen deliberately tiny: manifesto renders it "small and
// understated at the bottom center, sitting on the surface like a signature",
// problem-aware "present but not dominant". Requiring a 6pt brand mark to be read back
// off those is the same unsatisfiable expectation as the badge arc micro-copy, which
// cost five fix rounds and three burned renders per target before it was removed.
//
// The render prompt still names labelStrings for EVERY format (render.js's fidelity
// block) — the model is always told exactly what the label says, so it still cannot
// invent a volume. This flag only decides whether the gate demands to read it back.
//
// NARROWED 2026-08-14. This flag used to switch the label check OFF ENTIRELY, which is
// how a manifesto frame shipped with "4 FL oz / 118ml" printed on an 8 fl. oz. bottle:
// the volume was not merely un-demanded, it was un-checked. The VOLUME MARKING is now
// verified on every format regardless of this flag, in a shape that tolerates
// illegibility but not falsehood — the verifier answers with the volume it can read or
// with ILLEGIBLE, and only a value that CONTRADICTS the real one fails (see
// verify.js's volumeVerdict and index.js's expectedForFormat). The flag survives
// because the rest of the label genuinely cannot be read at signature size; do not
// widen it back into an off switch for the volume.
//
// layoutBrief describes the FINISHED ADVERTISEMENT — every column, rule, pill, bar and
// ingredient cut-out. plateBrief describes the AD BASE: the ground the product stands on
// and the size and position it occupies. They are separate fields because the plate used
// to inherit layoutBrief, and that is how a 1:1 plate came back with wood slices,
// greenery, a coconut and a second half-faded bottle (2026-08-15).
//
// The plate prompt did say "leave that area EMPTY and clean", but a negative instruction
// loses to a vivid positive one: `ingredient-callout`'s layoutBrief asks in so many words
// for "a small photorealistic cut-out image of that ingredient", and `problem-aware`'s for
// "the everyday moment where the problem shows up". The model rendered what it was told to
// render. The fix is to stop telling it — not to shout the negation louder.
//
// Sean's spec, after inspecting that plate: exactly ONE unit of the product, on a clean
// ground, no props, no scene dressing. He sets type and icons in Photoshop; the model's
// job is a correct product and clean space, nothing else. So a plateBrief may name only:
// the ground and its colour, and where the product sits and at what scale. It may NOT name
// a prop, an ingredient, a surface texture that reads as a set, or any element the
// finished ad would carry as artwork.
//
// A plateBrief must NOT name a unit count either — it says "the product", never "a single
// bottle". How many units belong in the frame is a property of the PRODUCT, not of the
// format: four of eleven RSC products are genuinely multi-unit (foam-soap-bundle is three
// bottles, coconut-oil-lip-balm four tubes, both starter sets two and three items), so a
// count baked in here would reject every correct render of them. render.js emits the count
// clause from product.unitCount instead.
//
// The consequence is deliberate and worth knowing: at PLATE level the six formats differ
// only in product scale, product position and ground tone. `problem-aware` and
// `top-x-review` lose the lifestyle/flat-lay staging they describe as finished ads. That
// staging is what the props came from, and none of it survives contact with "no scene
// dressing".
//
// zoneCapacity (optional) caps how many strings an array-valued zone may carry,
// keyed by the layoutBrief's own physical description of that zone — a "vertical
// list running down one side" or "cells split by thin vertical rules" only has room
// for so many rows/cells before the image model silently drops or rewrites the
// overflow. copy.js's buildCopyPrompt surfaces the cap as an instruction and
// enforceZoneCapacity truncates to it as a backstop. Formats with no list-shaped
// zone omit the key entirely.

const SAND = '#EDE5D8';
const BLACK = '#000000';
const GREEN = '#AEDEAC';
const GREY = '#EDEDED';

export const FORMATS = [
  {
    key: 'us-vs-them',
    name: 'Us vs them',
    awareness: 'solution',
    pairsImagesWithLabels: true,
    // "the product standing centered between the columns as the hero" — full-size.
    productProminent: true,
    zones: ['headline', 'leftHeader', 'leftItems', 'rightHeader', 'rightItems', 'bottomBar'],
    // leftItems/rightItems are paired rows (X icon vs check icon) — a phone-width two-
    // column comparison reads cleanly up to about 4 rows per side before it either
    // overflows the frame or crowds the centered product hero. bottomBar here is a
    // single letterspaced line, not a list, so it takes no cap.
    zoneCapacity: { leftItems: 4, rightItems: 4 },
    layoutBrief: [
      `A big two-line headline across the top third, black on a warm sand ${SAND} background.`,
      'Beneath it a two-column comparison with the product standing centered between the columns as the hero,',
      'lit like premium product photography with a soft contact shadow.',
      `The left column lists what conventional products do, each row led by a bold ${BLACK} X icon.`,
      `The right column lists what this product does, each row closed by a soft green ${GREEN} check icon.`,
      'Above each column sits a solid black rounded pill holding that column header in reversed type.',
      'A solid black bar runs across the very bottom holding one line of letterspaced caps.',
    ].join(' '),
    // Finished, the columns flank the product. On the base they are empty space.
    plateBrief: [
      `A flat, evenly lit warm sand ${SAND} ground filling the whole frame.`,
      'The product stands upright, centred left to right, its base sitting on the lower third and its',
      'top reaching about the middle of the frame, so the upper third is entirely clear.',
      'Nothing else appears in the picture.',
    ].join(' '),
  },
  {
    key: 'ingredient-callout',
    name: 'Ingredient callout',
    awareness: 'solution',
    pairsImagesWithLabels: true,
    // "The product stands large on the opposite side as the hero" — full-size.
    productProminent: true,
    zones: ['headline', 'subhead', 'listItems', 'bottomBar'],
    // This is the format the real incident happened on. listItems is a vertical list
    // running down HALF the frame opposite the hero product — 4 image+label rows is
    // what that half actually has room for (a 6-item ask was asked for and only 4
    // rendered, silently). bottomBar is a strip split into equal cells by vertical
    // rules — at phone width, more than 3 short phrases makes the cells too narrow to
    // set cleanly, which is what made the model rewrite/drop cells rather than render
    // the requested 4.
    zoneCapacity: { listItems: 4, bottomBar: 3 },
    layoutBrief: [
      `A bold two-line headline at the top, the first line black and the second in a warm gold, on a soft ${SAND} gradient.`,
      'A thin black rule under the headline.',
      'Below it a vertical list of ingredients running down one side, each row pairing a small photorealistic',
      'cut-out image of that ingredient with its label.',
      'The product stands large on the opposite side as the hero, lit to match, with a soft contact shadow.',
      `A ${GREY} strip across the bottom split by thin vertical rules into equal cells, one short phrase per cell.`,
    ].join(' '),
    // This is the format the props incident happened on. NOTHING about ingredients here —
    // the ingredient row is placed by hand, and naming it is what produced the coconut.
    plateBrief: [
      `A soft warm sand ${SAND} gradient filling the whole frame, smooth and free of texture.`,
      'The product stands upright on the RIGHT side of the frame, large, its base on the lower third and its',
      'height filling roughly the middle half of the frame.',
      'The entire left side and the top of the frame are empty ground.',
      'Nothing else appears in the picture.',
    ].join(' '),
  },
  {
    key: 'manifesto',
    name: 'Manifesto / negative framing',
    awareness: 'problem',
    pairsImagesWithLabels: false,
    // "small and understated at the bottom center, sitting on the surface like a
    // signature" — the label is not legible at that size, so it is not gated.
    productProminent: false,
    zones: ['headline', 'subhead', 'rows', 'closer'],
    // rows are full-width typographic lines separated by rules on a poster-style
    // layout — each one is visually heavy (label + a large phrase), so the format
    // reads as a manifesto rather than a list only while it stays short. 4 rows is
    // about what a single poster frame can hold before it stops feeling like a
    // manifesto and starts feeling like a spec sheet. closer is one line in a box, not
    // a list, so it takes no cap.
    zoneCapacity: { rows: 4 },
    layoutBrief: [
      `An almost entirely typographic letterpress-style poster on ${SAND}, modern and clean rather than rustic.`,
      'A very large stacked headline, then a smaller line beneath it.',
      'Then a series of rows separated by thin horizontal rules, each row pairing a small label on the left',
      'with a large phrase on the right set in a deep warm brick red.',
      'A closing line sits inside a thin rectangular box near the bottom.',
      'The product appears small and understated at the bottom center, sitting on the surface like a signature.',
    ].join(' '),
    // productProminent: false — the plate reproduces that signature scale, so the volume
    // marking will read ILLEGIBLE here and volumeVerdict will pass it. That is intended.
    plateBrief: [
      `A flat, evenly lit warm sand ${SAND} ground filling the whole frame, no texture and no vignette.`,
      'The product sits small and understated at the bottom centre, resting on the surface like a signature,',
      'occupying only the bottom fifth of the frame.',
      'Everything above it is empty ground. Nothing else appears in the picture.',
    ].join(' '),
  },
  {
    key: 'problem-aware',
    name: 'Problem-aware educational',
    awareness: 'problem',
    pairsImagesWithLabels: false,
    // "the product present but not dominant" in a lifestyle scene — not label-legible.
    productProminent: false,
    // No list-shaped zone — bottomBar is "a single restrained line of caps", so
    // zoneCapacity is omitted.
    zones: ['headline', 'subhead', 'bottomBar'],
    layoutBrief: [
      'An editorial, educational-feeling composition that reads as information rather than promotion.',
      `A curiosity-driven headline occupies the upper third on a ${SAND} background, with a supporting line beneath it.`,
      'The scene shows the everyday moment where the problem shows up, shot like clean lifestyle photography,',
      'with the product present but not dominant.',
      'A single restrained line of caps runs across the bottom.',
      'No before/after split and no depiction of a skin condition — those are restricted in health and beauty.',
    ].join(' '),
    // The "everyday moment where the problem shows up" is a SCENE, and a scene is what a
    // plate may not have. The editorial feel has to come from the type the operator sets.
    plateBrief: [
      `A flat, evenly lit warm sand ${SAND} ground filling the whole frame.`,
      'The product stands upright in the lower right of the frame at moderate scale — present but not',
      'dominant, occupying about a quarter of the frame height.',
      'The upper two-thirds and the left side are empty ground.',
      'Nothing else appears in the picture.',
    ].join(' '),
  },
  {
    key: 'top-x-review',
    name: 'Top-X / third-party review',
    awareness: 'solution',
    pairsImagesWithLabels: false,
    // "presented as the standout pick, clearly the hero" on a generous flat-lay — the
    // label is the point of a roundup frame and is rendered legibly.
    productProminent: true,
    // No list-shaped zone — bottomBar is "a restrained line of caps", so
    // zoneCapacity is omitted.
    zones: ['headline', 'subhead', 'bottomBar'],
    layoutBrief: [
      'A magazine-style editorial product layout that reads like a roundup or review rather than an ad.',
      `Clean flat-lay styling on ${SAND}, generous negative space, an evaluative rather than promotional tone.`,
      'A ranking-flavoured headline sits at the top with a credibility line beneath it.',
      'The product is presented as the standout pick, clearly the hero, without any competitor branding,',
      'lookalike packaging, or invented third-party logos, badges or award marks.',
      'A restrained line of caps runs across the bottom.',
    ].join(' '),
    // "Flat-lay styling" is styling, i.e. props, so the plate does not get it. A roundup
    // frame's job at base level is a legible hero with room for the ranking headline.
    plateBrief: [
      `A flat, evenly lit warm sand ${SAND} ground filling the whole frame, generous and uncluttered.`,
      'The product stands upright, centred left to right, at hero scale, its base on the lower third and its',
      'top reaching about the middle of the frame.',
      'The upper third is empty ground. Nothing else appears in the picture.',
    ].join(' '),
  },
  {
    key: 'offer-focused',
    name: 'Offer-focused',
    awareness: 'product',
    pairsImagesWithLabels: false,
    // "The product on a clean background, lit like premium CPG product photography" —
    // it is the frame's largest element after the offer badge.
    productProminent: true,
    // No list-shaped zone — offerBadge is a single badge/ribbon string and bottomBar
    // is "one line of letterspaced caps", so zoneCapacity is omitted.
    zones: ['headline', 'subhead', 'offerBadge', 'bottomBar'],
    layoutBrief: [
      `The product on a clean ${SAND} background, lit like premium CPG product photography with a soft contact shadow.`,
      'A benefit-driven headline sits top-left with a short supporting line beneath it.',
      'The offer is the loudest element after the product: a bold badge or ribbon carrying the offer text,',
      'placed so it reads within a second at phone size.',
      'A solid black bar across the bottom carries one line of letterspaced caps.',
    ].join(' '),
    // The offer badge is the loudest element in the finished ad and is set by hand, so the
    // plate must leave the upper left genuinely empty rather than fill it with product.
    plateBrief: [
      `A clean warm sand ${SAND} ground filling the whole frame, lit like premium CPG product photography.`,
      'The product stands upright in the lower right of the frame at hero scale, its base on the lower third,',
      'with a soft contact shadow.',
      'The top of the frame and the left side are empty ground. Nothing else appears in the picture.',
    ].join(' '),
  },
];

// A format with no plateBrief must not silently fall back to layoutBrief — that fallback
// IS the bug this field exists to fix, and it would come back the first time someone adds
// a seventh format and only fills in the finished-ad brief. Load-time, so it cannot be
// discovered halfway through a paid run.
for (const f of FORMATS) {
  for (const field of ['layoutBrief', 'plateBrief']) {
    if (!String(f[field] || '').trim()) throw new Error(`ad-studio format "${f.key}" is missing ${field}`);
  }
}

const BY_KEY = new Map(FORMATS.map(f => [f.key, f]));

export function formatByKey(key) {
  return BY_KEY.get(key);
}

/**
 * @param {string[]} [keys] format keys, in the order wanted. Falsy/empty → the full rotation.
 * @returns {typeof FORMATS}
 */
export function selectFormats(keys) {
  if (!keys || keys.length === 0) return [...FORMATS];
  return keys.map(k => {
    const f = BY_KEY.get(k);
    if (!f) throw new Error(`unknown format: ${k}`);
    return f;
  });
}
