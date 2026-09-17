import { createRequire } from 'node:module';
const require = createRequire('/Users/seanfillmore/Code/Claude/package.json');
const puppeteer = require('puppeteer');
const BASE = 'https://www.realskincare.com';
const OUT = '/private/tmp/claude-501/-Users-seanfillmore-Code-Claude/363304d7-fc64-470b-8f25-d8d7cc74b167/scratchpad/qa-shots';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
const ctx = await browser.createBrowserContext();
const page = await ctx.newPage();
const hits = { clarity: 0, rumAsset: 0, clickIdAsset: 0 };
page.on('request', (req) => { const u = req.url(); if (/clarity\.ms/.test(u)) hits.clarity++; if (/rsc-rum/.test(u)) hits.rumAsset++; if (/rsc-click-id/.test(u)) hits.clickIdAsset++; });
const errors = []; page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 140)));
await page.setViewport({ width: 390, height: 844, isMobile: true });
await page.goto(`${BASE}/products/head-to-toe?cb=${Date.now()}`, { waitUntil: 'networkidle2', timeout: 90000 });
await wait(7000);
const r = {
  themeId: await page.evaluate(() => window.Shopify?.theme?.id),
  bannerVisible: await page.evaluate(() => { const d = document.querySelector('.shopify-pc__banner__dialog, #shopify-pc__banner'); return d ? !!(d.offsetWidth || d.offsetHeight) : false; }),
  tokensInBody: await page.evaluate(() => (document.body.innerText.match(/\[\[(TOTAL|PRICE|SAVINGS|CTA)\]\]/g) || []).length),
};
await page.screenshot({ path: `${OUT}/published-h2t-m.png` });
await page.setViewport({ width: 1440, height: 900 });
await page.goto(`${BASE}/products/coconut-lotion?cb=${Date.now()}`, { waitUntil: 'networkidle2', timeout: 90000 });
await page.evaluate(() => fetch('/cart/clear.js', { method: 'POST' }));
r.atcClicked = await page.evaluate(() => { const b = [...document.querySelectorAll('button[name="add"], .product-form__submit')].find((x) => x.offsetParent !== null && !x.disabled); if (!b) return false; b.scrollIntoView({ block: 'center' }); b.click(); return true; });
await wait(4000);
r.cartCount = await page.evaluate(async () => (await (await fetch('/cart.js')).json()).item_count);
r.drawerOpen = await page.evaluate(() => { const el = document.querySelector('cart-drawer, mini-cart'); return el ? (el.hasAttribute('open') || el.classList.contains('active') || getComputedStyle(el).visibility === 'visible') : null; });
await page.screenshot({ path: `${OUT}/published-atc-d.png` });
await page.evaluate(() => fetch('/cart/clear.js', { method: 'POST' }));
await page.goto(`${BASE}/pages/free-soap-giveaway?cb=${Date.now()}`, { waitUntil: 'networkidle2', timeout: 90000 });
await wait(2000);
r.giveawayForm = await page.evaluate(() => ({ h1: document.querySelector('h1')?.innerText, emailInputs: document.querySelectorAll('input[type="email"]').length, forms: document.querySelectorAll('form').length }));
await page.goto(`${BASE}/blogs/news?cb=${Date.now()}`, { waitUntil: 'networkidle2', timeout: 90000 });
r.blogFilter = await page.evaluate(() => !!document.querySelector('.blog-filter'));
r.hits = hits; r.errors = [...new Set(errors)];
await browser.close();
console.log(JSON.stringify(r, null, 2));
