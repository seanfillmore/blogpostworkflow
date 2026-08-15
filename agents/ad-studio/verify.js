// agents/ad-studio/verify.js
//
// Stage 4. Nothing ships unread.
//
// Four checks, all required:
//   1. per-string checks — for each requested string, a POINTED yes/no about that exact
//                          character sequence, plus the literal text of that region
//   2. product volume     — read-or-ILLEGIBLE; illegible passes, WRONG fails
//   3. defects            — finished: text obscured, cut off at the frame edge, or garbled
//                           plate:    any text at all outside the product's own label; an
//                                     EMPTY copy zone is the deliverable, never a defect
//   4. pairing            — an ad whose words are all spelled correctly but whose
//                           pictures sit against the wrong labels
//
// ── Why this file was rebuilt (2026-08-14) ──────────────────────────────────────
//
// v1 asked the model to TRANSCRIBE every string and then looked for the expected text
// inside that transcript. A `manifesto` ad was accepted on attempt 1 whose rendered
// headline read "THE MOISTURIZING CLAIM DOES MORE WORK TTHAN THE FORMLA" and whose
// bottle carried a garbled "CERAMIO OCOCONUT OIL" badge over a "4 FL oz / 118ml"
// volume (the product is 8 fl. oz. / 236ml). The proof.json reported a perfect
// transcript, `missing: []`, `ok: true`.
//
// Three independent defects produced that pass, and each is fixed here:
//
//   R1. Open transcription invites auto-correction. A vision model reading text
//       SEMANTICALLY repairs misspellings on the way out — it reported FORMULA where
//       the pixels said FORMLA, and reconstructed the word "actually" that the bottle
//       was physically sitting on top of. The prompt already said "Do not correct
//       spelling"; it did not help, because the request itself ("transcribe this") is
//       a reading task and reading is where the repair happens.
//
//       So the verdict is no longer driven by a transcript. Each expected string gets
//       its own pointed question — does THIS exact character sequence appear, yes or
//       no, and what does that region actually say — and the model's own quoted
//       `rendered` text is then re-checked mechanically by diffTranscript. That is two
//       independent shots at the same defect: the model has to both answer "yes" AND
//       quote text that survives the token-boundary match. A transcript is still
//       collected, but purely as diagnostic output for proof.json.
//
//   R2. `productProminent: false` removed labelStrings from the expected set WHOLESALE,
//       so a garbled or outright wrong label went completely unchecked. That flag now
//       gates only the non-volume label strings (brand mark, product type, variant
//       name), which genuinely cannot be read off a product rendered "small and
//       understated at the bottom center". The VOLUME is checked on every format, in a
//       shape that tolerates illegibility but not falsehood: ILLEGIBLE passes, a value
//       matching the true volume passes, a value that contradicts it FAILS.
//
//   R3. Nothing looked for occlusion or truncation. The product physically covered the
//       word "actually" in the closing line and the verifier silently reconstructed it.
//       A human would reject an ad whose product sits on top of its own copy; the gate
//       now does too, along with text running off the frame edge and garbled glyph runs.
//
// ── R2b: the volume is checked ONCE, by volumeVerdict (2026-08-14, same day) ────
//
// R2 left the volume marking in the per-string expected set on productProminent formats
// AND checked it here, and called that "the intended ordering". It is not an ordering,
// it is a contradiction: the two mechanisms have different strictness and they disagreed
// inside a single verdict. From a live run (us-vs-them/v1/plate-1_91x1.jpg):
//
//   reasons: "8 fl. oz. (236ml)" — not present — that region reads "8 fl. oz - 236ml"
//   volume:  { "status": "match" }
//
// volumeVerdict compares NUMBERS and tolerates separator and abbreviation differences on
// purpose — the manifest prose writes "8 fl. oz. (236ml)" and the physical label prints
// "8 fl. oz - 236ml" / "8 fl. oz • 236ml" / "8 fl. oz ~ 236ml". The per-string check
// demands the character sequence literally and fails all of those. Three targets in one
// run were rejected for carrying a correct volume.
//
// index.js's expectedForFormat now SUBTRACTS the volume markings from the expected set
// in both modes, so the volume is asserted by exactly one mechanism: this one. Coverage
// is unchanged — volumeVerdict runs on every format in every mode, and it is strictly
// the more capable of the two, since the per-string check could only ever ask about the
// literal manifest spelling.
//
// One thing the duplicate was accidentally covering had to be picked up here: the model
// answering "productVolume": "ILLEGIBLE" while transcribing a readable — and wrong —
// volume elsewhere in the SAME response (top-x-review/v1/plate-1_91x1.jpg: ILLEGIBLE vs
// a transcribed "0 fl. oz. • 236ml", a misrendered 8). volumeVerdict now falls back to
// the transcript when, and only when, it has no direct reading, and that fallback can
// only fail a render, never pass one. Section 2 of the prompt was tightened to match.
//
// ── R3a: the defect check is MODE-AWARE (2026-08-14, same day) ──────────────────
//
// R3 shipped asking one question in both modes — "what copy here is not fully legible
// and correct" — and on a PLATE that question has no correct answer. A plate is rendered
// under an instruction to put NO text anywhere except the product's own label and to
// leave every copy zone "completely empty and clean"; Google Demand Gen mixes the text
// assets in at serve time. The emptiness IS the deliverable. Asked what copy was
// illegible, the verifier truthfully answered "the header bars are empty, the list rows
// have no text" and the gate failed 5 of 18 plates on a live run for being exactly right:
//
//   [obscured] "[black rounded bar, left]"   — solid black bar with no text inside it
//   [obscured] "[list items next to X marks]" — four rows with X icons and blank lines
//
// So in plate mode the question is INVERTED, not dropped. Absence of text is never a
// defect; text that is PRESENT anywhere but the product's own label is — the same run
// rendered a bottom bar reading "A LIBCDEFGHIJKLM NOPQRSTUVWXYZ" into a plate that was
// supposed to be clean, and that must keep failing. Stray text on a plate is arguably
// the more serious defect of the two: it cannot be fixed by the copy layer, it ships
// as pixels.
//
// The prompt asks the inverted question, and normalizeDefects backstops it: on a plate,
// a defect entry that quotes no rendered characters (a bracketed description of a region,
// or the word "blank") is a report of ABSENCE and is dropped. Finished mode is untouched
// — obscured, cut off and garbled all still fail there, which is what caught the
// corrupted headline and the bottle sitting on top of its own closing line.
//
// The model was also raised from Haiku to Sonnet (config/creative-models.js). This is
// one vision call guarding a ~$0.13 render that a human would otherwise have to read.

import { normalizeForMatch } from './claims.js';

/**
 * R4. The attributes the fidelity check asks about, one pointed question each.
 *
 * These are deliberately GENERIC across the catalogue rather than authored per product.
 * The reference photograph is the specification; a hand-written `fidelityChecks` array
 * per product would be nine more things to keep in sync with the photos, and the drift
 * would be silent.
 *
 * Every one is COARSE — a proportion, a cap, an element order, a solid colour block.
 * That is the point: these survive a product rendered small, where the label's own 6pt
 * text does not (see productProminent). Do not add an attribute that can only be judged
 * on a hero-sized render; it would answer CANNOT_TELL on half the rotation and quietly
 * do nothing.
 *
 * Styling is explicitly NOT here. Lighting, angle, background and crop are the ad's to
 * choose, and asking about them would fail correct renders for being art-directed.
 */
