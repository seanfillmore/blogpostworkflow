#!/usr/bin/env node
/**
 * Cut one product out of a white-backdrop PDP photograph.
 *
 *   node scripts/cut-component.mjs <photo> <out.png> --seed X,Y [--fuzz 3] [--measure]
 *   node scripts/cut-component.mjs <photo> <out.png> --seed X,Y --band Y0,Y1 [--fuzz 3]
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * The eight cutouts in data/brand/cutouts were produced by hand with ImageMagick
 * and needed THREE rebuilds (6fbe0c0 → 96b9185 → 6d48994). Every rebuild was one
 * of the same three mistakes, and none of them is a judgement call — each is a
 * measurement somebody estimated instead of taking:
 *
 *   1. Bounds read off a "clean band" that turned out to contain the MADE IN THE
 *      USA badge, a staged cap, or a cream swoosh. Confident, and wrong.
 *   2. The crop taken to the content box, which keeps the mirror reflection every
 *      one of these photos carries. Composited onto a coloured frame it reads as
 *      a grey smudge.
 *   3. The crop taken just below the base, which drags in the contact shadow and
 *      renders as a flat grey band — the bottle looks sliced off square.
 *
 * So this script measures rather than estimates, and refuses to guess the one
 * thing it cannot know.
 *
 * ── The backdrop key ────────────────────────────────────────────────────────
 * These are white-backdrop shots, which rules out the chromaticity key in
 * cutout-product.mjs: that script separates a warm product from a MINT backdrop
 * by hue, and a white bottle on white has no hue difference to separate. Here a
 * flood fill from the four corners is the right tool — it is topological, so a
 * white bottle body survives on the grounds that it is not reachable from a
 * corner, however close its colour sits to the backdrop.
 *
 * Fuzz is a real dial and the products disagree about it: 5% suits most, but
 * anything white-on-white (the toothpaste, the Coconut Breeze lotion, the
 * foaming hand soap) has its own body eaten at 5% and needs 2-3%.
 *
 * ── The contact line, found rather than guessed ─────────────────────────────
 * Scanning row widths downward from the base, the silhouette narrows to a
 * minimum where the product meets its own reflection, then widens again into the
 * mirror image. That waist IS the contact line. Cutting there keeps the base's
 * real curve; a row below it starts the reflection. This script finds the waist
 * by scanning and prints where it found it, so the number is checkable.
 *
 * ── What it will not do ─────────────────────────────────────────────────────
 * A swoosh of product passes BEHIND the bottle in most of these shots and is
 * therefore one connected component with it — no key separates them, and the fix
 * is to crop past it horizontally. Which rows hold only the product is the one
 * genuinely visual judgement here, so the script does not invent it: run
 * --measure, read the row spans, and pass the product-only rows as --band. Left
 * and right bounds are then measured from those rows, never estimated.
 */

import { writeFileSync } from 'node:fs';
import sharp from 'sharp';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
/** Flags that take a value, so their value is never mistaken for a positional. */
const VALUED = new Set(['--seed', '--band', '--fuzz', '--feather', '--x', '--top', '--taper', '--bottom']);
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) { if (VALUED.has(argv[i])) i++; continue; }
  positional.push(argv[i]);
}
const [src, out] = positional;

const MEASURE = argv.includes('--measure');
const FUZZ = Number(flag('fuzz', 3)) / 100 * 255;   // per-channel tolerance, as a % of full scale
const FEATHER = Number(flag('feather', 1.0));
const seedArg = flag('seed');
const bandArg = flag('band');

if (!src || (!MEASURE && !out)) {
  console.error('usage: cut-component.mjs <photo> <out.png> --seed X,Y [--band Y0,Y1] [--fuzz 3] [--measure]');
  process.exit(2);
}
if (!seedArg) { console.error('--seed X,Y is required: a pixel that is unambiguously ON the product'); process.exit(2); }
const [seedX, seedY] = seedArg.split(',').map(Number);

const { data, info } = await sharp(src).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const { width: W, height: H } = info;

// ── 1. Flood fill the backdrop from all four corners ────────────────────────
// Topological, not colorimetric: a white product body is kept because no path of
// similar pixels reaches it from a corner. Comparison is against each corner's
// own colour, because these frames vignette slightly.
const bg = new Uint8Array(W * H);
const stack = [];
const corners = [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1]];
for (const [cx, cy] of corners) {
  const k = cy * W + cx;
  if (bg[k]) continue;
  const ref = [data[k * 3], data[k * 3 + 1], data[k * 3 + 2]];
  bg[k] = 1; stack.push(k);
  while (stack.length) {
    const p = stack.pop();
    const x = p % W, y = (p / W) | 0;
    for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const q = ny * W + nx;
      if (bg[q]) continue;
      const s = q * 3;
      if (Math.abs(data[s] - ref[0]) <= FUZZ && Math.abs(data[s + 1] - ref[1]) <= FUZZ && Math.abs(data[s + 2] - ref[2]) <= FUZZ) {
        bg[q] = 1; stack.push(q);
      }
    }
  }
}

