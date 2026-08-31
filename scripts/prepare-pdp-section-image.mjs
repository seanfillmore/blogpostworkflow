#!/usr/bin/env node
/**
 * Fit a square product shot into a landscape PDP `image-with-text` slot by
 * EXTENDING its background, never by cropping into the product.
 *
 *   node scripts/prepare-pdp-section-image.mjs <in.jpg> <out.webp> [--width 1920] [--height 1160]
 *
 * ── Why extend rather than crop ────────────────────────────────────────────
 * The free-from / founder blocks on the landing-page templates are
 * `image-with-text` at `image_ratio: adapt`, so the section's height is the
 * IMAGE's own aspect ratio. A 1:1 shot in a `full_width` half-column is ~50vw
 * tall — roughly 720px against ~450px of text on a 1440 viewport — which leaves
 * the band far taller than the copy beside it and out of step with
 * `founder-landscape.webp` (1920x1160, 1.655:1) directly below.
 *
 * Cover-cropping a square to 1.655:1 slices the top and bottom off the product.
 * On a packshot that is the whole subject, so the ground is widened instead.
 *
 * ── Why the extension is seamless ──────────────────────────────────────────
 * A studio ground is not flat — the bar soap source runs (246,235,219) at the
 * top-left to (232,216,193) at the bottom-right. Two approaches were measured:
 *
 *   - Fitting a PLANE to the border band and rendering it across the wider
 *     canvas left visible banding at the paste edges and blotchy corners: the
 *     vignette is curved, and a plane over/under-shoots it.
 *   - Anchoring to the source's OWN edge column and continuing it outward along
 *     the measured horizontal gradient is exact at the boundary by
 *     construction — at distance 0 the pad IS the source pixel. Measured seam
 *     step on the bar soap image: 0.31 / 0.36 levels out of 255, under JPEG
 *     noise.
 *
 * The second is what this does. The edge column is smoothed vertically first,
 * or JPEG noise in that one column streaks horizontally across the whole pad as
 * a visible line.
 *
 * ── Preconditions, checked rather than assumed ─────────────────────────────
 * The product must clear the left and right edges, and the top and bottom
 * border bands must be pure background — that is what the gradient is measured
 * from. A shot whose subject touches an edge would replicate part of the
 * subject outward; `--check` reports the measured seam step so a bad input is
 * visible rather than silent.
 */
import sharp from 'sharp';
import { existsSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : Number(args[i + 1]);
};
const [SRC, OUT] = args.filter((a) => !a.startsWith('--') && !/^\d+$/.test(a));
const OUT_W = flag('width', 1920);
const OUT_H = flag('height', 1160);

if (!SRC || !OUT) {
  console.error('usage: prepare-pdp-section-image.mjs <in> <out> [--width N] [--height N]');
  process.exit(2);
}
if (!existsSync(SRC)) { console.error(`no such file: ${SRC}`); process.exit(1); }
if (OUT_W <= OUT_H) { console.error('output must be landscape — this widens, it does not letterbox'); process.exit(2); }

// The square is scaled to the full canvas height and centred; the pads are what
// this script synthesises.
const S = OUT_H;
const offX = Math.round((OUT_W - S) / 2);

const meta = await sharp(SRC).metadata();
if (meta.width !== meta.height) {
  console.warn(`note: source is ${meta.width}x${meta.height}, not square — it will be scaled to ${S}x${S}`);
}

const sq = await sharp(SRC).resize(S, S, { fit: 'fill' }).removeAlpha().raw().toBuffer();
const at = (x, y, ch) => sq[(y * S + x) * 3 + ch];

// Vertically smoothed edge columns.
const SMOOTH = 24;
const edgeColumn = (col) => {
  const out = new Float64Array(S * 3);
  for (let y = 0; y < S; y++) {
    for (let ch = 0; ch < 3; ch++) {
      let sum = 0, n = 0;
      for (let k = -SMOOTH; k <= SMOOTH; k++) {
        const yy = y + k;
        if (yy < 0 || yy >= S) continue;
        sum += at(col, yy, ch); n++;
      }
      out[y * 3 + ch] = sum / n;
    }
  }
  return out;
};
const edgeL = edgeColumn(0);
const edgeR = edgeColumn(S - 1);

// Horizontal gradient of the ground, measured on the top and bottom bands,
// which clear the subject on a centred packshot.
const BAND = 70;
const slope = [0, 0, 0];
for (let ch = 0; ch < 3; ch++) {
  let n = 0, sx = 0, sv = 0, sxx = 0, sxv = 0;
  for (const [y0, y1] of [[0, BAND], [S - BAND, S]]) {
    for (let y = y0; y < y1; y += 2) {
      for (let x = 0; x < S; x += 2) {
        const v = at(x, y, ch);
        n++; sx += x; sv += v; sxx += x * x; sxv += x * v;
      }
    }
  }
  slope[ch] = (n * sxv - sx * sv) / (n * sxx - sx * sx);
}
console.log(`ground gradient per px (R,G,B): ${slope.map((v) => v.toFixed(5)).join(', ')}`);

const canvas = Buffer.alloc(OUT_W * OUT_H * 3);
for (let y = 0; y < OUT_H; y++) {
  for (let x = 0; x < OUT_W; x++) {
    const i = (y * OUT_W + x) * 3;
    if (x >= offX && x < offX + S) {
      const sx = x - offX;
      for (let ch = 0; ch < 3; ch++) canvas[i + ch] = at(sx, y, ch);
    } else {
      const left = x < offX;
      const d = left ? x - offX : x - (offX + S - 1);   // signed distance past the edge
      const e = left ? edgeL : edgeR;
      for (let ch = 0; ch < 3; ch++) {
        canvas[i + ch] = Math.max(0, Math.min(255, Math.round(e[y * 3 + ch] + slope[ch] * d)));
      }
    }
  }
}

const pipeline = sharp(canvas, { raw: { width: OUT_W, height: OUT_H, channels: 3 } });
await (OUT.endsWith('.webp')
  ? pipeline.webp({ quality: 88 })
  : pipeline.jpeg({ quality: 92, chromaSubsampling: '4:4:4' })).toFile(OUT);

// Report the seam rather than promising it: a source whose subject touches an
// edge shows up here as a step of several levels.
const { data } = await sharp(OUT).raw().toBuffer({ resolveWithObject: true });
const seamStep = (bx) => {
  let s = 0;
  for (let y = 0; y < OUT_H; y++) {
    for (let ch = 0; ch < 3; ch++) {
      s += Math.abs(data[(y * OUT_W + bx) * 3 + ch] - data[(y * OUT_W + bx - 1) * 3 + ch]);
    }
  }
  return s / (OUT_H * 3);
};
const l = seamStep(offX), r = seamStep(offX + S);
console.log(`seam step: left ${l.toFixed(2)}, right ${r.toFixed(2)} levels (under ~1 is invisible)`);
if (l > 2 || r > 2) console.warn('⚠ visible seam — does the subject clear the left/right edges of the source?');
console.log(`wrote ${OUT} ${OUT_W}x${OUT_H}`);
