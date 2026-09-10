#!/usr/bin/env node
/**
 * Build the missing offer / proof / compare frames for bar soap, foaming hand
 * soap and coconut deodorant — the next three PDPs after the lotion, taken in
 * cluster-efficiency order (soap 2nd, deodorant 4th).
 *
 * Every string below is SOURCED and recorded in FRAMES[].source. All nine were
 * run through checkSeoCopyFields AND findProductCategoryMisnomers before a
 * single render was spent: 0 blocking, 0 advisory, 0 misnomers.
 *
 * THREE FACTS THAT CHANGED THE DESIGN, each established by checking rather than
 * assuming:
 *
 * 1. ONLY THE LOTION HAS A SUBSCRIPTION. `selling_plan_groups` is length 1 on
 *    coconut-lotion and 0 on all three of these, so the lotion's "Subscribe &
 *    Save 15%" offer frame has no equivalent here. Per the source article's own
 *    rule — "if there is no promotional offer, build the image around the
 *    strongest supported reason the product is worth its price" — the offer
 *    frame becomes the MULTI-PACK, which is a real catalogue fact and an AOV
 *    lever rather than an invented promotion.
 *
 * 2. `variants[0].available` IS NOT THE PRODUCT'S AVAILABILITY. Read that way,
 *    three of the four packs looked out of stock and the offer frames would have
 *    been dropped — the "Variety — one of each" variant happens to sort first
 *    and is out on all three. Checked per variant, every pack has stock. This is
 *    the same live-ness trap that put three DRAFT collections into the digest as
 *    revenue opportunities.
 *
 * 3. THE DEODORANT COMPARISON CLASS IS "CONVENTIONAL STICK", TAKEN FROM THE
 *    LIVE PDP BODY. Aluminium is an antiperspirant active, so naming the column
 *    "conventional deodorant" would be shaky and naming it "antiperspirant"
 *    risks implying our cosmetic substitutes for a drug. The live body already
 *    says "unlike the petroleum jelly and silicones in conventional sticks" and
 *    uses the word antiperspirant ZERO times — so the frame reuses the brand's
 *    own established framing instead of inventing a class.
 *
 * Usage: node scripts/build-pdp-frames-batch2.mjs [--only <product>/<frame>] [--attempt N]
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GoogleGenAI } from '@google/genai';
import { renderVariation } from '../agents/ad-studio/render.js';
import { sharedRequirements, blankFineTextRule } from '../lib/pdp-frame-prompts.js';

const ROOT = process.cwd();
const OUT = join(ROOT, 'data', 'creatives', 'pdp-frames-batch2');
mkdirSync(OUT, { recursive: true });
const REF = join(ROOT, 'data', 'product-images', '_clean-batch2');

const env = Object.fromEntries(
  readFileSync(join(ROOT, '.env'), 'utf8').split('\n')
    .filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; })
);
const gemini = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

const SHARED = sharedRequirements();

const PRODUCTS = {
  'bar-soap': {
    handle: 'coconut-soap',
    ref: 'bar-soap-ref.png',
    product: `THE PRODUCT — copy it exactly from the reference photograph, which shows this bar and nothing else.

A ROUND white bar of soap, about 3.5 inches across and roughly half an inch thick, with a distinctive PLEATED / scalloped rim where the wrapping pressed it. It lies flat, face up. The printed face carries, top to bottom: the brand name "real" in large lowercase near-black text with "SKIN CARE" in small spaced capitals beneath it; a small circular THIN GREY OUTLINE badge reading "MADE WITH ORGANIC COCONUT OIL"; a photographic green leaf with water droplets on it; then "pure unscented" in bold lowercase and "hand & body soap" smaller beneath. Small print curves around the outer edge of the face. It is a solid bar — NOT a bottle, NOT a jar, NOT wrapped, and there is no cap, pump or applicator of any kind.`,
    offer: { headline: '4 BARS FOR $39', price: '$9.75', sub: 'a bar when you buy four', checks: ['Save $5 against four singles', 'The 12-pack works out at $7.33 a bar'] },
    proof: { quote: 'Bar soap lathers up very well. The unscented is an excellent choice for sensitive people.', who: 'Stephen', label: 'Verified purchase' },
    compare: { them: 'Conventional bar', rows: [['No SLS or SLES', 'SLS, SLES'], ['No rendered animal fat', 'Tallow'], ['No EDTA', 'EDTA'], ['No dyes', 'Synthetic dyes']] },
    sources: {
      offer: 'Live catalogue 2026-09-10: coconut-soap $11.00; coconut-bar-soap-4-pack $39.00 (3 of 5 variants in stock); coconut-bar-soap-12-pack $88.00 (3 of 5 in stock). 39/4 = 9.75; 4x11 = 44, saving 5. 88/12 = 7.33.',
      proof: 'Judge.me, coconut-soap, Stephen, 5 stars, verified-purchase, verbatim first two sentences. No review count shown — the product has 8 reviews and an unreconciled widget count, so no number is published.',
      compare: 'Rows taken verbatim from the live bar-soap-not-in-it.png frame. Comparison column is the generic category; no competitor named.',
    },
  },
  foaming: {
    handle: 'organic-foaming-hand-soap',
    ref: 'foaming-ref.png',
    product: `THE PRODUCT — copy it exactly from the reference photograph, which shows this bottle and nothing else.

A tall slim WHITE cylindrical bottle, 8 fl. oz., with a BLACK FOAMING PUMP on top under a clear ribbed over-cap — the pump has a wide flat press-down head and a short spout. The white label carries, top to bottom: "real" in large lowercase near-black text with "SKIN CARE" in small spaced capitals beneath; a small circular THIN GREY OUTLINE badge; a PHOTOREALISTIC image of a whole brown coconut beside a halved coconut showing white flesh, with slim green blade leaves behind; then "coconut breeze" in bold lowercase on two lines and "hand soap" smaller beneath; and a solid black band at the base. It is a pump bottle — the pump is correct and must be shown.`,
    offer: { headline: '4 FOR $44', price: '$11', sub: 'a bottle when you buy four', checks: ['Save $8 against four singles', 'All four scents sold as a four-pack'] },
    proof: { quote: "The scent is great. Foams up nicely and doesn't leave hands dry at all!", who: 'Laura S.', label: null },
    compare: { them: 'Conventional foaming soap', rows: [['No SLS or SLES', 'SLS, SLES'], ['No cocamidopropyl betaine', 'Cocamidopropyl betaine'], ['No parabens', 'Parabens'], ['No dyes', 'Synthetic dyes']] },
    sources: {
      offer: 'Live catalogue 2026-09-10: organic-foaming-hand-soap $13.00; coconut-hand-soap-4-pack $44.00, 4 of 4 variants in stock. 44/4 = 11; 4x13 = 52, saving 8.',
      proof: 'Judge.me, organic-foaming-hand-soap, Laura S., 5 stars, verbatim. Judge.me records this reviewer as "buyer" rather than "verified-purchase", so NO verification label is shown — attribution only.',
      compare: 'Rows taken verbatim from the live foaming-soap-whats-not-in-it.png frame. Comparison column is the generic category; no competitor named.',
    },
  },
  deodorant: {
    handle: 'coconut-oil-deodorant',
    ref: 'deodorant-ref.png',
    product: `THE PRODUCT — copy it exactly from the reference photograph, which shows this bottle and nothing else.

A short WHITE ROLL-ON bottle, 2 fl. oz., with a large smooth WHITE ROLLER BALL seated in a collar at the top — the cap is off, so the ball is visible. The white label carries, top to bottom: "real" in large lowercase near-black text with "SKIN CARE" in small spaced capitals beneath; a small circular THIN GREY OUTLINE badge reading "STAY FRESH" in its centre with tiny arc text around it; a PHOTOREALISTIC pink geranium flower with green leaves; then "geranium flower" in bold lowercase on two lines and "natural deodorant" smaller beneath; and a solid black band at the base. It is a ROLL-ON — not a stick, not a spray, not a tube, and there is no twist-up mechanism.`,
    offer: { headline: '4 FOR $53', price: '$13.25', sub: 'a bottle when you buy four', checks: ['Save $7 against four singles', 'Four of your scent, one order'] },
    proof: { quote: 'The scents are enjoyable and not over powering. It works great.', who: 'Mike G.', label: 'Verified purchase' },
    compare: { them: 'Conventional stick', rows: [['No aluminum', 'Aluminum'], ['No synthetic fragrance', 'Synthetic fragrance'], ['No propylene glycol', 'Propylene glycol'], ['Jojoba soaks in', 'Petroleum jelly, silicones']] },
    sources: {
      offer: 'Live catalogue 2026-09-10: coconut-oil-deodorant $15.00; coconut-deodorant-4-pack $53.00, 2 of 5 variants in stock (both single-scent, so the copy says "four of your scent" rather than mix-and-match, which is the OUT-OF-STOCK Variety variant). 53/4 = 13.25; 4x15 = 60, saving 7.',
      proof: 'Judge.me, coconut-oil-deodorant, Mike Gray, 5 stars, verified-purchase. EXCERPTED deliberately: the full review says "I use this in the evening ... when I don\'t need anti-perspirant", and that word must not appear on an RSC product frame even in a customer\'s mouth. The two sentences quoted are verbatim and contiguous.',
      compare: 'First three rows verbatim from the live deodorant-not-in-it.png frame. The fourth and the column header come from the live PDP body: "Organic jojoba soaks in instead of leaving a film, unlike the petroleum jelly and silicones in conventional sticks." That body uses "antiperspirant" zero times.',
    },
  },
};

function offerPrompt(p) {
  const checks = p.offer.checks.map(c => `"${c}"`).join(' and ');
  return `Create a premium ecommerce carousel frame whose single job is to state the OFFER.

${p.product}

LAYOUT: The product sits in the right third of the frame on a plain seamless white ground with a soft contact shadow. The left two thirds carry the offer as clean typography on the same white ground.

EXACT TEXT, rendered precisely and spelled correctly:
- Large bold headline, the biggest element in the frame: "${p.offer.headline}"
- Beneath it, very large: "${p.offer.price}"
- Directly under that, small: "${p.offer.sub}"
- Two short supporting lines lower down, each with a simple thin check mark: ${checks}

No other text anywhere. No sale starbursts, no percentage badges, no urgency banners, no countdown.

${SHARED}`;
}

function proofPrompt(p) {
  const attribution = p.proof.label
    ? `- Beneath the quote, smaller: "${p.proof.who}"\n- Directly beneath that, smallest: "${p.proof.label}"`
    : `- Beneath the quote, smaller: "${p.proof.who}" — and NOTHING else. Do not add a verification line, a date, a location or a star count anywhere near it.`;
  return `Create a premium ecommerce carousel frame whose single job is TRUST, built around one real customer quote.

${p.product}

LAYOUT: A clean editorial layout on a plain seamless white ground. The quote is the hero and sits across the upper two thirds, set large. The product sits smaller in the lower right with a soft contact shadow. Quiet and typographic — no styling props whatsoever.

EXACT TEXT, rendered precisely and spelled correctly:
- A row of exactly five small filled black stars, above the quote.
- The quote, large, in matching curly typographic quotation marks at BOTH ends: "${p.proof.quote}"
${attribution}

THE QUOTE IS A REAL CUSTOMER'S WORDS AND MUST BE REPRODUCED EXACTLY — every word, in order, none dropped, none repeated, none substituted. It is ${p.proof.quote.split(/\s+/).length} words long. Earlier attempts at this frame DROPPED a word ("The unscented an excellent choice" for "The unscented is an excellent choice") and REPEATED one ("The scents are enjoyable enjoyable and not over powering"). Set the quote, then read it back word by word against the line above before finishing. Altering a customer's words is the worst defect this frame can have.

${blankFineTextRule()}

No other text anywhere. Do NOT add a review count, a numeric rating, an average score, a press logo or any badge. Do NOT show a person — no human face or body — because the reviewer must never be portrayed by a generated model.

${SHARED}`;
}

function comparePrompt(p) {
  const rows = p.compare.rows.map(([a, b], i) => `${i + 1}. "${a}" / "${b}"`).join('\n');
  return `Create a premium ecommerce carousel frame that is a clean two-column comparison chart.

${p.product}

LAYOUT: A simple, uncluttered two-column table occupying the UPPER TWO THIRDS of the frame on a plain seamless white ground, mobile-optimized, generous spacing, thin light rules only — no heavy boxes, no drop shadows on the table. The product sits small in the BOTTOM THIRD, centred, with a soft contact shadow.

The product must sit ENTIRELY BELOW the table with clear empty space between the table's lowest rule and the top of the product. It must NOT overlap, intersect or sit behind the table. An earlier attempt placed the bottle in the MIDDLE of the table, so the centre column divider ran down through it and it covered the text of the lower rows — never do that. Shrink the product and move it down until the whole table is clear of it.

Left column header: "Real Skin Care". Right column header: "${p.compare.them}".
Left column cells each carry a small green check mark. Right column cells each carry a small grey cross.

EXACT TEXT for the four rows, rendered precisely and spelled correctly, left cell then right cell:
${rows}

No other text anywhere. Do NOT name, show or imply any competitor brand, logo or packaging. Do NOT add a headline, footnote or call to action.

${blankFineTextRule()}

${SHARED}`;
}

const BUILDERS = { offer: offerPrompt, proof: proofPrompt, compare: comparePrompt };

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const attempt = process.argv.includes('--attempt') ? process.argv[process.argv.indexOf('--attempt') + 1] : '1';

const manifest = [];
for (const [key, p] of Object.entries(PRODUCTS)) {
  for (const frame of ['offer', 'proof', 'compare']) {
    const id = `${key}/${frame}`;
    manifest.push({ id, handle: p.handle, source: p.sources[frame] });
    if (only && only !== id && only !== key) continue;
    process.stdout.write(`▶ ${id} … `);
    try {
      const buf = await renderVariation(gemini, {
        prompt: BUILDERS[frame](p),
        photoPaths: [join(REF, p.ref)],
        ratio: '1:1',
      });
      const out = join(OUT, `${key}-${frame}-a${attempt}.png`);
      writeFileSync(out, buf);
      console.log(`${(buf.length / 1024).toFixed(0)} KB`);
    } catch (e) {
      console.log(`FAILED: ${e.message}`);
    }
  }
}
writeFileSync(join(OUT, 'frames.json'), JSON.stringify(manifest, null, 2));
console.log(`\nSourcing recorded → ${join(OUT, 'frames.json')}`);
