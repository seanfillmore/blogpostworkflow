// agents/ad-studio/render.js
//
// Stage 3. ONE generative pass per variation — never feed a render back in for a second
// pass. A second pass shifts supporting images against their labels (jojoba oil captioned
// as coconut oil) while spelling every word correctly, so a text-only check passes it.
//
// The product is generated IN the scene, conditioned on real photographs. Compositing a
// transparent cutout onto a generated background reads as a sticker: wrong light, wrong
// contact shadow, wrong perspective.

import { UNSCENTED_VARIANT_RE } from './verify.js';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { CREATIVE_MODELS } from '../../config/creative-models.js';
import { SAFE_ZONE_RATIOS } from './critique.js';

const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

/**
 * Deterministic, capped selection of reference photographs for one product variant.
 * @param {string} dir
 * @param {number} [max=4]
 * @returns {string[]} absolute paths
 */
export function selectReferencePhotos(dir, max = 4) {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => IMAGE_EXT.test(f))
    .sort()
    .slice(0, max)
    .map(f => join(dir, f));
}

/**
 * @param {{format:object, zones:object, product:object, brandKit:object, mode:'finished'|'plate'}} args
 * @returns {string}
 */
export function buildRenderPrompt({ format, zones, product, brandKit, mode, ratio = '' }) {
  if (mode !== 'finished' && mode !== 'plate') throw new Error(`unknown mode: ${mode}`);

  // Template literals stringify undefined rather than failing, so a format missing its
  // brief would ship the word "undefined" to a paid image call and render whatever the
  // model made of it. formats.js validates the real table at load; this catches a caller
  // that hand-builds a format object.
  const briefField = mode === 'plate' ? 'plateBrief' : 'layoutBrief';
  const brief = String(format?.[briefField] || '').trim();
  if (!brief) throw new Error(`ad-studio: format "${format?.key}" has no ${briefField}`);

  const palette = (brandKit?.palette_hexes || []).join(', ');
  const labels = (product.labelStrings || []).map(s => `  - "${s}"`).join('\n');

  // The manifest's prose description of the physical product. Naming what the label SAYS
  // without describing what the bottle IS is how a live frame came back squat and wide,
  // with a short disc cap and no black accent bar, while spelling every string correctly
  // — so the text gate accepted it on attempt 1. The sister agent learned this first
  // (PR #314, "faithful product renders ... pass product descriptions"); this is the
  // same lesson applied here. Omitted entirely when a product has none on file, rather
  // than rendered as an empty heading.
  // THE DESCRIPTION IS PER-PRODUCT; THE RENDER IS PER-VARIANT. Five RSC manifest entries
  // describe a badge reading "Made with Organic Coconut Oil + Essential Oils" and a
  // "botanical illustration matching the scent" — true of the product LINE, false of its
  // unscented variant, whose entire proposition is that it contains neither. Handing that
  // prose to the renderer for `pure-unscented` is instructing it to print a claim the
  // product does not make, and on 2026-08-18 it did exactly that: a plate came back with
  // "ORGANIC COCONUT OIL + ESSENTIAL OILS" on the unscented bar.
  //
  // copy.js has carried a variantBlock for this for a while — the COPY writer is told not to
  // claim a sibling variant's ingredients. The renderer never got the same warning, so the
  // gate downstream was catching a defect this prompt had asked for. Prevention beats
  // detection here for the usual reason: a rejected plate costs the full retry budget.
  const physical = String(product.physicalDescription || '').trim();
  const unscented = UNSCENTED_VARIANT_RE.test(String(product.variant || ''));
  const variantCorrection = unscented ? `
THIS IS THE UNSCENTED VARIANT, and the description above covers the whole product line. It
has NO essential oils and NO fragrance. Any badge on the label names ONLY the coconut oil —
never "+ Essential Oils" — and no botanical illustration stands for a scent this variant does
not have. Where the description and this paragraph disagree, THIS paragraph is correct.
` : '';
  const physicalBlock = physical ? `
PHYSICAL FORM — the product on file is described as:
${physical}
Match that description as well as the photographs. Bottle proportions, the height and shape
of the cap, and any solid colour bars or blocks on the label are part of the product's
identity, not styling you may reinterpret.
${variantCorrection}` : variantCorrection;

  const fidelity = `PRODUCT FIDELITY IS THE HIGHEST PRIORITY.
The supplied photographs are the SAME product from multiple angles. Study them and reproduce
it exactly: proportions, cap, finish, and every element of the printed label in the correct
order, at the correct relative size, with correct spelling.
${physicalBlock}The label carries exactly these strings and no others:
${labels}
Never render any other volume, size or count on the product.
The product must be generated as part of the scene, lit and shadowed to match it, resting
naturally on the surface. Do not paste it in flat. No human hands or faces.`;

  const brand = `Brand palette: ${palette}. Premium natural personal-care; clean grocery-modern,
not clinical, not crunchy. Bold geometric sans headlines.`;

  // The platform draws its own UI over a vertical frame, so copy placed in those bands is
  // invisible where it ships. critique.js hard-fails that — and on the first live run it
  // did so three times in a row on ingredient-callout, whose brief mandates a bottom bar,
  // because nothing had told the RENDERER the bottom fifth was unusable. A check the
  // layout cannot satisfy is not a gate, it is a tax on every attempt.
  //
  // Only for gated ratios (SAFE_ZONE_RATIOS, currently 9:16) and only for finished frames:
  // a plate carries no copy to place, and a feed image has nothing drawn over it, so the
  // instruction would just shrink the usable area for nothing.
  const safe = mode === 'finished' ? SAFE_ZONE_RATIOS[ratio] : null;
  const safeZoneBlock = safe ? `
SAFE ZONE — this is a vertical ${ratio} frame for Instagram/Facebook Stories and Reels. The
platform covers the ${safe.topFraction} of the frame with the account name and "Ad" label,
and the ${safe.bottomFraction} with its like/comment/share controls.
Keep ALL text — headline, body copy, any bottom bar, any price or offer badge — inside the
middle band, clear of both. The background, and the product itself, may extend to the edges;
it is only text that must stay out. If the layout described above calls for a bar or a strip
at the bottom, inset it so it sits ABOVE the ${safe.bottomFraction}, with clean background
below it.
` : '';

  // How many units belong in the frame. Driven by product.unitCount, never by a constant:
  // four of eleven RSC products are genuinely multi-unit, and "exactly one" would reject
  // every correct render of the foam soap bundle, the lip balm four-pack and both starter
  // sets. The ghost-second-bottle case and the bundle case are the same question asked
  // from opposite sides, so one number answers both.
  // Validated only where it is used. `Number(undefined)` is NaN, and NaN !== 1, so an
  // unvalidated missing count would fall through to the plural branch and ship the literal
  // string "EXACTLY NaN UNITS" to a paid render — the same silent-stringify hole as a
  // missing brief, one line further down.
  const units = Number(product?.unitCount);
  if (mode === 'plate' && (!Number.isInteger(units) || units < 1)) {
    throw new Error(`ad-studio: product "${product?.handle}" has no valid unitCount (got ${JSON.stringify(product?.unitCount)})`);
  }
  const unitClause = units === 1
    ? `EXACTLY ONE UNIT OF THE PRODUCT, and nothing else in the frame. No second bottle, tube
or jar, not even a faded, blurred, ghosted, reflected or partially cropped one.`
    : `EXACTLY ${units} UNITS — this product IS a set of ${units} pieces, described under
PHYSICAL FORM above. Render those ${units} and nothing else: no extra unit beyond them, and
no faded, blurred, ghosted, reflected or partially cropped duplicate of any of them.`;

  // What may share the frame with the product. Driven by format.plateSetting, because the
  // first cut of this forbade every setting on every format and flattened `problem-aware`
  // and `top-x-review` into the same studio shot as the rest — throwing away the one thing
  // those two formats are for. What put a coconut and a wood slice on the 2026-08-15 plate
  // was the finished ad's INGREDIENT ROW, not the existence of a room.
  //
  // Both branches forbid the same two things, and they are the things that actually went
  // wrong: ad furniture the operator sets by hand, and ingredient/botanical styling.
  const settingClause = format.plateSetting === 'scene'
    ? `THIS IS A REAL SETTING, NOT A STYLED SET. Ordinary things that genuinely belong in the
place described above may appear, softly and out of focus, well away from the product. Do
NOT dress the scene: no ingredients, no fruit, nuts, seeds, leaves, sprigs or greenery, no
wood slices, no arranged flat-lay of objects around the product, and nothing chosen to
signal what the product is made of. Those are artwork, and they are placed by hand later.
Anything in the frame must read as incidental, never as arranged.`
    : `NO PROPS AND NO SCENE DRESSING of any kind: no ingredients, no fruit or nuts, no leaves
or greenery, no wood slices, boards, trays, bowls, cloths, stones, water, splashes, towels
or bathroom fittings. The ground is a plain, even surface and nothing rests on it but the
product.`;

  if (mode === 'plate') {
    // format.plateBrief, NEVER format.layoutBrief. layoutBrief describes the finished ad —
    // its columns, rules, ingredient cut-outs and lifestyle scene — and feeding it here is
    // what put wood slices, a coconut and a second half-faded bottle on a plate that then
    // passed the gate (2026-08-15). The negations below did not save it: they were arguing
    // with a positive instruction sitting directly above them. formats.js throws at load
    // if a plateBrief is missing, so there is no fallback path back to layoutBrief.
    return `${brief}

${brand}

${fidelity}

THIS IS AN AD BASE, NOT A FINISHED ADVERTISEMENT AND NOT A BACKGROUND. Compose it exactly
as described above: put the product at the SIZE and in the POSITION called for, so the
frame reads as a real advertisement with its copy not yet set. Do not re-centre the product
and do not shrink it to be safe.

${unitClause}

${settingClause}

ABSOLUTELY NO TEXT, NO LETTERS, NO WORDS and NO NUMBERS anywhere in the image, except the
product's own printed label, which must be complete and correct.

NO ICONS, NO ILLUSTRATIONS, NO PICTOGRAMS, NO BADGES, NO SEALS and NO LOGOS anywhere except
those printed on the product's own label. The headline, the ingredient row, the checklist,
the comparison columns and the offer badge are all set by hand afterwards — leave every one
of those areas as empty ground.

Every area where copy or an icon would later sit must be clean, uncluttered and generously
sized, with an even surface that type can be set onto legibly.`;
  }

  const copyBlock = Object.entries(zones || {})
    .map(([zone, value]) => {
      const body = Array.isArray(value) ? value.map(v => `    - "${v}"`).join('\n') : `    "${value}"`;
      return `  ${zone}:\n${body}`;
    })
    .join('\n');

  return `${brief}

${brand}
${safeZoneBlock}
EXACT TEXT TO RENDER — reproduce every string below character for character, spelled
correctly and perfectly legible. Do not add any text that is not listed here.
${copyBlock}

${fidelity}`;
}

