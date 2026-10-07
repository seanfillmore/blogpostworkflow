/**
 * Ladder-tier product galleries: what to render for each multipack, and how to
 * judge a render. Pure — no network, no filesystem — so every rule is testable.
 *
 * ── Why these products need their own gallery ────────────────────────────────
 * The quantity-ladder tiers (bar soap 4/12, hand soap 2/4, lotion 5, cream 5,
 * lip balm 3x4, toothpaste 3, deodorant 4) are bought from the BASE product's
 * ladder buy box, but their own images are what a shopper sees in the cart
 * drawer, at checkout, in order emails, on the sets-and-bundles collection tile
 * and on the tier PDP a cart line links to. On 2026-10-07 six of them had ZERO
 * images, and the older three showed one unit (or a code composite) for a pack
 * of four.
 *
 * ── What each gallery holds ──────────────────────────────────────────────────
 *   hero    one per VARIANT, the exact units that ship, attached to that variant
 *           so the cart thumbnail shows the right scent and the right count.
 *   offer   the pack's price argument, with the same free-unit wording the
 *           ladder buy box renders ("Buy 8, get 4 free").
 *   scene   one believable in-home photograph of the pack in use.
 * followed by the base PDP's approved frames (mechanism, proof, not-in-it,
 * benefits, compare, how-to), which describe the same physical product.
 *
 * ── Why GENERATED, and how accuracy is held ──────────────────────────────────
 * Sean, 2026-10-07: "We have the ability to generate high quality creatives,
 * not just composites of four soap bars laid out in a grid." Every render is
 * grounded in prop-free cutouts of the real PDP photographs, and every render
 * gets a vision TRANSCRIPTION and COUNT, with the verdict made here in code
 * (`judge`), never by asking a model "is this right?" — the model only reads.
 * A frame fails on: the wrong number of our units, a scent name missing or
 * misspelled, a product that does not match the photos, any required string
 * missing, or ANY text beyond what was asked for (that is how an invented
 * review count or "dermatologist tested" would arrive).
 */

import { NO_PROPS } from './pdp-frame-prompts.js';
import { tokens, findRun, inventedClaims } from '../agents/ad-batch/check.js';