export const FIDELITY_ATTRIBUTES = [
  {
    key: 'silhouette',
    label: 'the body shape and proportions of the product',
    ask: 'Is the outline the same — height against width, taper, shoulders, whether it is tall and slim or short and wide?',
  },
  {
    key: 'closure',
    label: 'the cap or closure',
    ask: 'Same type, same shape, and the same height relative to the body?',
  },
  {
    key: 'labelLayout',
    label: 'the order and placement of the elements on the label',
    ask: 'Do the brand mark, product name, variant name, badge and volume sit in the same positions, top to bottom, as in the photographs?',
  },
  {
    key: 'labelGraphics',
    label: 'the SHAPE and PLACEMENT of the graphics printed on the label (colour bars or blocks, illustrations, badges, rules)',
    // NARROWED 2026-08-15. This used to invite a judgement on the badge as a whole, and
    // the badge carries arc-set micro-copy that no vision model reads reliably at render
    // size. Sean eyeballed both live rejects: the 9:16 badge "looks fine" — a FALSE
    // POSITIVE that cost three paid attempts — and the 4:5 badge was "definitely
    // garbled", but that frame was independently rejected for stray "HOIXIM HEADLINE"
    // text baked into a plate. So narrowing to shape and placement loses no true
    // positive and drops a whole class of false ones.
    //
    // This is the same exclusion buildLabelStrings already applies to badge micro-copy,
    // for the same reason, and the same lesson as productProminent: when a check demands
    // something unreadable, accept "cannot read it" rather than burning the retries.
    ask: 'Take each graphic printed on the label in the REFERENCE photographs in turn. Is it PRESENT in the render, in the same place, and the same shape? A missing solid colour bar, a missing illustration, or a badge that has become a rectangle or moved to the other end of the label is a mismatch. JUDGE SHAPE AND POSITION ONLY — never whether the small text inside or around a badge is spelled correctly or is readable at all. Arc-set badge micro-copy is illegible at render size by design and a garbled-looking badge legend is NOT a mismatch. Report ONLY reference elements that are missing, moved or reshaped — never an extra element you see in the render, which is far more often a highlight, a reflection or a moulding seam than printed ink.',
  },
  {
    key: 'containerColour',
    label: 'the base colours of the container, cap and label',
    ask: 'Is the container the same colour, the cap the same colour, the label the same colour? Judge the base colour only — a white bottle lit warm is still a white bottle.',
  },
];

/**
 * `mode` is 'finished' (Meta baked frame) or 'plate' (Demand Gen, text-free).
 *
 * A PLATE carries no ad copy by construction — buildRenderPrompt's plate branch says
 * "ABSOLUTELY NO TEXT ... anywhere in the image, except the product's own printed
 * label". So a plate has no labels to pair pictures with, and asking for pairings on
 * one can only produce noise. Both this prompt and verdictFor gate the pairing check
 * on mode for that reason; see verdictFor.
 *
 * It is also why the DEFECT question is inverted on a plate (R3a). Asking a plate "what
 * copy here is illegible" has no correct answer — the copy zones are empty on purpose,
 * and the verifier answering honestly failed 5 of 18 plates on a live run. The plate is
 * asked the opposite question instead: what text is PRESENT that should not be. Absence
 * is never reportable; stray glyphs always are.
 *
 * Defaults to 'finished' — the strict side — so a caller that forgets to thread mode
 * through gets the tighter gate, never the looser one.
 *
 * @param {{expected:string[], format:object, mode?:string, volumeStrings?:string[]}} args
 */
