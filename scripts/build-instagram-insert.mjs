#!/usr/bin/env node
// Build the printable Instagram packing insert: a 4 x 6 in portrait card that goes in
// every order and sends buyers to @realskincare_com.
//
//   node scripts/build-instagram-insert.mjs
//
// Outputs (assets/print/instagram-insert/):
//   instagram-insert-4x6.pdf          print-ready, 4.25 x 6.25 in (0.125 in bleed each side)
//   instagram-insert-4x6-preview.png  1200 px wide preview of the full bleed page
//
// Every copy string is run through the commercial health-claim gate before anything is
// rendered (a blocking hit aborts). The rendered PNG is decoded with zbarimg when it is
// installed, and the run fails if the QR does not decode to the exact URL.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import puppeteer from 'puppeteer';
import QRCode from 'qrcode';
import { fontFaceCss } from '../lib/brand-fonts.js';
import { checkSeoCopyFields } from '../lib/seo-copy-health-gate.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'assets', 'print', 'instagram-insert');
const PDF_PATH = join(OUT_DIR, 'instagram-insert-4x6.pdf');
const PNG_PATH = join(OUT_DIR, 'instagram-insert-4x6-preview.png');

export const IG_URL = 'https://www.instagram.com/realskincare_com/';
const HANDLE = '@realskincare_com';

// Geometry, in CSS inches (Chrome prints at 96 px per inch).
const TRIM_W = 4;
const TRIM_H = 6;
const BLEED = 0.125;
const SAFE = 0.25; // from trim
const PAGE_W = TRIM_W + 2 * BLEED;
const PAGE_H = TRIM_H + 2 * BLEED;
const QR_IN = 1.6; // printed QR size, quiet zone included
const PREVIEW_PX = 1200;

const PALETTE = { black: '#000000', sand: '#EDE5D8', green: '#AEDEAC', white: '#FFFFFF' };

export const COPY = Object.freeze({
  eyebrow: 'From our family to yours',
  headline: 'Thank you for your order.',
  lead: 'Come say hi on Instagram.',
  scan: 'Scan to follow',
  listIntro: 'What we post:',
  list: [
    'Short how-to guides, like switching to aluminum-free deodorant',
    'What is really in your toothpaste',
    'Real reviews from real customers',
    'Videos from creators who use our products',
  ],
  tag: 'Tag us @realskincare_com. We love seeing it.',
});

function copyFields() {
  const f = {};
  for (const [k, v] of Object.entries(COPY)) {
    if (Array.isArray(v)) v.forEach((s, i) => { f[`${k}[${i}]`] = s; });
    else f[k] = v;
  }
  return f;
}

export function gateCopy() {
  const fields = copyFields();
  const dashes = Object.entries(fields).filter(([, s]) => /[–—]/.test(s));
  if (dashes.length) throw new Error(`en/em dash in copy: ${dashes.map(([k]) => k).join(', ')}`);
  const res = checkSeoCopyFields(fields);
  if (!res.ok) {
    throw new Error(`health gate blocked: ${res.blocking.map((b) => `${b.field}: "${b.match}" (${b.category})`).join('; ')}`);
  }
  return res;
}

function dataUri(path, mime) {
  return `data:${mime};base64,${readFileSync(path).toString('base64')}`;
}

async function buildHtml() {
  const qrSvg = await QRCode.toString(IG_URL, {
    type: 'svg', errorCorrectionLevel: 'M', margin: 4,
    color: { dark: PALETTE.black, light: PALETTE.white },
  });
  const logo = dataUri(join(ROOT, 'data', 'brand', 'logo', 'rsc-logo-black.png'), 'image/png');
  const pad = BLEED + SAFE;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${fontFaceCss()}
@page { size: ${PAGE_W}in ${PAGE_H}in; margin: 0; }
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: ${PAGE_W}in; height: ${PAGE_H}in; }
body { background: ${PALETTE.sand}; color: ${PALETTE.black}; font-family: 'Cabin', sans-serif;
  -webkit-print-color-adjust: exact; print-color-adjust: exact; position: relative; overflow: hidden; }
.band { position: absolute; left: 0; right: 0; bottom: 0; height: ${BLEED + 0.72}in; background: ${PALETTE.green}; }
.safe { position: absolute; left: ${pad}in; right: ${pad}in; top: ${pad}in; bottom: ${pad}in;
  display: flex; flex-direction: column; align-items: center; text-align: center; }
.logo { height: 0.5in; width: auto; display: block; }
.eyebrow { font-family: 'Outfit'; font-weight: 600; font-size: 7.5pt; letter-spacing: 0.22em;
  text-transform: uppercase; margin-top: 0.2in; }
