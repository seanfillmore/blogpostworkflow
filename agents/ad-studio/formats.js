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
// Sean's spec, after inspecting that plate: the right number of units of the product, on a
// ground that suits the format, with no ad furniture. He sets type and icons in Photoshop;
// the model's job is a correct product and clean space to set type onto.
//
// A plateBrief must NOT name a unit count either — it says "the product", never "a single
// bottle". How many units belong in the frame is a property of the PRODUCT, not of the
// format: four of eleven RSC products are genuinely multi-unit (foam-soap-bundle is three
// bottles, coconut-oil-lip-balm four tubes, both starter sets two and three items), so a
// count baked in here would reject every correct render of them. render.js emits the count
// clause from product.unitCount instead.
//
// A PLATE MAY HAVE A SCENE WHERE ONE MESHES (Sean, 2026-08-15). The first cut of this
// flattened all six formats onto a plain studio ground, which threw away the thing
// `problem-aware` and `top-x-review` are for — an everyday moment and an editorial
// flat-lay. That was an over-correction: what put a coconut and a wood slice on that plate
// was the FINISHED-AD FURNITURE the layout brief described (a row of ingredient cut-outs),
// not the existence of a setting.
//
// So `plateSetting` decides, per format:
//
//   'studio' — a plain, even ground and nothing else. The product is the only object.
//   'scene'  — a coherent real-world setting the product plausibly sits in, with ordinary
//              incidental objects allowed.
//
// In BOTH settings a plateBrief may never name: ad furniture (columns, rules, pills, bars,
// badges, icons, checklists, headlines), ingredient or botanical styling (a coconut, a
// sprig, a scattering of seeds — that is artwork the operator places, and it is literally
// what went wrong), or a unit count. A scene is a PLACE, not ingredient styling.
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
    plateSetting: 'studio',
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
    plateSetting: 'studio',
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
    zones: ['headline', 'rows', 'bottomBar'],
    // REBUILT 2026-08-16. Sean, on the first live comp: "way too cluttered and is not an
    // effective ad." He was right, and the layoutBrief was the cause.
    //
    // It asked for a small label on the LEFT paired with a large phrase on the RIGHT,
    // four times, plus a headline, plus a subhead, plus a boxed closer — SEVEN competing
    // text blocks, about a dozen lines, all in one red at one weight. It read as a spec
    // sheet, the left labels (WATER / FILM / ABSORB / SIX) carried no meaning on their
    // own, and the product ended up physically overlapped by the middle rows instead of
    // sitting under them.
    //
    // A manifesto is ONE assertion said plainly. So: no label column, three short lines
    // instead of four long ones, the subhead and the boxed closer both gone, and the
    // product given clear space of its own. Three text blocks, not seven.
    //
    // 3, and the brief demands the lines be SHORT. The old cap of 4 was about how many
    // rows fit; the real constraint was never the count, it was the words per row —
    // "MOSTLY WATER, MINERAL OIL, AND A THICKENER" wrapped to three lines by itself.
    zoneCapacity: { rows: 3 },
    layoutBrief: [
      `An almost entirely typographic letterpress-style poster on ${SAND}, modern and clean rather than rustic.`,
      'One very large stacked headline across the top, at most two lines, in a deep warm brick red.',
      'Beneath it three short declarative lines, stacked and left-aligned, each on its own line and separated',
      'by a thin horizontal rule running the full width.',
      'Each of those lines is a SHORT phrase of no more than five or six words that fits on ONE line —',
      'they are statements, not sentences, and there is no label or category word beside them.',
      'The product sits at the bottom centre, clearly visible and completely clear of the type,',
      'with the lowest rule above it and nothing overlapping it.',
      'One restrained line of small letterspaced caps runs across the very bottom.',
    ].join(' '),
    // productProminent stays FALSE even though the 2026-08-16 rebuild enlarged the product.
    // The flag is permission for the gate to DEMAND the label back, not a claim about
    // size; leaving it false costs nothing and keeps the lenient path. The volume is still
    // checked on every format regardless (volumeVerdict).
    // A letterpress poster is typography on a flat ground; a setting would fight it.
    plateSetting: 'studio',
    plateBrief: [
      `A flat, evenly lit warm sand ${SAND} ground filling the whole frame, no texture and no vignette.`,
      'The product stands upright at the bottom centre, resting on the surface, occupying roughly the bottom',
      'third of the frame — understated, but large enough to read clearly at phone size.',
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
    // The whole point of this format is the everyday moment, so its plate KEEPS the setting.
    // A room is not what went wrong on 2026-08-15 — a row of ingredient cut-outs was.
    plateSetting: 'scene',
    plateBrief: [
      'A calm, real domestic setting shot like clean editorial lifestyle photography: a plain bathroom',
      'counter or bedside table in soft daylight, shallow depth of field, muted and uncluttered.',
      'The product stands upright in the lower right at moderate scale — present but not dominant,',
      'occupying about a quarter of the frame height, resting naturally on the surface.',
      'The upper two-thirds of the frame is quiet, evenly lit wall or air with nothing in it, so type can be',
      'set over it later.',
      'No people and no hands.',
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
    // A roundup reads as editorial because of how it is SHOT, not because of what is
    // scattered around it — so the plate keeps the surface and the light, not a prop pile.
    plateSetting: 'scene',
    plateBrief: [
      'A magazine-style editorial still life on a plain matte surface — pale stone, paper or painted wood —',
      'in soft directional daylight with a gentle natural shadow, generous negative space, restrained and',
      'expensive-looking rather than styled or busy.',
      'The product stands upright, centred left to right, at hero scale, its base on the lower third and its',
      'top reaching about the middle of the frame.',
      'The upper third of the frame is clear and empty, reserved for type that is added later.',
      'No competitor packaging and no award marks.',
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
    // Premium CPG product photography IS a clean ground — that is the format's whole look.
    plateSetting: 'studio',
    plateBrief: [
      `A clean warm sand ${SAND} ground filling the whole frame, lit like premium CPG product photography.`,
      'The product stands upright in the lower right of the frame at hero scale, its base on the lower third,',
      'with a soft contact shadow.',
      'The top of the frame and the left side are empty ground. Nothing else appears in the picture.',
    ].join(' '),
  },

  // ── Added 2026-08-15 from reference creatives Sean collected ──────────────────────
  //
  // Three shapes the rotation had no answer for, taken from ads that are running:
  // Bonafide (quote-led), Magic Spoon and MUD\WTR (stats radiating off a centred hero),
  // and a kids' supplement ad that contrasts a before state with an after state.
  //
  // STYLE ONLY (Sean, 2026-08-15). Several of those references have visibly garbled
  // machine-generated label text — "Zaro Sugar", "Het Flash Relief", "tummy discomrfort"
  // shipped in a live ad. We are reading their LAYOUT and their ANGLE, never their copy,
  // and that garbling is itself the argument for plate-first: they baked type into the
  // render and it broke.
  {
    key: 'testimonial',
    name: 'Testimonial / customer quote',
    awareness: 'problem',
    pairsImagesWithLabels: false,
    // The quote dominates and the product sits small beneath it, exactly as in the
    // reference. Not label-legible, so the gate must not demand the label back — same
    // reasoning as manifesto. The volume is still checked on every format.
    productProminent: false,
    // "headline" IS the quote here. Every format carries a headline zone; naming this one
    // "quote" would break that invariant for no gain.
    zones: ['headline', 'attribution', 'trustLine'],
    layoutBrief: [
      `A large opening quotation mark at the top, then a customer quote set very large across the upper half,`,
      `black on white, the most emotive phrase in heavier weight than the rest.`,
      'Beneath it the attribution on its own line, smaller and grey.',
      'The product stands centred in the lower third at modest scale.',
      'A short line of third-party credibility sits beside it, with a row of stars.',
      'THE QUOTE MUST BE A REAL CUSTOMER REVIEW, quoted verbatim from the reviews source — never written.',
      'A supplement disclaimer is required in the finished ad and is set by hand at the very bottom.',
    ].join(' '),
    // The quote needs a lot of quiet white space above the product, and the credibility
    // line needs room beside it.
    plateSetting: 'studio',
    plateBrief: [
      `A flat, evenly lit warm sand ${SAND} ground filling the whole frame.`,
      'The product stands upright, centred left to right, small and low — its base on the lower fifth and',
      'its top reaching no higher than a third of the way up the frame.',
      'The whole upper two-thirds is empty ground. Nothing else appears in the picture.',
    ].join(' '),
  },
  {
    key: 'stat-stack',
    name: 'Stat stack / annotated hero',
    awareness: 'solution',
    pairsImagesWithLabels: false,
    // "clearly the hero, centred" at full size — the label is the point of the frame.
    productProminent: true,
    zones: ['headline', 'stats', 'bottomBar'],
    // Four short stats, one per corner around a centred hero. The references run four
    // (MUD\WTR) to six (Magic Spoon); six crowds a phone-width frame and the fifth and
    // sixth end up overlapping the product.
    zoneCapacity: { stats: 4 },
    layoutBrief: [
      'A short benefit headline across the top, then the product standing centred as the hero at full size,',
      'lit like premium product photography with a soft contact shadow.',
      'Four short stats sit around it, one per corner, each a large number or figure above a small caption,',
      'and each joined to the product by a hand-drawn curved arrow.',
      'A solid bar across the very bottom carries one line of letterspaced caps.',
      'Every stat must be a figure quoted from a named source — never an invented number.',
    ].join(' '),
    plateSetting: 'studio',
    plateBrief: [
      `A flat, evenly lit warm sand ${SAND} ground filling the whole frame.`,
      'The product stands upright, centred both left to right and top to bottom, at hero scale, occupying',
      'roughly the middle third of the frame with a soft contact shadow.',
      'Wide, even margins of empty ground surround it on all four sides.',
      'Nothing else appears in the picture.',
    ].join(' '),
  },
  {
    key: 'state-contrast',
    name: 'State contrast (before / after)',
    awareness: 'problem',
    pairsImagesWithLabels: false,
    productProminent: true,
    zones: ['headline', 'subhead', 'beforeLabel', 'afterLabel', 'bottomBar'],
    // COMPLIANCE, and it is the reason this format is shaped the way it is. Meta's health
    // and beauty policy prohibits before-and-after imagery, and problem-aware's own
    // layoutBrief already encodes that rule for this catalogue. The reference ad gets away
    // with the shape because its two states are CARTOON ILLUSTRATIONS, not photographs of
    // a body.
    //
    // So the contrast here is illustrated and it is about the EXPERIENCE, never the skin:
    // no body, no face, no photographic skin, no depiction of a condition. And because the
    // illustrations are artwork, the operator draws them in Photoshop — which means this
    // format's plate is simply the product with the two state areas left empty.
    layoutBrief: [
      'A two-state contrast reading left to right: a "before" state on the left, a chevron or arrow in the',
      'middle, and an "after" state on the right, each drawn as a simple flat illustration with a short label.',
      'A bold headline sits across the top with a supporting line beneath it.',
      'The product stands centred and lower, between the two states, at full size.',
      'A bar across the bottom carries short benefit phrases.',
      'The two states illustrate the EXPERIENCE — a routine, a moment, a feeling — as flat illustration only.',
      'NEVER a photograph of skin, a body, a face, or any depiction of a skin condition: before-and-after',
      'imagery of a person is prohibited in health and beauty and will have the ad rejected.',
    ].join(' '),
    plateSetting: 'studio',
    plateBrief: [
      `A flat, evenly lit warm sand ${SAND} ground filling the whole frame.`,
      'The product stands upright, centred left to right, its base on the lower third and its top reaching',
      'about the middle of the frame.',
      'Wide areas of empty ground sit to the left and to the right of it, and across the top.',
      'Nothing else appears in the picture.',
    ].join(' '),
  },
];

// A format with no plateBrief must not silently fall back to layoutBrief — that fallback
// IS the bug this field exists to fix, and it would come back the first time someone adds
// a seventh format and only fills in the finished-ad brief. Load-time, so it cannot be
// discovered halfway through a paid run.
export const PLATE_SETTINGS = ['studio', 'scene'];

for (const f of FORMATS) {
  for (const field of ['layoutBrief', 'plateBrief']) {
    if (!String(f[field] || '').trim()) throw new Error(`ad-studio format "${f.key}" is missing ${field}`);
  }
  // No default. 'studio' would silently strip the setting off a format that wants one and
  // 'scene' would silently license props on one that does not; both are decisions, and a
  // default is how a decision gets made by nobody.
  if (!PLATE_SETTINGS.includes(f.plateSetting)) {
    throw new Error(`ad-studio format "${f.key}" needs plateSetting: one of ${PLATE_SETTINGS.join(' | ')}`);
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