export function buildVerifyPrompt({
  expected, format, mode = 'finished', volumeStrings = [],
  physicalDescription = '', referenceCount = 0, unitCount = 1,
}) {
  const list = (expected || []).map(s => `  - "${s}"`).join('\n');
  const wantsPairings = format.pairsImagesWithLabels && mode === 'finished';
  const isPlate = mode === 'plate';

  // R4. Reference photographs are only sent when the product has them, so the fidelity
  // section only exists when there is something to compare against. Asking it without
  // them is an unanswerable question that costs three paid attempts.
  const wantsFidelity = referenceCount > 0;
  const nFidelity = 3;
  const nDefects = wantsFidelity ? 4 : 3;
  const nTranscript = nDefects + 1;
  const nPairings = nTranscript + 1;
  // The inventory is a PLATE check and numbers after everything else. A finished frame is
  // supposed to carry columns, rules, ingredient cut-outs and a styled scene — its
  // layoutBrief asks for them — so there is no "does this belong" question to ask of it.
  // A plate is specified as the product on empty ground, which makes the question exact.
  const wantsInventory = isPlate;
  const nInventory = (wantsPairings ? nPairings : nTranscript) + 1;

  const intro = isPlate
    ? `You are proofreading a text-free BACKGROUND PLATE before it goes live. It is not a
finished ad: the ad copy is supplied separately and composited over this image at serve
time, so this image was rendered under an instruction to contain NO text of any kind
except the product's own printed label, and to leave every area where copy will later sit
completely empty and clean.`
    : `You are proofreading a finished advertisement image before it goes live.`;

  // R4. Pointed question per attribute, never one open "does this match?" — R1's finding
  // is that an open question is answered towards yes. Each attribute is coarse enough to
  // survive a product rendered small, and CANNOT_TELL is always available so that a small
  // product costs a skipped check rather than three failed renders.
  const fidelitySection = wantsFidelity
    ? `${nFidelity}. PRODUCT FIDELITY — compare the PRODUCT in the render against the reference
   photographs. Answer each of the following SEPARATELY. Do not answer them as a group and
   do not give an overall impression.
${FIDELITY_ATTRIBUTES.map(a => `     - "${a.key}" — ${a.label}. ${a.ask}`).join('\n')}
${physicalDescription ? `
   The product on file is described as: ${physicalDescription}
   Treat that description and the photographs as the same source of truth. Where the
   render contradicts either, that is a mismatch.
` : ''}
   For each attribute report "attribute", "verdict" and "detail". Keep "detail" to ONE
   short sentence — it is read by a human triaging a rejected frame, not by a machine:
     "MATCH"        — the render agrees with the reference photographs
     "MISMATCH"     — the render visibly contradicts them. Say what each shows in "detail".
     "CANNOT_TELL"  — the product is too small, too blurred, angled away or cropped for
                      you to judge THIS attribute.

   "CANNOT_TELL" is a correct and expected answer on layouts that render the product
   small, and it is never counted against the image. Guessing "MATCH" because the product
   is roughly right, or because you assume the render was produced from these photographs,
   is the failure this question exists to catch.

   REPORT A MISMATCH ONLY FOR THE PRODUCT'S PRINTED DESIGN OR PHYSICAL CONSTRUCTION.
   The reference photographs and the render were lit, staged and shot differently on
   purpose — the render is an advertisement, not a copy of the photograph. None of the
   following is EVER a mismatch, no matter how different it looks:
     - lighting, exposure, colour temperature, white balance, contrast
     - gloss, sheen, specular highlights, glare, gradients, gleam along an edge, or a
       bright or dark band that is a reflection rather than printed ink
     - shadows, reflections on the surface below, or the surface itself
     - background, props, scene, camera angle, distance, crop or depth of field
     - the product being shown at a different size or rotation
   A bottle that looks glossier, warmer, or has a highlight the photograph lacks is the
   SAME BOTTLE. Ask yourself: would this difference still exist if both were lit
   identically? If the answer is no, it is MATCH.` : '';

  const defectsSection = isPlate
    ? `${nDefects}. STRAY TEXT — every headline bar, list row, caption slot and panel in this layout is
   SUPPOSED to be empty. An empty bar, a blank line, a row of icons with nothing written
   beside them: that is this image working exactly as specified.

   DO NOT report absent, missing or blank text. There is no ad copy in this image that
   could be obscured, cut off, truncated or incomplete, and "this bar contains no text" is
   the correct outcome, never a defect. Never describe an empty region in "defects".

   Report the OPPOSITE. List in "defects" every piece of lettering, every word, number or
   glyph run that IS physically rendered anywhere in the image other than on the product's
   own printed label. Placeholder copy ("HEADLINE", "TEXT HERE", "LOREM IPSUM"), alphabet
   or letterform strips, stray captions, invented logos, watermarks, dates, prices: on a
   plate all of it is a defect, whether it is spelled correctly or garbled.

   For each one give "text" — the characters that are actually rendered, quoted glyph by
   glyph, never a description of a region — "issue": "stray-text", and a short "detail"
   saying where in the frame it sits.

   NOT defects, do not report them:
     - text printed on the PRODUCT'S OWN LABEL — the brand mark, the arc-set badge
       micro-copy, the variant name, the volume. The label belongs on the product and is
       supposed to be there; section 2 already covers the one falsifiable part of it.
     - an empty zone, a blank bar, a blank line, or a bare icon with no text beside it.
   Return [] if there is no text anywhere outside the product's own label.`
    : `${nDefects}. DEFECTS — list every piece of the AD'S OWN TYPESET COPY that is not fully legible
   and correct, in "defects". Report a defect when such text is:
     - overlapped, covered or obscured by another element (including the product itself)
     - running off the edge of the frame, cropped, or cut off
     - garbled: doubled letters, dropped letters, transposed letters, nonsense letter
       runs, or a word that is not correctly spelled
   For each defect give "text" (as rendered, not as you think it was meant) and "issue"
   (one of "obscured", "cut-off", "garbled") and a short "detail".

   NOT defects, do not report them:
     - text printed on the PRODUCT'S OWN LABEL — the brand mark, the arc-set badge
       micro-copy, the variant name, the volume. That label renders small by design and
       its curved micro-copy cannot be read reliably at any render size; the one part of
       it that carries a falsifiable spec is the volume, and section 2 already covers it.
       (This exclusion is about text physically printed on the bottle. Type that belongs
       to the ad's layout — headlines, rules, bottom bars, price/offer badges set on the
       background — is IN scope even when it sits near the product.)
     - text that is merely small, soft or low-resolution but not actually wrong. An
       overlap, a crop or a wrong glyph is a defect; "I cannot fully confirm this" is not.
     - correctly-spelled brand names, deliberate stylistic capitalisation, letterspacing
       and intentional line breaks.
   Return [] if there are none.`;

  // R5. SCENE INVENTORY — the check nothing was doing.
  //
  // The 2026-08-15 plate carried a ghost second bottle, a wood slice, greenery and a
  // coconut, and passed. Every existing check had a reason not to see it: FIDELITY_
  // ATTRIBUTES are phrased about *the* product, singular, so the verifier silently picked
  // one unit ("the large bottle on the right") and judged that; the volume scan was gated;
  // and the stray-text rule correctly exempts text on the product's own label, which
  // exempted the ghost bottle's wrong volume twice over.
  //
  // The generalisable shape: EVERY CHECK ASSUMED EXACTLY ONE PRODUCT IN THE FRAME. When
  // adding a check here, ask what it assumes about how many of something is present.
  //
  // This is an inventory, not a unit count (Sean, 2026-08-15). A hard-coded "exactly one"
  // would fail every genuine multi-unit product — foam-soap-bundle, both starter sets and
  // the lip balm four-pack — so the expected number comes from product.unitCount, and the
  // model is asked to CLASSIFY each object rather than to judge "does this belong".
  // Classification is the more reliable ask, and its output ("a wood slice, a coconut, a
  // second partially-rendered bottle") is actionable where "count: 2" is not. Same move as
  // the pointed per-attribute fidelity questions: specific beats open-ended.
  //
  // The verifier is NOT told how many units to expect. Telling it would be R1's exact
  // failure mode — an open question answered towards the number in the prompt — and the
  // whole point is to learn what is in the frame from a model that does not know what the
  // right answer is. inventoryVerdict does the comparison against unitCount in code.
  const inventorySection = wantsInventory
    ? `${nInventory}. SCENE INVENTORY — list EVERY distinct physical object you can see in the frame, in
   "sceneInventory". Work across the whole image, including anything faint, blurred,
   ghosted, semi-transparent, out of focus, reflected, or cropped by the frame edge. An
   object that is only half-rendered is still an object and MUST be listed.

   For each one give:
     "object" — a short concrete description including where it sits ("a white lotion
                bottle, centre right", "a slice of wood under the bottle", "a second,
                partly faded bottle behind the first")
     "kind"   — exactly one of:
                  "product-unit" — a unit of the product being advertised, INCLUDING a
                                   faded, ghosted, duplicated or partially rendered one.
                                   Count every one you can see separately, even if two
                                   are the same item shown twice.
                  "surface"      — the ground, table, backdrop or background the product
                                   rests on or against. There is normally exactly one.
                  "other"        — anything else at all: ingredients, fruit, nuts, leaves,
                                   greenery, wood slices, boards, trays, bowls, cloths,
                                   stones, water, splashes, packaging boxes, props of any
                                   kind, decorative shapes.

   NOT objects — never list these: shadows, reflected light, highlights, gradients,
   vignettes, blur, grain, or the empty background itself considered separately from the
   surface. Lighting is not a thing in the scene.

   Report what you SEE, not what you expect a clean advertisement to contain. If there is
   a second bottle you are unsure about, list it — an object listed in error costs one
   re-render, an object omitted ships.

` : '';

  // R4. With reference photographs attached there is more than one image in the call, and
  // every other section asks about exactly one of them. Saying which is which is not
  // optional: a model that transcribes the label off a reference photograph would report
  // a perfect render of a product the ad never contained.
  const imageOrder = wantsFidelity
    ? `You have been given ${referenceCount + 1} images. The FIRST ${referenceCount} ${referenceCount === 1 ? 'is a REFERENCE PHOTOGRAPH' : 'are REFERENCE PHOTOGRAPHS'}
of the real physical product, for comparison only. The LAST image is the RENDER UNDER TEST.
Every question below is about the RENDER UNDER TEST unless it explicitly names the
reference photographs. Never transcribe, read or report text from a reference photograph.

`
    : '';

  return `${intro} ${imageOrder}This image
was produced by a generative image model. Those models corrupt text constantly: doubled
letters ("TTHAN"), dropped letters ("FORMLA"), invented words ("CERAMIO"), and text that
ends up underneath another object.

Your job is to READ THE PIXELS, glyph by glyph, and report what is physically there.
You are NOT reading for meaning. Do not repair, complete, normalize or auto-correct
anything: if the image says "FORMLA", your answer is "FORMLA". If an object covers part
of a word, report the covered word as covered — never infer what it must have said.

1. STRING CHECKS — for EACH requested string below, answer separately.

${list}

   For each one report:
     "expected"  — the requested string, copied exactly as written above
     "found"     — true only if that exact character sequence is physically present in
                   the image, every character, in order, correctly spelled
     "rendered"  — the literal text of the region where that string appears, or where it
                   was supposed to appear, transcribed glyph by glyph from the pixels.
                   ALWAYS fill this in, even when "found" is true. Use "" only if that
                   region contains no text whatsoever.

   Ignore ONLY these differences when deciding "found": letter case, line breaks and
   spacing, and separator punctuation (a bullet where the request has parentheses).
   Everything else means found: false — a different word, a missing word, an extra word,
   a doubled letter, a dropped letter, a transposed letter.

2. PRODUCT VOLUME — read the volume marking printed on the product itself (the
   "8 fl. oz. (236ml)" style text on the label). Report the literal text you can see in
   "productVolume". If the product is too small, too blurred, angled away, cropped out
   or simply absent, answer exactly "ILLEGIBLE". Never guess it, never infer it from the
   product's proportions, and never copy it from this prompt.

   "ILLEGIBLE" means you cannot make out ANY characters there. If you can read
   characters at all, quote them — even partially, even if the number looks wrong,
   implausible or misprinted. A volume you can read but that looks wrong is precisely
   what this question exists to surface; reporting it is never a mistake. Do not answer
   "ILLEGIBLE" for a marking you are able to transcribe anywhere else in this response.

${wantsFidelity ? `${fidelitySection}

` : ''}${defectsSection}

${nTranscript}. TRANSCRIPT — every piece of text visible in the image, as rendered. Diagnostic only.
${wantsPairings ? `
${nPairings}. PAIRINGS — this layout pairs a picture with each label. For every such pair, report the
   label text, a short description of what the picture actually depicts, and whether they
   match.
` : ''}
${inventorySection}Respond with JSON only:
{
  "checks": [{ "expected": "...", "found": true, "rendered": "..." }],
  "productVolume": "...",${wantsFidelity ? `
  "fidelity": [{ "attribute": "${FIDELITY_ATTRIBUTES[0].key}", "verdict": "MATCH", "detail": "..." }],` : ''}
  "defects": [{ "text": "...", "issue": "${isPlate ? 'stray-text' : 'obscured'}", "detail": "..." }],
  "transcript": ["...", "..."]${wantsPairings ? `,
  "pairings": [{ "label": "...", "depicts": "...", "matches": true }]` : ''}${wantsInventory ? `,
  "sceneInventory": [{ "object": "...", "kind": "product-unit" }]` : ''}
}${wantsInventory ? `

("sceneInventory" must list every object in the frame, one entry each. It is a factual
inventory, not a judgement about whether the image is good — do not leave an object out
because it looks like it belongs, and do not merge two units into one entry.)` : ''}${wantsFidelity ? `

("fidelity" must carry one entry for EVERY attribute listed in section ${nFidelity}, in that order.)` : ''}${volumeStrings.length ? `

(The product's true volume is on file and your "productVolume" answer will be compared
against it. Answering "ILLEGIBLE" when you genuinely cannot read it is correct and is
not a failure — guessing is.)` : ''}`;
}

