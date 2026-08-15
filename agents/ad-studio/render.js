// agents/ad-studio/render.js
//
// Stage 3. ONE generative pass per variation — never feed a render back in for a second
// pass. A second pass shifts supporting images against their labels (jojoba oil captioned
// as coconut oil) while spelling every word correctly, so a text-only check passes it.
//
// The product is generated IN the scene, conditioned on real photographs. Compositing a
// transparent cutout onto a generated background reads as a sticker: wrong light, wrong
// contact shadow, wrong perspective.

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

  const palette = (brandKit?.palette_hexes || []).join(', ');
  const labels = (product.labelStrings || []).map(s => `  - "${s}"`).join('\n');

  // The manifest's prose description of the physical product. Naming what the label SAYS
  // without describing what the bottle IS is how a live frame came back squat and wide,
  // with a short disc cap and no black accent bar, while spelling every string correctly
  // — so the text gate accepted it on attempt 1. The sister agent learned this first
  // (PR #314, "faithful product renders ... pass product descriptions"); this is the
  // same lesson applied here. Omitted entirely when a product has none on file, rather
  // than rendered as an empty heading.
  const physical = String(product.physicalDescription || '').trim();
  const physicalBlock = physical ? `
PHYSICAL FORM — the product on file is described as:
${physical}
Match that description as well as the photographs. Bottle proportions, the height and shape
of the cap, and any solid colour bars or blocks on the label are part of the product's
identity, not styling you may reinterpret.
` : '';

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

  if (mode === 'plate') {
    return `${format.layoutBrief}

${brand}

${fidelity}

THIS IS AN AD BASE, NOT A BACKGROUND. Compose it exactly as the layout above describes:
put the product at the SIZE and in the POSITION that layout calls for, so the frame reads
as a real advertisement with its copy not yet set. Do not centre the product or shrink it
to be safe.

ABSOLUTELY NO TEXT, NO LETTERS, NO WORDS and NO NUMBERS anywhere in the image, except the
product's own printed label, which must be complete and correct.

NO ICONS, NO ILLUSTRATIONS, NO PICTOGRAMS, NO INGREDIENT IMAGES, NO BADGES and NO LOGOS
anywhere except those printed on the product's own label. Where the layout calls for a row
of ingredient photographs, a checklist, a comparison column or a seal, leave that area
EMPTY and clean — those elements are placed by hand afterwards.

Every area where copy or an icon would sit must be clean, uncluttered and generously
sized, with an even surface that type can be set onto legibly.`;
  }

  const copyBlock = Object.entries(zones || {})
    .map(([zone, value]) => {
      const body = Array.isArray(value) ? value.map(v => `    - "${v}"`).join('\n') : `    "${value}"`;
      return `  ${zone}:\n${body}`;
    })
    .join('\n');

  return `${format.layoutBrief}

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
export function buildCompPrompt({ zones }) {
  const copyBlock = Object.entries(zones || {})
    .map(([zone, value]) => {
      const body = Array.isArray(value) ? value.map(v => `    - "${v}"`).join('\n') : `    "${value}"`;
      return `  ${zone}:\n${body}`;
    })
    .join('\n');

  return `Keep this image IDENTICAL — same composition, same product, same position and
scale, same background, same lighting, same colours. Change nothing about the scene.

Set the following advertising copy into the empty areas of the image, choosing sensible
placement, size and hierarchy for a finished advertisement. Use a clean geometric sans.

${copyBlock}

Keep all type clear of the outer edges of the frame. This is a rough visual comp for
review — the final type is set by hand afterwards.`;
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
