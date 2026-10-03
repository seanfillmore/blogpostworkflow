//
// Stage 2: the shot spec (model-written scene), wrapped in code-owned product and scene-text
// blocks, then the take loop. The product block is Ad Studio's own (buildProductFidelityBlock)
// so the two pipelines describe the product in identical words.
import { buildProductFidelityBlock } from '../ad-studio/render.js';

export function sceneTextBlock(sceneText) {
  return sceneText === 'illegible-print'
    ? `PRINT IN THE SCENE: any printed surface the scene describes (paper, a receipt, packaging) shows fine grey hairlines only, like rows of print seen from far away. There are no letters, numbers or symbols on it anywhere. The only readable text in the whole image is our product's own label.`
    : `TEXT: there is no text anywhere except our product's own label. No signs, no packaging copy, no screens with words.`;
}

export function typeBandBlock(typeBand) {
  const where = typeBand === 'bottom' ? 'bottom' : 'top';
  return `Keep the ${where} quarter of the frame clean, evenly lit and empty of objects and fine detail, so type can be set over it later.`;
}

export function unitBlock(unitCount) {
  const n = Number(unitCount);
  return `EXACTLY ${n} UNIT${n === 1 ? '' : 'S'} OF OUR PRODUCT. Any other object the scene describes is a different object and must not resemble our product in shape, colour or label.`;
}

export function buildShotSpecPrompt({ concept, product, ratio }) {
  return `Write the SCENE description for one photorealistic ${ratio} ad image. It will be sent to an image model together with reference photographs of the product, which are described separately, so do NOT describe our product's appearance.

Concept: ${concept.title}. ${concept.picture}
Anchor: ${concept.anchor}. Twist: ${concept.twist}. Our product's role: ${concept.productRole}.
People: ${concept.people}.

Direct it like a film director:
  - one style line (lens, light, mood), then literal blocking: where every object sits relative to the frame and to each other
  - any person's acting as observable behaviour ("brow raised, holding it at arm's length"), never an emotion label
  - no referential language ("same as", "as before", "as established")
  - make it bold and graphic enough to stop a scroll; avoid anything that reads as stock photography
  - our product (${product.title}) is the sharpest, best-lit object in the frame
Return ONLY the scene description as plain prose, under 220 words.`;
}

export function parseShotSpec(text) {
  const s = String(text || '').trim();
  if (!s) throw new Error('ad-concepts: the shot spec came back empty');
  return s;
}

export function buildTakePrompt({ sceneSpec, concept, product, brandKit }) {
  const palette = (brandKit?.palette_hexes || []).join(', ');
  return [
    sceneSpec.trim(),
    typeBandBlock(concept.typeBand),
    sceneTextBlock(concept.sceneText),
    unitBlock(product.unitCount),
    palette ? `Brand palette, for any colour accents: ${palette}.` : '',
    buildProductFidelityBlock(product, { allowPeople: concept.people !== 'none' }),
  ].filter(Boolean).join('\n\n');
}

// onTake runs as soon as a take is verified, so a throw on a LATER take (or later in the
// concept) cannot lose a render that was already paid for and checked.
export async function runConceptTakes({ concept, prompt, render, verify, budget, takes = 3, retryTakes = 2, onTake = null }) {
  const all = [];
  let budgetStopped = false;
  const review = concept.people !== 'none' ? ['anatomy'] : [];

  const shoot = async (count, p) => {
    for (let i = 0; i < count; i++) {
      if (!budget.take()) { budgetStopped = true; return; }
      const buffer = await render(p);
      const { mediaType, proof } = await verify(buffer);
      const take = { n: all.length + 1, buffer, mediaType, proof, needsHumanReview: review };
      all.push(take);
      if (onTake) await onTake(take);
    }
  };

  await shoot(takes, prompt);
  let repaired = false;
  if (!budgetStopped && !all.some(t => t.proof.ok)) {
    repaired = true;
    const reasons = [...new Set(all.flatMap(t => t.proof.reasons || []))].slice(0, 12);
    await shoot(retryTakes, `${prompt}\n\nPREVIOUS TAKES FAILED these checks. Fix them:\n${reasons.map(r => `- ${r}`).join('\n')}`);
  }
  return { takes: all, passed: all.filter(t => t.proof.ok), budgetStopped, repaired };
}