function extractJson(raw) {
  const s = String(raw || '').trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : s;
  try { return JSON.parse(candidate); } catch { /* fall through */ }
  const first = candidate.indexOf('{');
  const last = candidate.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try { return JSON.parse(candidate.slice(first, last + 1)); } catch { /* fall through */ }
  }
  return null;
}

/**
 * `checks` is the verdict driver and is REQUIRED — a response without it cannot be
 * scored, and defaulting it to [] would silently score every render as "everything
 * missing" while looking like a parse success. `transcript` is diagnostic and is
 * allowed to be absent (v1 required it; it no longer decides anything).
 */
export function parseVerifyResponse(raw) {
  const obj = extractJson(raw);
  if (!obj || !Array.isArray(obj.checks)) {
    throw new Error('ad-studio: could not parse verify response as JSON with a checks array');
  }
  return {
    checks: obj.checks,
    productVolume: typeof obj.productVolume === 'string' ? obj.productVolume : '',
    defects: Array.isArray(obj.defects) ? obj.defects : [],
    transcript: Array.isArray(obj.transcript) ? obj.transcript : [],
    pairings: Array.isArray(obj.pairings) ? obj.pairings : [],
    // Absent → []. fidelityVerdict, not the parser, decides what an empty list means:
    // nothing when no reference photographs were sent, a hard fail when they were.
    fidelity: Array.isArray(obj.fidelity) ? obj.fidelity : [],
    // Absent → []. Same division of labour: inventoryVerdict decides that an empty
    // inventory means "unreported" on a plate and means nothing on a finished frame.
    sceneInventory: Array.isArray(obj.sceneInventory) ? obj.sceneInventory : [],
  };
}

/**
 * The match is ANCHORED AT TOKEN BOUNDARIES. A plain String.includes accepts a
 * superstring, which is the single worst false pass this gate can produce:
 *
 *   expected "8 fl. oz. (236ml)"  vs rendered "18 fl. oz. • 236ml"   → passed
 *   expected "2 fl oz (60ml)"     vs rendered "12 fl oz 60ml"        → passed
 *   expected "real SKIN CARE"     vs rendered "unreal SKIN CARE"     → passed
 *
 * i.e. a render printing an invented volume on the bottle sailed through the one gate
 * that exists to stop invented specs. A match may therefore neither start nor end
 * mid-token. Whitespace is the only boundary: the hyphen is NOT one, because
 * normalizeForMatch keeps "cold-pressed" as a single token on purpose.
 */
function includesAtTokenBoundary(haystack, needle) {
  if (!needle) return false;
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(needle, from);
    if (i === -1) return false;
    const end = i + needle.length;
    const startsClean = i === 0 || haystack[i - 1] === ' ';
    const endsClean = end === haystack.length || haystack[end] === ' ';
    if (startsClean && endsClean) return true;
    from = i + 1;
  }
}

