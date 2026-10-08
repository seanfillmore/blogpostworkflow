/**
 * Mixed-product bundle galleries (Clean Swap, 90-Day Clean Swap, Head-to-Toe,
 * Gift Box, 90-Day Coconut Reset): what to render per kit and how to judge it.
 * Pure — no network, no filesystem.
 *
 * Built on lib/ladder-gallery.js and deliberately NOT a copy of it: the product
 * descriptions (UNIT), the props ban and the code-decided verdict (`judge`) are
 * imported, because two copies of "what a lotion bottle looks like" is how the
 * squat-bottle defect Sean caught on 2026-10-07 would come back on one surface
 * after being fixed on the other.
 *
 * What differs from a ladder tier is that one image holds DIFFERENT products, so a
 * unit is identified by product AND scent ("body lotion pure unscented"), and the
 * vision read transcribes both. Sizes are stated from the same physical-scale
 * basis the old composites used (data/brand/frames/head-to-toe/h2t-common.mjs), so
 * a lip balm is never drawn the height of a lotion bottle.
 *
 * Per kit: a HERO (exactly what ships, at true relative scale), an OFFER (the
 * kit's price against the products bought separately) and a SCENE (one of each
 * product, in use at home). The bundle-landing template gang-scopes media by alt
 * suffix, so every frame is per kit.
 *
 * GIFT BOX: data/brand/packaging/README.md forbids showing products nested inside
 * the open mailer — nobody has photographed that arrangement and a render would
 * manufacture one. The products stand BESIDE the closed box instead, which shows
 * two real things without inventing how they are packed.
 */

import { NO_PROPS } from './pdp-frame-prompts.js';
import { UNIT, judge } from './ladder-gallery.js';
import { tokens } from '../agents/ad-batch/check.js';

export { judge };
const money = (n) => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`);

/** Display name, physical height basis (cm), and how many sellable pieces one component is. */
export const PRODUCT = {
  'organic-foaming-hand-soap': { name: 'hand soap', cm: 21.5, per: 1 },
  'coconut-lotion': { name: 'body lotion', cm: 17.2, per: 1 },
  'coconut-oil-toothpaste': { name: 'toothpaste', cm: 15.5, per: 1 },
  'coconut-oil-deodorant': { name: 'deodorant', cm: 13.0, per: 1 },
  'coconut-soap': { name: 'bar soap', cm: 8.9, per: 1, note: '8.9 cm across, lying flat or propped on its edge' },
  'coconut-oil-lip-balm': { name: 'lip balm', cm: 6.8, per: 4, note: 'a four-pack: four separate tubes of the same scent' },
  'coconut-moisturizer': { name: 'body cream', cm: 6.4, per: 1, note: 'a squat jar, wider than it is tall' },
};

export const BUNDLES = {
  'clean-swap': {
    option: 'Kit',
    scene: 'a bright, clean bathroom counter beside a white basin in soft morning window light',
  },
  '90-day-clean-swap': {
    option: 'Kit',
    scene: 'a bright, tidy open bathroom cabinet shelf with folded white towels, the products set out in a row as if just unpacked',
  },
  'head-to-toe': {
    option: 'Kit',
    scene: 'a bright, calm bathroom with a white vanity and a round mirror, the products arranged along the back of the counter',
  },
  'gift-box': {
    option: 'Kit',
    giftBox: true,
    scene: 'a warm, softly lit living-room side table, the closed white Real Skin Care gift mailer with the products standing beside it, as if about to be given',
  },
  '99-coconut-reset-digital': {
    option: 'Scent',
    keepHero: true, // the live hero and lounge photo are REAL photographs; only offer + scene are generated
    scene: 'a calm bedroom nightstand in soft evening lamp light, the lotion bottles and cream jars standing in a neat group',
  },
};

/** Units that ship for one kit, one entry per physical piece, largest product first. */
export function kitUnits(kit) {
  const out = [];
  for (const c of kit.components) {
    const p = PRODUCT[c.product];
    if (!p) throw new Error(`no PRODUCT entry for ${c.product}`);
    for (let i = 0; i < c.qty * p.per; i++) out.push({ product: c.product, scent: c.variant });
  }
  return out.sort((a, b) => PRODUCT[b.product].cm - PRODUCT[a.product].cm);
}

/** One of each product in the kit — what a scene shows. */
export function sceneUnitsOf(kit) {
  const seen = new Set();
  return kitUnits(kit).filter((u) => (seen.has(u.product) ? false : seen.add(u.product)));
}

export const label = (u) => `${PRODUCT[u.product].name} ${u.scent.toLowerCase()}`;

export function composition(units) {
  const m = new Map();
  for (const u of units) m.set(label(u), (m.get(label(u)) || 0) + 1);
  return [...m].map(([k, n]) => `${n} × ${k}`).join(', ');
}

/** Number of PRODUCTS a shopper counts: a lip balm four-pack is one product. */
export const productCount = (kit) => kit.components.reduce((a, c) => a + c.qty, 0);

/** `#kit_gentle` — the bundle-landing template's gang-scope suffix. */
export const handleize = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
export const scopeSuffix = (option, value) => `#${handleize(option)}_${handleize(value)}`;