/**
 * The COMP pass: take a finished plate and show what it looks like with the copy set.
 *
 * This is a SECOND generative pass over a rendered image, which the rest of this pipeline
 * refuses to do — see the note in CLAUDE.md. It is allowed here, and only here, because of
 * what it is applied to and what it produces:
 *
 *   - The plate has ALREADY been verified and is the artifact that ships. It is not
 *     modified; the comp is a separate file.
 *   - The comp is a throwaway picture of what the ad could look like. Drift in it costs
 *     nothing, because nobody uploads it.
 *   - The original probe's failure mode was image/label pairing drift — ingredient photos
 *     shifting one row against their captions. A plate carries no icons and no captions
 *     now, so there are no pairings on it to shift.
 *
 * The instruction mirrors the Creatives tab's upscale path, which resubmits an image with
 * "keep everything identical" and holds composition well enough in practice.
 */
export function buildCompPrompt({ zones, format }) {
  const copyBlock = Object.entries(zones || {})
    .map(([zone, value]) => {
      const body = Array.isArray(value) ? value.map(v => `    - "${v}"`).join('\n') : `    "${value}"`;
      return `  ${zone}:\n${body}`;
    })
    .join('\n');

  // The comp MUST carry format.layoutBrief. Without it this asked only for copy placed
  // "sensibly", so every comp came back as the same generic arrangement no matter which
  // format produced it — a testimonial and a stat-stack were indistinguishable.
  //
  // That was tolerable while the comp was scenery. It is not any more: the operator
  // rebuilds the ad in Photoshop FROM the comp, so the comp is the design reference and
  // its job is to show the format's actual structure — the two columns, the arrows off
  // the hero, the quote — not merely that words fit somewhere.
  const layout = String(format?.layoutBrief || '').trim();

  return `Turn this image into a finished advertisement.

KEEP THE PRODUCT EXACTLY AS IT IS — same position in the frame, same scale, same angle,
same lighting and colours. Do not move it, resize it, re-render it or replace it. It is the
one fixed element; everything else is built around it.

${layout ? `THE ADVERTISEMENT TO BUILD:
${layout}

Follow that layout as closely as the product's existing position allows. Where the layout
calls for a structure the product now sits in the way of, move the STRUCTURE, never the
product.

` : ''}EXACT COPY TO SET — use these strings, in these zones:
${copyBlock}

Use a clean geometric sans. Keep all type clear of the outer edges of the frame.

This is a visual comp: it shows what the finished ad should look like so a designer can
rebuild it by hand. Layout, hierarchy and structure are what matter — get those right even
if small type renders imperfectly.`;
}

