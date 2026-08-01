#!/usr/bin/env node
/**
 * Key a flat backdrop out of a product photo and emit a transparent PNG.
 *
 *   node scripts/cutout-product.mjs <photo> <out.png> [--tolerance 0.030] [--feather 1.2]
 *
 * Why this exists: gemini-3-pro-image composes and lights at a professional
 * standard but cannot preserve label text — asked three ways, including a prompt
 * that only requested a backdrop swap, it re-lettered every bottle ("235ml",
 * "255ml", "6 fl oz" against a real 8 fl oz / 236ml) and rendered the ORGANIC
 * COCONUT OIL seal as gibberish. It redraws the product rather than moving it.
 * So the real pixels have to survive into the composite, and that means keying.
 *
 * ── The metric ──────────────────────────────────────────────────────────────
 * The obvious key — RGB distance from the backdrop colour — does not work on
 * these frames. Measured on the Coconut Breeze hero, against a mint backdrop:
 *
 *     backdrop  15   ·   jar body  54   ·   jar lid  65   ·   bottle  80-102
 *
 * The warm jar sits close enough to the mint that no threshold separates them
 * without eating the jars or keeping backdrop.
 *
 * Chromaticity separates them cleanly, because the difference is hue, not
 * brightness: the backdrop is green-dominant and every product surface is
 * neutral-to-warm. Normalising each pixel by r+g+b and measuring distance there:
 *
 *     backdrop 0.005  ·  shadowed backdrop 0.005  ·  black cap 0.054
 *     bottle 0.061    ·  jar body 0.071
 *
 * An order of magnitude of margin, and it is luminance-invariant, so the shadow
 * under a jar keys as backdrop instead of tearing a notch out of the matte.
 *
 * A global test is enough — no flood fill. The worry was the green coconut-palm
 * artwork on the labels getting punched out, but measured it is nowhere near:
 * a leaf sits at 0.196 because it is far more saturated than the pale mint
 * backdrop. Every enclosed green survives on its own merits.
 *
 * One guard: near-black pixels are always subject. Chromaticity is unstable when
 * r+g+b is tiny, and the caps are the darkest thing in frame.
 */

import { writeFileSync } from 'node:fs';
import sharp from 'sharp';

const argv = process.argv.slice(2);
const [src, out] = argv.filter((a) => !a.startsWith('--'));
const TOL = argv.includes('--tolerance') ? Number(argv[argv.indexOf('--tolerance') + 1]) : 0.038;
const FEATHER = argv.includes('--feather') ? Number(argv[argv.indexOf('--feather') + 1]) : 1.2;
// r+g+b below this is always subject. Set high on purpose: the backdrop never
// falls below ~531 even in the darkest corner of the vignette, while the caps and
// label bands are near-black. At 70 the guard only protected true black, so the
// dark-grey transition pixels around every band got their (very noisy) chromaticity
// computed, landed inside the tolerance by chance, and tore ragged holes through
// the black bands and jar lids.
const DARK = 300;
if (!src || !out) { console.error('usage: cutout-product.mjs <photo> <out.png> [--tolerance N] [--feather N]'); process.exit(2); }

const { data, info } = await sharp(src).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const { width: W, height: H } = info;

const chroma = (i) => {
  const r = data[i], g = data[i + 1], b = data[i + 2];
  const s = r + g + b;
  return s < DARK ? null : [r / s, g / s, b / s];
};

// Per-row backdrop reference, averaged from both side edges. These frames
// vignette — the Coconut Breeze corners run RGB(154,203,174) to (182,219,186) —
// and a single global reference clips one end of that.
const rowRef = new Array(H);
for (let y = 0; y < H; y++) {
  const a = chroma((y * W + 2) * 3) ?? [1 / 3, 1 / 3, 1 / 3];
  const b = chroma((y * W + (W - 3)) * 3) ?? [1 / 3, 1 / 3, 1 / 3];
  rowRef[y] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

const isBackdrop = (x, y) => {
  const c = chroma((y * W + x) * 3);
  if (!c) return false;                    // near-black is always subject
  const r = rowRef[y];
  return Math.hypot(c[0] - r[0], c[1] - r[1], c[2] - r[2]) <= TOL;
};

const hard = Buffer.alloc(W * H);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) hard[y * W + x] = isBackdrop(x, y) ? 0 : 255;
}