// ── 2. Keep only the component the seed sits in ─────────────────────────────
// Drops the MADE IN THE USA badge, staged spare caps, and the loose extra units
// staged behind the hero — all of which are separate components and all of which
// have corrupted a bounding box before.
const subject = new Uint8Array(W * H);
{
  const seedK = seedY * W + seedX;
  if (bg[seedK]) throw new Error(`the seed pixel (${seedX},${seedY}) keyed as backdrop — it is not on the product, or --fuzz is too high`);
  const q = [seedK]; subject[seedK] = 1;
  while (q.length) {
    const p = q.pop();
    const x = p % W, y = (p / W) | 0;
    for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const r = ny * W + nx;
      if (!bg[r] && !subject[r]) { subject[r] = 1; q.push(r); }
    }
  }
}

// ── 2b. Taper: the crop is a rectangle, the product is not ─────────────────
// A jar's lid is inset from its body, and a pump is far narrower than the bottle
// under it. Crop x to the widest part and the corners above it are left holding
// whatever the photo staged back there — on the Coconut Breeze cream, the swoosh
// fills the notch beside the lid and renders as a tan wedge in the top corner.
//
// No key removes it: the swoosh passes BEHIND the jar, so it is the same
// connected component, and it is pale enough that no colour threshold separates
// it from a white jar without eating the jar. The shape is the only thing that
// distinguishes them, so the shape is what is stated here. Measure LEFT/RIGHT off
// the lid (a dark band is unambiguous) and Y off the row where the body flares.
const taperArg = flag('taper');
if (taperArg) {
  const [tY, tL, tR] = taperArg.split(',').map(Number);
  for (let y = 0; y < tY; y++) {
    for (let x = 0; x < W; x++) if (x < tL || x > tR) subject[y * W + x] = 0;
  }
}

/** The contiguous run of subject pixels on row y that contains column x. */
const spanAt = (y, x) => {
  if (!subject[y * W + x]) return null;
  let a = x, b = x;
  while (a > 0 && subject[y * W + a - 1]) a--;
  while (b < W - 1 && subject[y * W + b + 1]) b++;
  return [a, b];
};

/** Full extent of the subject on row y, ignoring gaps. */
const rowExtent = (y) => {
  let a = -1, b = -1;
  for (let x = 0; x < W; x++) if (subject[y * W + x]) { if (a < 0) a = x; b = x; }
  return a < 0 ? null : [a, b];
};

let top = 0; while (top < H && !rowExtent(top)) top++;
let bottom = H - 1; while (bottom > 0 && !rowExtent(bottom)) bottom--;

if (MEASURE) {
  console.log(`${src}  ${W}x${H}  fuzz ${(FUZZ / 255 * 100).toFixed(1)}%`);
  console.log(`seed (${seedX},${seedY})  subject rows ${top}..${bottom}\n`);
  console.log('   row | span containing seed column |  width | full row extent      | width');
  console.log('  -----+-----------------------------+--------+----------------------+------');
  const step = Math.max(1, Math.round((bottom - top) / 60));
  for (let y = top; y <= bottom; y += step) {
    const s = spanAt(y, seedX), e = rowExtent(y);
    const sTxt = s ? `${String(s[0]).padStart(5)}..${String(s[1]).padStart(5)}` : '        —    ';
    const sW = s ? String(s[1] - s[0] + 1).padStart(6) : '     —';
    const eTxt = e ? `${String(e[0]).padStart(5)}..${String(e[1]).padStart(5)}` : '        —    ';
    const eW = e ? String(e[1] - e[0] + 1).padStart(5) : '    —';
    console.log(`  ${String(y).padStart(5)} | ${sTxt}              | ${sW} | ${eTxt}        | ${eW}`);
  }
  console.log('\nRead the product-only rows off this table and pass them as --band Y0,Y1.');
  console.log('A row whose full extent is much wider than the seed span has something else on it');
  console.log('(a swoosh, a badge, a staged second unit) and is NOT a product-only row.');
  process.exit(0);
}

// ── 3. Left/right, measured from rows proven to hold only the product ───────
// On most of these photos a --band of product-only rows exists and measuring is
// strictly better than estimating. On some it does not: the body cream's swoosh
// wraps the jar at EVERY height, so no row holds only the jar and there is
// nothing to measure. That is the case --x exists for, and it is the one input
// here that is a genuine visual judgement.
const xArg = flag('x');
let left, right;
let bandY0, bandY1;
if (xArg) {
  [left, right] = xArg.split(',').map(Number);
  const b = (bandArg || `${seedY},${seedY}`).split(',').map(Number);
  [bandY0, bandY1] = b;
} else {
  if (!bandArg) {
    console.error('--band Y0,Y1 is required (rows that hold ONLY the product), or --x LEFT,RIGHT');
    console.error('when the backdrop art merges with the product at every height. Run --measure first.');
    process.exit(2);
  }
  [bandY0, bandY1] = bandArg.split(',').map(Number);
  left = W; right = -1;
  for (let y = bandY0; y <= bandY1; y++) {
    const s = spanAt(y, seedX);
    if (!s) continue;
    if (s[0] < left) left = s[0];
    if (s[1] > right) right = s[1];
  }
  if (right < 0) throw new Error(`--band ${bandY0},${bandY1} contains no subject pixels in the seed's column`);
}

