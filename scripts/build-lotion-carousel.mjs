#!/usr/bin/env node
/**
 * Build the four MISSING lotion PDP gallery frames.
 *
 * The live coconut-lotion gallery covers hero / mechanism / not-in-it / benefits /
 * how-to / lifestyle. Audited 2026-09-08 against the seven-frame Shopify gallery
 * order in marketing-product-image-stack, it is missing FOUR jobs:
 *
 *   offer      — a dedicated offer frame (the job adopted from the Kenyon article,
 *                PR #844; our seven-frame order never had one)
 *   proof      — a real, attributed review
 *   transform  — routine contrast (NOT a skin before/after: this is a cosmetic and
 *                may not claim a result)
 *   compare    — us-vs-them against the conventional category, no brand named
 *
 * Every copy string below is SOURCED and recorded in FRAMES[].source so the
 * proofread pass has something to check the render against. Nothing here may
 * invent a testimonial, a review count, a certification or a scarcity claim.
 *
 * Usage: node scripts/build-lotion-carousel.mjs [--only <id>] [--attempt N]
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GoogleGenAI } from '@google/genai';
import { renderVariation } from '../agents/ad-studio/render.js';

const ROOT = process.cwd();
const OUT = join(ROOT, 'data', 'creatives', 'lotion-carousel');
mkdirSync(OUT, { recursive: true });

const env = Object.fromEntries(
  readFileSync(join(ROOT, '.env'), 'utf8').split('\n')
    .filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; })
);
const gemini = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

const REF_DIR = join(ROOT, 'data', 'product-images', 'coconut-lotion', 'coconut-breeze');
const PHOTOS = ['IMG_7589.jpg', '3.jpg', '5.jpg'].map(f => join(REF_DIR, f));

// From data/product-images/manifest.json, coconut-lotion entry.
const PRODUCT = `An 8 fl. oz. (236ml) white plastic cylindrical squeeze bottle with a smooth, slightly glossy finish and a BLACK flip-top disc cap. Clean minimalist white label: the brand name "real" in large lowercase black text with "SKIN CARE" in small spaced capitals directly beneath it; a small circular badge reading "ORGANIC COCONUT OIL + ESSENTIAL OILS"; a centered coconut-and-palm illustration; the scent name "coconut breeze" in bold lowercase black text above "moisturizing body lotion" in smaller type; and a black horizontal bar at the base of the label. The bottle is a TALL SLIM cylinder, roughly 7-8 inches tall and about 2.5 inches across - clearly taller than it is wide, never squat or jar-shaped.

THREE LABEL DETAILS THAT HAVE BEEN RENDERED WRONG BEFORE - get each exactly right:
1. VOLUME. The black bar at the base of the label reads exactly "8 fl. oz. - 236ml". A previous render read "8 fl. oz ~ 238ml", which is wrong. The number is 236, never 238. The separator is a hyphen, never a tilde. Never omit the millilitres.
2. BADGE. The small circular badge reading "ORGANIC COCONUT OIL + ESSENTIAL OILS" is REQUIRED and sits above the coconut illustration. A previous render omitted it entirely. Include both the circular badge and the coconut-and-palm illustration.
3. INK. Every piece of label text is BLACK. A previous render set "coconut breeze" in brown/tan. There is no brown, tan or coloured type anywhere on the label.
4. ILLUSTRATION. The coconut illustration is ONE whole brown coconut beside ONE halved coconut showing white flesh, with a few slim green palm FRONDS fanning out behind them at the sides. There is NO palm TREE. A previous render drew a complete palm tree with a brown trunk and a full crown rising above the coconuts - that tree does not exist on the real label and must not appear. Fronds only, no trunk, no tree.`;

// Shared visual identity, taken from the brand's own reference photography:
// marble counter, raw-edge wood slice, pothos greenery, soft natural daylight.
const IDENTITY = `VISUAL IDENTITY (identical across the set): bright natural daylight, soft directional shadows, a white marble or pale stone counter, and restrained styling drawn from the brand's own photography - a raw-edge wood slice riser and fresh green pothos leaves. Palette is white, black, warm wood and living green. Typography is a clean modern geometric sans-serif in near-black on white. Premium commercial product photography, realistic materials, believable depth. Consistency must come from this identity and NOT from repeating the same composition - every frame is a different scene and layout.`;

const SHARED = `${IDENTITY}

SHARED REQUIREMENTS: One main selling idea. Square 1:1. Mobile-first hierarchy - the largest text must be readable at thumbnail size on a phone. Keep all essential content comfortably inside the edges. The product must be recognizable and its label must match the reference photographs exactly in shape, cap colour, label layout and printed text. Render every text string EXACTLY as written, spelled correctly, with no extra words, no invented copy, no watermark and no signature. Do NOT invent testimonials, review counts, star ratings, press logos, certifications, awards, badges, scarcity or before-and-after evidence. Produce one finished square image, not a collage of alternatives.`;

const FRAMES = [
  {
    id: 'offer',
    source: 'Live PDP 2026-09-08: "Save 15%" subscription, "Free shipping on orders $45+ and on every subscription order", "Pause, skip, or cancel anytime". Price $30.00 → $25.50 at 15%.',
    strings: ['SUBSCRIBE & SAVE 15%', '$25.50', 'per 8 oz bottle when you subscribe', 'Free shipping on every subscription order', 'Pause, skip or cancel anytime'],
    prompt: `Create a premium ecommerce carousel frame whose single job is to state the OFFER.

${PRODUCT}

LAYOUT: The bottle stands upright, lit and photographed for real, occupying the right third of the frame on the marble counter with a wood slice and a few pothos leaves. The left two thirds carry the offer on a clean white field.

EXACT TEXT, rendered precisely and spelled correctly:
- Large bold headline, the biggest element in the frame: "SUBSCRIBE & SAVE 15%"
- Beneath it, very large: "$25.50"
- Directly under that price, small: "per 8 oz bottle when you subscribe"
- Two short supporting lines lower down, each with a simple thin check mark: "Free shipping on every subscription order" and "Pause, skip or cancel anytime"

No other text anywhere. No sale starbursts, no percentage badges, no urgency banners, no countdown, no additional headlines.

${SHARED}`,
  },
  {
    id: 'proof',
    source: 'Judge.me, coconut-lotion, Nicole Hoopman, 5 stars, verified-purchase. Verbatim excerpt of the first two sentences. No review count shown: the API reports 26 product reviews while the on-page widget badge reads 174, and an unreconciled count may not be published.',
    strings: ['"This is the perfect moisturizer for my kids in the summer. It absorbs quickly yet is effective all day."', 'Nicole H.', 'Verified purchase'],
    prompt: `Create a premium ecommerce carousel frame whose single job is TRUST, built around one real customer quote.

${PRODUCT}

LAYOUT: A clean editorial layout on a white field. The quote is the hero of the frame and sits in the upper two thirds, set large. The bottle is photographed for real, smaller, resting on a wood slice with a pothos leaf at the lower right. This must NOT look like the other frames - it is quiet, typographic and editorial.

EXACT TEXT, rendered precisely and spelled correctly:
- A row of exactly five small filled black stars, above the quote.
- The quote, large, in quotation marks: "This is the perfect moisturizer for my kids in the summer. It absorbs quickly yet is effective all day."
- Beneath the quote, smaller: "Nicole H."
- Directly beneath that, smallest: "Verified purchase"

No other text anywhere. Do NOT add a review count, a numeric rating, an average score, a press logo or any badge. Do NOT show a person - there must be no human face or body in this frame, because the reviewer must never be portrayed by a generated model.

${SHARED}`,
  },
  {
    id: 'transform',
    source: 'Routine contrast, not a skin result. Grounded in the live PDP benefit "Absorbs without a film" and the product mechanism frame "built to absorb into skin instead of sitting on top of it". Depicts waiting to dress, never a change in skin condition.',
    strings: ['Still waiting to get dressed.', 'Dressed and out the door.'],
    prompt: `Create a premium ecommerce carousel frame that contrasts a familiar ROUTINE frustration with the easier routine, split vertically down the middle into two panels.

${PRODUCT}

This is a contrast of ROUTINE and TIMING only. It is NOT a skin before-and-after and must NOT depict any change in skin condition, redness, dryness, texture or healing.

LEFT PANEL: the same woman in her thirties sits on the edge of a bed in a bright bedroom, in a robe, waiting - arms held slightly away from her body, hands tacky, clothes still folded beside her, faintly impatient. Cooler, flatter light.

RIGHT PANEL: the SAME woman, the SAME bedroom, the SAME camera angle and framing, now dressed in a simple cream sweater, relaxed and ready to leave. The lotion bottle sits on the nightstand, clearly recognizable. Warmer light.

CRITICAL: the two panels must be the SAME PHOTOGRAPH of the SAME SET, changed only in what she is doing. A previous render changed the bedding colour, the wall colour, the props and the plant position between panels, which reads as two different rooms and breaks the comparison. Identical bedding, identical headboard, identical wall, identical nightstand, identical plant in the identical position, identical camera height and distance. Only her clothing, her posture and the warmth of the light may differ.

EXACT TEXT, rendered precisely and spelled correctly - one short label at the top of each panel, nothing else:
- Left: "Still waiting to get dressed."
- Right: "Dressed and out the door."

No other text anywhere. No arrows, no "before" or "after" words, no timers, no clock graphics, no split-screen sparkles.

${SHARED}`,
  },
  {
    id: 'compare',
    source: 'Rows sourced from the live PDP frames: product title "Made With Only 6 Clean Ingredients"; "not in it" frame (no mineral oil, no petroleum jelly, no silicones, no parabens); mechanism frame ("absorb into skin instead of sitting on top of it"). Comparison column is the generic category - no competitor brand is named.',
    strings: ['Real Skin Care', 'Conventional lotion', '6 ingredients you can read', '20+ ingredient list', 'No mineral oil or petrolatum', 'Mineral oil, petrolatum', 'No silicones or parabens', 'Silicones, parabens', 'Absorbs in, leaves no film', 'Sits on top of skin'],
    prompt: `Create a premium ecommerce carousel frame that is a clean two-column comparison chart.

${PRODUCT}

LAYOUT: A simple, uncluttered two-column table on a white field, mobile-optimized, with generous spacing. The bottle is photographed for real and sits small at the top centre or bottom centre, above or below the table, not behind it. Simple, modern and clean - not busy, no heavy boxes or borders, no drop shadows on the table.

Left column header: "Real Skin Care". Right column header: "Conventional lotion".
Left column cells each carry a small green check mark. Right column cells each carry a small grey cross.

EXACT TEXT for the four rows, rendered precisely and spelled correctly, left cell then right cell:
1. "6 ingredients you can read" / "20+ ingredient list"
2. "No mineral oil or petrolatum" / "Mineral oil, petrolatum"
3. "No silicones or parabens" / "Silicones, parabens"
4. "Absorbs in, leaves no film" / "Sits on top of skin"

No other text anywhere. Do NOT name, show or imply any competitor brand, logo or packaging. Do NOT add a headline, a footnote or a call to action.

${SHARED}`,
  },
];

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const attempt = process.argv.includes('--attempt') ? process.argv[process.argv.indexOf('--attempt') + 1] : '1';

for (const f of FRAMES) {
  if (only && f.id !== only) continue;
  process.stdout.write(`▶ ${f.id} … `);
  try {
    const buf = await renderVariation(gemini, { prompt: f.prompt, photoPaths: PHOTOS, ratio: '1:1' });
    const p = join(OUT, `${f.id}-v${attempt}.png`);
    writeFileSync(p, buf);
    console.log(`${(buf.length / 1024).toFixed(0)} KB → ${p}`);
  } catch (e) {
    console.log(`FAILED: ${e.message}`);
  }
}
writeFileSync(join(OUT, 'frames.json'), JSON.stringify(FRAMES.map(({ id, source, strings }) => ({ id, source, strings })), null, 2));
console.log(`\nSourcing + exact strings recorded → ${join(OUT, 'frames.json')}`);
