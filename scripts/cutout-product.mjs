#!/usr/bin/env node
/**
 * Key the flat backdrop out of a product photo and emit a transparent PNG.
 *
 *   node scripts/cutout-product.mjs <photo> <out.png> [--tolerance 62] [--feather 1.4]
 *
 * Why this exists: gemini-3-pro-image composes and lights beautifully but cannot
 * preserve label text. Asked three different ways — full infographic, and twice
 * just to swap the backdrop — it re-lettered the bottles every time: "8 fl oz -
 * 235ml" and "- 255ml" where the real bottle says 236ml, jars at 110ml where they
 * are 118ml, and the ORGANIC COCONUT OIL seal as mirrored nonsense. It regenerates
 * the product rather than moving it, and a wrong volume on a cosmetic is an
 * accuracy problem, not a style note.
 *
 * So the real product pixels have to survive into the composite. The bundle heroes
 * were shot on a flat mint backdrop, which keys cleanly.
 *
 * The key is a FLOOD FILL inward from the image border, not a global colour
 * distance. That distinction matters here: the labels carry green coconut-palm
 * leaves that sit closer to the backdrop hue than the white bottle does, so a
 * global key eats holes in the artwork. Flood fill only removes backdrop that is
 * actually connected to the edge, so enclosed green stays.
 *
 * Tolerance is measured against a per-row sample of the true backdrop, because
 * these frames vignette — the corners of the Coconut Breeze hero range from
 * RGB(154,203,174) to (182,219,186), which a single global reference would clip.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';

const argv = process.argv.slice(2);
const [src, out] = argv.filter((a) => !a.startsWith('--'));
const TOL = argv.includes('--tolerance') ? Number(argv[argv.indexOf('--tolerance') + 1]) : 62;
const FEATHER = argv.includes('--feather') ? Number(argv[argv.indexOf('--feather') + 1]) : 1.4;
if (!src || !out) { console.error('usage: cutout-product.mjs <photo> <out.png> [--tolerance N] [--feather N]'); process.exit(2); }

const img = sharp(src);
const { data, info } = await img.clone().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const { width: W, height: H, channels: C } = info;

// Per-row backdrop reference, sampled from whichever side edge is further from ink.
const rowRef = new Array(H);
for (let y = 0; y < H; y++) {
  const l = (y * W + 2) * C;
  const r = (y * W + (W - 3)) * C;
  rowRef[y] = [(data[l] + data[r]) / 2, (data[l + 1] + data[r + 1]) / 2, (data[l + 2] + data[r + 2]) / 2];
}

const isBackdrop = (x, y) => {
  const i = (y * W + x) * C;
  const [rr, rg, rb] = rowRef[y];
  const dr = data[i] - rr, dg = data[i + 1] - rg, db = data[i + 2] - rb;
  return Math.sqrt(dr * dr + dg * dg + db * db) <= TOL;
};

// Flood fill inward from every border pixel.
const bg = new Uint8Array(W * H);
const stack = [];
for (let x = 0; x < W; x++) { stack.push(x, 0, x, H - 1); }
for (let y = 0; y < H; y++) { stack.push(0, y, W - 1, y); }
while (stack.length) {
  const y = stack.pop(), x = stack.pop();
  if (x < 0 || y < 0 || x >= W || y >= H) continue;
  const k = y * W + x;
  if (bg[k]) continue;
  if (!isBackdrop(x, y)) continue;
  bg[k] = 1;
  stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
}

// Alpha = 0 on backdrop, 255 on subject; blurred slightly to feather the matte
// so the composite does not show a hard aliased rim against a new background.
const alpha = Buffer.alloc(W * H);
for (let k = 0; k < W * H; k++) alpha[k] = bg[k] ? 0 : 255;
const feathered = await sharp(alpha, { raw: { width: W, height: H, channels: 1 } })
  .blur(FEATHER).raw().toBuffer();

const rgba = Buffer.alloc(W * H * 4);
for (let k = 0; k < W * H; k++) {
  const s = k * C;
  rgba[k * 4] = data[s]; rgba[k * 4 + 1] = data[s + 1]; rgba[k * 4 + 2] = data[s + 2];
  rgba[k * 4 + 3] = feathered[k];
}

// Trim fully-transparent margins so the caller can lay the subject out by its own box.
const trimmed = await sharp(rgba, { raw: { width: W, height: H, channels: 4 } })
  .png().toBuffer();
const final = await sharp(trimmed).trim({ threshold: 1 }).toBuffer();
writeFileSync(out, final);

const m = await sharp(final).metadata();
const kept = alpha.reduce((n, v) => n + (v ? 1 : 0), 0);
console.log(`${out}  ${m.width}×${m.height}  subject ${(100 * kept / (W * H)).toFixed(1)}% of source`);
