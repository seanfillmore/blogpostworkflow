import { createRequire } from 'node:module';
import { getProducts } from '/Users/seanfillmore/Code/Claude/lib/shopify.js';
const require = createRequire('/Users/seanfillmore/Code/Claude/package.json');
const puppeteer = require('puppeteer');
const BASE = 'https://www.realskincare.com', LIVE = 148439367850, DRAFT = 148782940330;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const gangCandidates = (await getProducts({ limit: 250 }))
  .filter((p) => p.status === 'active' && p.variants.length > 1 && (p.images || []).some((i) => /#/.test(i.alt || '')))
  .map((p) => ({ handle: p.handle, suffix: p.template_suffix, variants: p.variants.length }));
console.log('gang-scoped multi-variant products:', JSON.stringify(gangCandidates));
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
const out = {};
const banner = (page) => page.evaluate(() => {
  const d = document.querySelector('.shopify-pc__banner__dialog, #shopify-pc__banner');
  return d ? !!(d.offsetWidth || d.offsetHeight) : false;
});
// Control: is the consent banner a preview-mode artifact? Preview the LIVE theme through the same mechanism.
for (const [label, previewId] of [['live-plain', null], ['live-via-preview', LIVE], ['draft-via-preview', DRAFT]]) {
  const ctx = await browser.createBrowserContext(); const page = await ctx.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  if (previewId) await page.goto(`${BASE}/?preview_theme_id=${previewId}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.goto(`${BASE}/?cb=${Date.now()}`, { waitUntil: 'networkidle2', timeout: 90000 }); await wait(6000);
  const r = (out[label] = { themeId: await page.evaluate(() => window.Shopify?.theme?.id), bannerVisible: await banner(page) });
  // Gang-scoped variant switch scroll test (live-plain and draft only).
  if (label !== 'live-via-preview') {
    for (const { handle } of gangCandidates.slice(0, 2)) {
      await page.goto(`${BASE}/products/${handle}?cb=${Date.now()}`, { waitUntil: 'networkidle2', timeout: 90000 }); await wait(2500);
      await page.evaluate(() => window.scrollTo(0, 700)); await wait(1200);
      const before = await page.evaluate(() => window.scrollY);
      const clicked = await page.evaluate(() => {
        const li = [...document.querySelectorAll('li[data-gang-option]')].find((x) => !x.classList.contains('active') && !x.querySelector('input:checked'));
        const radio = [...document.querySelectorAll('variant-selects input[type="radio"], variant-radios input[type="radio"]')].find((i) => !i.checked && !i.disabled);
        const sel = [...document.querySelectorAll('variant-selects select, variant-radios select')].find((s) => s.options.length > 1);
        if (radio) { (document.querySelector(`label[for="${radio.id}"]`) || radio).click(); return 'radio:' + radio.value; }
        if (sel) { sel.selectedIndex = sel.selectedIndex === 0 ? 1 : 0; sel.dispatchEvent(new Event('change', { bubbles: true })); return 'select:' + sel.value; }
        if (li) { li.click(); return 'li'; }
        return null;
      });
      await wait(4500);
      r[handle] = { clicked, scrollBefore: before, scrollAfter: await page.evaluate(() => window.scrollY), variant: await page.evaluate(() => new URL(location.href).searchParams.get('variant')) };
    }
  }
  await ctx.close();
}
await browser.close();
console.log(JSON.stringify(out, null, 2));
