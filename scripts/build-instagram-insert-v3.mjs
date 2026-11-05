#!/usr/bin/env node
// Packing insert v3, the direction Sean chose: two-sided GotPrint 3" x 5" vertical
// postcard ("Full Color Both Sides").
//   FRONT  a 3x3 Instagram-style grid of our real organic posts under a profile header.
//   BACK   handwritten thank-you, the THANKS DM offer, the QR, and the tag line.
//
//   node scripts/build-instagram-insert-v3.mjs
//
// Same print spec and checks as v2 (rendering and verification are imported from
// scripts/build-instagram-insert-v2.mjs): 3.1 x 5.1 in, 0.15 in safe margin, one
// DeviceCMYK image per side at 350 ppi, K-only black, no fonts; safe-area and overlap
// check on every [data-safe] block; the back's QR decoded from its final CMYK PDF at
// 350 dpi must equal the exact URL. Grid tiles and their provenance live in
// assets/print/instagram-insert/v3/front-sources/ (sources.json).
//
// Outputs (assets/print/instagram-insert/v3/):
//   rsc-instagram-insert-v3-3x5-FRONT-gotprint.pdf, rsc-instagram-insert-v3-3x5-BACK-gotprint.pdf
//   preview-front.png, preview-back.png, preview-front-back.png
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import sharp from 'sharp';
import { checkSeoCopyFields } from '../lib/seo-copy-health-gate.js';
import { isDirectRun } from '../lib/is-direct-run.js';
import { page, qrSvg, renderSide, PAD, C } from './build-instagram-insert-v2.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const V3 = join(ROOT, 'assets', 'print', 'instagram-insert', 'v3');
const SRC = join(V3, 'front-sources');
const TILE_IN = (2.7 - 2 * 0.025) / 3; // grid spans the safe width, 0.025 in gutters
const PRINT_DPI = 350;

export const COPY = Object.freeze({
  front: {
    name: 'Real Skin Care',
    bio: 'Coconut oil body care, deodorant & toothpaste',
    follow: 'Follow',
    turn: 'Turn over for a thank-you from us',
  },
  back: {
    eyebrow: 'From our family to yours',
    thanks: 'Thank you!',
    offerLead: 'Follow us and DM us',
    keyword: 'THANKS',
    offerBody: 'for $10 off your next order of $55 or more, plus free shipping.',
    scan: 'Scan to follow',
    tag: 'Tag us. We love seeing it.',
    fine: 'One code per customer, sent to you by DM. Free shipping on US orders.',
  },
});

export function gateCopy() {
  const fields = {};
  for (const [side, obj] of Object.entries(COPY)) for (const [k, v] of Object.entries(obj)) fields[`${side}.${k}`] = v;
  const dashes = Object.entries(fields).filter(([, s]) => /[–—]/.test(s));
  if (dashes.length) throw new Error(`en/em dash in copy: ${dashes.map(([k]) => k).join(', ')}`);
  if (Object.values(fields).some((s) => /antiperspirant|whiten/i.test(s))) throw new Error('banned term in copy');
  const b = COPY.back;
  const offer = `${b.offerLead} ${b.keyword} ${b.offerBody} ${b.fine}`;
  for (const must of ['THANKS', '$10 off', '$55', 'free shipping', 'DM']) {
    if (!offer.includes(must)) throw new Error(`offer copy lost "${must}"`);
  }
  const res = checkSeoCopyFields(fields);
  if (!res.ok) throw new Error(`health gate blocked: ${res.blocking.map((x) => `${x.field}: "${x.match}"`).join('; ')}`);
  return { ...res, count: Object.keys(fields).length };
}

const dataUri = (path) => `data:${path.endsWith('.png') ? 'image/png' : 'image/jpeg'};base64,${readFileSync(path).toString('base64')}`;