const money = (n) => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`);
export const slugify = (s) => String(s).toLowerCase().replace(/[—–]/g, '-').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// ── The physical products ────────────────────────────────────────────────────
// One unit each. Written from the cutouts in data/brand/cutouts, which are crops
// of the live PDP photographs — the model copies the reference, this text keeps
// it from improvising the things it most often gets wrong (cap type, label order).
export const UNIT = {
  'coconut-soap': {
    noun: 'bar', plural: 'bars', refKey: 'soap',
    desc: 'a round, puck-shaped bar of soap wrapped in white pleated paper with crimped edges, like a hotel-style wrapped soap disc. Its flat top carries a circular white label: the brand name "real" in large italic near-black lowercase with "SKIN CARE" in small spaced capitals beneath, a small round badge at the left, a PHOTOREALISTIC botanical illustration matching the scent in the centre, the scent name in bold lowercase, and "hand & body soap" in lighter lowercase beneath it. Fine print runs round the label rim',
    lying: true,
  },
  'organic-foaming-hand-soap': {
    noun: 'bottle', plural: 'bottles', refKey: 'handsoap',
    desc: 'a tall, slim, frosted semi-transparent foaming soap bottle with a BLACK foaming pump head under a CLEAR protective overcap. The white label carries the brand name "real" in italic near-black lowercase with "SKIN CARE" beneath, a small round badge, a PHOTOREALISTIC fruit or botanical illustration matching the scent, the scent name in bold lowercase, "hand soap" in lighter lowercase beneath it, and a solid black band near the base',
  },
  'coconut-lotion': {
    noun: 'bottle', plural: 'bottles', refKey: 'lotion',
    // Rewritten 2026-10-07 after Sean caught the first 5-pack set live: every render
    // drew a SHORT, SQUAT bottle with the scent name broken over two lines and a
    // solid black badge. The checker passed them because nothing stated proportions.
    desc: 'a TALL, SLIM, white cylindrical SQUEEZE bottle — about 3.4 times as tall as it is wide, never short or squat — with gently rounded shoulders and a tall BLACK FLIP-TOP DISC CAP about one fifth of the bottle height. There is no pump, dropper or nozzle. The white label runs almost the full height of the body with generous white space: near the top, the brand name "real" in LARGE italic near-black lowercase with "SKIN CARE" in small spaced capitals beneath; below it a small round badge drawn as a THIN GREY OUTLINE circle with tiny grey text (never a solid or black disc); then a PHOTOREALISTIC illustration matching the scent; then the scent name in bold near-black lowercase on ONE single line (never broken over two lines); "moisturizing body lotion" in lighter lowercase beneath it; and a solid black band across the bottom of the label',
    detailCrop: [0.2, 0.95],
  },
  'coconut-moisturizer': {
    noun: 'jar', plural: 'jars', refKey: 'cream',
    desc: 'a SHORT, WIDE, SQUAT round WHITE JAR, clearly wider than it is tall, with a BLACK screw-on lid finely RIBBED with vertical ridges. Its wrap-around label carries, left to right: a PHOTOREALISTIC illustration matching the scent; the brand name "real" in large italic near-black lowercase with "SKIN CARE" beneath; the scent name in large bold lowercase; "moisturizing body cream" in lighter grey beneath; and a solid black band across the lower label. There is NO circular badge on this label and NO pump or applicator',
  },
  'coconut-oil-lip-balm': {
    noun: 'tube', plural: 'tubes', refKey: 'lipbalm',
    desc: 'a slim cylindrical twist-up LIP BALM TUBE about 2.75 inches long: a BLACK cap with a small white panel, a white body with the brand name "real" in italic near-black lowercase and "SKIN CARE" beneath, a PHOTOREALISTIC illustration matching the scent, the scent name in bold lowercase printed VERTICALLY along the tube with "moisturizing lip balm" beside it, a solid black band near the bottom, and a light grey ribbed base. It is a tube — never a jar, pot or bottle',
    lying: true,
  },
  'coconut-oil-toothpaste': {
    noun: 'tube', plural: 'tubes', refKey: 'toothpaste',
    desc: 'a slim, upright WHITE plastic bottle with rounded shoulders and a BLACK screw cap on TOP. The white label carries the brand name "real" in italic near-black lowercase with "SKIN CARE" beneath, a small round badge, a PHOTOREALISTIC illustration matching the flavor, the flavor name in bold lowercase, "toothpaste" in lighter lowercase beneath it, and a solid black band near the base',
  },
  'coconut-oil-deodorant': {
    noun: 'roll-on', plural: 'roll-ons', refKey: 'deodorant',
    desc: 'a compact white roll-on deodorant bottle with a domed WHITE cap. The white label carries the brand name "real" in italic near-black lowercase with "SKIN CARE" beneath, a small round badge, a PHOTOREALISTIC botanical illustration matching the scent, the scent name in bold lowercase, "natural deodorant" in lighter lowercase beneath it, and a solid black band near the base',
  },
};

// ── The tiers ────────────────────────────────────────────────────────────────
// `unitsPer` is how many sellable units of the BASE product one component holds:
// the lip balm's base product is itself a four-pack, so one component is four
// tubes. `varietyOf` names what a "Variety" component expands to — the variety
// four-pack of lip balm is one of each scent (live PDP alt, 2026-10-07).
// `scene` is the one in-home photograph; `sceneUnits` is how many units it shows,
// never more than ship, and the checker counts them.
export const TIERS = {
  'coconut-bar-soap-12-pack': {
    base: 'coconut-soap', option: 'Scent', unitsPer: 1,
    arrangement: () => 'an art-directed cluster with real depth: the bars rest on a plain surface in three loose, gently curving rows that step back from the camera, front row lowest, each bar slightly turned and lightly overlapping its neighbour like scattered coins, shot from a low three-quarter angle with a gentle depth of field so the back row softens slightly — no bar fully hidden and every scent name still readable, never a flat, evenly spaced grid',
    scene: 'an open bathroom cabinet shelf, bright and tidy, with the bars in a neat row beside a short stack of folded white hand towels — a household that has stocked up',
    sceneUnits: 4,
  },
  'coconut-bar-soap-4-pack': {
    base: 'coconut-soap', option: 'Scent', unitsPer: 1,
    arrangement: () => 'two bars lying flat in front and two bars standing upright on their edges just behind them, leaning gently back, with a clear gap between every bar so NO bar overlaps or hides another and every full label faces the camera; depth comes from the low three-quarter camera angle and soft directional light, never from overlap',
    scene: 'the edge of a bright, clean bathtub with white tile, the bars in a neat row on a plain white ceramic tray',
    sceneUnits: 4,
  },
  'coconut-hand-soap-2-pack': {
    base: 'organic-foaming-hand-soap', option: 'Scent', unitsPer: 1,
    arrangement: () => 'one bottle standing slightly forward and turned a few degrees toward the other, the second just behind and to the side, both labels facing the camera, shot at a low eye-level angle with gentle depth',
    scene: 'a bright modern kitchen sink with a white subway-tile backsplash and a brushed-steel faucet, the two bottles standing on the counter beside the sink',
    sceneUnits: 2,
  },
  'coconut-hand-soap-4-pack': {
    base: 'organic-foaming-hand-soap', option: 'Scent', unitsPer: 1,
    arrangement: () => 'a staggered group with depth — two bottles in a back row and two in front, the front pair offset into the gaps so all four labels face the camera and none hides another — shot at a low eye-level angle, never a single flat lineup',
    scene: 'a bright white bathroom vanity with a basin and a round mirror edge, the bottles standing in a neat row along the back of the counter',
    sceneUnits: 4,
  },
  'coconut-lotion-5-pack': {
    base: 'coconut-lotion', option: 'Scent', unitsPer: 1,
    arrangement: () => 'five bottles standing in ONE straight row, side by side with a clear gap of about a third of a bottle width between each, every full label facing the camera; NO bottle overlaps or hides another; depth comes from a slightly low three-quarter camera angle, a soft floor reflection and directional window light',
    scene: 'a bright, calm bedroom dresser top in soft morning light, the bottles standing in a neat row against a plain light wall',
    sceneUnits: 5,
  },
  'coconut-moisturizer-5-pack': {
    base: 'coconut-moisturizer', option: 'Scent', unitsPer: 1,
    arrangement: () => 'a staggered group with depth — three jars in a back row and two in front, the front pair offset into the gaps so all five labels face the camera; one front jar has its lid off and resting beside it so the rich white cream shows; shot at a low three-quarter angle, never a single flat lineup or a stack',
    scene: 'a bright, calm bathroom shelf in soft morning light, the jars in a neat row with one lid set aside so the rich white cream shows in the open jar',
    sceneUnits: 3,
  },
  'coconut-lip-balm-3-pack': {
    base: 'coconut-oil-lip-balm', option: 'Scent', unitsPer: 4,
    varietyOf: ['Vanilla Dream', 'Sweet Tangerine', 'Coconut Breeze', 'Pure Unscented'],
    arrangement: () => 'three neat groups of four tubes — one group per four-pack — lying flat side by side on a plain surface, each group a tidy bundle of four parallel tubes with small gaps between tubes, the three groups set on a gentle diagonal, shot from a high three-quarter angle with soft directional light; NO tube overlaps or hides another and every vertical scent name is fully readable',
    scene: 'a bright, tidy entryway console with a plain white ceramic dish, the tubes set out on the dish as if about to be dropped into a coat pocket and a bag',
    sceneUnits: 4,
  },
  'coconut-toothpaste-3-pack': {
    base: 'coconut-oil-toothpaste', option: 'Flavor', unitsPer: 1,
    arrangement: () => 'a fanned trio with depth — the centre bottle standing slightly forward, the other two just behind and angled inward, all three labels facing the camera — shot at a low eye-level angle',
    scene: 'a bright white bathroom sink counter, the tubes standing in a neat row beside a clear glass tumbler',
    sceneUnits: 3,
  },
  'coconut-deodorant-4-pack': {
    base: 'coconut-oil-deodorant', option: 'Scent', unitsPer: 1,
    arrangement: () => 'four roll-ons standing in ONE straight row, side by side with a clear gap of about half a bottle width between each, every full label facing the camera; NO roll-on overlaps or hides another; depth comes from a slightly low three-quarter camera angle, a soft floor reflection and directional window light',
    scene: 'a bright, clean bathroom shelf with a plain white wall, the roll-ons in a neat row beside a folded white towel',
    sceneUnits: 4,
  },
};

/** The units that ship for one roster variant, as a flat list of scent names. */
export function unitsFor(tier, variant) {
  const out = [];
  for (const c of variant.components) {
    const scents = /variety/i.test(c.variant) ? (tier.varietyOf || null) : null;
    if (/variety/i.test(c.variant) && !scents) throw new Error(`"${c.variant}" names a variety the tier does not expand`);
    for (let i = 0; i < c.qty; i++) {
      if (scents) out.push(...scents);
      else for (let j = 0; j < tier.unitsPer; j++) out.push(c.variant);
    }
  }
  return out;
}

/**
 * The variant a PRODUCT-level frame (offer, scene) depicts. Those frames show for
 * every variant, so they draw the mixed variant where one exists — it reads as
 * "the range" — and otherwise the first variant the roster lists.
 */
export function representativeVariant(bundle) {
  return bundle.variants.find((v) => v.components.some((c) => /variety/i.test(c.variant))
    || new Set(v.components.map((c) => c.variant)).size > 1) || bundle.variants[0];
}

/** Units the scene shows: distinct scents first, then repeats, capped at `n`. */
export function sceneUnits(tier, bundle) {
  const units = unitsFor(tier, representativeVariant(bundle));
  const distinct = [...new Set(units)];
  const out = [...distinct];
  for (const u of units) { if (out.length >= tier.sceneUnits) break; if (out.filter((x) => x === u).length < units.filter((x) => x === u).length) out.push(u); }
  return out.slice(0, tier.sceneUnits).sort((a, b) => distinct.indexOf(a) - distinct.indexOf(b));
}

/** The one choice line an offer frame carries, from the roster's own option values. */
export function choiceLine(tier, bundle, unit) {
  const mixed = bundle.variants.some((v) => v.components.some((c) => /variety/i.test(c.variant))
    || new Set(v.components.map((c) => c.variant)).size > 1);
  const kind = tier.option === 'Flavor' ? 'flavor' : 'scent';
  return mixed ? `One ${kind} or a mix of each` : `Pick your ${kind}`;
}

/** "3 × calming lavender, 3 × nourishing tea tree" in first-seen order. */
export function composition(units) {
  const counts = new Map();
  for (const u of units) counts.set(u, (counts.get(u) || 0) + 1);
  return [...counts].map(([s, n]) => `${n} × ${s.toLowerCase()}`).join(', ');
}

/**
 * The pack's price argument, mirroring blocks/quantity-ladder.liquid: when the
 * price is a whole number of singles, it is "Buy P, get F free"; otherwise it is
 * "N for $X". The per-unit figure divides by the units a shopper counts (tubes,
 * bars), not by components.
 */
export function offerCopy({ tier, unit, variant, basePrice }) {
  const units = unitsFor(tier, variant).length;
  const components = variant.components.reduce((a, c) => a + c.qty, 0);
  const paid = variant.price / basePrice;
  const per = variant.price / units;
  const whole = Number.isInteger(paid) && paid < components;
  const headline = whole
    ? `BUY ${paid}, GET ${components - paid} FREE`
    : `${units} ${unit.plural.toUpperCase()} FOR ${money(variant.price)}`;
  return {
    headline,
    price: whole ? money(variant.price) : money(Number(per.toFixed(2))),
    sub: whole ? `${units} ${unit.plural} · ${money(Number(per.toFixed(2)))} a ${unit.noun}` : `a ${unit.noun}`,
  };
}

// ── Prompts ──────────────────────────────────────────────────────────────────
// A mixed pack is grouped by scent in the prompt. The first trial render of the
// 12-pack variety came back 3/4/3/2 instead of 3/3/3/3 — a plausible-looking pack
// that is not what ships — and grouping is what makes a count per scent legible
// to the model and to the checker.
function grouping(units) {
  return new Set(units).size > 1 ? ' Keep each scent\'s units together as a small group, so the count of each scent is obvious at a glance.' : '';
}
const FINE_PRINT = 'Fine print too small to resolve at this size — the volume line, the badge ring, rim text — must be left as faint plain lines or an empty band, NEVER filled with invented words or numbers. The brand name and every scent name must be correct.';

function productBlock(unit, units) {
  const names = [...new Set(units)].map((s) => `"${s.toLowerCase()}"`).join(', ');
  return `THE PRODUCT — copy it exactly from the reference photographs, which show the real product and nothing else. Each unit is ${unit.desc}.

