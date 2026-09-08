#!/usr/bin/env node
/**
 * Regenerate step 2 of the lotion how-to frame.
 *
 * THE DEFECT: the live frame's step 2 draws a PUMP DISPENSER and reads "Pump a
 * small amount". This product has no pump — it is a squeeze bottle with a
 * flip-top disc cap. Step 1 of the same frame draws the correct bottle, which
 * is why step 1 is used here as both the style and the product reference.
 *
 * Icon only, on white, no text — the caption is set afterwards with ImageMagick
 * so the surrounding frame stays byte-identical apart from the two regions
 * being replaced.
 *
 * Usage: node scripts/build-howto-step2-icon.mjs [--attempt N]
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GoogleGenAI } from '@google/genai';
import { renderVariation } from '../agents/ad-studio/render.js';

const ROOT = process.cwd();
const OUT = join(ROOT, 'data', 'creatives', 'lotion-howto');
mkdirSync(OUT, { recursive: true });

const env = Object.fromEntries(
  readFileSync(join(ROOT, '.env'), 'utf8').split('\n')
    .filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; })
);
const gemini = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

const attempt = process.argv.includes('--attempt') ? process.argv[process.argv.indexOf('--attempt') + 1] : '1';

const prompt = `Draw ONE flat line-art pictogram, in exactly the style of the reference image supplied.

STYLE — match the reference precisely: single-weight OUTLINE strokes in muted sage green (#819E7F), uniform stroke thickness throughout, softly rounded stroke caps and corners, NO fill of any kind, NO shading, NO gradient, NO colour other than that one green. Pure flat white background. The whole pictogram centred with a little breathing room, filling most of the square.

SUBJECT — keep it SIMPLE. A minimal pictogram of exactly THREE elements and nothing else:

1. Upper left: the bottle, tipped nozzle-downward at about 45 degrees. It is the SAME bottle as the reference image — a tall slim rounded-cornered cylinder with a small FLIP-TOP DISC CAP at the narrow end. Drawn as a plain outline, no hand holding it.
2. Middle: ONE single teardrop shape falling from the cap.
3. Lower right: ONE open hand, palm up and gently cupped, waiting to catch the drop. Draw the hand simply — a cupped palm and four soft finger contours plus a thumb, in the clean minimal manner of the reference. Do not overlap or stack multiple hands.

This is a simple pictogram of a few clean strokes, NOT a detailed illustration. Fewer, longer, confident strokes. Every stroke must be a closed, coherent, anatomically sensible contour — no stray fragments, no overlapping duplicate outlines, no scribble.

CRITICAL: there is NO PUMP. Do not draw a pump dispenser, a pump head, a plunger, a press-down actuator, a collar, a dip tube, a spray nozzle or a soap dispenser of any kind. The container is a plain squeeze bottle closed by a small flat disc cap. A previous version of this pictogram drew a pump dispenser and that is the exact error being corrected.

NO TEXT anywhere in the image — no numerals, no captions, no letters. Pictogram only.

Output one square image.`;

const buf = await renderVariation(gemini, {
  prompt,
  photoPaths: [join(ROOT, 'refs', 'step1-icon.png')],
  ratio: '1:1',
});
const p = join(OUT, `step2-icon-a${attempt}.png`);
writeFileSync(p, buf);
console.log(`→ ${p} (${(buf.length / 1024).toFixed(0)} KB)`);
