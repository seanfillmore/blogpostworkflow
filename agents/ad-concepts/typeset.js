// agents/ad-concepts/typeset.js
//
// Overlay type set in CODE, in the real brand faces, so the copy on the ad is exactly the
// copy that passed the gates. Image models approximate type: Ad Studio's comp pass printed
// "50ml" on a 60ml bottle on 2026-10-03, and a hand mockup that day overflowed the frame,
// which is why the headline is fitted to the band by measuring it in the browser.
import { createRequire } from 'node:module';
import { fontFaceCss } from '../../lib/brand-fonts.js';
import { sniffImageMediaType } from '../ad-studio/index.js';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

export const TREATMENTS = Object.freeze(['band', 'caption']);
const SAND = '#EDE5D8';

export function pickTextColour(luminance) {
  return luminance >= 140 ? '#000000' : '#FFFFFF';
}

export async function bandLuminance(buffer, band) {
  const { width, height } = await sharp(buffer).metadata();
  const h = Math.max(1, Math.round(height * 0.25));
  const top = band === 'bottom' ? height - h : 0;
  const { channels } = await sharp(buffer).extract({ left: 0, top, width, height: h }).stats();
  const [r, g, b] = channels.map(c => c.mean);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function buildOverlayHtml({ dataUrl, width, height, headline, sub, band, treatment, colour, fontCss }) {
  const pad = Math.round(width * 0.06);
  const caption = treatment === 'caption';
  const ink = caption ? '#000000' : colour;
  const pos = band === 'bottom' ? 'bottom:0' : 'top:0';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${fontCss}
html,body{margin:0;padding:0;width:${width}px;height:${height}px;overflow:hidden}
.frame{position:relative;width:${width}px;height:${height}px;background:url('${dataUrl}') center/cover no-repeat}
.band{position:absolute;left:0;right:0;${pos};height:${Math.round(height * 0.25)}px;box-sizing:border-box;padding:${pad}px;
  display:flex;flex-direction:column;justify-content:center;${caption ? `background:${SAND};` : ''}}
.h{font-family:'Outfit';font-weight:600;color:${ink};line-height:1.02;letter-spacing:-0.01em;white-space:normal;margin:0}
.s{font-family:'Cabin';font-weight:400;color:${ink};margin:${Math.round(pad * 0.35)}px 0 0;font-size:${Math.round(width * 0.034)}px;line-height:1.2}
</style></head><body><div class="frame"><div class="band" id="band"><p class="h" id="h">${esc(headline)}</p>${sub ? `<p class="s" id="s">${esc(sub)}</p>` : ''}</div></div>
<script>
window.__runFit = () => {
  const band = document.getElementById('band'); const h = document.getElementById('h');
  let px = ${Math.round(width * 0.11)}; const min = ${Math.round(width * 0.045)};
  const over = () => band.scrollHeight > band.clientHeight || h.scrollWidth > h.clientWidth;
  h.style.fontSize = px + 'px';
  while (px > min && over()) { px -= 2; h.style.fontSize = px + 'px'; }
  window.__fit = { px, overflow: over() };
  return window.__fit;
};
window.__runFit();
</script></body></html>`;
}

export async function typesetTake({ buffer, headline, sub = '', band = 'top', treatment = 'band', browser = null }) {
  const mediaType = sniffImageMediaType(buffer);
  const { width, height } = await sharp(buffer).metadata();
  const colour = pickTextColour(await bandLuminance(buffer, band));
  const html = buildOverlayHtml({
    dataUrl: `data:${mediaType};base64,${buffer.toString('base64')}`,
    width, height, headline, sub, band, treatment, colour, fontCss: fontFaceCss(),
  });
  const puppeteer = require('puppeteer');
  const own = !browser;
  const b = browser || await puppeteer.launch({ args: ['--no-sandbox', '--font-render-hinting=none'] });
  try {
    const page = await b.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    // Fit again now that the brand faces have loaded: metrics measured on a fallback face are wrong.
    const fit = await page.evaluate(() => window.__runFit());
    const out = await page.screenshot({ type: 'jpeg', quality: 92, clip: { x: 0, y: 0, width, height } });
    await page.close();
    return { buffer: Buffer.from(out), mediaType: 'image/jpeg', colour: treatment === 'caption' ? '#000000' : colour, treatment, overflow: !!fit?.overflow, headlinePx: fit?.px ?? 0 };
  } finally {
    if (own) await b.close();
  }
}
