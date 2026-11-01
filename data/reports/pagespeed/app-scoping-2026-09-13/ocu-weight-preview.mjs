import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
const require = createRequire('/Users/seanfillmore/Code/Claude/package.json');
const puppeteer = require('puppeteer');
const BASE = 'https://www.realskincare.com', PREVIEW = 148801880234;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const OCU = /zipify|oneclickupsell|ocu-in-checkout|ocu\.zipify/i;
const cache = new Map();
const kbOf = (u) => { if (cache.has(u)) return cache.get(u); let kb = 0; try { kb = Math.round(Number(execFileSync('curl', ['-s', '-o', '/dev/null', '-w', '%{size_download}', '-H', 'Accept-Encoding: br, gzip', '-A', 'Mozilla/5.0', u], { timeout: 30000 }).toString()) / 1024); } catch {} cache.set(u, kb); return kb; };
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
for (const [label, preview] of [['live', false], ['preview', true]]) {
  const ctx = await browser.createBrowserContext(); const page = await ctx.newPage();
  await page.setViewport({ width: 390, height: 844, isMobile: true });
  let urls = new Map();
  page.on('requestfinished', (req) => { const u = req.url(); if (OCU.test(u)) urls.set(u, req.resourceType()); });
  if (preview) await page.goto(`${BASE}/?preview_theme_id=${PREVIEW}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  for (const [name, path] of [['index', '/'], ['collection', '/collections/coconut-oil-lotion'], ['page', '/pages/faqs'], ['product', '/products/coconut-lotion']]) {
    urls = new Map();
    await page.goto(`${BASE}${path}?cb=${Date.now()}`, { waitUntil: 'networkidle2', timeout: 90000 }); await wait(6000);
    const themeId = await page.evaluate(() => window.Shopify?.theme?.id);
    let js = 0, css = 0; const files = [];
    for (const [u, t] of urls) { if (t !== 'script' && t !== 'stylesheet') continue; const kb = kbOf(u); if (t === 'script') js += kb; else css += kb; files.push(u.replace(/\?.*/, '').split('/').pop()); }
    console.log(`${label.padEnd(8)} ${name.padEnd(10)} theme ${themeId}  OCU js ${String(js).padStart(3)} kb css ${String(css).padStart(2)} kb  [${files.join(', ')}]`);
    await wait(1200);
  }
  await ctx.close();
}
await browser.close();