${unit.detailCrop ? 'For each scent there are TWO references: the whole product, and a close-up of its label. Match the label layout, spacing and type sizes to the close-up exactly.\n\n' : ''}The scent name printed on each label reads exactly ${names}. Match each label's illustration to its scent as in the references. Do not invent, alter, add or remove any label text or graphics.`;
}

export function heroPrompt({ tier, unit, units }) {
  const n = units.length;
  return `Create a premium ecommerce product photograph for a product page gallery. Square 1:1.

${productBlock(unit, units)}

SHOW EXACTLY ${n} ${unit.plural.toUpperCase()} — ${composition(units)} — never ${n - 1}, never ${n + 1}.${grouping(units)} Arrangement: ${tier.arrangement(n)}. The group fills most of the frame and sits centred, with at least 6% clear margin on every side; nothing touches or crosses a frame edge.

PHOTOGRAPHY: high-end commercial product photography, as if shot on a medium-format camera — soft directional window light from the upper left, gentle realistic shadows and a faint surface reflection, rich tonal depth, crisp focus on the front units. Premium and editorial, never a flat catalogue cut-out.

${NO_PROPS}

${FINE_PRINT}

NO TEXT anywhere in the image other than what is printed on the product labels: no headline, no price, no badge, no watermark.`;
}

