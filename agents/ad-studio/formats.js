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
// requiresGiveaway (optional, default false) marks a format whose copy CANNOT be written
// without a live giveaway to cite. It is not a style flag — it is a sourcing fact. Every
// factual line such a format asks for ("36 bars", "entries close September 14, 2026") can
// only be traced to the `giveaway` source, and that source exists only while an Entry Period
// is open (lib/giveaway-claim-source.js). Offering the format outside that window would spend
// an Opus copy call on an ad the claim gate is guaranteed to reject.
//
// So it is filtered out of the default rotation and out of the awareness join whenever no
// giveaway is running — see visibleFormats() below and formatsForAngle() in
// lib/ad-brief-plan.js. With no giveaway live, FORMATS behaves exactly as it did before this
// flag existed. selectFormats(['giveaway-entry']) still resolves it by name, deliberately:
// naming a format explicitly is an operator decision, and the gate is the right place for
// that decision to fail if it was wrong.
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
    // The product moved to the BOTTOM RIGHT on the second pass. Decluttering alone left it
    // centred, and a centred product under full-width rows collides every time — the comp
    // put the bottle straight through "A film that sits on top". Asking for clearance in
    // words did not work; moving the product out of the column did. LATERAL placement is
    // the instruction this model actually honours (ingredient-callout's "RIGHT side" and
    // problem-aware's "lower right" both held, while every vertical/scale instruction has
    // been ignored), so the fix uses the lever that works rather than repeating the one
    // that does not.
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
      'The product stands in the BOTTOM RIGHT of the frame, clearly visible and completely clear of the type.',
      'The three lines and their rules occupy the LEFT of the frame and stop short of the product —',
      'no line, rule or word crosses it or runs behind it.',
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
      'The product stands upright in the BOTTOM RIGHT of the frame, resting on the surface, occupying roughly',
      'the bottom third of the frame height — understated, but large enough to read clearly at phone size.',
      // THE 9:16 GHOST LABEL, 2026-08-18. This said "The whole left side and the top of the
      // frame are empty ground", and on 9:16 that failed the stray-text gate 3 times out of
      // 3: the model filled the tall upper region with a half-faded DUPLICATE of the product
      // label — "pure unscented", "3.4 oz - 84g", "realskincare.com" floating with no wrapper
      // beneath them. Same ghost-duplicate failure as 2026-08-15, and manifesto is the format
      // most exposed to it because its product is deliberately small, which on the tallest
      // ratio leaves the most unexplained space.
      //
      // The fix is NOT to enlarge the product — being understated is the whole format, and
      // the operator wants that look tested rather than compromised to satisfy a gate. It is
      // to stop describing that region as an ABSENCE. "Empty ground" names a hole and invites
      // the model to fill it; the header's own lesson is that a negative instruction loses to
      // a vivid positive one. So the region is now described as a POSITIVE surface — a
      // continuous, unbroken expanse of the same sand — which is a thing to render rather
      // than a space to populate.
      'Above and to the left of it, that same sand surface continues unbroken to the edges of the frame as one',
      'smooth, uninterrupted expanse — a single continuous field of colour, evenly lit corner to corner.',
      // NOT "the product appears exactly once", which was written here and taken back out:
      // that is a UNIT COUNT, and unit count is a property of the PRODUCT (render.js emits it
      // from product.unitCount), never of the format. Baked in here it would reject every
      // correct render of the four multi-unit products — the foam soap bundle is three
      // bottles, the lip balm four tubes. The test regex does not catch this phrasing; the
      // rule in this file's header does.
      'Nothing else appears in the picture.',
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
  // ── Added 2026-08-18, for the "Win 36 Free Bars" giveaway ────────────────────────────
  //
  // WHY THIS IS A SEPARATE FORMAT AND NOT A TWEAK TO `offer-focused`.
  //
  // offer-focused is a SALES ad: its awareness level is product-aware, its headline is
  // "benefit-driven", and the thing its badge carries is a price. A giveaway ad asks for an
  // ENTRY. Those two ads differ in the only thing that matters about an ad — what it asks
  // the reader to do — so widening offer-focused's briefs to mean either would have made the
  // one format that is currently unambiguous say two things at once, mid-campaign, on a
  // format that is live. This table is DATA and its header says the extension path is a new
  // entry; that is what this is.
  //
  // It sits BEFORE offer-focused so that while a giveaway is running it is the PROPOSED
  // format for a product-aware angle, with offer-focused offered as the alternative. Order
  // is the only thing that decides `proposed` (formatsForAngle takes the first match), and
  // the whole point of the campaign is that the giveaway is the ask.
  //
  // Its zone list is deliberately IDENTICAL to offer-focused's. lib/ad-brief.js's
  // selectableFormats only allows an operator to switch a brief between formats of the same
  // zone shape, so matching it is what turns "flexibility on creatives" into a one-click
  // switch between the entry ad and the sales ad instead of a regenerate. `offerBadge` keeps
  // its name for the same reason: the entry IS the offer here, and renaming it would break
  // that switch for nothing.
  {
    key: 'giveaway-entry',
    name: 'Giveaway entry (lead ad)',
    awareness: 'product',
    // No copy without a live Entry Period to cite — see the header note.
    requiresGiveaway: true,
    pairsImagesWithLabels: false,
    // The product is shot at hero scale on a clean ground, same as offer-focused.
    productProminent: true,
    zones: ['headline', 'subhead', 'offerBadge', 'bottomBar'],
    layoutBrief: [
      `The product on a clean ${SAND} background, lit like premium CPG product photography with a soft contact shadow.`,
      'The headline states the SIZE of the prize and sits top-left, the largest type in the frame, with a short',
      'supporting line beneath it.',
      'The entry call to action is the loudest element after the headline: a bold badge or ribbon carrying it,',
      'placed so it reads within a second at phone size.',
      'A solid black bar across the bottom carries one line of letterspaced caps holding the closing date and',
      'the words NO PURCHASE NECESSARY.',
      'This ad asks for an ENTRY, never a purchase: no price, no discount, no cart, no shipping promise, and',
      "nothing that implies buying improves anyone's chances of winning.",
    ].join(' '),
    // Same reasoning as offer-focused: the loud elements are set by hand, so the plate must
    // leave the top and the left genuinely empty rather than fill them with product.
    plateSetting: 'studio',
    plateBrief: [
      `A clean warm sand ${SAND} ground filling the whole frame, lit like premium CPG product photography.`,
      'The product stands upright in the lower right of the frame at hero scale, its base on the lower third,',
      'with a soft contact shadow.',
      'The top of the frame and the left side are empty ground, and a clear band runs across the very bottom.',
      'Nothing else appears in the picture.',
    ].join(' '),
    // FIVE DELIBERATE TREATMENTS, added 2026-08-18 for the giveaway launch.
    //
    // `--variations 5` on its own re-renders the SAME brief five times and buys only seed
    // noise: the ground colour and the product's scale and position are written into the
    // brief, so they cannot differ between variations. These are the axes an operator
    // actually wants to test on a lead ad, so they are DATA — one entry per treatment,
    // cycled by variation index (formatForVariation below).
    //
    // WHAT IS NOT HERE, and cannot be: TEXT COLOUR. A plate carries no text. Type is set in
    // Photoshop, so the headline's colour is an operator decision made after this stage —
    // what a plate can offer is a GROUND that makes a given text colour work, which is why
    // these run light-to-dark and include one high-contrast dark treatment. Do not add a
    // "text colour" variant here; it would describe something the render cannot contain.
    //
    // Grounds stay inside the brand palette (brand-kit.json's palette_hexes: black, sand,
    // green, grey) — a giveaway ad is still a brand ad, and inventing a sixth colour here
    // would put an off-brand frame into the one campaign that reaches cold audiences.
    // Each keeps its own empty region for type, and each still ends with the studio rule.
    plateVariants: [
      {
        key: 'sand-hero',
        plateBrief: [
          `A clean warm sand ${SAND} ground filling the whole frame, lit like premium CPG product photography.`,
          'The product stands upright in the lower right of the frame at hero scale, its base on the lower third,',
          'with a soft contact shadow.',
          'The top of the frame and the left side are empty ground, and a clear band runs across the very bottom.',
          'Nothing else appears in the picture.',
        ].join(' '),
      },
      {
        key: 'sand-large-centered',
        plateBrief: [
          `A clean warm sand ${SAND} ground filling the whole frame, evenly lit.`,
          'The product stands upright, centred left to right, LARGE — its base on the lower third and its top',
          'reaching well past the middle of the frame, dominating the composition.',
          'A generous band of empty ground runs across the top of the frame and another across the very bottom.',
          'Nothing else appears in the picture.',
        ].join(' '),
      },
      {
        key: 'green-small',
        plateBrief: [
          `A flat, evenly lit soft green ${GREEN} ground filling the whole frame, smooth and free of texture.`,
          'The product stands upright in the lower right, SMALL and understated — occupying roughly a quarter of',
          'the frame height — resting on the surface with a soft contact shadow.',
          'The upper half of the frame and the whole left side are one continuous, unbroken field of that green.',
          'Nothing else appears in the picture.',
        ].join(' '),
      },
      {
        key: 'charcoal-contrast',
        plateBrief: [
          `A deep near-black ${BLACK} ground filling the whole frame, lit like premium CPG product photography so`,
          'the pale product separates sharply from the dark surface.',
          'The product stands upright in the lower right at hero scale, its base on the lower third, with a soft',
          'contact shadow and a gentle rim of light along its edge.',
          'The top of the frame and the left side are unbroken dark ground.',
          'Nothing else appears in the picture.',
        ].join(' '),
      },
      {
        key: 'grey-flatlay',
        plateBrief: [
          `A pale grey ${GREY} surface filling the whole frame, shot straight down from directly above in soft,`,
          'even daylight with a faint natural shadow.',
          'The product lies flat on that surface in the lower right, label upward, at moderate scale.',
          'The upper half of the frame and the left side are one continuous expanse of that grey.',
          'Nothing else appears in the picture.',
        ].join(' '),
      },
    ],
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
  // ── Added 2026-08-18: the two awareness levels that had no format ────────────────────
  //
  // Until now `unaware` and `most-aware` mapped to null, so 4 of the 15 angles on file
  // could be briefed but never rendered — including the HIGHEST-SCORING angle we hold
  // (p2a2 "125 chemicals a day", 81). That gap was deliberate and documented rather than
  // papered over by aliasing the two levels onto `problem`/`product`; these two entries
  // close it the way the header prescribes, as new data rows.
  //
  // They introduce two NEW awareness values rather than reusing the existing three. The
  // join in lib/ad-brief-plan.js is what makes a level renderable, and mapping `unaware`
  // onto `problem` would have silently briefed a problem-aware ad — an ad that assumes the
  // reader already knows they have a problem — against a reader who by definition does not.
  // That is the exact "closest available format" substitution the ad-brief README refuses.
  {
    key: 'fact-hook',
    name: 'Fact hook (unaware)',
    awareness: 'unaware',
    pairsImagesWithLabels: false,
    // The number is the hero and the product is deliberately incidental and small, so its
    // label cannot be read back — same declaration as manifesto and problem-aware, and for
    // the same reason: demanding a 6pt brand mark off it would burn retries at ~$0.13.
    productProminent: false,
    // No list-shaped zone — every zone here is a single string. `headline` carries the
    // FIGURE itself and is the largest type in the frame; that is what a headline is here,
    // and it keeps this format inside the invariant that every format has one.
    zones: ['headline', 'statContext', 'subhead', 'bottomBar'],
    layoutBrief: [
      'An editorial, information-first composition that reads like a public-interest fact rather than an ad.',
      `The headline is a single arresting figure and dominates the upper half on a warm sand ${SAND} ground,`,
      'set in heavy black type, with a short caption directly beneath it naming what the figure counts.',
      'A supporting line below that turns the fact toward the reader.',
      'The product sits small and incidental in the lower right, resting on the surface like a footnote.',
      'A single restrained line of caps runs across the bottom.',
      'The number must be a figure quoted from a named source — never an invented or rounded-up statistic.',
      'No before/after split and no depiction of a skin condition — those are restricted in health and beauty.',
    ].join(' '),
    // A giant numeral needs a genuinely flat, uninterrupted field to sit on, which is why
    // this is 'studio' and not a scene: a bathroom counter would put texture and edges
    // exactly where the largest type in the frame has to land. The product goes to the
    // lower RIGHT corner rather than manifesto's bottom centre, so the whole upper-left
    // field stays clear for the number.
    plateSetting: 'studio',
    plateBrief: [
      `A flat, evenly lit warm sand ${SAND} ground filling the whole frame, smooth and free of texture.`,
      'The product stands upright in the lower right corner, small and understated — occupying roughly a fifth',
      'of the frame height — resting on the surface with a soft contact shadow.',
      'The entire upper half of the frame and the whole left side are empty, even ground with nothing in them.',
      'Nothing else appears in the picture.',
    ].join(' '),
  },
  {
    key: 'spec-panel',
    name: 'Spec panel (most-aware)',
    awareness: 'most-aware',
    pairsImagesWithLabels: false,
    // Label legibility IS the ad here — a transparency pitch whose own product label cannot
    // be read is self-defeating — so this one genuinely wants the verify gate reading it back.
    productProminent: true,
    zones: ['headline', 'specRows', 'closingLine', 'bottomBar'],
    // specRows is a plain vertical list occupying one half of the frame, with no paired
    // imagery to crowd it; five short rows is what that column holds at phone width before
    // the type has to shrink below comfortable reading size.
    zoneCapacity: { specRows: 5 },
    layoutBrief: [
      'A calm, factual composition that reads like a specification sheet rather than a pitch — the reader has',
      'already decided they want this kind of product and wants the plain facts to act on.',
      `A restrained headline across the top on a ${SAND} ground.`,
      'A vertical list of short factual rows runs down one half of the frame, each row a single plain statement',
      'separated from the next by a thin hairline rule, with no icons and no illustration.',
      'The product stands large on the opposite side as the hero, lit like premium product photography with a',
      'soft contact shadow, close enough that its printed label is legible.',
      'One short closing line sits beneath the list.',
      'A solid bar across the very bottom carries one line of letterspaced caps.',
      'Every row must be a plain verifiable fact about the product — never a benefit promise or a claim of effect.',
    ].join(' '),
    plateSetting: 'studio',
    plateBrief: [
      `A flat, evenly lit warm sand ${SAND} ground filling the whole frame.`,
      'The product stands upright on the RIGHT side of the frame at hero scale, its base on the lower third and',
      'its height filling roughly the middle half of the frame, with a soft contact shadow.',
      'The entire left half of the frame is empty, even ground, and a clear band runs across the very bottom.',
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
  // Every plateVariant is a plateBrief and is held to the SAME load-time contract. Without
  // this a variant could ship empty, or without a key, and the failure would arrive halfway
  // through a paid multi-variation run rather than at import.
  for (const [i, v] of (f.plateVariants || []).entries()) {
    if (!String(v?.key || '').trim()) throw new Error(`ad-studio format "${f.key}" plateVariants[${i}] is missing key`);
    if (!String(v?.plateBrief || '').trim()) {
      throw new Error(`ad-studio format "${f.key}" plateVariant "${v.key}" is missing plateBrief`);
    }
  }
  const variantKeys = (f.plateVariants || []).map(v => v.key);
  if (new Set(variantKeys).size !== variantKeys.length) {
    throw new Error(`ad-studio format "${f.key}" has duplicate plateVariant keys`);
  }
  // No default. 'studio' would silently strip the setting off a format that wants one and
  // 'scene' would silently license props on one that does not; both are decisions, and a
  // default is how a decision gets made by nobody.
  if (!PLATE_SETTINGS.includes(f.plateSetting)) {
    throw new Error(`ad-studio format "${f.key}" needs plateSetting: one of ${PLATE_SETTINGS.join(' | ')}`);
  }
}

/**
 * The format to render for variation N (1-based), with its plate treatment selected.
 *
 * Resolved HERE, at the boundary, and handed downstream as an ordinary format object — so
 * renderVariationTargets, renderTarget and buildRenderPrompt need no new argument and there
 * is no call site that can forget to pass the variation index and silently render treatment
 * one five times. Same reasoning as applying the persona overlay at load.
 *
 * A format with no plateVariants is returned UNCHANGED (identity, not a copy), so every
 * format that has not opted in behaves exactly as it did before this existed.
 *
 * Cycles rather than clamps: --variations 7 against five treatments gives 1,2,3,4,5,1,2,
 * which is the useful reading of "more variations than treatments". `plateVariantKey` is
 * stamped on the returned object so run.json and proof.json can say which one a frame is.
 */
export function formatForVariation(format, variation = 1) {
  const variants = format?.plateVariants;
  if (!variants || !variants.length) return format;
  const i = (Math.max(1, Number(variation) || 1) - 1) % variants.length;
  const chosen = variants[i];
  return { ...format, plateBrief: chosen.plateBrief, plateVariantKey: chosen.key };
}

const BY_KEY = new Map(FORMATS.map(f => [f.key, f]));

export function formatByKey(key) {
  return BY_KEY.get(key);
}

/**
 * The rotation as it stands RIGHT NOW — every format minus the ones that cannot be written
 * without a live giveaway to cite (see requiresGiveaway in the header).
 *
 * Declaration order is preserved, which is what keeps `proposed` correct on both sides of
 * the window: with a giveaway live, `giveaway-entry` precedes `offer-focused` and wins the
 * product-aware slot; without one it is not in the list at all and `offer-focused` wins it,
 * exactly as before this format existed.
 *
 * @param {{giveawayLive?:boolean}} [opts]
 * @returns {typeof FORMATS}
 */
export function visibleFormats({ giveawayLive = false } = {}) {
  return FORMATS.filter(f => giveawayLive || !f.requiresGiveaway);
}

/**
 * @param {string[]} [keys] format keys, in the order wanted. Falsy/empty → the full rotation.
 *   "Full rotation" means visibleFormats() — a giveaway format is opt-in BY NAME and never
 *   arrives by default, because the default is the thing you get by accident.
 * @returns {typeof FORMATS}
 */
export function selectFormats(keys) {
  if (!keys || keys.length === 0) return visibleFormats();
  return keys.map(k => {
    const f = BY_KEY.get(k);
    if (!f) throw new Error(`unknown format: ${k}`);
    return f;
  });
}