h1 { font-family: 'Outfit'; font-weight: 600; font-size: 17pt; line-height: 1.12; margin-top: 0.05in; }
.lead { font-size: 10.5pt; line-height: 1.3; margin-top: 0.07in; }
.qr { margin-top: 0.14in; width: ${QR_IN}in; height: ${QR_IN}in; background: ${PALETTE.white}; }
.qr svg { width: 100%; height: 100%; display: block; shape-rendering: crispEdges; }
.handle { font-family: 'Outfit'; font-weight: 600; font-size: 11pt; margin-top: 0.07in; }
.scan { font-size: 8pt; letter-spacing: 0.08em; text-transform: uppercase; margin-top: 0.02in; }
.list { margin-top: 0.15in; text-align: left; width: 100%; }
.list p { font-family: 'Outfit'; font-weight: 600; font-size: 9pt; margin-bottom: 0.04in; }
.list ul { list-style: none; }
.list li { font-size: 9pt; line-height: 1.28; padding-left: 0.16in; position: relative; margin-bottom: 0.025in; }
.list li::before { content: ''; position: absolute; left: 0.02in; top: 0.055in; width: 0.06in; height: 0.06in;
  border-radius: 50%; background: ${PALETTE.black}; }
.tag { position: absolute; left: ${pad}in; right: ${pad}in; bottom: ${BLEED}in; height: 0.72in; display: flex;
  align-items: center; justify-content: center; font-family: 'Outfit'; font-weight: 600; font-size: 10pt; }
</style></head><body>
<div class="band"></div>
<div class="safe">
  <img class="logo" src="${logo}" alt="Real Skin Care">
  <div class="eyebrow">${COPY.eyebrow}</div>
  <h1>${COPY.headline}</h1>
  <div class="lead">${COPY.lead}</div>
  <div class="qr">${qrSvg}</div>
  <div class="handle">${HANDLE}</div>
  <div class="scan">${COPY.scan}</div>
  <div class="list"><p>${COPY.listIntro}</p><ul>${COPY.list.map((s) => `<li>${s}</li>`).join('')}</ul></div>
</div>
<div class="tag"><span>${COPY.tag}</span></div>
</body></html>`;
}

function verifyQr(pngPath) {
  let out;
  try {
    out = execFileSync('zbarimg', ['--quiet', '--raw', '-Sdisable', '-Sqrcode.enable', pngPath], { encoding: 'utf8' });
  } catch (err) {
    if (err.code === 'ENOENT') return { checked: false, reason: 'zbarimg not installed' };
    throw new Error(`QR did not decode: ${err.message}`);
  }
  const decoded = out.trim();
  if (decoded !== IG_URL) throw new Error(`QR decoded to "${decoded}", expected "${IG_URL}"`);
  return { checked: true, decoded };
}

async function main() {
  const gate = gateCopy();
  mkdirSync(OUT_DIR, { recursive: true });
  const html = await buildHtml();
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--font-render-hinting=none'] });
  try {
    const page = await browser.newPage();
    const cssW = PAGE_W * 96;
    const cssH = PAGE_H * 96;
    await page.setViewport({ width: Math.round(cssW), height: Math.round(cssH), deviceScaleFactor: PREVIEW_PX / cssW });
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    const overflow = await page.evaluate(() => {
      const safe = document.querySelector('.safe').getBoundingClientRect();
      const bad = [];
      for (const el of document.querySelectorAll('.safe > *, .list li, .tag span')) {
        const r = el.getBoundingClientRect();
        if (r.top < safe.top - 0.5 || r.bottom > safe.bottom + 0.5 || r.left < safe.left - 0.5 || r.right > safe.right + 0.5) bad.push(el.className || el.tagName);
      }
      const list = document.querySelector('.list').getBoundingClientRect();
      const band = document.querySelector('.band').getBoundingClientRect();
      if (list.bottom > band.top - 4) bad.push('list overlaps band');
      return bad;
    });
    if (overflow.length) throw new Error(`layout outside safe area: ${overflow.join(', ')}`);
    await page.screenshot({ path: PNG_PATH, type: 'png' });
    const pdf = await page.pdf({ width: `${PAGE_W}in`, height: `${PAGE_H}in`, printBackground: true, preferCSSPageSize: true });
    writeFileSync(PDF_PATH, pdf);
  } finally {
    await browser.close();
  }
  const qr = verifyQr(PNG_PATH);
  console.log(`PDF  ${PDF_PATH}  (${PAGE_W} x ${PAGE_H} in, ${BLEED} in bleed)`);
  console.log(`PNG  ${PNG_PATH}  (${PREVIEW_PX} px wide)`);
  console.log(`Gate ok: ${gate.ok} · blocking ${gate.blocking.length} · advisory ${gate.advisory.length}`);
  console.log(qr.checked ? `QR decoded: ${qr.decoded}` : `QR NOT verified: ${qr.reason}`);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
