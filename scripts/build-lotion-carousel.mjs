#!/usr/bin/env node
/**
 * Build the four missing lotion PDP gallery frames — offer, proof, transform, compare.
 *
 * V2 (2026-09-08), after the operator rejected the first set: "The three of these
 * bottles don't even match each other let alone the product image. Remove the ivy,
 * wooden block, and the wavy background from the sample images so they do not render."
 *
 * TWO ROOT CAUSES, both in the REFERENCE PHOTOS rather than the prompt:
 *
 * 1. PROPS. The v1 references were the brand's styled flat-lays — coconut-breeze/3.jpg
 *    carries a wavy textured wall, trailing pothos ivy, a raw-edge wood slice, stacked
 *    stones and a loofah ALL IN ONE FRAME. The model faithfully reproduced them, so
 *    every generated frame grew ivy and a wood riser. The fix is not to ask the model
 *    to omit them; it is to never show them. References are now cropped from 1.webp,
 *    the clean studio shot, and carry the bottle and nothing else.
 *
 * 2. AN INVENTED LABEL. Feeding three different styled photos at three different
 *    angles let the model improvise, and it improvised differently every time — a
 *    full palm TREE in one, a bare "organic Oil" dot in another, engraved line-art
 *    coconuts in a third. Measured against the real label, the truth is:
 *      - the coconut art is PHOTOREALISTIC, not an engraving or line drawing
 *      - the badge is a thin GREY OUTLINE circle, not a filled black dot
 *      - the volume separator is a BULLET (•), not a hyphen or a tilde
 *      - "coconut breeze" sits on ONE line
 *    All four are now stated, and the badge and coconut art each get their own
 *    close-up reference (the multi-angle + fine-detail rule in
 *    marketing-ai-product-imagery).
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

// Prop-free crops of coconut-breeze/1.webp — the clean studio shot. Never the flat-lays.
const REF_DIR = join(ROOT, 'data', 'product-images', 'coconut-lotion', '_clean');
const PHOTOS = ['ref-bottle.png', 'ref-label.png', 'ref-badge.png', 'ref-coconut.png'].map(f => join(REF_DIR, f));

const PRODUCT = `THE PRODUCT — copy it exactly from the reference photographs, which show this bottle and nothing else.

An 8 fl. oz. (236ml) white plastic bottle: a TALL SLIM cylinder with a gentle shoulder taper, roughly three times taller than it is wide, with a glossy BLACK flip-top disc cap about one sixth of the total height. The label wraps the lower two thirds on a white ground, top to bottom:

1. "real" — large, lowercase, in a distinctive rounded near-black sans with a small flick on the r and a tall l.
2. "SKIN CARE" — small, widely letter-spaced capitals, centred beneath it.
3. A circular badge: a THIN GREY OUTLINE circle, not a filled dot and not black. Inside, tiny grey "MADE" and "WITH" flanking a small water-drop icon, then "ORGANIC / COCONUT / OIL" on three stacked lines. "+ ESSENTIAL OILS" curves along the OUTSIDE of the lower arc.
4. The coconut artwork: a PHOTOREALISTIC photograph of one whole brown husked coconut on the left and one halved coconut showing white flesh on the right, with slim spiky GREEN BLADE LEAVES fanning out behind them. Photographic, full colour, with real texture — NOT an engraving, NOT line art, NOT a woodcut, NOT a flat illustration.
5. "coconut breeze" — bold lowercase near-black, on ONE single line.
6. "moisturizing body lotion" — smaller, lighter, beneath it.
7. A solid black horizontal bar at the base reading "8 fl. oz. • 236ml" in white, with a round BULLET between the two, never a hyphen and never a tilde.

FIVE THINGS PREVIOUS RENDERS GOT WRONG. Do not repeat any of them:
- Do NOT draw a palm TREE with a trunk. There is no tree. Coconuts and blade leaves only.
- Do NOT render the coconuts as an engraved, etched or line-drawn illustration. They are a photograph.
- Do NOT replace the badge with a plain filled circle, a black dot, or the words "organic Oil". Reproduce the outlined badge as described, or if it is too small to render legibly, render it as a plain thin grey outline circle with no invented text inside.
- The volume is 236ml. Never 238ml.
- All label text is BLACK or GREY. Never brown, tan or coloured.

The reference photographs may show a faint beige lotion smear at the extreme left and right edges. That is studio styling, NOT part of the product. Ignore it and never render it.`;

const NO_PROPS = `BACKGROUND AND PROPS — a hard requirement, and the reason this set is being rebuilt:

Render the product on a PLAIN, SEAMLESS, UNCLUTTERED background — clean white or a very light neutral grey, with a soft realistic contact shadow beneath the bottle.

Do NOT include, anywhere in the frame: house plants, pothos, ivy, trailing vines, leaves or foliage of any kind; wood, wooden slices, wooden risers, tree stumps, bark or cutting boards; wavy, rippled, fluted, panelled or textured walls; stacked stones or pebbles; loofahs, towels, sponges or woven baskets; marble slabs or stone counters. No botanical styling of any kind. The frame contains the product, the typography, and empty space.`;

const IDENTITY = `VISUAL IDENTITY, identical across the set: bright, even, soft studio daylight; a plain seamless white or very pale neutral ground; a soft grounded contact shadow; near-black clean modern geometric sans-serif typography; generous white space. Consistency comes from this identity and from the product being IDENTICAL in every frame — never from repeating a composition. Each frame is a different layout.`;

const SHARED = `${IDENTITY}

${NO_PROPS}

SHARED REQUIREMENTS: One main selling idea. Square 1:1. Mobile-first hierarchy — the largest text must be readable at thumbnail size on a phone. Keep all essential content comfortably inside the edges. Render every text string EXACTLY as written, spelled correctly, with no extra words, no invented copy, no watermark and no signature. Do NOT invent testimonials, review counts, star ratings, press logos, certifications, awards, badges, scarcity or before-and-after evidence. Produce one finished square image, not a collage of alternatives.`;

const FRAMES = [
  {
    id: 'offer',
    source: 'Live PDP 2026-09-08: "Save 15%" subscription, "Free shipping on orders $45+ and on every subscription order", "Pause, skip, or cancel anytime". Price $30.00 → $25.50 at 15%.',
    strings: ['SUBSCRIBE & SAVE 15%', '$25.50', 'per 8 oz bottle when you subscribe', 'Free shipping on every subscription order', 'Pause, skip or cancel anytime'],
    prompt: `Create a premium ecommerce carousel frame whose single job is to state the OFFER.

${PRODUCT}

LAYOUT: The bottle stands upright and centred in the right third of the frame on a plain seamless white ground with a soft contact shadow. The left two thirds carry the offer as clean typography on the same white ground.

EXACT TEXT, rendered precisely and spelled correctly:
- Large bold headline, the biggest element in the frame: "SUBSCRIBE & SAVE 15%"
- Beneath it, very large: "$25.50"
- Directly under that price, small: "per 8 oz bottle when you subscribe"
- Two short supporting lines lower down, each with a simple thin check mark: "Free shipping on every subscription order" and "Pause, skip or cancel anytime"

No other text anywhere. No sale starbursts, no percentage badges, no urgency banners, no countdown.

${SHARED}`,
  },
  {
    id: 'proof',
    source: 'Judge.me, coconut-lotion, Nicole Hoopman, 5 stars, verified-purchase. Verbatim excerpt of the first two sentences. No review count shown: the API reports 26 product reviews while the on-page widget badge reads 174, and an unreconciled count may not be published.',
    strings: ['"This is the perfect moisturizer for my kids in the summer. It absorbs quickly yet is effective all day."', 'Nicole H.', 'Verified purchase'],
    prompt: `Create a premium ecommerce carousel frame whose single job is TRUST, built around one real customer quote.

${PRODUCT}

LAYOUT: A clean editorial layout on a plain seamless white ground. The quote is the hero and sits across the upper two thirds, set large. The bottle stands upright, smaller, in the lower right, with a soft contact shadow. Quiet and typographic — no styling props whatsoever.

EXACT TEXT, rendered precisely and spelled correctly:
- A row of exactly five small filled black stars, above the quote.
- The quote, large, in quotation marks: "This is the perfect moisturizer for my kids in the summer. It absorbs quickly yet is effective all day." Use matching curly typographic quotation marks for BOTH the opening and the closing mark — a previous render opened with a curly mark and closed with a straight one.
- Beneath the quote, smaller: "Nicole H."
- Directly beneath that, smallest: "Verified purchase"

No other text anywhere. Do NOT add a review count, a numeric rating, an average score, a press logo or any badge. Do NOT show a person — no human face or body — because the reviewer must never be portrayed by a generated model.

${SHARED}`,
  },
  {
    id: 'transform',
    source: 'Routine contrast, not a skin result. Grounded in the live PDP benefit "Absorbs without a film" and the mechanism frame "built to absorb into skin instead of sitting on top of it". Depicts waiting to dress, never a change in skin condition.',
    strings: ['Still waiting to get dressed.', 'Dressed and out the door.'],
    prompt: `Create a premium ecommerce carousel frame contrasting a familiar ROUTINE frustration with the easier routine, split vertically down the middle into two panels.

${PRODUCT}

This is a contrast of ROUTINE and TIMING only. It is NOT a skin before-and-after and must NOT depict any change in skin condition, redness, dryness, texture or healing.

LEFT PANEL: a woman in her thirties sits on the edge of a neatly made bed in a bright, plain, minimal bedroom, in a white robe, waiting — arms held slightly away from her body, hands tacky, folded clothes beside her, faintly impatient. Cooler, flatter light.

RIGHT PANEL: the SAME woman, the SAME bedroom, the SAME camera angle and framing, now dressed in a simple cream sweater, relaxed and ready to leave. Warmer light.

The room is deliberately BARE: plain painted wall, plain bedding, a simple bedside table. NO houseplants, NO wood slices, NO textured or paneled wall, NO botanical styling — see the background requirements below, which apply to this scene exactly as they do to the studio frames.

SCALE OF THE BOTTLE — get this right, it has been wrong in both directions. The bottle stands ON the bedside table in each panel, in the MIDDLE DISTANCE at realistic real-world size: an 8 oz lotion bottle is about 20cm tall, so it should occupy roughly one fifth of the panel's height and read as a small object sitting on furniture. It is a background detail in a photograph of a room, NOT a foreground product shot. A previous render placed an enormous bottle in the foreground of each panel, taller than the seated woman and covering half the scene — never do that. The woman and the room are the subject; the bottle is simply present, identical in both panels, recognizable but small.

BECAUSE THE BOTTLE IS SMALL HERE, THE FINE LABEL TEXT MUST NOT BE INVENTED. At this scale the volume line cannot be resolved, and previous renders filled it in with numbers that are simply wrong — "250ml" and "238ml" on a 236ml product. So: render the black bar at the base of the label as a PLAIN SOLID BLACK BAND WITH NO TEXT IN IT AT ALL, and likewise leave the small circular badge as a plain thin grey outline circle with no text inside. "real", "SKIN CARE", "coconut breeze" and the photographic coconut artwork stay and must be correct. An empty band is right; an invented number is a product-accuracy failure.

Keep the person, room, angle, framing, bedding and furniture identical across both panels. Only her clothing, her posture and the warmth of the light may differ.

EXACT TEXT, rendered precisely and spelled correctly — one short label at the top of each panel, nothing else:
- Left: "Still waiting to get dressed."
- Right: "Dressed and out the door."

The left label is FIVE words and contains the word "to" exactly ONCE. A previous render duplicated it and read "Still waiting to to get dressed." Proofread both labels letter by letter before finishing.

No other text anywhere. No arrows, no "before" or "after" words, no timers or clock graphics.

${SHARED}`,
  },
  {
    id: 'compare',
    source: 'Rows sourced from the live PDP frames: product title "Made With Only 6 Clean Ingredients"; "not in it" frame (no mineral oil, no petroleum jelly, no silicones, no parabens); mechanism frame ("absorb into skin instead of sitting on top of it"). Comparison column is the generic category — no competitor brand is named.',
    strings: ['Real Skin Care', 'Conventional lotion', '6 ingredients you can read', '20+ ingredient list', 'No mineral oil or petrolatum', 'Mineral oil, petrolatum', 'No silicones or parabens', 'Silicones, parabens', 'Absorbs in, leaves no film', 'Sits on top of skin'],
    prompt: `Create a premium ecommerce carousel frame that is a clean two-column comparison chart.

${PRODUCT}

LAYOUT: A simple, uncluttered two-column table occupying the UPPER TWO THIRDS of the frame on a plain seamless white ground, mobile-optimized, generous spacing, thin light rules only — no heavy boxes, no drop shadows on the table. The bottle stands upright and small in the BOTTOM THIRD, centred, with a soft contact shadow.

The bottle must sit ENTIRELY BELOW the table with clear empty space between the table's lowest rule and the top of the cap. It must NOT overlap, intersect or sit behind the table. A previous render placed the bottle in the middle of the table so the centre column divider ran down through the cap and the bottle covered the row text — never do that. The background behind the table is plain white and completely empty.

Left column header: "Real Skin Care". Right column header: "Conventional lotion".
Left column cells each carry a small green check mark. Right column cells each carry a small grey cross.

EXACT TEXT for the four rows, rendered precisely and spelled correctly, left cell then right cell:
1. "6 ingredients you can read" / "20+ ingredient list"
2. "No mineral oil or petrolatum" / "Mineral oil, petrolatum"
3. "No silicones or parabens" / "Silicones, parabens"
4. "Absorbs in, leaves no film" / "Sits on top of skin"

No other text anywhere. Do NOT name, show or imply any competitor brand, logo or packaging. Do NOT add a headline, footnote or call to action.

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
    const p = join(OUT, `${f.id}-c${attempt}.png`);
    writeFileSync(p, buf);
    console.log(`${(buf.length / 1024).toFixed(0)} KB → ${p}`);
  } catch (e) {
    console.log(`FAILED: ${e.message}`);
  }
}
writeFileSync(join(OUT, 'frames.json'), JSON.stringify(FRAMES.map(({ id, source, strings }) => ({ id, source, strings })), null, 2));
console.log(`\nSourcing + exact strings recorded → ${join(OUT, 'frames.json')}`);