async function checkTileResolution(tiles) {
  const need = Math.ceil(TILE_IN * PRINT_DPI);
  const out = [];
  for (const t of tiles) {
    const m = await sharp(join(SRC, t.file)).metadata();
    const side = Math.min(m.width, m.height);
    if (side < need) throw new Error(`${t.file}: ${side} px square crop is below ${need} px needed for ${TILE_IN.toFixed(3)} in at ${PRINT_DPI} dpi`);
    out.push(`${t.file} ${m.width}x${m.height} -> ${Math.round(side / TILE_IN)} dpi`);
  }
  return out;
}

function htmlFront(tiles) {
  const t = COPY.front;
  const grid = tiles.map((x) => `<div class="tile" style="background-image:url(${dataUri(join(SRC, x.file))});background-position:50% ${x.focusY * 100}%"></div>`).join('');
  const gridIcon = '<svg viewBox="0 0 24 24" width="0.13in" height="0.13in"><g fill="none" stroke="#000" stroke-width="2"><rect x="3" y="3" width="18" height="18"/><path d="M9 3v18M15 3v18M3 9h18M3 15h18"/></g></svg>';
  const css = `
body { background: ${C.sand}; }
.head { left: ${PAD}in; right: ${PAD}in; top: ${PAD + 0.1}in; display: flex; align-items: center; gap: 0.14in; }
.avatar { width: 0.66in; height: 0.66in; border-radius: 50%; flex: none; background-size: cover; background-position: center;
  box-shadow: 0 0 0 0.025in ${C.white}, 0 0 0 0.045in ${C.green}; }
.who { flex: 1; min-width: 0; }
.handle { font-family: 'Outfit'; font-weight: 600; font-size: 11.5pt; line-height: 1.1; }
.name { font-family: 'Outfit'; font-weight: 600; font-size: 8pt; margin-top: 0.03in; }
.bio { font-size: 8pt; line-height: 1.25; margin-top: 0.01in; }
.follow { left: ${PAD}in; right: ${PAD}in; top: 1.13in; height: 0.25in; background: ${C.black}; color: ${C.white}; border-radius: 0.05in;
  display: flex; align-items: center; justify-content: center; font-family: 'Outfit'; font-weight: 600; font-size: 8.5pt; }
.tabs { left: ${PAD}in; right: ${PAD}in; top: 1.45in; height: 0.2in; display: flex; justify-content: center; align-items: center;
  border-top: 0.01in solid rgba(0,0,0,0.18); }
.tabs span { border-top: 0.015in solid #000; margin-top: -0.012in; padding: 0.04in 0.25in 0; display: flex; }
.grid { left: ${PAD}in; top: 1.7in; width: 2.7in; display: grid; grid-template-columns: repeat(3, ${TILE_IN}in); gap: 0.025in; }
.tile { width: ${TILE_IN}in; height: ${TILE_IN}in; background-size: cover; background-color: #ccc; }
.turn { left: ${PAD}in; right: ${PAD}in; bottom: ${PAD + 0.07}in; text-align: center; font-family: 'Outfit'; font-weight: 600; font-size: 9pt; }
`;
  const body = `
<div class="abs head" data-safe><div class="avatar" style="background-image:url(${dataUri(join(SRC, 'profile.jpg'))})"></div>
  <div class="who"><div class="handle">realskincare_com</div><div class="name">${t.name}</div><div class="bio">${t.bio}</div></div></div>
<div class="abs follow" data-safe>${t.follow}</div>
<div class="abs tabs" data-safe><span>${gridIcon}</span></div>
<div class="abs grid" data-safe>${grid}</div>
<div class="abs turn" data-safe>${t.turn} &rarr;</div>`;
  return page(body, css);
}