/**
 * Mechanical containment test: does every expected string appear in `runs`?
 *
 * No longer the primary gate (see the R1 note at the top of this file) — it is now the
 * VERIFIER of the model's own quoted `rendered` text inside evaluateChecks, and the
 * diagnostic diff against the secondary transcript. Its matching rules are unchanged
 * and must stay unchanged; every relaxation and every anchor in here was paid for.
 *
 * `runs` is checked against TWO joins of the same normalized strings, and either one
 * satisfies a match:
 *
 *   1. joined by ' | ' — preserves run boundaries (the original behaviour)
 *   2. joined by a single space — lets one expected string span *consecutive* runs
 *
 * (2) exists because the vision model reports a visual lockup as separate runs: the
 * label "real SKIN CARE" comes back as ["real", "SKIN CARE"], and "Organic Coconut Oil
 * + Essential Oils" as two runs, even though the image is correct. A live run rejected
 * 6/6 correct renders on that formatting alone.
 *
 * This relaxes run-boundary whitespace and NOTHING else. Each expected string must
 * still appear as one contiguous, correctly-spelled, correctly-ordered sequence of
 * characters. Deliberately not per-word matching and not a similarity score: the gate's
 * value is that it caught a bottom bar the model had silently rewritten, and either of
 * those would let that through.
 */
export function diffTranscript(expected, transcript) {
  const runs = (transcript || []).map(normalizeForMatch).filter(Boolean);
  const byRun = runs.join(' | ');
  const flowed = runs.join(' ');
  const missing = (expected || []).filter(e => {
    const needle = normalizeForMatch(e);
    // An expected string with no matchable text (pure punctuation) is unverifiable
    // either way; it was never a failure before the anchoring and must not become one,
    // or a stray glyph in a zone would burn three paid renders proving nothing.
    if (!needle) return false;
    return !includesAtTokenBoundary(byRun, needle) && !includesAtTokenBoundary(flowed, needle);
  });
  return { ok: missing.length === 0, missing };
}

/**
 * Score the per-string checks. THIS is the verdict driver.
 *
 * A pointed "does this exact sequence appear, yes or no" is much harder to auto-correct
 * through than "transcribe everything", but it is still one model answer. So the
 * model's "yes" is not taken on trust: the `rendered` text it quotes for that region is
 * re-run through diffTranscript's token-anchored match, and a "yes" whose own quoted
 * text does not contain the expected string is treated as a NO. The model has to get
 * both halves wrong in the same direction for a corrupted string to survive.
 *
 * Fail-closed, three ways, all of them cheap to recover from (a retry is one render):
 *   - an expected string with no check at all → missing. A model that skips the awkward
 *     string must not thereby pass it.
 *   - found:true with an empty `rendered` → missing, "quoted no rendered text". There is
 *     nothing to falsify the claim against, and an unfalsifiable pass is what this whole
 *     rebuild exists to remove.
 *   - found:true whose `rendered` fails the token-anchored match → missing.
 *
 * Checks are matched to expected strings by NORMALIZED expected text first, then
 * positionally when the model returned exactly one check per expected string in order.
 * Keying on the raw string would break on any punctuation the model re-typed.
 *
 * @returns {{missing:string[], details:{expected:string, rendered:string, reason:string}[]}}
 */
export function evaluateChecks(expected, checks) {
  const list = Array.isArray(checks) ? checks : [];
  const byExpected = new Map();
  for (const c of list) {
    const key = normalizeForMatch(c?.expected);
    if (key && !byExpected.has(key)) byExpected.set(key, c);
  }
  const positional = list.length === (expected || []).length;

  const missing = [];
  const details = [];

  (expected || []).forEach((e, i) => {
    const needle = normalizeForMatch(e);
    // Pure-punctuation expectations are unverifiable either way — same carve-out
    // diffTranscript makes, for the same reason.
    if (!needle) return;

    const check = byExpected.get(needle) || (positional ? list[i] : null);
    const rendered = typeof check?.rendered === 'string' ? check.rendered : '';

    if (!check) {
      missing.push(e);
      details.push({ expected: e, rendered: '', reason: 'the verifier returned no check for this string' });
      return;
    }
    if (check.found !== true) {
      missing.push(e);
      details.push({
        expected: e,
        rendered,
        reason: rendered
          ? `not present — that region reads "${rendered}"`
          : 'not present — the verifier reported no text in that region',
      });
      return;
    }
    if (!normalizeForMatch(rendered)) {
      missing.push(e);
      details.push({ expected: e, rendered, reason: 'reported present but the verifier quoted no rendered text' });
      return;
    }
    if (!diffTranscript([e], [rendered]).ok) {
      missing.push(e);
      details.push({
        expected: e,
        rendered,
        reason: `reported present, but the text quoted from that region is "${rendered}"`,
      });
    }
  });

  return { missing, details };
}

// "8 fl. oz. (236ml)" / "2 fl oz (60ml)" / "4 FL oz / 118ml" — the volume marking is
// stated with wildly inconsistent punctuation in the manifest prose, on the physical
// label, and in whatever the vision model types back. Compare the NUMBERS, not the
// string: separator and abbreviation differences must never fail a render, and a
// wrong number must always fail one.
const OZ_RE = /(\d+(?:\.\d+)?)\s*fl\.?\s*oz/i;
const ML_RE = /(\d+(?:\.\d+)?)\s*m\s*l\b/i;
// R2c. Products marked by NET WEIGHT rather than fluid volume — the lip balm
// ("0.15 oz • 4.25g") and the bar soap ("3.4 oz • 84g"). Without these two patterns the
// whole volume gate was blind to them: nothing on file meant nothing to falsify, AND the
// marking stayed in the literal expected set, which is the strictness R2b removed.
//
// WT_OZ_RE cannot match a FLUID ounce marking: "8 fl. oz." puts "fl." between the number
// and "oz", and \s* cannot cross it. That separation is the whole reason this is safe to
// run alongside OZ_RE — if it ever loosened, every lotion would carry a phantom weight
// reading that nothing on its label supports.
const WT_OZ_RE = /(\d+(?:\.\d+)?)\s*oz/i;
const G_RE = /(\d+(?:\.\d+)?)\s*g\b/i;

/** Does this parse carry any readable marking at all? */
function hasVolumeReading(v) {
  return v.oz !== null || v.ml !== null || v.wtOz !== null || v.g !== null;
}

// Answers that mean "I could not read it". The prompt asks for exactly "ILLEGIBLE";
// the synonyms are here because a model that types "not visible" has still told us it
// could not read the label, and punishing the wording rather than the answer would
// burn three paid renders on a product that is small BY DESIGN.
const ILLEGIBLE_RE = /^(illegible|unreadable|not\s*(visible|legible|readable|present)|none|absent|n\/?a|unknown)\.?$/i;

export function readVolume(text) {
  const s = String(text || '');
  const oz = s.match(OZ_RE);
  const ml = s.match(ML_RE);
  const wtOz = s.match(WT_OZ_RE);
  const g = s.match(G_RE);
  return {
    oz: oz ? Number(oz[1]) : null,
    ml: ml ? Number(ml[1]) : null,
    wtOz: wtOz ? Number(wtOz[1]) : null,
    g: g ? Number(g[1]) : null,
  };
}

/**
 * Volume markings out of a product's labelStrings, so index.js does not have to know
 * the shape of a volume string in two places.
 */
export function selectVolumeStrings(labelStrings) {
  return (labelStrings || []).filter(s => hasVolumeReading(readVolume(s)));
}