/**
 * One image generation call.
 * @param {object} gemini a @google/genai client
 * @param {{prompt:string, photoPaths:string[], ratio:string}} args
 * @returns {Promise<Buffer>}
 */
export async function renderVariation(gemini, { prompt, photoPaths, ratio, inputImage = null }) {
  const parts = [];
  // The comp pass sends the finished PLATE back in and asks for copy to be set onto it.
  // It goes first so the model reads it as the subject, with the reference photographs
  // (if any) as supporting context rather than the other way round.
  if (inputImage) {
    parts.push({ inlineData: { data: inputImage.data, mimeType: inputImage.mimeType } });
  }
  for (const p of photoPaths || []) {
    parts.push({
      inlineData: {
        data: readFileSync(p).toString('base64'),
        mimeType: MIME[extname(p).toLowerCase()] || 'image/jpeg',
      },
    });
  }
  parts.push({ text: prompt });

  const res = await gemini.models.generateContent({
    model: CREATIVE_MODELS.adStudio.imageGen,
    contents: [{ role: 'user', parts }],
    config: { responseModalities: ['IMAGE', 'TEXT'], imageConfig: { imageSize: '2K', aspectRatio: ratio } },
  });

  const img = res?.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
  if (!img) throw new Error('ad-studio: Gemini returned no image');
  return Buffer.from(img.inlineData.data, 'base64');
}