async function htmlBack() {
  const t = COPY.back;
  const css = `
body { background: ${C.sand}; }
.top { left: ${PAD}in; right: ${PAD}in; top: ${PAD + 0.03}in; text-align: center; }
.top .thanks { font-family: 'Caveat'; font-weight: 700; font-size: 38pt; line-height: 0.95; margin-top: 0.02in; }
.offer { left: ${PAD}in; right: ${PAD}in; top: 1.02in; height: 1.62in; background: ${C.green}; border-radius: 0.14in;
  display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 0 0.16in; }
.offer .lead { font-family: 'Outfit'; font-weight: 600; font-size: 12pt; }
.offer .kw { font-family: 'Outfit'; font-weight: 600; font-size: 30pt; letter-spacing: 0.08em; line-height: 1; margin-top: 0.05in;
  background: ${C.black}; color: ${C.sand}; padding: 0.06in 0.16in 0.05in 0.2in; border-radius: 0.07in; }
.offer .body { font-family: 'Outfit'; font-weight: 600; font-size: 10pt; line-height: 1.22; margin-top: 0.09in; }
.row { left: ${PAD}in; right: ${PAD}in; top: 2.86in; display: flex; align-items: center; gap: 0.13in; }
.row .qr { width: 1.42in; height: 1.42in; }
.row .txt { flex: 1; }
.row .scan { font-family: 'Outfit'; font-weight: 600; font-size: 8pt; letter-spacing: 0.1em; text-transform: uppercase; }
.row .handle { font-size: 9.5pt; margin-top: 0.02in; }
.row .tag { font-size: 9pt; line-height: 1.25; margin-top: 0.08in; }
.fine { left: ${PAD}in; right: ${PAD}in; bottom: ${PAD + 0.06}in; text-align: center; font-size: 7.5pt; line-height: 1.3; color: #222; }
`;
  const body = `
<div class="abs top" data-safe><div class="eyebrow">${t.eyebrow}</div><div class="thanks">${t.thanks}</div></div>
<div class="abs offer" data-safe><div class="lead">${t.offerLead}</div><div class="kw">${t.keyword}</div><div class="body">${t.offerBody.replace(' of $55', '<br>of $55')}</div></div>
<div class="abs row" data-safe><div class="qr">${await qrSvg()}</div>
  <div class="txt"><div class="scan">${t.scan}</div><div class="handle">@realskincare_com</div><div class="tag">${t.tag}</div></div></div>
<div class="abs fine" data-safe>${t.fine.replace(' Free shipping', '<br>Free shipping')}</div>`;
  return page(body, css);
}

async function main() {
  const gate = gateCopy();
  const { tiles } = JSON.parse(readFileSync(join(SRC, 'sources.json'), 'utf8'));
  if (tiles.length !== 9) throw new Error(`need 9 tiles, have ${tiles.length}`);
  const res = await checkTileResolution(tiles);
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--font-render-hinting=none'] });
  try {
    const f = await renderSide(browser, htmlFront(tiles), { pdfPath: join(V3, 'rsc-instagram-insert-v3-3x5-FRONT-gotprint.pdf'), pngPath: join(V3, 'preview-front.png'), expectQr: false });
    const b = await renderSide(browser, await htmlBack(), { pdfPath: join(V3, 'rsc-instagram-insert-v3-3x5-BACK-gotprint.pdf'), pngPath: join(V3, 'preview-back.png'), expectQr: true });
    console.log(`FRONT ${f.pdf}  ${f.image}`);
    console.log(`BACK  ${b.pdf}  ${b.image}  QR ok: ${b.decoded}`);
  } finally {
    await browser.close();
  }
  const fp = join(V3, 'preview-front.png');
  const bp = join(V3, 'preview-back.png');
  const m = await sharp(fp).metadata();
  await sharp({ create: { width: m.width * 2 + 60, height: m.height, channels: 3, background: '#FFFFFF' } })
    .composite([{ input: fp, left: 0, top: 0 }, { input: bp, left: m.width + 60, top: 0 }]).png().toFile(join(V3, 'preview-front-back.png'));
  console.log(`side by side ${join(V3, 'preview-front-back.png')}`);
  console.log(`Tiles (square crop at ${TILE_IN.toFixed(3)} in):\n  ${res.join('\n  ')}`);
  console.log(`Gate ok: ${gate.ok} · ${gate.count} strings · blocking ${gate.blocking.length} · advisory ${gate.advisory.length}`);
}

if (isDirectRun(import.meta.url)) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
