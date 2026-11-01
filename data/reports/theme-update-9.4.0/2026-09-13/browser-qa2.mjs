import { createRequire } from 'node:module';
const require = createRequire('/Users/seanfillmore/Code/Claude/package.json');
const puppeteer = require('puppeteer');
const BASE = 'https://www.realskincare.com', DRAFT = 148782940330;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
const out = {};
for (const [label, preview] of [['live', false], ['draft', true]]) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  if (preview) await page.goto(`${BASE}/?preview_theme_id=${DRAFT}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const r = (out[label] = {});
  for (const path of ['/products/coconut-lotion', '/products/coconut-soap', '/products/organic-foaming-hand-soap']) {
    await page.goto(`${BASE}${path}?cb=${Date.now()}`, { waitUntil: 'networkidle2', timeout: 90000 });
    await wait(5000);
    const banner = await page.evaluate(() => {
      const el = document.querySelector('#shopify-pc__banner, .shopify-pc__banner__dialog, [id*="shopify-pc"]');
      return el ? { id: el.id, visible: !!(el.offsetWidth || el.offsetHeight) } : null;
    });
    await page.evaluate(() => window.scrollTo(0, 700)); await wait(1200);
    const before = await page.evaluate(() => window.scrollY);
    const change = await page.evaluate(() => {
      const sel = [...document.querySelectorAll('variant-selects select, variant-radios select, select[name^="options"]')].find((s) => s.options.length > 1);
      if (sel) { const cur = sel.selectedIndex; sel.selectedIndex = cur === 0 ? 1 : 0; sel.dispatchEvent(new Event('change', { bubbles: true })); return { kind: 'select', to: sel.value }; }
      const radio = [...document.querySelectorAll('variant-selects input[type="radio"], variant-radios input[type="radio"]')].find((i) => !i.checked && !i.disabled);
      if (radio) { (document.querySelector(`label[for="${radio.id}"]`) || radio).click(); return { kind: 'radio', to: radio.value }; }
      return null;
    });
    await wait(4000);
    const after = await page.evaluate(() => ({ y: window.scrollY, variant: new URL(location.href).searchParams.get('variant') }));
    r[path] = { banner, change, scrollBefore: before, scrollAfter: after.y, variantParam: after.variant };
  }
  await ctx.close();
}
await browser.close();
console.log(JSON.stringify(out, null, 2));