export function offerPrompt({ tier, unit, units, copy, checks }) {
  const n = units.length;
  const lines = checks.map((c) => `"${c}"`).join(' and ');
  return `Create a premium ecommerce product-page frame whose single job is to state the OFFER. Square 1:1.

${productBlock(unit, units)}

LAYOUT: The typography sits in the UPPER 40% of the frame, centred. Below it, filling the lower 60%, SHOW EXACTLY ${n} ${unit.plural.toUpperCase()} — ${composition(units)}.${grouping(units)} Arrangement: ${tier.arrangement(n)}. Soft directional studio light, gentle realistic shadows, premium commercial photography. The product group never overlaps the type and keeps at least 6% clear margin on every side.

EXACT TEXT, rendered precisely, spelled correctly, and nothing else:
- Large bold headline, the biggest text: "${copy.headline}"
- Beneath it, very large: "${copy.price}"
- Directly under that, small: "${copy.sub}"
- One line lower, small, each with a simple thin check mark: ${lines}

No sale starbursts, no percentage badges, no urgency, no stars, no review counts. Near-black clean modern geometric sans-serif typography on a plain seamless white ground, generous white space.

${NO_PROPS}

${FINE_PRINT}`;
}

export function scenePrompt({ tier, unit, units }) {
  const n = units.length;
  return `Create a premium lifestyle photograph for a product page gallery. Square 1:1.

${productBlock(unit, units)}

SCENE: ${tier.scene}. SHOW EXACTLY ${n} ${unit.plural.toUpperCase()} of our product — ${composition(units)} — never ${n - 1}, never ${n + 1}, clearly visible, labels facing the camera, sharp, not overlapping and not hidden behind anything. Our product is the hero and sits in the middle of the frame. Premium commercial photography, natural daylight, shallow depth of field, rich and believable, uncluttered.

Do NOT include house plants, trailing vines, ivy, wood slices, stacked stones or loofahs. Do NOT show any person, face, hand or body. Do NOT show any other branded product.

${FINE_PRINT}

NO TEXT anywhere in the image other than what is printed on our product labels.`;
}