// Drop small disconnected blobs. Even a backdrop asked to be perfectly flat comes
// back with faint gradient banding where a shadow would have been, and those
// survive the key as free-floating smudges under the product — which look worse
// than the shadow would have. The subject is a few large components; anything
// under MIN_FRACTION of the largest is not part of it.
const MIN_FRACTION = 0.18;
const label = new Int32Array(W * H).fill(-1);
const sizes = [];
const queue = new Int32Array(W * H);
for (let start = 0; start < W * H; start++) {
  if (!hard[start] || label[start] !== -1) continue;
  const id = sizes.length;
  let head = 0, tail = 0, n = 0;
  queue[tail++] = start; label[start] = id;
  while (head < tail) {
    const k = queue[head++]; n++;
    const x = k % W, y = (k / W) | 0;
    if (x > 0 && hard[k - 1] && label[k - 1] === -1) { label[k - 1] = id; queue[tail++] = k - 1; }
    if (x < W - 1 && hard[k + 1] && label[k + 1] === -1) { label[k + 1] = id; queue[tail++] = k + 1; }
    if (y > 0 && hard[k - W] && label[k - W] === -1) { label[k - W] = id; queue[tail++] = k - W; }
    if (y < H - 1 && hard[k + W] && label[k + W] === -1) { label[k + W] = id; queue[tail++] = k + W; }
  }
  sizes.push(n);
}
const biggest = Math.max(...sizes, 1);
let dropped = 0;
for (let k = 0; k < W * H; k++) {
  if (hard[k] && sizes[label[k]] < biggest * MIN_FRACTION) { hard[k] = 0; dropped++; }
}
if (dropped) console.log(`  dropped ${sizes.filter((s) => s < biggest * MIN_FRACTION).length} stray blob(s), ${dropped} px`);

// Feather the matte so the composite has no hard aliased rim on a new background.
//
// toColourspace('b-w') is load-bearing: sharp promotes a 1-channel raw buffer to
// 3 channels on the way out, so without it the matte comes back at 3×W×H and
// every alpha[k] read is misaligned by a factor of three. That silently produced
// a garbage matte and a nonsense bounding box before the length assertion below
// caught it.
const alpha = await sharp(hard, { raw: { width: W, height: H, channels: 1 } })
  .blur(FEATHER).toColourspace('b-w').raw().toBuffer();
if (alpha.length !== W * H) throw new Error(`matte came back ${alpha.length}, expected ${W * H}`);

// Despill. A keyed subject carries backdrop colour bounced onto its edges and
// into contact shadows; dropped straight onto sand it reads as a green halo.
// Standard fix: wherever green leads both other channels, pull it back to their
// max. Applied only where the subject is white-ish or neutral (r and b within a
// short distance of each other), so the deliberately green coconut-palm artwork
// on the labels is left alone.
const rgba = Buffer.alloc(W * H * 4);
for (let k = 0; k < W * H; k++) {
  const s = k * 3;
  let r = data[s], g = data[s + 1], b = data[s + 2];
  const neutral = Math.abs(r - b) < 46;
  if (neutral && g > r && g > b) g = Math.max(r, b);
  rgba[k * 4] = r; rgba[k * 4 + 1] = g; rgba[k * 4 + 2] = b;
  rgba[k * 4 + 3] = alpha[k];
}

// Trim on our own alpha. sharp.trim() keys off the top-left pixel colour, which
// on a transparent PNG is not the same question and crops the wrong box.
let minX = W, minY = H, maxX = -1, maxY = -1;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (alpha[y * W + x] > 8) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
}
if (maxX < 0) throw new Error('the key removed everything — tolerance is too high for this photo');

const png = await sharp(rgba, { raw: { width: W, height: H, channels: 4 } })
  .extract({ left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 })
  .png({ compressionLevel: 9 }).toBuffer();
writeFileSync(out, png);

let kept = 0; for (let k = 0; k < W * H; k++) if (alpha[k] > 8) kept++;
console.log(`${out}  ${maxX - minX + 1}×${maxY - minY + 1}  subject ${(100 * kept / (W * H)).toFixed(1)}% of source  (box x${minX}..${maxX} y${minY}..${maxY})`);