// ── 4. Top of the product, walking up inside the measured x band ────────────
// Stops at the first row with nothing in the band, so a swoosh crossing ABOVE
// the product's own top is only included where it genuinely overlaps it.
// --top overrides it for the same reason --x does: where the swoosh crosses ABOVE
// the product's own top edge inside the x band, walking up finds the swoosh's top
// rather than the product's.
let prodTop = flag('top') !== null ? Number(flag('top')) : bandY0;
if (flag('top') === null) {
  while (prodTop > 0) {
    let any = false;
    for (let x = left; x <= right && !any; x++) if (subject[(prodTop - 1) * W + x]) any = true;
    if (!any) break;
    prodTop--;
  }
}

// ── 5. The contact line: the waist between product and reflection ───────────
// Scan down from the band, tracking the width of the seed-column span clipped to
// the measured x bounds. The product's base is the widest part down there; the
// waist is the first clear local minimum after it. Below the waist the width
// climbs again as the mirror image opens up.
const widths = [];
for (let y = bandY1; y <= bottom; y++) {
  let n = 0;
  for (let x = left; x <= right; x++) if (subject[y * W + x]) n++;
  widths.push([y, n]);
}
let contact = bottom;
{
  // Smooth first. The pinch is a real feature several rows deep, but the raw
  // silhouette wobbles by a pixel or two along a straight edge, and an unsmoothed
  // scan locks onto that noise instead.
  const SMOOTH = 5;
  const w = widths.map((_, i) => {
    let sum = 0, n = 0;
    for (let k = Math.max(0, i - SMOOTH); k <= Math.min(widths.length - 1, i + SMOOTH); k++) { sum += widths[k][1]; n++; }
    return sum / n;
  });
  const maxW = Math.max(...w);
  const WINDOW = 10;
  // The waist is shallow — on the lotion it is 508px against a 533px base, a 5%
  // pinch. An absolute depth threshold missed it entirely and cut nothing, so the
  // test is shape, not depth: a local minimum that the silhouette then REOPENS
  // past. Reopening is what distinguishes a contact line from the product simply
  // running out at the bottom of the frame.
  let best = -1;
  for (let j = WINDOW; j < w.length - WINDOW; j++) {
    if (w[j] === 0) { best = j; break; }
    let isMin = true;
    for (let k = j - WINDOW; k <= j + WINDOW; k++) if (w[k] < w[j]) { isMin = false; break; }
    if (!isMin) continue;
    const reopens = w.slice(j + 1).some((v) => v >= w[j] + Math.max(2, maxW * 0.01));
    if (reopens) { best = j; break; }
  }
  if (best >= 0) contact = widths[best][0];
}
// --bottom overrides the scan. The waist only exists where the product sits on a
// reflective surface and the mirror image OPENS BACK UP below the contact point.
// The lip balm's reflection instead fades straight out at constant width, so
// there is no waist to find and the scan correctly reports that it found nothing
// rather than inventing one. Read the base off the photo and state it.
if (flag('bottom') !== null) contact = Number(flag('bottom'));

// ── 6. Matte, feather, crop ────────────────────────────────────────────────
const cropW = right - left + 1, cropH = contact - prodTop + 1;
const hard = Buffer.alloc(W * H);
for (let k = 0; k < W * H; k++) hard[k] = subject[k] ? 255 : 0;
const alpha = await sharp(hard, { raw: { width: W, height: H, channels: 1 } })
  .blur(FEATHER).toColourspace('b-w').raw().toBuffer();
if (alpha.length !== W * H) throw new Error(`matte came back ${alpha.length}, expected ${W * H}`);

const rgba = Buffer.alloc(W * H * 4);
for (let k = 0; k < W * H; k++) {
  rgba[k * 4] = data[k * 3]; rgba[k * 4 + 1] = data[k * 3 + 1]; rgba[k * 4 + 2] = data[k * 3 + 2];
  rgba[k * 4 + 3] = alpha[k];
}
const png = await sharp(rgba, { raw: { width: W, height: H, channels: 4 } })
  .extract({ left, top: prodTop, width: cropW, height: cropH })
  .png({ compressionLevel: 9 }).toBuffer();
writeFileSync(out, png);

console.log(`${out}  ${cropW}x${cropH}`);
console.log(`  x ${left}..${right} measured from band ${bandY0}..${bandY1}`);
console.log(`  y ${prodTop}..${contact}   (contact line found at ${contact}; subject ran to ${bottom}, so ${bottom - contact}px of reflection dropped)`);
if (bottom - contact < 5) console.log('  ⚠️  almost nothing was dropped — check this photo really has a reflection, or the waist was missed');
