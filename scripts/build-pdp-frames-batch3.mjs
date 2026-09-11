#!/usr/bin/env node
/**
 * Build the missing offer / proof / compare frames for the coconut body cream
 * (coconut-moisturizer) and the coconut oil lip balm four-pack.
 *
 * Every string below is SOURCED (FRAMES' `sources`) and was run through
 * checkSeoCopyFields, findProductCategoryMisnomers and the ruled-word list
 * (mineral oil / petrolatum / dimethicone / petroleum, plus "pump") before a
 * render was spent: 0 blocking, 0 advisory, 0 misnomers.
 *
 * FOUR FACTS THAT SHAPED THESE FRAMES, each checked rather than assumed:
 *
 * 1. THE CREAM HAS NO MULTI-PACK AND NO SUBSCRIPTION, so the offer frame is the
 *    Sensitive Skin Moisturizing Set — the pure unscented lotion ($30) plus this
 *    cream ($28) for $46.80, saving $11.20 and clearing the live "Free Shipping
 *    on Orders Over $45" bar. It is the growth plan's hero SKU, and the frame
 *    shows the PURE UNSCENTED jar because that is the cream the set contains.
 *
 * 2. THE LIP BALM IS ALREADY A FOUR-PACK at $15, so its offer is the per-tube
 *    price, $3.75 — a catalogue fact, not a promotion. All five variants (four
 *    scents + Variety Pack) are in stock, checked per variant.
 *
 * 3. fetchAllReviews() DROPS the reviewer and the verification flag. Pulled raw:
 *    coconut-moisturizer has 27 published reviews, the lip balm 11. Both quotes
 *    below are `verified-purchase`. Two of the most emphatic reviews (an eczema
 *    rash "gone"; lips "healed" after radiation) fail the health-claim gate and
 *    were never candidates.
 *
 * 4. NO RULED WORDS, even from the live bodies. The cream body says "No petrolatum,
 *    no mineral oil"; those claims are not reused. Rows come from the not-in-it v2
 *    frames and the body's own other claims.
 *
 * References are prop-free crops of the studio shots in
 * data/product-images/_clean-batch3/ — no swatch, no USA badge, no reflection.
 *
 * Usage: node scripts/build-pdp-frames-batch3.mjs [--only <product>/<frame>] [--attempt N]
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GoogleGenAI } from '@google/genai';
import { renderVariation } from '../agents/ad-studio/render.js';
import { FRAME_BUILDERS } from '../lib/pdp-frame-prompts.js';

const ROOT = process.cwd();
const OUT = join(ROOT, 'data', 'creatives', 'pdp-frames-batch3');
mkdirSync(OUT, { recursive: true });
const REF = join(ROOT, 'data', 'product-images', '_clean-batch3');

const env = Object.fromEntries(
  readFileSync(join(ROOT, '.env'), 'utf8').split('\n')
    .filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; })
);
const gemini = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

const jar = (art, name) => `THE PRODUCT — copy it exactly from the reference photograph, which shows this jar and nothing else.

A SHORT, WIDE, SQUAT round WHITE JAR, 4 fl. oz., clearly wider than it is tall, with a softly rounded base and a BLACK screw-on lid whose side is finely RIBBED with vertical ridges all the way round. The white wrap-around label carries, left to right: ${art}; then the brand name "real" in large italic near-black lowercase with "SKIN CARE" in small spaced capitals beneath it; a thin horizontal rule; "${name}" in large bold lowercase; "moisturizing body cream" in lighter grey lowercase beneath; and a solid black band across the lower part of the label. There is NO circular badge anywhere on this label. It is a jar — not a bottle, not a tube, and there is no pump, dropper or applicator of any kind.

THE WHOLE JAR MUST BE INSIDE THE FRAME. Attempt 1 ran the jar off the RIGHT edge on two frames, cutting the scent name in half, and off the BOTTOM edge on a third, cutting the base away. This jar is wide, so make it SMALLER than feels natural: leave at least 6% of the frame as clear empty margin beyond every side of the jar — left, right, top and bottom — and never let any part of the jar, its lid or its shadow touch or cross a frame edge.`;

const TUBE_DESC = `a slim cylindrical twist-up LIP BALM TUBE about 2.75 inches tall, standing upright: a BLACK cap carrying a small white rectangular panel with a tiny grey leaf icon and very small grey text; a white tube body with the brand name "real" in italic near-black lowercase and "SKIN CARE" in small spaced capitals beneath; a PHOTOREALISTIC ingredient illustration; the scent name in bold lowercase printed VERTICALLY, rotated to read from top to bottom, with "moisturizing lip balm" printed vertically beside it; a solid black band near the bottom; and a light grey ribbed base`;

const PRODUCTS = {
  cream: {
    handle: 'coconut-moisturizer',
    refs: { offer: 'cream-pure-unscented.png', proof: 'cream-coconut-breeze.png', compare: 'cream-coconut-breeze.png' },
    products: {
      offer: jar('a PHOTOREALISTIC single green leaf with small clear water droplets on it, cropped by the left edge of the label', 'pure unscented'),
      proof: jar('a PHOTOREALISTIC whole brown coconut behind a halved coconut showing white flesh, with slim green blade leaves', 'coconut breeze'),
      compare: jar('a PHOTOREALISTIC whole brown coconut behind a halved coconut showing white flesh, with slim green blade leaves', 'coconut breeze'),
    },
    // The default fine-text rule tells the model to draw the small circular badge as an
    // empty outline. This jar has NO badge, and attempt 2 duly drew one on the proof
    // frame, at the top right of the label. Same blank-band rule, no badge clause.
    fineText: `BECAUSE THE JAR RENDERS SMALL HERE, FINE LABEL TEXT MUST NOT BE INVENTED. If the volume line cannot be resolved at this size, render the black band as a PLAIN SOLID BAND WITH NO TEXT IN IT AT ALL rather than inventing a number. THIS LABEL CARRIES NO CIRCULAR BADGE, SEAL OR RING ANYWHERE — an earlier attempt drew an empty outline circle at the top right of the label, and there is no such thing on the real product. The brand name and the scent name stay and must be correct.`,
    offer: { headline: 'THE SENSITIVE SKIN SET', price: '$46.80', sub: 'lotion + this cream', checks: ['Save $11.20 against buying both', 'Orders over $45 ship free'] },
    proof: { quote: "This is THE moisturizer for Wisconsin winters for my whole family. It's long lasting and doesn't feel greasy.", who: 'Nicole H.', label: 'Verified purchase' },
    compare: { them: 'Conventional body cream', rows: [['No synthetic fragrance', 'Synthetic fragrance'], ['No parabens', 'Parabens'], ['No lanolin', 'Lanolin'], ['Works in, no slick film', 'Leaves a slick film']] },
    sources: {
      offer: 'Live catalogue 2026-09-10: sensitive-skin-starter-set "Sensitive Skin Moisturizing Set" $46.80 (available; body: "Eight ingredients across two products" — the Body Lotion and the Body Cream); coconut-lotion $30.00; coconut-moisturizer $28.00. 30 + 28 = 58; 58 - 46.80 = 11.20. Free shipping: live announcement bar "Free Shipping on Orders Over $45" and the PDP "Free shipping on orders $45+".',
      proof: 'Judge.me, coconut-moisturizer, Nicole Hoopman, 5 stars, verified-purchase, 2025-02-13, "Phenomenal winter moisturizer". Verbatim, contiguous: the review\'s second and third sentences. Surname shortened to an initial. No review count shown.',
      compare: 'First three rows from the live body-cream-not-in-it-v2.png frame (no synthetic fragrance, no lanolin, no parabens). The fourth from the live PDP body: "It goes on like butter and works in — heavy enough for rough spots, without the slick film." Comparison column is the generic category; no competitor named.',
    },
  },
  'lip-balm': {
    handle: 'coconut-oil-lip-balm',
    refs: { offer: 'lip-balm-four-ref.png', proof: 'tube-coconut-breeze.png', compare: 'tube-coconut-breeze.png' },
    products: {
      offer: `THE PRODUCT — copy it exactly from the reference photograph, which shows these four tubes and nothing else.

FOUR identical-format lip balm tubes standing upright in a neat row, left to right: vanilla dream (vanilla pods with a pale yellow flower), sweet tangerine (a halved tangerine with a green leaf), coconut breeze (a whole and a halved coconut with green blade leaves), pure unscented (a single green leaf). Each is ${TUBE_DESC}. Exactly four tubes — never three, never five. They are lip balm tubes — not jars, not pots, not bottles.

The tiny text on each cap panel is too small to read: render it as a few faint grey lines rather than inventing words.`,
      proof: `THE PRODUCT — copy it exactly from the reference photograph, which shows this tube and nothing else.

ONE ${TUBE_DESC}. The illustration is a whole brown coconut and a halved coconut showing white flesh, with green blade leaves, and the scent name is "coconut breeze". It is a lip balm tube — not a jar, not a pot, not a bottle. The tiny text on the cap panel must never be invented: leave it as faint grey lines.`,
      compare: `THE PRODUCT — copy it exactly from the reference photograph, which shows this tube and nothing else.

ONE ${TUBE_DESC}. The illustration is a whole brown coconut and a halved coconut showing white flesh, with green blade leaves, and the scent name is "coconut breeze". It is a lip balm tube — not a jar, not a pot, not a bottle. The tiny text on the cap panel must never be invented: leave it as faint grey lines.`,
    },
    offer: { headline: '4 BALMS FOR $15', price: '$3.75', sub: 'a tube', checks: ['Pick one scent or the variety pack', 'Three ingredients in every tube'] },
    proof: { quote: 'The texture is so smooth and glides right on. It leaves my lips so soft and smooth without any sticky feeling.', who: 'Hendrika', label: 'Verified purchase' },
    compare: { them: 'Conventional lip balm', rows: [['No paraffin', 'Paraffin'], ['No lanolin', 'Lanolin'], ['No menthol', 'Menthol'], ['No synthetic flavoring', 'Synthetic flavoring']] },
    sources: {
      offer: 'Live catalogue 2026-09-10: coconut-oil-lip-balm "Natural Coconut Oil Lip Balm | 0.15oz | Four Pack" $15.00, 5 of 5 variants in stock (Pure Unscented, Vanilla Dream, Sweet Tangerine, Coconut Breeze, Variety Pack). 15 / 4 = 3.75. "Three ingredients" from the live body ("Three ingredients, three jobs") and the live lip-balm-mechanism.png frame.',
      proof: 'Judge.me, coconut-oil-lip-balm, Hendrika, 5 stars, verified-purchase, 2023-01-29, "So moisturizing". Verbatim, contiguous: the review\'s second and third sentences. No review count shown.',
      compare: 'First three rows from the live lip-balm-not-in-it-v2.png frame (no paraffin, no lanolin, no menthol). The fourth from the live PDP body: "no synthetic flavoring". Comparison column is the generic category; no competitor named.',
    },
  },
};

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const attempt = process.argv.includes('--attempt') ? process.argv[process.argv.indexOf('--attempt') + 1] : '1';

const manifest = [];
for (const [key, p] of Object.entries(PRODUCTS)) {
  for (const frame of ['offer', 'proof', 'compare']) {
    const id = `${key}/${frame}`;
    manifest.push({ id, handle: p.handle, ref: p.refs[frame], source: p.sources[frame] });
    if (only && only !== id && only !== key) continue;
    process.stdout.write(`▶ ${id} … `);
    try {
      const buf = await renderVariation(gemini, {
        prompt: FRAME_BUILDERS[frame](p, p.products[frame], p.fineText),
        photoPaths: [join(REF, p.refs[frame])],
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
