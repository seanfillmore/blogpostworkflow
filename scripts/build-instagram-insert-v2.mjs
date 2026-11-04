#!/usr/bin/env node
// Packing insert v2: three design directions for the Instagram packing card, each built
// to the same GotPrint 3" x 5" vertical postcard spec as v1 (scripts/build-instagram-insert.mjs):
// 3.1 x 5.1 in with 0.05 in bleed per side, everything critical 0.15 in inside the trim,
// one DeviceCMYK image at 350 ppi per side, black on the K plate only, no fonts.
//
//   node scripts/build-instagram-insert-v2.mjs            # build a, b, c and compare.png
//   node scripts/build-instagram-insert-v2.mjs --only b   # one direction
//
// Directions (outputs under assets/print/instagram-insert/v2/<dir>/):
//   a  "Your feed, previewed": a phone showing our real Instagram grid. The tiles are
//      cached copies of real posts (a/feed/, ids and permalinks in a/feed/feed.json),
//      because Graph API media URLs expire.
//   b  "Product + handwritten note": product cutouts from data/brand/cutouts and a
//      handwritten thank-you in Caveat (OFL, v2/fonts/caveat-latin.woff2).
//   c  "Two-sided": a giftable front and a back carrying the QR. Two print PDFs.
//
// Every copy string goes through the commercial health-claim gate and a dash check
// before anything renders. Each side aborts if a [data-safe] element leaves the safe
// area. Each side carrying a QR is rasterized from its final CMYK PDF at 350 dpi and
// the QR must decode to the exact URL with zbarimg. Needs poppler and zbar.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import puppeteer from 'puppeteer';
import QRCode from 'qrcode';
import sharp from 'sharp';
import { fontFaceCss } from '../lib/brand-fonts.js';
import { checkSeoCopyFields } from '../lib/seo-copy-health-gate.js';
import { isDirectRun } from '../lib/is-direct-run.js';
import { rgbaToCmyk, cmykImagePdf, IG_URL } from './build-instagram-insert.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const V2 = join(ROOT, 'assets', 'print', 'instagram-insert', 'v2');
const CUTOUTS = join(ROOT, 'data', 'brand', 'cutouts');
const LOGOS = join(ROOT, 'data', 'brand', 'logo');

const TRIM_W = 3;
const TRIM_H = 5;
const BLEED = 0.05;
const SAFE = 0.15;
const PAGE_W = TRIM_W + 2 * BLEED;
const PAGE_H = TRIM_H + 2 * BLEED;
const PAD = BLEED + SAFE; // page edge to safe line
const PRINT_DPI = 350;
const PREVIEW_PX = 1200;
const HANDLE = '@realskincare_com';
const C = { black: '#000000', sand: '#EDE5D8', green: '#AEDEAC', white: '#FFFFFF', paper: '#FBF8F2' };

// All visible copy, by direction. The in-phone UI text in A is included too.
export const COPY = Object.freeze({
  a: {
    eyebrow: 'From our family to yours',
    headline: 'Thank you for your order.',
    sub: 'Here is what you will find on our feed.',
    bio1: 'Coconut oil body care, deodorant & toothpaste',
    bio2: 'How-tos, real reviews and creator videos',
    follow: 'Follow',
    scan: 'Scan to follow',
    tag: 'Tag us when your order lands. We love seeing it.',
  },
  b: {
    note1: 'Thank you!',
    note2: 'From our family to yours.',
    lead: 'Come say hi on Instagram',
    scan: 'Scan to follow',
    posts: 'How-tos, real reviews and videos from creators who use our products.',
    tag: 'Tag us. We love seeing it.',
  },
  cFront: {
    eyebrow: 'From our family to yours',
    headline: 'Welcome to the family.',
    sub: 'Thank you for your order.',
    turn: 'Turn over for a hello',
  },
  cBack: {
    headline: 'Let’s stay in touch.',
    lead: 'Follow us on Instagram for:',
    list: ['How-to guides, like switching to aluminum-free deodorant', 'Real reviews from real customers', 'Videos from creators who use our products'],
    scan: 'Scan to follow',
    tag: 'Tag us. We love seeing it.',
  },
});