export function offerCopy(kit, { kitLabel }) {
  const n = productCount(kit);
  if (!(kit.compareAtPrice > kit.price)) throw new Error('no saving to state');
  if (kit.price < 45) throw new Error('"Free shipping" is only true at $45+');
  return {
    headline: `${n} FULL-SIZE PRODUCTS`,
    price: money(kit.price),
    sub: `${money(kit.compareAtPrice)} bought separately`,
    checks: [kitLabel, 'Free shipping'],
  };
}

// ── Prompts ──────────────────────────────────────────────────────────────────
function productBlock(units) {
  const kinds = [...new Set(units.map((u) => u.product))];
  const byHeight = [...kinds].sort((a, b) => PRODUCT[b].cm - PRODUCT[a].cm);
  const [tallest, shortest] = [byHeight[0], byHeight[byHeight.length - 1]];
  const lines = kinds.map((k) => {
    const p = PRODUCT[k];
    const scents = [...new Set(units.filter((u) => u.product === k).map((u) => `"${u.scent.toLowerCase()}"`))].join(', ');
    return `- ${p.name.toUpperCase()} (true height about ${p.cm} cm${p.note ? `; ${p.note}` : ''}): ${UNIT[k].desc}. Its scent name reads exactly ${scents}.`;
  });
  return `THE PRODUCTS — copy each one exactly from the reference photographs, which show the real products and nothing else. For the body lotion there is also a close-up of its label.

${lines.join('\n')}

KEEP TRUE RELATIVE SCALE using the heights above: the ${PRODUCT[tallest].name} is the tallest item and the ${PRODUCT[shortest].name} the shortest${kinds.includes('coconut-oil-lip-balm') ? '; a lip balm tube is small — never drawn the size of a bottle' : ''}. Do not invent, alter, add or remove any label text or graphics.`;
}

const FINE_PRINT = 'Fine print too small to resolve — volume lines, badge rings, rim text — must be left as faint plain lines or an empty band, NEVER filled with invented words or numbers. Every brand name and scent name must be correct.';

export function heroPrompt({ bundle, units }) {
  const n = units.length;
  const box = bundle.giftBox ? ' The closed white Real Skin Care gift mailer box from the reference stands behind the group, lid shut; NO product is inside it or sitting in it.' : '';
  return `Create a premium ecommerce product photograph of a product bundle for a product page gallery. Square 1:1.

${productBlock(units)}

SHOW EXACTLY ${n} ITEMS — ${composition(units)} — never ${n - 1}, never ${n + 1}. Group identical items together. Tallest items at the back, shorter ones in front, every item standing apart with a small clear gap so NO item hides another and every scent name is readable.${box} The group fills most of the frame, centred, with at least 6% clear margin on every side.

PHOTOGRAPHY: high-end commercial product photography, soft directional window light from the upper left, gentle realistic shadows and a faint surface reflection, rich tonal depth, crisp focus. Premium and editorial, never a flat catalogue cut-out.

${NO_PROPS}

${FINE_PRINT}

NO TEXT anywhere other than what is printed on the product labels${bundle.giftBox ? ' and the box' : ''}.`;
}