/**
 * Tolerant of ILLEGIBLE, intolerant of WRONG. See R2 at the top of this file.
 *
 * `productProminent: false` used to strip labelStrings out of the expected set
 * entirely, which is how "4 FL oz / 118ml" shipped on an 8 fl. oz. bottle. The reason
 * that flag existed is real — no vision model can read a 6pt volume marking off a
 * product rendered "small and understated at the bottom center", and demanding it back
 * fails every attempt and burns the retries — but the response to "cannot read it" is
 * to accept "cannot read it", not to stop asking.
 *
 *   ILLEGIBLE / no digits readable        → pass  (the legitimate small-product case)
 *   a number that agrees with the truth   → pass
 *   a number that contradicts the truth   → FAIL
 *
 * Only the dimensions the model actually reported are compared: reading "8 fl. oz."
 * off a bottle whose ml marking is turned away is a correct read, not a mismatch.
 *
 * THIS IS THE ONLY CHECK ON THE VOLUME (R2b). expectedForFormat subtracts the volume
 * markings from the per-string expected set, because that check demands the manifest's
 * literal spelling and the label prints a different one — it failed three correct
 * renders in one live run while this function said "match". Do not put the volume back
 * into the expected set; if this check is not strict enough, make this check stricter.
 *
 * `transcript` is the response's own transcript of the frame. It is scanned on EVERY
 * call, not only when the direct reading is missing, and can only ever fail a render.
 * See the loop below for why the old gate let a wrong volume through.
 *
 * @returns {{ok:boolean, status:string, read:string, source:string, expected:string[]}}
 */
export function volumeVerdict(productVolume, volumeStrings, transcript = []) {
  const read = String(productVolume || '').trim();
  const truths = (volumeStrings || []).map(readVolume).filter(hasVolumeReading);

  // Nothing on file to compare against — this product's manifest entry carries no
  // volume marking, so there is no claim to falsify. (index.js already aborts a run
  // whose labelStrings come back empty for the separate, stronger reason that an
  // unnamed label is how the image model invents a volume in the first place.)
  if (truths.length === 0) return { ok: true, status: 'no-volume-on-file', read, source: 'reported', expected: [] };

  const expectedList = (volumeStrings || []).filter(s => hasVolumeReading(readVolume(s)));

  // Only the dimensions actually reported are compared: reading "8 fl. oz." off a
  // bottle whose ml marking is turned away is a correct read, not a mismatch.
  const agreesWithTruth = got => truths.some(t =>
    (got.oz === null || t.oz === null || got.oz === t.oz) &&
    (got.ml === null || t.ml === null || got.ml === t.ml) &&
    (got.wtOz === null || t.wtOz === null || got.wtOz === t.wtOz) &&
    (got.g === null || t.g === null || got.g === t.g)
  );

  const direct = (!read || ILLEGIBLE_RE.test(read))
    ? { oz: null, ml: null, wtOz: null, g: null }
    : readVolume(read);

  // A WRONG direct reading fails immediately and is reported as itself: it is the answer
  // to the question asked about exactly this marking, so it is the most actionable thing
  // to put in front of a human triaging the reject.
  if (hasVolumeReading(direct) && !agreesWithTruth(direct)) {
    return { ok: false, status: 'mismatch', read, source: 'reported', expected: expectedList };
  }

  // The direct reading is now either absent or correct. Scan the response's own
  // transcript for a volume that CONTRADICTS the truth — UNCONDITIONALLY.
  //
  // This used to run only when there was no direct reading, and that gate is how the
  // 2026-08-15 plate passed. The response transcript carried BOTH "8 fl. oz • 236ml" and
  // "8 fl. oz . 230ml" — the second one printed on a ghost second bottle — while the
  // direct "productVolume" answer was correct, so the fallback never ran and the frame
  // was accepted.
  //
  // The old docstring's own justification for the gate was that the scan "can only ever
  // FAIL a render, never pass one". That is an argument for running it ALWAYS, not for
  // gating it: a check that cannot produce a false pass costs nothing to run, and there
  // was never a reason to make a correct direct reading suppress it. R1's finding cuts
  // the same way — open transcription auto-corrects TOWARDS the truth, so a transcript
  // that volunteers a contradicting volume is reporting a defect against its own bias.
  // One frame reading its volume correctly does not mean every unit in the frame does.
  for (const run of transcript || []) {
    const got = readVolume(run);
    if (!hasVolumeReading(got)) continue;
    if (!agreesWithTruth(got)) {
      return { ok: false, status: 'mismatch', read: String(run).trim(), source: 'transcript', expected: expectedList };
    }
  }

  if (hasVolumeReading(direct)) {
    return { ok: true, status: 'match', read, source: 'reported', expected: expectedList };
  }

  return { ok: true, status: 'illegible', read, source: 'reported', expected: expectedList };
}

// R4. Answers that mean "the render contradicts the reference". Everything that is not
// one of these — including a word nobody anticipated — is read as cannot-tell. The
// asymmetry is deliberate and matches ILLEGIBLE_RE above: a missed check costs one
// unverified attribute, while reading a model's wording slip as a defect costs three
// paid renders of a frame that was correct.
const FIDELITY_MISMATCH_RE = /^(mismatch|mis-match|no|wrong|incorrect|different|differs|false|fail(ed|s)?)\.?$/i;
const FIDELITY_MATCH_RE = /^(match(es|ed)?|yes|correct|same|identical|true|ok)\.?$/i;

/**
 * One reported verdict → 'match' | 'mismatch' | 'cannot-tell'.
 */
export function normalizeFidelityVerdict(verdict) {
  const v = String(verdict ?? '').trim();
  if (FIDELITY_MISMATCH_RE.test(v)) return 'mismatch';
  if (FIDELITY_MATCH_RE.test(v)) return 'match';
  return 'cannot-tell';
}

/**
 * R4. Does the rendered product match the real one?
 *
 * The gate had four checks and all four were about TEXT. A live ingredient-callout frame
 * rendered a squat, wide bottle with a short disc cap, the brand mark halfway down the
 * label, no leaf illustration and the volume set in black on white where the real bottle
 * reverses it out of a black bar — and every expected string was present and correctly
 * spelled, so it was accepted on attempt 1. A human rejected it in one glance. Nothing
 * in the pipeline had ever compared the render to the photographs it was conditioned on.
 *
 * The shape is volumeVerdict's, deliberately — tolerant of "cannot tell", intolerant of
 * "wrong":
 *
 *   no reference photographs sent      → pass  (the question was never asked)
 *   every attribute cannot-tell        → pass  (the small-product case)
 *   any attribute mismatch             → FAIL
 *   reference photographs, no answers  → FAIL  (the check silently did not run)
 *
 * That last case is the pairing check's precedent: "no pairings reported for a layout
 * that pairs images with labels" fails rather than passes, because a check that returns
 * nothing is indistinguishable from a check that was never wired up. It is the one
 * direction where a model formatting slip costs a retry, and it is worth it — the
 * alternative is this whole function quietly doing nothing for a month.
 *
 * @returns {{ok:boolean, status:string, mismatches:Array<{attribute:string,detail:string}>,
 *            answers:Array<{attribute:string,verdict:string,detail:string}>}}
 */
