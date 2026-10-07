// agents/ad-batch/prompt.js
//
// One finished-ad prompt per (headline, scene). The structure is the one the
// 2026-10-06 spike proved on three products (29 of 29 exact-text renders):
// exact product description + exact label strings, product as hero, one-line scene,
// a named type pairing, and an explicit "no other text" rule.

/** Packaged or unwrapped for this scene. Unwrapped only exists for the bar soap today. */
export function productForm({ product, scene, form }) {
  const canUnwrap = product.refs.unwrapped.length > 0 && !!product.unwrappedDescription;
  if (!canUnwrap) return 'packaged';
  if (form === 'unwrapped') return 'unwrapped';
  if (form === 'packaged') return 'packaged';
  return scene.inUse ? 'unwrapped' : 'packaged';
}

export function buildPrompt({ product, concept, scene, form = null }) {
  const shown = productForm({ product, scene, form });
  const count = product.unitCount || 1;
  const productBlock = shown === 'unwrapped'
    ? `PRODUCT (must match the reference photos exactly): ${product.unwrappedDescription}
It is NOT a rectangle, NOT pure white, and has NO stamp, engraving or text on it.`
    : `PRODUCT (must match the reference photos exactly): ${product.description}
The printed label reads exactly: ${product.labelStrings.map(s => `"${s}"`).join(', ')}. Do not invent, alter, add or remove any label text or graphics.`;

  const lines = [`"${concept.headline}" is the headline: the dominant lettering, large.`];
  if (concept.subhead) lines.push(`"${concept.subhead}" is the subhead: smaller, set directly beneath the headline.`);

  return {
    shown,
    refs: shown === 'unwrapped' ? product.refs.unwrapped : product.refs.packaged,
    prompt: `Design a finished, scroll-stopping vertical social media ad (4:5) for Real Skin Care "${product.title}".

${productBlock}
Show exactly ${count === 1 ? 'one' : count} of this product.${/\bjar\b/i.test(product.description) && shown === 'packaged' ? ' Where it suits the scene, the lid may sit off to the side so the rich product is visible in the open jar.' : ''} The product is the hero: large, sharp, in the lower-center of the frame, about 45-55% of the frame height. Props never cover the label. Other generic objects in the scene are fine.

SCENE / THEME: ${scene.scene}. Premium commercial photography, shallow depth of field, rich and believable.

HEADLINE TYPOGRAPHY (designed into the image, in the top 25-30% of the frame, clear of the outer edges):
${lines.join('\n')}
Lettering style: ${scene.typeStyle}. You may break the headline across lines and mix the two typefaces for emphasis, as a designed lockup.
Use EXACTLY these words with correct spelling, in this order. Never add, drop, change or reorder a word. No other text anywhere in the image: no badges, seals, logos, claims, captions, review stars, prices or icons, apart from the printed product label. Colors harmonize with the scene and stay highly legible.`,
  };
}
