// agents/ad-concepts/typeset.js
//
// Overlay type set in CODE, in the real brand faces, so the copy on the ad is exactly the
// copy that passed the gates. Image models approximate type: Ad Studio's comp pass printed
// "50ml" on a 60ml bottle on 2026-10-03, and a hand mockup that day overflowed the frame,
// which is why every fitted box is measured in the browser after the fonts load.
import { createRequire } from 'node:module';
import { fontFaceCss } from '../../lib/brand-fonts.js';

const require = createRequire(import.meta.url);

// ---- generalized layout renderer ------------------------------------------------------
// data-fit contract: every element carrying data-fit is shrunk (1px at a time, down to its
// data-min, default 12) until its content fits its box; window.__fit.overflow is true when any
// still does not. Layouts size such elements explicitly and give descendants em font sizes.
const FIT_SCRIPT = `<script>
window.__fitAll = () => {
  let overflow = false;
  document.querySelectorAll('[data-fit]').forEach((el) => {
    const min = Number(el.dataset.min) || 12;
    // Restart from the declared size every pass: shrink-only would lock in a fallback-font result.
    if (!el.dataset.fitStart) el.dataset.fitStart = String(parseFloat(getComputedStyle(el).fontSize));
    let px = Number(el.dataset.fitStart);
    el.style.fontSize = px + 'px';
    const over = () => el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1;
    while (px > min && over()) { px -= 1; el.style.fontSize = px + 'px'; }
    if (over()) overflow = true;
  });
  window.__fit = { overflow };
  return window.__fit;
};
window.__fitAll();
</script>`;

export function wrapLayoutHtml({ html, width, height, fontCss = fontFaceCss() }) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${fontCss}
html,body{margin:0;padding:0;width:${width}px;height:${height}px;overflow:hidden}</style></head><body>${html}${FIT_SCRIPT}</body></html>`;
}

export async function renderLayoutHtml({ html, width, height, browser = null }) {
  const puppeteer = require('puppeteer');
  const own = !browser;
  const b = browser || await puppeteer.launch({ args: ['--no-sandbox', '--font-render-hinting=none'] });
  let page;
  try {
    page = await b.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.setContent(wrapLayoutHtml({ html, width, height }), { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    // Fit after the brand faces load: metrics taken on a fallback face are wrong.
    const fit = await page.evaluate(() => window.__fitAll());
    const out = await page.screenshot({ type: 'jpeg', quality: 92, clip: { x: 0, y: 0, width, height } });
    return { buffer: Buffer.from(out), overflow: !!fit?.overflow };
  } finally {
    try { await page?.close(); } catch { /* page already gone */ }
    if (own) await b.close();
  }
}
