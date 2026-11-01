import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require = createRequire('/Users/seanfillmore/Code/Claude/package.json');
const puppeteer = require('puppeteer');
const BASE = 'https://www.realskincare.com';
const THEMES = { current: 148782940330, zoomOff: 148801880234 };
const PAGES = [['article', '/blogs/news/toothpaste-without-sls-what-to-know-best-options'], ['product', '/products/coconut-lotion'], ['collection', '/collections/coconut-oil-lotion'], ['home', '/']];
const RUNS = 5;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
const ctxs = {};
for (const [k, id] of Object.entries(THEMES)) {
  const ctx = await browser.createBrowserContext(); const p = await ctx.newPage();
  await p.goto(`${BASE}/?preview_theme_id=${id}`, { waitUntil: 'domcontentloaded', timeout: 60000 }); await p.close();
  ctxs[k] = ctx;
}
const rows = [];
for (const [label, path] of PAGES) for (let run = 0; run < RUNS; run++) for (const k of (run % 2 ? ['zoomOff', 'current'] : ['current', 'zoomOff'])) {
  const page = await ctxs[k].newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const cdp = await page.createCDPSession();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await cdp.send('Network.enable'); await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await page.evaluateOnNewDocument(() => {
    window.__lcp = null;
    new PerformanceObserver((l) => { const e = l.getEntries().at(-1); window.__lcp = { t: e.startTime, el: e.element ? (e.element.tagName + '.' + (e.element.className || '')).slice(0, 60) : null, load: e.loadTime }; }).observe({ type: 'largest-contentful-paint', buffered: true });
  });
  await page.goto(`${BASE}${path}?cb=${Date.now()}`, { waitUntil: 'load', timeout: 90000 });
  await wait(5000);
  const r = await page.evaluate(() => ({ lcp: window.__lcp, theme: window.Shopify?.theme?.id, ttfb: performance.getEntriesByType('navigation')[0]?.responseStart }));
  rows.push({ label, theme: k, run, themeId: r.theme, lcp: Math.round(r.lcp?.t ?? -1), imgLoaded: Math.round(r.lcp?.load ?? -1), el: r.lcp?.el, ttfb: Math.round(r.ttfb ?? -1) });
  await page.close(); await wait(800);
}
await browser.close();
writeFileSync('/Users/seanfillmore/Code/Claude/data/reports/pagespeed/app-scoping-2026-09-13/lcp-ab-zoom-effect.json', JSON.stringify(rows, null, 2));
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
for (const [label] of PAGES) {
  const line = Object.keys(THEMES).map((k) => { const r = rows.filter((x) => x.label === label && x.theme === k); return `${k}: LCP median ${med(r.map((x) => x.lcp))}ms (img loaded ${med(r.map((x) => x.imgLoaded))}ms, ttfb ${med(r.map((x) => x.ttfb))}) runs [${r.map((x) => x.lcp).join(',')}] theme ${[...new Set(r.map((x) => x.themeId))]} el ${[...new Set(r.map((x) => x.el))].join('|')}`; });
  console.log(`\n## ${label}\n  ${line.join('\n  ')}`);
}
