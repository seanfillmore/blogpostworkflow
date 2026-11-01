// agents/ad-batch/prompt.js
//
// One finished-ad prompt per (headline, scene). The structure is the one the
// 2026-10-06 spike proved on three products (29 of 29 exact-text renders):
// exact product description + exact label strings, product as hero, one-line scene,
// a named type pairing, and an explicit "no other text" rule.
//
// style 'animated' (2026-10-20) keeps every one of those rules and changes three
// things: the scene is a stylized 3D-animated world with characters, OUR product is
// the one object kept photo-real and exact, and it is smaller (held by a character or
// in the foreground) instead of filling half the frame. The label check is identical.

/** Packaged or unwrapped for this scene. Unwrapped only exists for the bar soap today. */
export function productForm({ product, scene, form }) {
  const canUnwrap = product.refs.unwrapped.length > 0 && !!product.unwrappedDescription;
  if (!canUnwrap) return 'packaged';
  if (form === 'unwrapped') return 'unwrapped';
  if (form === 'packaged') return 'packaged';
  return scene.inUse ? 'unwrapped' : 'packaged';
}

/** The product block for a set: each product described on its own, one of each, side by side. */
function setBlock(product) {
  const n = product.items.length;
  const each = product.items.map((p, i) => `PRODUCT ${i + 1} (reference photo ${i + 1}; must match it exactly): ${p.description}
Its printed label reads exactly: ${p.labelStrings.map(s => `"${s}"`).join(', ')}.`).join('\n\n');
  return `This ad shows a SET of ${n} different products together. Do not invent, alter, add or remove any label text or graphics on any of them.

${each}

Show exactly ONE of each of the ${n} products, and no other unit of any of them. They stand together as a group, side by side or slightly overlapping, every label facing the camera and fully readable. Keep their real relative sizes: do not scale one product up or down to match another. Together they are the hero: large, sharp, in the lower-center of the frame, the tallest about 45-55% of the frame height. Props never cover a label. Other generic objects in the scene are fine.`;
}

const PHOTO_PLACEMENT = 'The product is the hero: large, sharp, in the lower-center of the frame, about 45-55% of the frame height. Props never cover the label. Other generic objects in the scene are fine.';

const ANIMATED_PLACEMENT = 'The product is clearly visible and sharp, about 25-35% of the frame height, held up by a character or standing in the foreground, its label facing the camera and fully readable. Hands and props never cover the label. Other generic objects in the scene are fine.';

const ANIMATED_RENDER = `ART STYLE: a polished, stylized 3D-animated feature-film look: expressive cartoon characters with big, readable emotions, soft cinematic lighting with a gentle rim light, a simple uncluttered backdrop. The characters act out the headline. OUR product is the one object NOT stylized: render it photo-real and exactly like the reference photo, so its label is crisp and readable. Any other product a character holds is generic and unbranded, or carries only a made-up parody name; never a real brand.`;

export function buildPrompt({ product, concept, scene, form = null, style = 'photo' }) {
  const isSet = Array.isArray(product.items) && product.items.length > 1;
  const shown = isSet ? 'packaged' : productForm({ product, scene, form });
  const count = product.unitCount || 1;
  const productBlock = isSet ? setBlock(product) : shown === 'unwrapped'
    ? `PRODUCT (must match the reference photos exactly): ${product.unwrappedDescription}
It is NOT a rectangle, NOT pure white, and has NO stamp, engraving or text on it.`
    : `PRODUCT (must match the reference photos exactly): ${product.description}
The printed label reads exactly: ${product.labelStrings.map(s => `"${s}"`).join(', ')}. Do not invent, alter, add or remove any label text or graphics.`;

  const animated = style === 'animated';
  const lines = [`"${concept.headline}" is the headline: the dominant lettering, large.`];
  if (concept.subhead) lines.push(`"${concept.subhead}" is the subhead: smaller, set directly beneath the headline.`);
  if (concept.cta) lines.push(`"${concept.cta}" sits in a small rounded pill-shaped button beneath the headline, like a link button in a social post.`);

  return {
    shown,
    refs: shown === 'unwrapped' ? product.refs.unwrapped : product.refs.packaged,
    prompt: `Design a finished, scroll-stopping vertical social media ad (4:5) for Real Skin Care "${product.title}".

${isSet ? productBlock : `${productBlock}
Show exactly ${count === 1 ? 'one' : count} of this product.${/\bjar\b/i.test(product.description) && shown === 'packaged' ? ' Where it suits the scene, the lid may sit off to the side so the rich product is visible in the open jar. The jar is EITHER open (lid fully off and set aside, cream visible inside the rim) OR closed (lid screwed on, no cream visible anywhere). Never show cream on top of, around or coming through a lid that is on the jar.' : ''} ${animated ? ANIMATED_PLACEMENT : PHOTO_PLACEMENT}`}

SCENE / THEME: ${scene.scene}. ${animated ? ANIMATED_RENDER : 'Premium commercial photography, shallow depth of field, rich and believable.'}

HEADLINE TYPOGRAPHY (designed into the image, in the top 25-30% of the frame, clear of the outer edges):
${lines.join('\n')}
Lettering style: ${scene.typeStyle}. You may break the headline across lines and mix the two typefaces for emphasis, as a designed lockup.
Use EXACTLY these words with correct spelling, in this order. Never add, drop, change or reorder a word. No other text anywhere in the image: no badges, seals, logos, claims, captions, review stars, prices or icons, apart from the printed product label${animated ? ' and, only where the scene calls for one, a made-up parody name on a generic product a character holds' : ''}. Colors harmonize with the scene and stay highly legible.`,
  };
}
