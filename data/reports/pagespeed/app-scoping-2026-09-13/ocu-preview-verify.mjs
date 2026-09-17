import { createRequire } from 'node:module';
const require = createRequire('/Users/seanfillmore/Code/Claude/package.json');
const puppeteer = require('puppeteer');
const BASE = 'https://www.realskincare.com', PREVIEW = 148801880234;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function safeClear(page) { for (let i = 0; i < 3; i++) { const ok = await page.evaluate(async () => { try { const r = await fetch('/cart/clear.js', { method: 'POST' }); return r.ok; } catch { return false; } }); if (ok) return true; await wait(2000); } return false; }
const OCU = /zipify|oneclickupsell|ocu-in-checkout|ocu\.zipify/i;
const HIDE = '#preview-bar-iframe,#PBarNextFrameWrapper{display:none!important}';
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
const out = {};
for (const [label, preview] of [['live', false], ['preview', true]]) {
  const ctx = await browser.createBrowserContext(); const page = await ctx.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  let ocuReqs = []; const blocked = [];
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = req.url();
    if (/\/checkouts?\b|\/checkout(\?|$)/.test(new URL(u).pathname + (new URL(u).search ? '?' : '')) && req.isNavigationRequest()) { blocked.push(u.slice(0, 90)); return req.abort(); }
    if (OCU.test(u)) ocuReqs.push(u);
    req.continue();
  });
  if (preview) await page.goto(`${BASE}/?preview_theme_id=${PREVIEW}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const r = (out[label] = { templates: {} });
  for (const [name, path] of [['index', '/'], ['collection', '/collections/coconut-oil-lotion'], ['page', '/pages/faqs'], ['page-giveaway', '/pages/free-soap-giveaway'], ['blog', '/blogs/news'], ['product', '/products/coconut-lotion'], ['cart', '/cart'], ['article', '/blogs/news/best-soap-for-tattoos-what-to-use-for-safe-healing-3']]) {
    ocuReqs = [];
    await page.goto(`${BASE}${path}${path.includes('?') ? '&' : '?'}cb=${Date.now()}`, { waitUntil: 'networkidle2', timeout: 90000 }); await wait(5000);
    r.templates[name] = { theme: await page.evaluate(() => window.Shopify?.theme?.id), ocuRequests: ocuReqs.length, hasZipifyGlobal: await page.evaluate(() => typeof window.Zipify !== 'undefined' && !!window.Zipify?.OCU) };
  }
  // Pre-purchase flow: add on the PDP, then check out from the cart drawer on the PDP and on the homepage.
  await safeClear(page);
  for (const [where, path] of [['product', '/products/coconut-lotion'], ['index', '/']]) {
    await page.goto(`${BASE}/products/coconut-lotion?cb=${Date.now()}`, { waitUntil: 'networkidle2', timeout: 90000 }); await wait(3000);
    await safeClear(page);
    await page.evaluate(() => fetch('/cart/add.js', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [{ id: Number(document.querySelector('form[action*="/cart/add"] [name="id"]').value), quantity: 1 }] }) }));
    if (where !== 'product') { await page.goto(`${BASE}${path}?cb=${Date.now()}`, { waitUntil: 'networkidle2', timeout: 90000 }); await wait(4000); }
    else { await page.reload({ waitUntil: 'networkidle2' }); await wait(4000); }
    await page.addStyleTag({ content: HIDE });
    const opened = await page.evaluate(() => { const b = document.querySelector('a[href="/cart"], [aria-controls*="CartDrawer"], .header__icon--cart, [data-cart-toggle], button[name="cart"]'); if (!b) return false; b.click(); return true; });
    await wait(3000);
    const before = blocked.length;
    const clicked = await page.evaluate(() => { const b = [...document.querySelectorAll('cart-drawer button[name="checkout"], mini-cart button[name="checkout"], button[name="checkout"], a[href*="/checkout"]')].find((x) => x.offsetParent !== null); if (!b) return false; b.click(); return true; });
    await wait(6000);
    const popup = await page.evaluate(() => { const els = [...document.querySelectorAll('[class*="zipify"], [id*="zipify"], [class*="ocu-"], [id*="ocu-"], [class*="upsell-popup"]')].filter((e) => e.offsetWidth || e.offsetHeight); return els.slice(0, 3).map((e) => (e.id || e.className).toString().slice(0, 60)); });
    await page.screenshot({ path: `/private/tmp/claude-501/-Users-seanfillmore-Code-Claude/363304d7-fc64-470b-8f25-d8d7cc74b167/scratchpad/qa-shots/ocu-${label}-${where}-checkout.png` });
    r[`checkoutFrom_${where}`] = { drawerOpened: opened, checkoutClicked: clicked, visibleOcuPopupEls: popup, navigatedToCheckout: blocked.length > before };
  }
  await safeClear(page);
  await ctx.close();
}
await browser.close();
console.log(JSON.stringify(out, null, 2));