export function fidelityVerdict(fidelity, { hasReference = false } = {}) {
  if (!hasReference) {
    return { ok: true, status: 'no-reference', mismatches: [], answers: [] };
  }

  const answers = (Array.isArray(fidelity) ? fidelity : [])
    .filter(f => f && (f.attribute || f.key))
    .map(f => ({
      attribute: String(f.attribute || f.key).trim(),
      verdict: normalizeFidelityVerdict(f.verdict ?? f.result ?? f.status),
      detail: typeof f.detail === 'string' ? f.detail.trim() : '',
    }));

  if (answers.length === 0) {
    return { ok: false, status: 'unreported', mismatches: [], answers: [] };
  }

  const mismatches = answers
    .filter(a => a.verdict === 'mismatch')
    .map(a => ({ attribute: a.attribute, detail: a.detail }));

  if (mismatches.length) return { ok: false, status: 'mismatch', mismatches, answers };

  // Attributes the model did not answer at all are absent from `answers` and count as
  // cannot-tell — the same tolerance an explicit CANNOT_TELL gets.
  const status = answers.some(a => a.verdict === 'match') ? 'match' : 'cannot-tell';
  return { ok: true, status, mismatches: [], answers };
}

// R5. Inventory `kind` values, and how a word nobody anticipated is read.
//
// The asymmetry is the opposite of FIDELITY_MISMATCH_RE's, on purpose. There, an
// unrecognised word is read as cannot-tell, because a missed check costs one unverified
// attribute while a misread costs three paid renders of a correct frame. Here, the model
// has just told us there IS an object and has described it; the only open question is
// which bucket it falls in. Reading "prop" or "decoration" or "garnish" as `surface`
// would silently drop it from the gate — the exact way the ghost bottle got through — so
// anything that is not clearly a product unit or the ground is treated as `other`.
const INVENTORY_PRODUCT_RE = /^(product[\s-]?unit|product|unit|item|bottle|tube|jar|container|the\s+product)s?\.?$/i;
const INVENTORY_SURFACE_RE = /^(surface|ground|background|backdrop|table|floor|wall|base)s?\.?$/i;

/**
 * One reported `kind` → 'product-unit' | 'surface' | 'other'.
 */
export function normalizeInventoryKind(kind) {
  const k = String(kind ?? '').trim();
  if (INVENTORY_PRODUCT_RE.test(k)) return 'product-unit';
  if (INVENTORY_SURFACE_RE.test(k)) return 'surface';
  return 'other';
}

/**
 * R5. Does the frame contain the product and nothing else?
 *
 * Runs on PLATES only. A finished frame is supposed to carry the furniture its
 * layoutBrief describes, so "does this object belong" has no answer there; a plate is
 * specified as the product on empty ground, which makes the question exact.
 *
 * Two ways to fail, and they are reported separately because they are different bugs:
 *
 *   - the wrong NUMBER of product units. Compared against product.unitCount, never
 *     against a hard-coded 1: foam-soap-bundle is three bottles and both starter sets
 *     are multi-item, so "exactly one" would reject every correct render of them. Too
 *     many catches the ghost second bottle; too few catches a bundle rendered short.
 *     THIS APPLIES IN EVERY SETTING — a ghost bottle is wrong on a lifestyle shot too.
 *   - any `other` object at all — but ONLY when the format's plateSetting is 'studio'.
 *     A 'scene' plate is specified as a real place (`problem-aware`'s everyday moment,
 *     `top-x-review`'s editorial still life), so a counter edge or a soft background
 *     object is the deliverable, not a defect. Strays are still recorded on a scene
 *     plate and still land in proof.json, so a frame that drifted into a prop pile is
 *     visible to a human — they just do not fail it automatically.
 *
 * An EMPTY inventory on a plate is a fail, not a pass. The model was asked for the one
 * thing every frame has at least one of; getting nothing back means the question was not
 * answered, and scoring an unanswered question as clean is how a gate becomes decorative.
 * Same posture as fidelityVerdict's 'unreported'.
 *
 * @param {object[]} inventory
 * @param {{expectedUnits?:number, mode?:string}} opts
 */
export function inventoryVerdict(inventory, { expectedUnits = 1, mode = 'finished', setting = 'studio' } = {}) {
  if (mode !== 'plate') {
    return { ok: true, status: 'not-applicable', units: [], strays: [], expectedUnits, setting };
  }

  const entries = (Array.isArray(inventory) ? inventory : [])
    .filter(e => e && (typeof e.object === 'string' ? e.object.trim() : ''))
    .map(e => ({ object: String(e.object).trim(), kind: normalizeInventoryKind(e.kind) }));

  if (entries.length === 0) {
    return { ok: false, status: 'unreported', units: [], strays: [], expectedUnits, setting };
  }

  const units = entries.filter(e => e.kind === 'product-unit');
  const strays = entries.filter(e => e.kind === 'other');

  // Unit count first, and in every setting. Defaults to 'studio' — the strict side — so a
  // caller that forgets to thread the setting keeps the tighter gate, never the looser one.
  if (units.length !== expectedUnits) {
    return { ok: false, status: 'wrong-unit-count', units, strays, expectedUnits, setting };
  }
  if (strays.length && setting !== 'scene') {
    return { ok: false, status: 'stray-objects', units, strays, expectedUnits, setting };
  }
  return { ok: true, status: strays.length ? 'clean-with-scene' : 'clean', units, strays, expectedUnits, setting };
}

const DEFECT_ISSUES = new Set(['obscured', 'cut-off', 'garbled', 'stray-text']);

// Does this string quote any actual rendered character? Letters and digits only —
// "—", "___" and "[]" quote nothing.
const HAS_GLYPH_RE = /[\p{L}\p{N}]/u;
// A whole-string bracket wrap is the model DESCRIBING a region, not quoting glyphs off
// it: "[black rounded bar, left]", "(the four list rows)". Every false positive in the
// live plate run had this exact shape. The plate prompt tells the model to quote
// characters "glyph by glyph, never a description of a region", so a bracket wrap is a
// reliable tell — and this test runs on plates ONLY, where a bracketed report can only
// mean "there is nothing here". In finished mode "[the closing line]" may well be a real
// occlusion report and is left alone.
const BRACKETED_DESCRIPTION_RE = /^[[(<][\s\S]*[\])>]$/;
// The same statement in words rather than brackets.
const ABSENCE_WORD_RE = /^(blank|empty|none|nothing|no\s+text|not\s+present|absent|missing|n\/?a)\.?$/i;

/**
 * A defect entry that reports the ABSENCE of text rather than quoting text that is
 * present. Only meaningful on a plate, where absence is the specification (R3a).
 */
function isAbsenceReport(text) {
  const t = String(text || '').trim();
  if (!HAS_GLYPH_RE.test(t)) return true;
  if (BRACKETED_DESCRIPTION_RE.test(t)) return true;
  return ABSENCE_WORD_RE.test(t);
}

