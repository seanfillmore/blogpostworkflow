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
export function buildRenderPrompt({ format, zones, product, brandKit, mode }) {
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

  if (mode === 'plate') {
    return `${format.layoutBrief}

${brand}

${fidelity}

ABSOLUTELY NO TEXT, NO LETTERS, NO WORDS and NO NUMBERS anywhere in the image, except the
product's own printed label, which must be complete and correct. Leave every area where copy
would sit completely empty and clean, generously sized, so text can be set into it later.`;
  }

  const copyBlock = Object.entries(zones || {})
    .map(([zone, value]) => {
      const body = Array.isArray(value) ? value.map(v => `    - "${v}"`).join('\n') : `    "${value}"`;
      return `  ${zone}:\n${body}`;
    })
    .join('\n');

  return `${format.layoutBrief}

${brand}

EXACT TEXT TO RENDER — reproduce every string below character for character, spelled
correctly and perfectly legible. Do not add any text that is not listed here.
${copyBlock}

${fidelity}`;
}

/**
 * One image generation call.
 * @param {object} gemini a @google/genai client
 * @param {{prompt:string, photoPaths:string[], ratio:string}} args
 * @returns {Promise<Buffer>}
 */
export async function renderVariation(gemini, { prompt, photoPaths, ratio }) {
  const parts = [];
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
