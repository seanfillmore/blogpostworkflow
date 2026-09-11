#!/usr/bin/env node
/**
 * Build the missing offer / proof / compare frames for the coconut oil toothpaste
 * — the last non-bundle PDP without them.
 *
 * Every string is SOURCED (FRAMES' `sources`) and was run through
 * checkSeoCopyFields, findProductCategoryMisnomers and the ruled-word list
 * before a render was spent: 0 blocking, 0 advisory, 0 misnomers.
 *
 * THREE FACTS, each checked rather than assumed:
 *
 * 1. THE 3-PACK IS REAL AND ALL FOUR OF ITS VARIANTS ARE IN STOCK. $34.00
 *    against $13.00 singles — $5 saved, $11.33 a tube, which the 3-pack's own
 *    body states in those words. No subscription exists on either product.
 *
 * 2. THE VERIFIED REVIEWS ARE TOO THIN TO QUOTE. Of 20 published reviews only
 *    two are `verified-purchase`: "Works wonders" (two words) and a 4-star whose
 *    substance is a complaint about the cap clogging. So the proof frame quotes
 *    Mike Gray, whose Judge.me source is `email` rather than `verified-purchase`,
 *    and shows NO verification label — the same rule the foaming hand soap frame
 *    follows. Attribution only; never a badge the record does not support.
 *
 * 3. THIS PRODUCT REALLY HAS A CIRCULAR BADGE ("MADE WITH ORGANIC COCONUT OIL +
 *    ESSENTIAL OILS" around a toothbrush-and-droplet mark), so the default
 *    blankFineTextRule() is correct here and no `fineText` override is passed —
 *    unlike the body cream, where that rule invented a badge.
 *
 * References are prop-free crops in data/product-images/_clean-toothpaste/ — the
 * studio shots have gel squiggles beside the bottle, and the model reproduces
 * props faithfully when they are in the reference.
 *
 * Usage: node scripts/build-pdp-frames-toothpaste.mjs [--only <frame>] [--attempt N]
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GoogleGenAI } from '@google/genai';
import { renderVariation } from '../agents/ad-studio/render.js';
import { FRAME_BUILDERS } from '../lib/pdp-frame-prompts.js';

const ROOT = process.cwd();
const OUT = join(ROOT, 'data', 'creatives', 'pdp-frames-toothpaste');
mkdirSync(OUT, { recursive: true });
const REF = join(ROOT, 'data', 'product-images', '_clean-toothpaste');

const env = Object.fromEntries(
  readFileSync(join(ROOT, '.env'), 'utf8').split('\n')
    .filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; })
);
const gemini = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

const BOTTLE = (art, name) => `a tall slim WHITE opaque plastic SQUEEZE BOTTLE, 4 fl. oz., with straight sides and a glossy BLACK FLIP-TOP CAP as tall as roughly a fifth of the bottle. The white label carries, top to bottom: the brand name "real" in large italic near-black lowercase with "SKIN CARE" in small spaced capitals beneath; a circular THIN GREY OUTLINE BADGE enclosing a small toothbrush-and-droplet mark, with tiny arc text around its rim; ${art}; then "${name}" in bold lowercase on two lines with "toothpaste" in lighter grey beneath; and a solid black band across the base of the label. It is a squeeze bottle — NOT a tube, not a jar, not a pump, and it has no applicator`;

const MINT = BOTTLE('a PHOTOREALISTIC sprig of bright green mint leaves', 'fresh mint');

const P = {
  handle: 'coconut-oil-toothpaste',
  refs: { offer: 'tp-three-ref.png', proof: 'tp-fresh-mint.png', compare: 'tp-fresh-mint.png' },
  products: {
    offer: `THE PRODUCT — copy it exactly from the reference photograph, which shows these three bottles and nothing else.

THREE identical-format bottles standing upright in a neat row, left to right: "fresh mint" (a sprig of green mint leaves), "all natural" (a cinnamon stick with cloves and green leaves), "cinnamon spice" (cinnamon sticks with cloves). Each is ${BOTTLE('a PHOTOREALISTIC botanical illustration matching its flavour', 'the flavour name')}. Exactly three bottles — never two, never four.

THE BADGE'S TINY CURVED TEXT CANNOT BE RESOLVED AT THIS SIZE AND MUST NOT BE INVENTED. Render the circular badge as a thin grey outline holding the small toothbrush-and-droplet mark, with its rim text as faint grey marks carrying NO legible words. Attempt 1 printed "MADE WITH ORGANIC COCOBUY OIL" on all three bottles — an invented word on a real product. Faint unreadable marks are right; a misspelt word is a product-accuracy failure.`,
    proof: `THE PRODUCT — copy it exactly from the reference photograph, which shows this bottle and nothing else.

ONE ${MINT}.`,
    compare: `THE PRODUCT — copy it exactly from the reference photograph, which shows this bottle and nothing else.

ONE ${MINT}.`,
  },
  offer: { headline: '3 TUBES FOR $34', price: '$11.33', sub: 'a tube', checks: ['Save $5 against three singles', 'One flavor or one of each'] },
  // ONE sentence, not the first two. Attempt 1 rendered the 33-word version with a
  // duplicated word ("mouth fee feeling fresh") — altering a customer's words is the
  // worst defect this frame can have, and a shorter quote is far less likely to mangle.
  proof: { quote: 'This is my first time trying natural toothpaste and I am impressed.', who: 'Mike G.', label: null },
  compare: { them: 'Conventional toothpaste', rows: [['No fluoride', 'Fluoride'], ['No SLS', 'SLS'], ['No titanium dioxide', 'Titanium dioxide'], ['No synthetic sweeteners', 'Synthetic sweeteners']] },
  sources: {
    offer: 'Live catalogue 2026-09-11: coconut-oil-toothpaste $13.00 (3 of 3 variants in stock); coconut-toothpaste-3-pack $34.00, 4 of 4 variants in stock (Variety — one of each, 3x Fresh Mint, 3x All Natural, 3x Cinnamon Spice). 3 x 13 = 39, saving 5; 34 / 3 = 11.33. The 3-pack body states both figures: "a $5 saving against three singles, or $11.33 per tube".',
    proof: 'Judge.me, coconut-oil-toothpaste, Mike Gray, 5 stars, 2024-06-04, "Impressive toothpaste". Verbatim: the review\'s FIRST SENTENCE alone (attempt 1 rendered the two-sentence version with a duplicated word). Judge.me records the source as "email", NOT verified-purchase, so NO verification label is shown — attribution only, same as the foaming hand soap frame. Only 2 of 20 published reviews are verified-purchase and neither is quotable ("Works wonders"; a 4-star about the cap clogging). No review count shown.',
    compare: 'All four rows verbatim from the live toothpaste-not-in-it.png frame, and each also appears in the live PDP body ("No SLS, no fluoride, no titanium dioxide, no synthetic sweeteners"). Comparison column is the generic category; no competitor named.',
  },
};

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const attempt = process.argv.includes('--attempt') ? process.argv[process.argv.indexOf('--attempt') + 1] : '1';

const manifest = [];
for (const frame of ['offer', 'proof', 'compare']) {
  manifest.push({ id: frame, handle: P.handle, ref: P.refs[frame], source: P.sources[frame] });
  if (only && only !== frame) continue;
  process.stdout.write(`▶ ${frame} … `);
  try {
    const buf = await renderVariation(gemini, {
      prompt: FRAME_BUILDERS[frame](P, P.products[frame]),
      photoPaths: [join(REF, P.refs[frame])],
      ratio: '1:1',
    });
    const out = join(OUT, `toothpaste-${frame}-a${attempt}.png`);
    writeFileSync(out, buf);
    console.log(`${(buf.length / 1024).toFixed(0)} KB`);
  } catch (e) {
    console.log(`FAILED: ${e.message}`);
  }
}
writeFileSync(join(OUT, 'frames.json'), JSON.stringify(manifest, null, 2));
console.log(`\nSourcing recorded → ${join(OUT, 'frames.json')}`);