// ── Verdict ──────────────────────────────────────────────────────────────────
export function checkPrompt({ unit, units }) {
  const scents = [...new Set(units)].map((s) => s.toLowerCase()).join(', ');
  return `The first image(s) are REFERENCE photos of our product, Real Skin Care ${unit.plural} (scents: ${scents}). The LAST image is a render to check.

Answer about the LAST image ONLY, as JSON, transcribing letter by letter exactly as rendered. Do NOT correct spelling and do NOT fill in words you cannot see.

{
  "lettering": ["every line of text in the image that is NOT printed on a product label, in reading order; [] if none"],
  "scent_names": ["the scent name printed on EACH unit of our product, EXACTLY one entry per unit — the list is as long as the unit count — as rendered; write UNREADABLE for a unit whose scent name you cannot read"],
  "our_product_count": <how many units of our product (${unit.plural}) appear, counting every unit even partly visible>,
  "matches_reference": "MATCH" | "MISMATCH" | "CANNOT_TELL",
  "mismatch_reason": "<if MISMATCH: what differs in shape, cap or closure, color, label layout or illustration; else empty>",
  "people_present": true | false,
  "defects": "<anything physically wrong: a unit cut off by the frame edge, melted or warped units, duplicated or fused objects; else empty>"
}

"matches_reference" is about the physical product and its LABEL DESIGN, including PROPORTIONS: a container clearly shorter, squatter or wider than the reference is a MISMATCH, and so is a scent name broken over two lines where the reference prints it on one. Lighting, angle and gloss are never a mismatch, and neither is unreadable fine print. But each of these IS a MISMATCH, because a shopper would see a different product: the scent name printed in a colour other than the reference's near-black; an illustration of a different subject or colour (e.g. beige pellets where the reference shows amber resin); a badge, seal or icon that the reference does not have, or in a different place; a differently styled or sized "real" wordmark; a bottle, jar or bar of a different shape, base or cap colour. Answer with the JSON only.`;
}

