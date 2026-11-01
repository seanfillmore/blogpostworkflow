import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire('/Users/seanfillmore/Code/Claude/package.json');
const puppeteer = require('puppeteer');
const BASE = 'https://www.realskincare.com', DRAFT = 148782940330;
const OUT = '/private/tmp/claude-501/-Users-seanfillmore-Code-Claude/363304d7-fc64-470b-8f25-d8d7cc74b167/scratchpad/qa-shots';
mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
const HIDE = '#preview-bar-iframe,#PBarNextFrameWrapper,iframe[id*="preview-bar"]{display:none!important}';
const results = {};
for (const [label, preview] of [['live', false], ['draft', true]]) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => (results[label + ':errors'] ??= []).push(String(e.message).slice(0, 160)));
  if (preview) await page.goto(`${BASE}/?preview_theme_id=${DRAFT}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const r = (results[label] = {});
  // Screenshots, mobile + desktop, top of page.
  for (const [vp, w, h] of [['m', 390, 844], ['d', 1440, 900]]) {
    await page.setViewport({ width: w, height: h, isMobile: vp === 'm', deviceScaleFactor: 1 });
    for (const [name, path] of [['home', '/'], ['lotion', '/products/coconut-lotion'], ['h2t', '/products/head-to-toe'], ['giveaway', '/pages/free-soap-giveaway']]) {
      await page.goto(BASE + path, { waitUntil: 'networkidle2', timeout: 90000 });
      await page.addStyleTag({ content: HIDE }); await wait(1500);
      r[`${name}-${vp}-theme`] = await page.evaluate(() => window.Shopify?.theme?.id);
      await page.screenshot({ path: `${OUT}/${label}-${name}-${vp}.png` });
      await wait(800);
    }
  }
  // Add to cart on the lotion PDP (desktop).
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(BASE + '/products/coconut-lotion', { waitUntil: 'networkidle2', timeout: 90000 });
  await page.evaluate(() => fetch('/cart/clear.js', { method: 'POST' }));
  const clicked = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button[name="add"], button[type="submit"][name="add"], .product-form__submit')].find((b) => b.offsetParent !== null && !b.disabled);
    if (!btn) return false; btn.scrollIntoView({ block: 'center' }); btn.click(); return true;
  });
  await wait(4000);
  r.atcClicked = clicked;
  r.cartCount = await page.evaluate(async () => (await (await fetch('/cart.js')).json()).item_count);
  r.drawerOpen = await page.evaluate(() => {
    const el = document.querySelector('mini-cart, cart-drawer, #MiniCart, .mini-cart');
    return el ? { tag: el.tagName, open: el.hasAttribute('open') || el.classList.contains('active') || el.classList.contains('is-open') || getComputedStyle(el).visibility === 'visible' } : null;
  });
  await page.addStyleTag({ content: HIDE });
  await page.screenshot({ path: `${OUT}/${label}-atc-d.png` });
  await page.evaluate(() => fetch('/cart/clear.js', { method: 'POST' }));
  // Variant switch must not jump the page (the product-info.js fix).
  await page.goto(BASE + '/products/99-coconut-reset-digital', { waitUntil: 'networkidle2', timeout: 90000 });
  await page.evaluate(() => window.scrollTo(0, 700)); await wait(1200);
  const before = await page.evaluate(() => window.scrollY);
  const switched = await page.evaluate(() => {
    const inputs = [...document.querySelectorAll('variant-radios input[type="radio"], variant-selects input[type="radio"], .product-form__input input[type="radio"]')];
    const target = inputs.find((i) => !i.checked);
    if (!target) return null;
    const lab = document.querySelector(`label[for="${target.id}"]`); (lab || target).click(); return target.value;
  });
  await wait(3500);
  r.variantSwitchedTo = switched; r.scrollBefore = before; r.scrollAfter = await page.evaluate(() => window.scrollY);
  await ctx.close();
}
await browser.close();
console.log(JSON.stringify(results, null, 2));