export function gateAllCopy() {
  const fields = {};
  for (const [dir, obj] of Object.entries(COPY)) {
    for (const [k, v] of Object.entries(obj)) {
      if (Array.isArray(v)) v.forEach((s, i) => { fields[`${dir}.${k}[${i}]`] = s; });
      else fields[`${dir}.${k}`] = v;
    }
  }
  const dashes = Object.entries(fields).filter(([, s]) => /[–—]/.test(s));
  if (dashes.length) throw new Error(`en/em dash in copy: ${dashes.map(([k]) => k).join(', ')}`);
  if (Object.values(fields).some((s) => /antiperspirant|whiten|% off|\$\d|discount|free gift/i.test(s))) {
    throw new Error('copy mentions a banned term (antiperspirant, whitening, or an offer)');
  }
  const res = checkSeoCopyFields(fields);
  if (!res.ok) throw new Error(`health gate blocked: ${res.blocking.map((b) => `${b.field}: "${b.match}"`).join('; ')}`);
  return { ...res, count: Object.keys(fields).length };
}

const uri = (path, mime) => `data:${mime};base64,${readFileSync(path).toString('base64')}`;
const png = (p) => uri(p, 'image/png');
const jpg = (p) => uri(p, 'image/jpeg');
const cutout = (name) => png(join(CUTOUTS, `${name}.png`));

async function qrSvg(light = C.white) {
  return QRCode.toString(IG_URL, { type: 'svg', errorCorrectionLevel: 'M', margin: 4, color: { dark: C.black, light } });
}

function caveatCss() {
  const b64 = readFileSync(join(V2, 'fonts', 'caveat-latin.woff2')).toString('base64');
  return `@font-face{font-family:'Caveat';font-weight:400 700;font-style:normal;font-display:block;src:url(data:font/woff2;base64,${b64}) format('woff2');}`;
}