/**
 * Pass/fail in code from the transcription. `required` is every string the
 * frame must carry; any other lettering fails the render outright.
 */
export function judge({ read, units, required = [] }) {
  const reasons = [];
  if (!read) return { ok: false, reasons: ['vision check returned no readable answer'] };

  const lettering = (Array.isArray(read.lettering) ? read.lettering : [read.lettering || '']).join(' ');
  let left = tokens(lettering);
  for (const s of required) {
    const at = findRun(left, tokens(s));
    if (at < 0) reasons.push(`missing or misspelled "${s}" (read "${lettering}")`);
    else left.splice(at, tokens(s).length);
  }
  if (left.length) {
    const claims = inventedClaims(left.join(' '));
    reasons.push(`unrequested text "${left.join(' ')}"${claims.length ? ` (${claims.join('; ')})` : ''}`);
  }

  const n = Number(read.our_product_count);
  if (!Number.isFinite(n)) reasons.push('unit count unreadable');
  else if (n !== units.length) reasons.push(`${n} units of our product, expected ${units.length}`);

  // The mix must be exactly what ships, per scent — not merely "every scent appears".
  // The first 12-pack trial passed that weaker test while showing 3/4/3/2 for 3/3/3/3.
  const key = (x) => tokens(x).join(' ');
  const want = new Map();
  for (const u of units) want.set(key(u), (want.get(key(u)) || 0) + 1);
  const got = new Map();
  for (const x of read.scent_names || []) got.set(key(x), (got.get(key(x)) || 0) + 1);
  const fmt = (m) => [...m].map(([k, v]) => `${v} × ${k || '?'}`).join(', ');
  const same = want.size === got.size && [...want].every(([k, v]) => got.get(k) === v);
  if (!same) reasons.push(`scent mix read as ${fmt(got) || 'nothing'}, expected ${fmt(want)}`);

  if (read.matches_reference === 'MISMATCH') reasons.push(`product does not match the photos: ${read.mismatch_reason || 'unspecified'}`);
  if (read.people_present) reasons.push('a person appears');
  if (read.defects && String(read.defects).trim()) reasons.push(`defect: ${read.defects}`);
  return { ok: reasons.length === 0, reasons };
}

/** Alt text, derived — the uploader refuses empty alts. */
export function heroAlt({ handle, title, variantTitle, units, unit }) {
  return `${title} — ${variantTitle}: ${units.length} ${unit.plural}, ${composition(units)}`.slice(0, 500);
}
