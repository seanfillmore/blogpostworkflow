#!/usr/bin/env node
// Build the printable Instagram packing insert: a 3 x 5 in portrait card, printed at
// GotPrint as a 3" x 5" postcard (Full Color Front, Blank Back), that goes in every order
// and sends buyers to @realskincare_com.
//
//   node scripts/build-instagram-insert.mjs
//
// GotPrint spec followed (verified 2026-11-04):
//   - Template https://static.gotprint.com/templates/gotprint.com/postcard-3inx5in-v.pdf.zip
//     "Final Size: 3 inches x 5 inches Vertical / Size with Bleed: 3.1 inches x 5.1 inches"
//     (0.05 in each side), "allow 0.1 inches cutting tolerance all around",
//     "All text should be converted to outline".
//   - https://www.gotprint.com/resources/preparing-files.html: CMYK, 350 dpi at final size,
//     fonts embedded in PDF, flatten before upload, 75 MB max.
//   We keep everything critical 0.15 in inside the trim, which is inside GotPrint's
//   template safe line and clears its 0.1 in cutting tolerance.
//
// Outputs (assets/print/instagram-insert/):
//   rsc-instagram-insert-3x5-front-gotprint.pdf   UPLOAD THIS (front). 3.1 x 5.1 in, one page,
//                                                 one DeviceCMYK image at 350 ppi, no fonts
//                                                 (text is outlined by rasterizing), flattened,
//                                                 TrimBox/BleedBox set.
//   rsc-instagram-insert-3x5-preview.png          1200 px wide RGB preview of the full bleed page
//
// Every copy string is run through the commercial health-claim gate before anything is
// rendered (a blocking hit aborts). The render aborts if text leaves the safe area. The
// final CMYK PDF is rasterized at 350 dpi with pdftoppm and the QR must decode to the
// exact URL with zbarimg; page size, fonts and image colour/ppi are checked with poppler
// (pdfinfo, pdffonts, pdfimages). Needs poppler and zbar installed (brew install poppler zbar).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import puppeteer from 'puppeteer';
import QRCode from 'qrcode';
import sharp from 'sharp';
import { deflateSync } from 'node:zlib';
import { fontFaceCss } from '../lib/brand-fonts.js';
import { checkSeoCopyFields } from '../lib/seo-copy-health-gate.js';
import { isDirectRun } from '../lib/is-direct-run.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'assets', 'print', 'instagram-insert');
const PDF_PATH = join(OUT_DIR, 'rsc-instagram-insert-3x5-front-gotprint.pdf');
const PNG_PATH = join(OUT_DIR, 'rsc-instagram-insert-3x5-preview.png');

export const IG_URL = 'https://www.instagram.com/realskincare_com/';
const HANDLE = '@realskincare_com';

// Geometry, in CSS inches (Chrome prints at 96 px per inch).
const TRIM_W = 3;
const TRIM_H = 5;
const BLEED = 0.05; // GotPrint postcard: 0.1 in total, 0.05 in per side
const SAFE = 0.15; // from trim
const PAGE_W = TRIM_W + 2 * BLEED;
const PAGE_H = TRIM_H + 2 * BLEED;
const QR_IN = 1.45; // printed QR size, 4-module quiet zone included
const PRINT_DPI = 350;
const PREVIEW_PX = 1200;
const BAND_IN = 0.5; // green band height above the trim edge

const PALETTE = { black: '#000000', sand: '#EDE5D8', green: '#AEDEAC', white: '#FFFFFF' };