/**
 * Any reported defect fails the render. A human would reject an ad whose product sits
 * on top of its own closing line — the live manifesto frame did exactly that and the
 * verifier reconstructed the covered word instead of reporting it.
 *
 * Entries with no `text` at all are dropped: an empty object carries nothing a human
 * could act on from the proof file, and treating it as a failure would make a model
 * formatting slip indistinguishable from a real occlusion.
 *
 * On a PLATE (R3a) entries that report an absence are dropped as well. The plate is
 * specified empty wherever copy will later be set, so "this bar has no text in it" is
 * the deliverable and must never fail a render — while text that IS rendered on a plate
 * still fails, because it cannot be fixed by the copy layer. `mode` defaults to
 * 'finished', the strict side, so a caller that forgets to thread it keeps the full
 * obscured/cut-off/garbled gate.
 */
export function normalizeDefects(defects, mode = 'finished') {
  return (defects || [])
    .filter(d => d && typeof d.text === 'string' && d.text.trim())
    .filter(d => mode !== 'plate' || !isAbsenceReport(d.text))
    .map(d => ({
      text: d.text.trim(),
      issue: DEFECT_ISSUES.has(String(d.issue || '').toLowerCase()) ? String(d.issue).toLowerCase() : 'unspecified',
      detail: typeof d.detail === 'string' ? d.detail : '',
    }));
}

/**
 * The pairing requirement applies to FINISHED frames only.
 *
 * A plate is text-free by construction, so it carries no labels, so the vision model
 * correctly reports `pairings: []` — and requiring pairings there made every Demand Gen
 * plate of a pairing format a guaranteed hard fail: 2 formats × 3 plate targets ×
 * 3 variations × 3 attempts = 54 renders (~$7) that could not succeed, with both
 * concepts reported as fully failed even though their Meta frames were fine.
 *
 * For finished frames the check is unchanged and stays exactly as strict — it is the
 * design's centrepiece, the one thing that catches an ad where every word is spelled
 * correctly and jojoba oil is captioned as coconut oil. `mode` defaults to 'finished'
 * so a caller that omits it gets the strict path.
 *
 * @param {{expected:string[], checks:object[], productVolume?:string, defects?:object[],
 *          transcript?:string[], pairings?:object[], format:object, mode?:string,
 *          volumeStrings?:string[]}} args
 */
export function verdictFor({
  expected, checks, productVolume = '', defects = [], transcript = [],
  pairings, format, mode = 'finished', volumeStrings = [],
  fidelity = [], hasReference = false, sceneInventory = [], unitCount = 1,
}) {
  const reasons = [];

  // 1. Per-string checks — the verdict driver (R1).
  const { missing, details } = evaluateChecks(expected, checks);
  if (missing.length) {
    reasons.push(`${missing.length} expected string(s) missing or corrupted in the render`);
    for (const d of details) reasons.push(`  "${d.expected}" — ${d.reason}`);
  }

  // 2. Product volume — illegible passes, wrong fails, on EVERY format (R2). This is
  //    the ONLY mechanism that checks the volume: expectedForFormat subtracts the
  //    volume markings from `expected` so the per-string check never sees them (R2b).
  const volume = volumeVerdict(productVolume, volumeStrings, transcript);
  if (!volume.ok) {
    reasons.push(volume.source === 'transcript'
      ? `product volume marking is WRONG — the verifier could not read it directly but ` +
        `transcribed "${volume.read}" off the frame; the product is ${volume.expected.join(' / ')}`
      : `product volume marking is WRONG — the render shows "${volume.read}", ` +
        `the product is ${volume.expected.join(' / ')}`
    );
  }

  // 3. Product fidelity (R4) — is the rendered product actually our product? Runs in
  //    BOTH modes: unlike the defect question (R3a) this one does not invert, and a
  //    plate is nothing but the product, so it matters there at least as much.
  //    `hasReference` defaults to false, which switches the check OFF rather than
  //    failing every render — a product with no reference photos on file would otherwise
  //    burn three paid attempts per target on a question nothing can answer.
  const productFidelity = fidelityVerdict(fidelity, { hasReference });
  if (!productFidelity.ok) {
    if (productFidelity.status === 'unreported') {
      reasons.push('no product fidelity answers reported while reference photographs were supplied');
    } else {
      reasons.push(
        `rendered product does not match the reference photographs ` +
        `(${productFidelity.mismatches.length} attribute(s))`
      );
      for (const m of productFidelity.mismatches) {
        reasons.push(`  [${m.attribute}]${m.detail ? ` ${m.detail}` : ''}`);
      }
    }
  }

  // 4. Text defects (R3), mode-aware (R3a): on a finished frame, copy that is obscured,
  //    cut off or garbled; on a plate, copy that exists at all outside the product label.
  const reportedDefects = normalizeDefects(defects, mode);
  if (reportedDefects.length) {
    reasons.push(mode === 'plate'
      ? `${reportedDefects.length} text defect(s) — a plate must carry no text except the product's own label`
      : `${reportedDefects.length} text defect(s) — obscured, cut off, or garbled text`);
    for (const d of reportedDefects) reasons.push(`  [${d.issue}] "${d.text}"${d.detail ? ` — ${d.detail}` : ''}`);
  }

  // 4b. Scene inventory (R5) — plates only. Is the product in the frame, in the right
  //     number, with nothing else beside it? This is the check that was missing when a
  //     plate carrying a ghost second bottle, a wood slice, greenery and a coconut passed
  //     every other question in this file.
  const inventory = inventoryVerdict(sceneInventory, {
    expectedUnits: unitCount, mode, setting: format.plateSetting,
  });
  if (!inventory.ok) {
    if (inventory.status === 'unreported') {
      reasons.push('no scene inventory reported for a plate');
    } else if (inventory.status === 'wrong-unit-count') {
      reasons.push(
        `the frame shows ${inventory.units.length} unit(s) of the product, expected ${inventory.expectedUnits}`
      );
      for (const u of inventory.units) reasons.push(`  [unit] ${u.object}`);
    } else {
      reasons.push(`${inventory.strays.length} object(s) in the frame that a plate must not contain`);
      for (const s of inventory.strays) reasons.push(`  [stray] ${s.object}`);
    }
  }

  // 5. Image/label pairing — unchanged, still the design's centrepiece.
  let mismatchedPairs = [];
  if (format.pairsImagesWithLabels && mode === 'finished') {
    if (!pairings || pairings.length === 0) {
      reasons.push('no pairings reported for a layout that pairs images with labels');
    } else {
      mismatchedPairs = pairings.filter(p => p.matches === false);
      if (mismatchedPairs.length) {
        reasons.push(`${mismatchedPairs.length} image/label pairing mismatch(es)`);
      }
    }
  }

  return {
    ok: reasons.length === 0,
    reasons,
    missing,
    checkDetails: details,
    volume,
    fidelity: productFidelity,
    inventory,
    defects: reportedDefects,
    mismatchedPairs,
    // Diagnostic only — see R1. Recorded in proof.json so a human reading a failure can
    // see what the model thought the frame said; nothing in this diff decides anything.
    // (The transcript itself is not entirely inert: volumeVerdict falls back to it when
    // it has no direct volume reading — see R2b. That is the volume mechanism reaching
    // for more evidence about the fact it owns, not this diff gaining teeth.)
    transcriptDiff: diffTranscript(expected, transcript),
  };
}