function page(body, extraCss = '') {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${fontFaceCss()}
${caveatCss()}
@page { size: ${PAGE_W}in ${PAGE_H}in; margin: 0; }
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: ${PAGE_W}in; height: ${PAGE_H}in; }
body { position: relative; overflow: hidden; font-family: 'Cabin', sans-serif; color: ${C.black};
  -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.abs { position: absolute; }
.eyebrow { font-family: 'Outfit'; font-weight: 600; font-size: 7pt; letter-spacing: 0.2em; text-transform: uppercase; }
.qr { background: ${C.white}; flex: none; }
.qr svg { width: 100%; height: 100%; display: block; shape-rendering: crispEdges; }
.handle { font-family: 'Outfit'; font-weight: 600; }
${extraCss}
</style></head><body>${body}</body></html>`;
}

// ---------- A: your feed, previewed ----------
async function htmlA() {
  const t = COPY.a;
  const feed = JSON.parse(readFileSync(join(V2, 'a', 'feed', 'feed.json'), 'utf8')).posts;
  const tiles = feed.map((p) => `<div class="tile" style="background-image:url(${jpg(join(V2, 'a', 'feed', p.file))})"></div>`).join('');
  const css = `
body { background: ${C.green}; }
.sandwave { position: absolute; left: 0; right: 0; bottom: 0; height: 1.56in; background: ${C.sand}; }
.top { left: ${PAD}in; right: ${PAD}in; top: ${PAD + 0.02}in; text-align: center; }
.top h1 { font-family: 'Outfit'; font-weight: 600; font-size: 15pt; line-height: 1.08; margin-top: 0.04in; }
.top .sub { font-size: 8.5pt; margin-top: 0.04in; }
.phone { left: 50%; transform: translateX(-50%); top: 0.88in; width: 1.8in; height: 2.66in; background: #111;
  border-radius: 0.24in; padding: 0.07in; box-shadow: 0 0.06in 0.16in rgba(0,0,0,0.28); }
.screen { width: 100%; height: 100%; background: ${C.white}; border-radius: 0.18in; overflow: hidden; position: relative; }
.notch { position: absolute; top: 0.05in; left: 50%; transform: translateX(-50%); width: 0.42in; height: 0.09in; background: #111; border-radius: 0.05in; z-index: 2; }
.status { height: 0.2in; }
.uname { font-family: 'Outfit'; font-weight: 600; font-size: 5.6pt; text-align: center; padding-bottom: 0.03in; }
.prof { display: flex; align-items: center; gap: 0.07in; padding: 0.02in 0.08in 0.02in; }
.avatar { width: 0.36in; height: 0.36in; border-radius: 50%; background-size: cover; background-position: center; border: 0.012in solid #ddd; flex: none; }
.bio { font-size: 4.8pt; line-height: 1.3; color: #222; }
.bio b { font-family: 'Outfit'; font-weight: 600; font-size: 5.2pt; color: #000; display: block; }
.followbtn { margin: 0.05in 0.08in 0.05in; background: #0095F6; color: #fff; border-radius: 0.03in; text-align: center;
  font-family: 'Outfit'; font-weight: 600; font-size: 5.2pt; padding: 0.025in 0; }
.grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.01in; }
.tile { aspect-ratio: 4 / 5; background-size: cover; background-position: center; }
.bottom { left: ${PAD}in; right: ${PAD}in; top: 3.66in; height: 1.2in; display: flex; align-items: center; gap: 0.12in; }
.bottom .qr { width: 1.2in; height: 1.2in; }
.bottom .txt { flex: 1; }
.bottom .scan { font-family: 'Outfit'; font-weight: 600; font-size: 8pt; letter-spacing: 0.1em; text-transform: uppercase; }
.bottom .handle { font-size: 9.5pt; margin-top: 0.02in; }
.bottom .tag { font-size: 8pt; line-height: 1.25; margin-top: 0.06in; }
`;
  const body = `
<div class="sandwave"></div>
<div class="abs top" data-safe><div class="eyebrow">${t.eyebrow}</div><h1>${t.headline}</h1><div class="sub">${t.sub}</div></div>
<div class="abs phone" data-safe><div class="screen"><div class="notch"></div><div class="status"></div>
  <div class="uname">realskincare_com</div>
  <div class="prof"><div class="avatar" style="background-image:url(${jpg(join(V2, 'a', 'feed', 'profile.jpg'))})"></div>
    <div class="bio"><b>Real Skin Care</b>${t.bio1}<br>${t.bio2}</div></div>
  <div class="followbtn">${t.follow}</div>
  <div class="grid">${tiles}</div>
</div></div>
<div class="abs bottom" data-safe><div class="qr">${await qrSvg()}</div>
  <div class="txt"><div class="scan">${t.scan}</div><div class="handle">${HANDLE}</div><div class="tag">${t.tag}</div></div></div>`;
  return page(body, css);
}

// ---------- B: product + handwritten note ----------
async function htmlB() {
  const t = COPY.b;
  const css = `
body { background: ${C.sand}; }
.arch { left: 0.45in; right: 0.45in; top: 0.64in; height: 1.84in; background: ${C.green}; border-radius: 1.2in 1.2in 0.1in 0.1in; }
.logo { left: 50%; transform: translateX(-50%); top: ${PAD}in; height: 0.3in; }
.prods { left: 0; right: 0; top: 0.66in; height: 1.74in; }
.prods img { position: absolute; bottom: 0; filter: drop-shadow(0 0.03in 0.04in rgba(0,0,0,0.25)); }
.note { left: 0.36in; right: 0.36in; top: 2.5in; background: ${C.paper}; padding: 0.12in 0.14in 0.1in; transform: rotate(-2.2deg);
  box-shadow: 0 0.03in 0.08in rgba(0,0,0,0.18); text-align: center; }
.note .h { font-family: 'Caveat'; font-weight: 700; font-size: 25pt; line-height: 1; }
.note .s { font-family: 'Caveat'; font-weight: 500; font-size: 15pt; line-height: 1.1; margin-top: 0.02in; }
.row { left: ${PAD}in; right: ${PAD}in; top: 3.42in; display: flex; align-items: center; gap: 0.12in; }
.row .qr { width: 1.2in; height: 1.2in; }
.row .txt { flex: 1; }
.row .lead { font-family: 'Outfit'; font-weight: 600; font-size: 10pt; line-height: 1.15; }
.row .handle { font-size: 9pt; margin-top: 0.03in; }
.row .scan { font-size: 8pt; letter-spacing: 0.08em; text-transform: uppercase; margin-top: 0.02in; }
.row .posts { font-size: 8pt; line-height: 1.25; margin-top: 0.06in; }
.tag { left: ${PAD}in; right: ${PAD}in; bottom: ${PAD}in; text-align: center; font-family: 'Caveat'; font-weight: 700; font-size: 14pt; }
`;
  const body = `
<div class="abs arch"></div>
<img class="abs logo" data-safe src="${png(join(LOGOS, 'rsc-logo-black.png'))}">
<div class="abs prods">
  <img src="${cutout('component-lotion-coconut-breeze')}" style="height:1.52in; left:0.92in; z-index:1">
  <img src="${cutout('component-cream-coconut-breeze')}" style="height:0.98in; left:1.36in; z-index:2">
</div>
<div class="abs note" data-safe><div class="h">${t.note1}</div><div class="s">${t.note2}</div></div>
<div class="abs row" data-safe><div class="qr">${await qrSvg()}</div>
  <div class="txt"><div class="lead">${t.lead}</div><div class="handle">${HANDLE}</div><div class="scan">${t.scan}</div><div class="posts">${t.posts}</div></div></div>
<div class="abs tag" data-safe>${t.tag}</div>`;
  return page(body, css);
}

// ---------- C: two-sided ----------
function htmlCFront() {
  const t = COPY.cFront;
  const css = `
body { background: ${C.green}; }
.floor { left: 0; right: 0; bottom: 0; height: 1.25in; background: ${C.sand}; }
.logo { left: 50%; transform: translateX(-50%); top: ${PAD + 0.05}in; height: 0.36in; }
.copy { left: ${PAD}in; right: ${PAD}in; top: 0.9in; text-align: center; }
.copy h1 { font-family: 'Outfit'; font-weight: 600; font-size: 31pt; line-height: 0.98; letter-spacing: -0.01em; margin-top: 0.08in; }
.copy .sub { font-size: 10pt; margin-top: 0.1in; }
.prods { left: 0; right: 0; bottom: 0.66in; height: 1.9in; }
.prods img { position: absolute; bottom: 0; filter: drop-shadow(0 0.03in 0.035in rgba(0,0,0,0.25)); }
.turn { left: ${PAD}in; right: ${PAD}in; bottom: ${PAD + 0.04}in; text-align: center; font-family: 'Outfit'; font-weight: 600; font-size: 8pt; letter-spacing: 0.14em; text-transform: uppercase; }
`;
  const body = `
<div class="abs floor"></div>
<img class="abs logo" data-safe src="${png(join(LOGOS, 'rsc-logo-black.png'))}">
<div class="abs copy" data-safe><div class="eyebrow">${t.eyebrow}</div><h1>${t.headline}</h1><div class="sub">${t.sub}</div></div>
<div class="abs prods">
  <img src="${cutout('component-toothpaste-fresh-mint')}" style="height:1.21in; left:0.286in">
  <img src="${cutout('component-lotion-coconut-breeze')}" style="height:1.75in; left:0.667in">
  <img src="${cutout('component-cream-coconut-breeze')}" style="height:1.026in; left:1.229in">
  <img src="${cutout('component-deodorant-calming-lavender')}" style="height:1.166in; left:2.4in">
</div>
<div class="abs turn" data-safe>${t.turn} &rarr;</div>`;
  return page(body, css);
}

async function htmlCBack() {
  const t = COPY.cBack;
  const css = `
body { background: ${C.sand}; }
.band { left: 0; right: 0; bottom: 0; height: ${BLEED + 0.5}in; background: ${C.green}; }
.mono { left: 50%; transform: translateX(-50%); top: ${PAD}in; height: 0.3in; }
.head { left: ${PAD}in; right: ${PAD}in; top: 0.6in; text-align: center; }
.head h1 { font-family: 'Outfit'; font-weight: 600; font-size: 17pt; line-height: 1.1; }
.qrwrap { left: 50%; transform: translateX(-50%); top: 1.08in; text-align: center; }
.qrwrap .qr { width: 1.55in; height: 1.55in; margin: 0 auto; }
.qrwrap .handle { font-size: 10pt; margin-top: 0.06in; }
.qrwrap .scan { font-size: 8pt; letter-spacing: 0.1em; text-transform: uppercase; margin-top: 0.01in; }
.list { left: ${PAD}in; right: ${PAD}in; top: 3.22in; }
.list p { font-family: 'Outfit'; font-weight: 600; font-size: 9pt; margin-bottom: 0.04in; }
.list li { list-style: none; font-size: 8.5pt; line-height: 1.25; padding-left: 0.12in; position: relative; margin-bottom: 0.02in; }
.list li::before { content: ''; position: absolute; left: 0.015in; top: 0.05in; width: 0.045in; height: 0.045in; border-radius: 50%; background: ${C.black}; }
.tag { left: ${PAD}in; right: ${PAD}in; bottom: ${BLEED}in; height: 0.5in; display: flex; align-items: center; justify-content: center;
  font-family: 'Outfit'; font-weight: 600; font-size: 9pt; }
`;
  const body = `
<div class="abs band"></div>
<img class="abs mono" data-safe src="${png(join(LOGOS, 'monogram_rsc_black.png'))}">
<div class="abs head" data-safe><h1>${t.headline}</h1></div>
<div class="abs qrwrap" data-safe><div class="qr">${await qrSvg()}</div><div class="handle">${HANDLE}</div><div class="scan">${t.scan}</div></div>
<div class="abs list" data-safe><p>${t.lead}</p><ul>${t.list.map((s) => `<li>${s}</li>`).join('')}</ul></div>
<div class="abs tag"><span data-safe>${t.tag}</span></div>`;
  return page(body, css);
}

// ---------- render + verify ----------
async function renderSide(browser, html, { pdfPath, pngPath, expectQr }) {
  const pg = await browser.newPage();
  const cssW = PAGE_W * 96;
  const cssH = PAGE_H * 96;
  await pg.setViewport({ width: Math.ceil(cssW), height: Math.ceil(cssH), deviceScaleFactor: PRINT_DPI / 96 });
  await pg.setContent(html, { waitUntil: 'load' });
  await pg.evaluate(() => document.fonts.ready);
  const bad = await pg.evaluate((padPx) => {
    const W = document.body.getBoundingClientRect().width;
    const H = document.body.getBoundingClientRect().height;
    const out = [];
    for (const el of document.querySelectorAll('[data-safe], .qr')) {
      const r = el.getBoundingClientRect();
      if (r.left < padPx - 0.5 || r.top < padPx - 0.5 || r.right > W - padPx + 0.5 || r.bottom > H - padPx + 0.5) {
        out.push(`${el.className || el.tagName} [${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.right)},${Math.round(r.bottom)}]`);
      }
    }
    // overlapping safe blocks
    const els = [...document.querySelectorAll('[data-safe]')].map((e) => [e, e.getBoundingClientRect()]);
    for (let i = 0; i < els.length; i++) for (let j = i + 1; j < els.length; j++) {
      const [a, ra] = els[i]; const [b, rb] = els[j];
      if (a.contains(b) || b.contains(a)) continue;
      if (ra.left < rb.right && rb.left < ra.right && ra.top < rb.bottom && rb.top < ra.bottom) out.push(`${a.className} overlaps ${b.className}`);
    }
    return out;
  }, PAD * 96);
  if (bad.length) throw new Error(`${pdfPath}: layout outside safe area or overlapping: ${bad.join('; ')}`);
  const pxW = Math.round(PAGE_W * PRINT_DPI);
  const pxH = Math.round(PAGE_H * PRINT_DPI);
  const raw = await pg.screenshot({ type: 'png', clip: { x: 0, y: 0, width: cssW, height: cssH, scale: 1 } });
  await pg.close();
  const shot = await sharp(raw).extract({ left: 0, top: 0, width: pxW, height: pxH }).png().toBuffer();
  const { data } = await sharp(shot).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  writeFileSync(pdfPath, cmykImagePdf({ cmyk: rgbaToCmyk(data), pxW, pxH, ptW: PAGE_W * 72, ptH: PAGE_H * 72 }));
  await sharp(shot).resize({ width: PREVIEW_PX }).png().toFile(pngPath);
  return verifyPdf(pdfPath, expectQr);
}

function verifyPdf(pdfPath, expectQr) {
  const work = mkdtempSync(join(tmpdir(), 'ig-v2-'));
  try {
    const info = execFileSync('pdfinfo', [pdfPath], { encoding: 'utf8' });
    const size = info.match(/Page size:\s+([\d.]+) x ([\d.]+) pts/);
    if (Math.abs(Number(size[1]) / 72 - PAGE_W) > 0.005 || Math.abs(Number(size[2]) / 72 - PAGE_H) > 0.005) throw new Error(`${pdfPath}: wrong page size`);
    if (execFileSync('pdffonts', [pdfPath], { encoding: 'utf8' }).trim().split('\n').length > 2) throw new Error(`${pdfPath}: carries fonts`);
    const img = execFileSync('pdfimages', ['-list', pdfPath], { encoding: 'utf8' }).trim().split('\n').slice(2);
    const cols = img[0].trim().split(/\s+/);
    if (img.length !== 1 || cols[5] !== 'cmyk' || Math.round(Number(cols[12])) !== PRINT_DPI) throw new Error(`${pdfPath}: not one CMYK image at ${PRINT_DPI} ppi`);
    let decoded = null;
    if (expectQr) {
      execFileSync('pdftoppm', ['-r', String(PRINT_DPI), '-png', pdfPath, join(work, 'p')]);
      const f = join(work, readdirSync(work).find((n) => n.endsWith('.png')));
      const lines = execFileSync('zbarimg', ['--quiet', '--raw', '-Sdisable', '-Sqrcode.enable', f], { encoding: 'utf8' }).trim().split('\n');
      if (lines.length !== 1 || lines[0] !== IG_URL) throw new Error(`${pdfPath}: QR decoded to ${JSON.stringify(lines)}`);
      decoded = lines[0];
    }
    return { pdf: pdfPath, image: `${cols[3]}x${cols[4]} ${cols[5]} ${cols[12]}ppi`, decoded };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function compare(paths, outPath) {
  const H = 1100;
  const labels = ['A  Your feed, previewed', 'B  Product + note', 'C  Front', 'C  Back'];
  const tiles = await Promise.all(paths.map((p) => sharp(p).resize({ height: H }).png().toBuffer()));
  const metas = await Promise.all(tiles.map((t) => sharp(t).metadata()));
  const gap = 60;
  const top = 110;
  const W = metas.reduce((s, m) => s + m.width, 0) + gap * (tiles.length + 1) + 40;
  let x = gap;
  const comps = [];
  const svgText = [];
  tiles.forEach((t, i) => {
    if (i === 3) x -= 20; // C front and back sit closer together
    if (i === 2) x += 40;
    comps.push({ input: t, left: x, top });
    svgText.push(`<text x="${x}" y="70" font-family="Helvetica, Arial" font-size="40" font-weight="700">${labels[i]}</text>`);
    x += metas[i].width + gap;
  });
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H + top + gap}">${svgText.join('')}</svg>`);
  await sharp({ create: { width: W, height: H + top + gap, channels: 3, background: '#FFFFFF' } })
    .composite([...comps.map((c) => ({ ...c })), { input: svg, left: 0, top: 0 }]).png().toFile(outPath);
}

async function main() {
  const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
  const gate = gateAllCopy();
  const jobs = [
    ['a', async () => [[await htmlA(), 'a/rsc-instagram-insert-v2a-3x5-gotprint.pdf', 'a/preview.png', true]]],
    ['b', async () => [[await htmlB(), 'b/rsc-instagram-insert-v2b-3x5-gotprint.pdf', 'b/preview.png', true]]],
    ['c', async () => [
      [htmlCFront(), 'c/rsc-instagram-insert-v2c-3x5-FRONT-gotprint.pdf', 'c/preview-front.png', false],
      [await htmlCBack(), 'c/rsc-instagram-insert-v2c-3x5-BACK-gotprint.pdf', 'c/preview-back.png', true],
    ]],
  ];
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--font-render-hinting=none'] });
  try {
    for (const [dir, build] of jobs) {
      if (only && only !== dir) continue;
      mkdirSync(join(V2, dir), { recursive: true });
      for (const [html, pdf, prev, qr] of await build()) {
        const r = await renderSide(browser, html, { pdfPath: join(V2, pdf), pngPath: join(V2, prev), expectQr: qr });
        console.log(`${pdf}  ${r.image}  ${r.decoded ? `QR ok: ${r.decoded}` : '(no QR on this side)'}`);
      }
    }
    if (!only) {
      const fb = join(V2, 'c', 'preview-front.png');
      const bk = join(V2, 'c', 'preview-back.png');
      await sharp({ create: { width: 2460, height: 1974, channels: 3, background: '#FFFFFF' } })
        .composite([{ input: fb, left: 0, top: 0 }, { input: bk, left: 1260, top: 0 }]).png().toFile(join(V2, 'c', 'preview-front-back.png'));
      await compare([join(V2, 'a', 'preview.png'), join(V2, 'b', 'preview.png'), fb, bk], join(V2, 'compare.png'));
      console.log(`compare ${join(V2, 'compare.png')}`);
    }
  } finally {
    await browser.close();
  }
  console.log(`Gate ok: ${gate.ok} · ${gate.count} strings · blocking ${gate.blocking.length} · advisory ${gate.advisory.length}`);
}

if (isDirectRun(import.meta.url)) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