export const COPY = Object.freeze({
  eyebrow: 'From our family to yours',
  headline: 'Thank you for your order.',
  lead: 'Come say hi on Instagram.',
  scan: 'Scan to follow',
  listIntro: 'What we post:',
  list: [
    'How-to guides, like switching to aluminum-free deodorant',
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
.band { position: absolute; left: 0; right: 0; bottom: 0; height: ${BLEED + BAND_IN}in; background: ${PALETTE.green}; }
.safe { position: absolute; inset: ${pad}in; pointer-events: none; }
.content { position: absolute; left: ${pad}in; right: ${pad}in; top: ${pad}in; bottom: ${BLEED + BAND_IN + 0.12}in;
  display: flex; flex-direction: column; align-items: center; justify-content: space-between; text-align: center; }
.group { display: flex; flex-direction: column; align-items: center; width: 100%; }
.logo { height: 0.44in; width: auto; display: block; }
.eyebrow { font-family: 'Outfit'; font-weight: 600; font-size: 6.5pt; letter-spacing: 0.2em;
  text-transform: uppercase; }
h1 { font-family: 'Outfit'; font-weight: 600; font-size: 14pt; line-height: 1.12; margin-top: 0.04in; }
.lead { font-size: 9pt; line-height: 1.25; margin-top: 0.04in; }
.qr { width: ${QR_IN}in; height: ${QR_IN}in; background: ${PALETTE.white}; flex: none; }
.qr svg { width: 100%; height: 100%; display: block; shape-rendering: crispEdges; }
.handle { font-family: 'Outfit'; font-weight: 600; font-size: 9.5pt; margin-top: 0.06in; }
.scan { font-size: 7pt; letter-spacing: 0.08em; text-transform: uppercase; margin-top: 0.01in; }
.list { text-align: left; width: 100%; }
.list p { font-family: 'Outfit'; font-weight: 600; font-size: 8pt; margin-bottom: 0.03in; }
.list ul { list-style: none; }
.list li { font-size: 8pt; line-height: 1.25; padding-left: 0.12in; position: relative; margin-bottom: 0.02in; }
.list li::before { content: ''; position: absolute; left: 0.015in; top: 0.048in; width: 0.045in; height: 0.045in;
  border-radius: 50%; background: ${PALETTE.black}; }
.tag { position: absolute; left: ${pad}in; right: ${pad}in; bottom: ${BLEED}in; height: ${BAND_IN}in; display: flex;
  align-items: center; justify-content: center; font-family: 'Outfit'; font-weight: 600; font-size: 8pt; text-align: center; }
</style></head><body>
<div class="band"></div>
<div class="safe"></div>
<div class="content">
  <img class="logo" src="${logo}" alt="Real Skin Care">
  <div class="group"><div class="eyebrow">${COPY.eyebrow}</div><h1>${COPY.headline}</h1><div class="lead">${COPY.lead}</div></div>
  <div class="group"><div class="qr">${qrSvg}</div><div class="handle">${HANDLE}</div><div class="scan">${COPY.scan}</div></div>
  <div class="list"><p>${COPY.listIntro}</p><ul>${COPY.list.map((s) => `<li>${s}</li>`).join('')}</ul></div>
</div>
<div class="tag"><span>${COPY.tag}</span></div>
</body></html>`;
}

// GotPrint prints CMYK only and asks for text converted to outlines and flattened files.
// The card is rendered at exactly 350 dpi (GotPrint's print resolution), converted to
// CMYK with full grey-component replacement (K = 1 - max(R,G,B)) so black type and the QR
// sit on the K plate alone and cannot misregister, and wrapped in a one-page PDF as a
// single DeviceCMYK image. No fonts, no transparency, no layers.
export function rgbaToCmyk(rgba) {
  const n = rgba.length / 4;
  const out = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4] / 255; const g = rgba[i * 4 + 1] / 255; const b = rgba[i * 4 + 2] / 255;
    const k = 1 - Math.max(r, g, b);
    const d = 1 - k;
    out[i * 4] = d > 0 ? Math.round(((d - r) / d) * 255) : 0;
    out[i * 4 + 1] = d > 0 ? Math.round(((d - g) / d) * 255) : 0;
    out[i * 4 + 2] = d > 0 ? Math.round(((d - b) / d) * 255) : 0;
    out[i * 4 + 3] = Math.round(k * 255);
  }
  return out;
}

export function cmykImagePdf({ cmyk, pxW, pxH, ptW, ptH }) {
  const img = deflateSync(cmyk);
  const content = Buffer.from(`q ${ptW} 0 0 ${ptH} 0 0 cm /Im0 Do Q`);
  const objs = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${ptW} ${ptH}] /TrimBox [${BLEED * 72} ${BLEED * 72} ${ptW - BLEED * 72} ${ptH - BLEED * 72}] /BleedBox [0 0 ${ptW} ${ptH}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`),
    Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${pxW} /Height ${pxH} /ColorSpace /DeviceCMYK /BitsPerComponent 8 /Filter /FlateDecode /Length ${img.length} >>\nstream\n`), img, Buffer.from('\nendstream')]),
    Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from('\nendstream')]),
  ];
  const parts = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  const offsets = [];
  let pos = parts[0].length;
  objs.forEach((body, i) => {
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), body, Buffer.from('\nendobj\n')]);
    offsets.push(pos); parts.push(chunk); pos += chunk.length;
  });
  const xref = [`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`));
  return Buffer.concat(parts);
}

function verifyPrintFile(pdfPath, workDir) {
  const prefix = join(workDir, 'print');
  execFileSync('pdftoppm', ['-r', String(PRINT_DPI), '-png', pdfPath, prefix]);
  const png = join(workDir, readdirSync(workDir).find((f) => f.startsWith('print') && f.endsWith('.png')));
  const out = execFileSync('zbarimg', ['--quiet', '--raw', '-Sdisable', '-Sqrcode.enable', png], { encoding: 'utf8' }).trim();
  if (out !== IG_URL) throw new Error(`QR decoded to "${out}", expected "${IG_URL}"`);
  const info = execFileSync('pdfinfo', [pdfPath], { encoding: 'utf8' });
  const fonts = execFileSync('pdffonts', [pdfPath], { encoding: 'utf8' }).trim().split('\n').slice(2);
  const images = execFileSync('pdfimages', ['-list', pdfPath], { encoding: 'utf8' }).trim().split('\n').slice(2);
  const size = info.match(/Page size:\s+([\d.]+) x ([\d.]+) pts/);
  const pages = Number(info.match(/Pages:\s+(\d+)/)[1]);
  const wIn = Number(size[1]) / 72;
  const hIn = Number(size[2]) / 72;
  if (pages !== 1 || Math.abs(wIn - PAGE_W) > 0.005 || Math.abs(hIn - PAGE_H) > 0.005) {
    throw new Error(`print file is ${pages} page(s) at ${wIn} x ${hIn} in, expected 1 at ${PAGE_W} x ${PAGE_H}`);
  }
  if (fonts.length) throw new Error(`print file carries fonts: ${fonts.join(' | ')}`);
  const cols = images[0]?.trim().split(/\s+/) || [];
  // pdfimages -list: page num type width height color comp bpc enc interp object ID x-ppi y-ppi ...
  if (images.length !== 1 || cols[5] !== 'cmyk' || Math.round(Number(cols[12])) !== PRINT_DPI) {
    throw new Error(`print file image is not one CMYK image at ${PRINT_DPI} ppi: ${images.join(' | ')}`);
  }
  return { decoded: out, wIn, hIn, image: `${cols[3]} x ${cols[4]} px, ${cols[5]}, ${cols[12]} ppi` };
}

async function main() {
  const gate = gateCopy();
  mkdirSync(OUT_DIR, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), 'ig-insert-'));
  let printRaster;
  try {
    const html = await buildHtml();
    const browser = await puppeteer.launch({ args: ['--no-sandbox', '--font-render-hinting=none'] });
    try {
      const page = await browser.newPage();
      const cssW = PAGE_W * 96;
      const cssH = PAGE_H * 96;
      await page.setViewport({ width: Math.ceil(cssW), height: Math.ceil(cssH), deviceScaleFactor: 1 });
      await page.setContent(html, { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready);
      const overflow = await page.evaluate(() => {
        const safe = document.querySelector('.safe').getBoundingClientRect();
        const bad = [];
        for (const el of document.querySelectorAll('.content *, .tag span')) {
          const r = el.getBoundingClientRect();
          if (r.top < safe.top - 0.5 || r.bottom > safe.bottom + 0.5 || r.left < safe.left - 0.5 || r.right > safe.right + 0.5) bad.push(el.className || el.tagName);
        }
        const list = document.querySelector('.list').getBoundingClientRect();
        const band = document.querySelector('.band').getBoundingClientRect();
        if (list.bottom > band.top - 4) bad.push('list overlaps band');
        return bad;
      });
      if (overflow.length) throw new Error(`layout outside safe area: ${overflow.join(', ')}`);
      const clip = { x: 0, y: 0, width: cssW, height: cssH, scale: 1 };
      await page.setViewport({ width: Math.ceil(cssW), height: Math.ceil(cssH), deviceScaleFactor: PRINT_DPI / 96 });
      await page.evaluate(() => document.fonts.ready);
      const pxW = Math.round(PAGE_W * PRINT_DPI);
      const pxH = Math.round(PAGE_H * PRINT_DPI);
      // Chrome rounds the clip up to whole device pixels; trim the sub-pixel overhang.
      const raw = await page.screenshot({ type: 'png', clip, omitBackground: false });
      const meta = await sharp(raw).metadata();
      if (meta.width < pxW || meta.height < pxH || meta.width > pxW + 1 || meta.height > pxH + 1) {
        throw new Error(`render is ${meta.width} x ${meta.height}, expected ${pxW} x ${pxH}`);
      }
      const shot = await sharp(raw).extract({ left: 0, top: 0, width: pxW, height: pxH }).png().toBuffer();
      const { data } = await sharp(shot).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      printRaster = { data, pxW, pxH, shot };
    } finally {
      await browser.close();
    }
    const { data, pxW, pxH, shot } = printRaster;
    writeFileSync(PDF_PATH, cmykImagePdf({ cmyk: rgbaToCmyk(data), pxW, pxH, ptW: PAGE_W * 72, ptH: PAGE_H * 72 }));
    await sharp(shot).resize({ width: PREVIEW_PX }).png().toFile(PNG_PATH);
    const v = verifyPrintFile(PDF_PATH, work);
    console.log(`PDF  ${PDF_PATH}  (${v.wIn.toFixed(2)} x ${v.hIn.toFixed(2)} in, ${v.image})`);
    console.log(`PNG  ${PNG_PATH}  (${PREVIEW_PX} px wide)`);
    console.log(`Gate ok: ${gate.ok} · blocking ${gate.blocking.length} · advisory ${gate.advisory.length}`);
    console.log(`QR decoded from print file at ${PRINT_DPI} dpi: ${v.decoded}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (isDirectRun(import.meta.url)) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
