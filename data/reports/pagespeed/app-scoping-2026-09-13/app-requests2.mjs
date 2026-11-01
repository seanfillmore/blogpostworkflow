import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const require = createRequire('/Users/seanfillmore/Code/Claude/package.json');
const puppeteer = require('puppeteer');
const BASE = 'https://www.realskincare.com';
const OUT = '/private/tmp/claude-501/-Users-seanfillmore-Code-Claude/363304d7-fc64-470b-8f25-d8d7cc74b167/scratchpad/app-weight-9.4.0.json';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const APP = [['ocu', /zipify|oneclickupsell|ocu-in-checkout|ocu\.zipify/i], ['judge.me', /judge\.me|judgeme/i], ['recurpay', /recurpay/i], ['paypal', /paypal/i], ['klaviyo', /klaviyo/i], ['zigpoll', /zigpoll/i], ['shop-js', /shop-js|shopifycloud\/shop|checkouts\/internal\/preloads/i], ['theme', /\/cdn\/shop\/t\//i]];
const cache = new Map();
const kbOf = (u) => { if (cache.has(u)) return cache.get(u); let kb = 0; try { kb = Math.round(Number(execFileSync('curl', ['-s', '-o', '/dev/null', '-w', '%{size_download}', '-H', 'Accept-Encoding: br, gzip', '-A', 'Mozilla/5.0', u], { timeout: 30000 }).toString()) / 1024); } catch {} cache.set(u, kb); return kb; };
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
const out = {};
for (const [label, path] of [['home', '/'], ['collection', '/collections/coconut-oil-lotion'], ['pdp-lotion', '/products/coconut-lotion'], ['article', '/blogs/news/best-soap-for-tattoos-what-to-use-for-safe-healing-3'], ['page-faqs', '/pages/faqs']]) {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, isMobile: true });
  const urls = new Map();
  page.on('requestfinished', (req) => { const t = req.resourceType(); if (t === 'script' || t === 'stylesheet') urls.set(req.url(), t); });
  await page.goto(`${BASE}${path}?cb=${Date.now()}`, { waitUntil: 'networkidle2', timeout: 90000 });
  await wait(8000);
  const r = (out[label] = { template: await page.evaluate(() => document.body.className.match(/template-[\w-]+/)?.[0]), apps: {} });
  r.addForms = await page.evaluate(() => [...document.querySelectorAll('form[action*="/cart/add"]')].map((f) => ({ section: (f.closest('[id^="shopify-section"]')?.id || '').replace(/template--\d+__/, ''), visible: !!(f.offsetWidth || f.offsetHeight) })));
  r.quickAdd = await page.evaluate(() => document.querySelectorAll('[class*="quick-add"], [data-quick-add], quick-add-modal, .card__quick-add').length);
  for (const [u, t] of urls) {
    const app = (APP.find(([, re]) => re.test(u)) || [null])[0]; if (!app) continue;
    const a = (r.apps[app] ??= { jsKb: 0, cssKb: 0, files: 0 }); const kb = kbOf(u);
    if (t === 'script') a.jsKb += kb; else a.cssKb += kb; a.files++;
  }
  await page.close(); await wait(1500);
}
await browser.close();
writeFileSync(OUT, JSON.stringify(out, null, 2));
for (const [label, r] of Object.entries(out)) {
  console.log(`\n## ${label} (${r.template}) add-to-cart forms: ${r.addForms.length} [${r.addForms.map((f) => f.section + (f.visible ? '' : ' hidden')).join(', ')}] quick-add els: ${r.quickAdd}`);
  for (const [app, a] of Object.entries(r.apps).sort((x, y) => (y[1].jsKb + y[1].cssKb) - (x[1].jsKb + x[1].cssKb))) console.log(`  ${app.padEnd(10)} js ${String(a.jsKb).padStart(4)} kb  css ${String(a.cssKb).padStart(3)} kb  (${a.files} files)`);
}
