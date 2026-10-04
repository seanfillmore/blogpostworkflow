// agents/ad-concepts/plates.js
//
// Plate-level checks and prompts for the structure pipeline.
//  - buildScenePrompt: library scene (primary | fallback) + code-owned phone look, no-text,
//    unit and label-ink blocks, and Ad Studio's product fidelity block. A product-free plate
//    (e.g. the left half of a split) gets only the preamble, the scene and a hard no-text line.
//  - checkStrayText: fails CLOSED vision check that a product-free plate carries no text/logo.
import { buildProductFidelityBlock } from '../ad-studio/render.js';
import { unitBlock } from './shots.js';

export const PHONE_LOOK = 'A casual, photorealistic smartphone photo: natural daylight, slightly imperfect framing, real camera-roll look with a touch of grain, true-to-life colour, nothing staged or glossy like studio product photography.';

const textOf = (msg) => (msg?.content || []).filter(b => b.type === 'text').map(b => b.text).join('');

export function buildStrayTextPrompt() {
  return `This is one photograph meant to contain NO text and NO branding at all.
Check ONLY for:
  - hasText: is any readable text, letters, numbers or symbols visible anywhere (on any object, label, packaging, sign, screen or surface)?
  - hasLogo: is any logo, brand mark or printed brand graphic visible anywhere?
Look closely at every object. Do not assume it is fine.

Return ONLY: {"hasText":false,"hasLogo":false,"detail":"one sentence naming what text or logo is visible, empty if none"}`;
}

export function parseStrayText(text) {
  const s = String(text || '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  let o = null;
  if (a !== -1 && b > a) { try { o = JSON.parse(s.slice(a, b + 1)); } catch { o = null; } }
  if (!o || typeof o.hasText !== 'boolean' || typeof o.hasLogo !== 'boolean') {
    return { ok: false, detail: `stray-text check unparseable, treated as a failure: ${s.slice(0, 160)}` };
  }
  const detail = String(o.detail || '').trim();
  if (o.hasText || o.hasLogo) return { ok: false, detail: detail || (o.hasText ? 'readable text is visible' : 'a logo is visible') };
  return { ok: true, detail };
}

export async function checkStrayText({ anthropic, model, buffer, mediaType }) {
  const msg = await anthropic.messages.create({
    model,
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: buffer.toString('base64') } },
        { type: 'text', text: buildStrayTextPrompt() },
      ],
    }],
  });
  if (msg.stop_reason === 'max_tokens') throw new Error('ad-concepts: the stray-text check was cut off at the token limit');
  return parseStrayText(textOf(msg));
}

const fill = (tpl, vars) => String(tpl).replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m));

// `plate` (optional) is one entry of structure.plates[]; its scene and productFree win.
export function buildScenePrompt({ structure, which = 'primary', product, brandKit, plate = null }) {
  const src = plate?.scene || structure.scene || {};
  const tpl = which === 'fallback' ? (src.fallback || src.primary) : src.primary;
  if (!tpl) throw new Error(`ad-concepts: structure "${structure?.id}" has no ${which} scene`);
  const scene = fill(tpl, {
    productNoun: product?.productNoun || String(product?.title || 'product').toLowerCase(),
    productDescriptionShort: product?.productDescriptionShort || product?.physicalDescription || '',
  }).trim();
  if (plate?.productFree) {
    return [PHONE_LOOK, scene, 'No logo, no printing, no text anywhere in the image.'].join('\n\n');
  }
  const palette = (brandKit?.palette_hexes || []).join(', ');
  return [
    PHONE_LOOK,
    scene,
    `TEXT: there is no text anywhere in the image except our product's own printed label.`,
    unitBlock(product.unitCount),
    product.labelInk ? `All printed type on our product's label is ${product.labelInk} ink; only the botanical illustration is in colour.` : '',
    palette ? `Brand palette, for any colour accents: ${palette}.` : '',
    buildProductFidelityBlock(product, { allowPeople: structure.people !== 'none' }),
  ].filter(Boolean).join('\n\n');
}