export function offerPrompt({ bundle, units, copy }) {
  const n = units.length;
  return `Create a premium ecommerce product-page frame whose single job is to state the OFFER for a bundle. Square 1:1.

${productBlock(units)}

LAYOUT: Typography in the UPPER 40% of the frame, centred. Below it, filling the lower 60%, SHOW EXACTLY ${n} ITEMS — ${composition(units)} — grouped by product, ${n > 8 ? 'in TWO neat rows: the tallest products standing in the back row and the shorter ones in a front row set slightly lower, each item in the gap between two behind it, so every label stays fully visible' : 'tallest at the back'}, a small clear gap between items so none hides another. Soft directional studio light, gentle realistic shadows. The products never overlap the type.

EXACT TEXT, rendered precisely, spelled correctly, and nothing else:
- Large bold headline, the biggest text: "${copy.headline}"
- Beneath it, very large: "${copy.price}"
- Directly under that, small: "${copy.sub}"
- One line lower, small, each with a simple thin check mark: "${copy.checks[0]}" and "${copy.checks[1]}"

No sale starbursts, no percentage badges, no urgency, no stars, no review counts. Near-black clean modern geometric sans-serif type on a plain seamless white ground.

${NO_PROPS}

${FINE_PRINT}`;
}

export function scenePrompt({ bundle, units }) {
  const n = units.length;
  return `Create a premium lifestyle photograph for a product page gallery. Square 1:1.

${productBlock(units)}

SCENE: ${bundle.scene}. SHOW EXACTLY ${n} ITEMS of our products — ${composition(units)} — never ${n - 1}, never ${n + 1}, standing apart so none hides another, labels facing the camera, sharp and clearly the hero of the frame. Premium commercial photography, natural daylight, shallow depth of field, rich and believable, uncluttered.

Do NOT include house plants, trailing vines, ivy, wood slices, stacked stones or loofahs. Do NOT show any person, face, hand or body. Do NOT show any other branded product.${bundle.giftBox ? ' The gift mailer stays closed; no product is inside it.' : ''}

${FINE_PRINT}

NO TEXT anywhere other than what is printed on our product labels${bundle.giftBox ? ' and the box' : ''}.`;
}

// ── Verdict ──────────────────────────────────────────────────────────────────
const VOCAB = [...new Set(Object.values(PRODUCT).map((p) => p.name))];

export function checkPrompt({ units }) {
  return `The first images are REFERENCE photos of our products (Real Skin Care: ${[...new Set(units.map((u) => PRODUCT[u.product].name))].join(', ')}). The LAST image is a render to check.

Answer about the LAST image ONLY, as JSON, transcribing exactly as rendered. Do NOT correct spelling and do NOT fill in words you cannot see.

{
  "lettering": ["every line of text NOT printed on a product label or on the gift box, in reading order; [] if none"],
  "items": ["one entry per unit of our product, EXACTLY one per physical item, formatted '<product> <scent name as printed>', where <product> is one of: ${VOCAB.join(', ')}; write '<product> UNREADABLE' if you cannot read its scent name"],
  "our_product_count": <total number of our product items, counting every one even partly visible>,
  "matches_reference": "MATCH" | "MISMATCH" | "CANNOT_TELL",
  "mismatch_reason": "<if MISMATCH, what differs; else empty>",
  "people_present": true | false,
  "defects": "<a unit cut off by the frame edge, a unit hidden behind another, warped or fused objects, a product drawn far out of scale with the others (e.g. a lip balm as tall as a bottle); else empty>"
}

"matches_reference" covers each product's physical design and LABEL DESIGN, including PROPORTIONS: a container clearly shorter, squatter or wider than its reference is a MISMATCH; so is a scent name printed in a colour other than near-black, an illustration of a different subject or colour, a badge in a different place or style, or a scent name broken over two lines where the reference prints it on one. Lighting, angle and unreadable fine print are never a mismatch. Answer with the JSON only.`;
}

/** Adapts the bundle read to the ladder `judge`, which compares a multiset of labels. */
export function judgeBundle({ read, units, required = [] }) {
  const adapted = read ? { ...read, scent_names: (read.items || []).map((x) => tokens(x).join(' ')) } : null;
  return judge({ read: adapted, units: units.map(label), required });
}
