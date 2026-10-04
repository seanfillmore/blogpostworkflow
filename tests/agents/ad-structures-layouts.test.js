import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { LAYOUT_REGISTRY, getLayout } from '../../agents/ad-concepts/layouts/index.js';
import { LAYOUTS } from '../../agents/ad-concepts/structures.js';
import { renderLayoutHtml } from '../../agents/ad-concepts/typeset.js';

const require = createRequire(import.meta.url);
const sharp = require('sharp');
const plate = async (w, h) => `data:image/jpeg;base64,${(await sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 190, b: 180 } } }).jpeg().toBuffer()).toString('base64')}`;
const LONG = 'This is THE moisturizer for Wisconsin winters for my whole family and it is long lasting and never greasy, we use it all over and love it every single day of the year. '.repeat(3);

const CASES = {
  'comment-card': { ratio: '1:1', slots: { headline: 'The winter moisturizer.', emphasis: 'winter', quote: 'Soft & <b>never</b> greasy "really"', band: 'FREE SHIPPING ON ORDERS OVER $45' } },
  'headline-over-photo': { ratio: '1:1', slots: { headline: 'Soft.\nNever greasy.' } },
  'split-two-panel': { ratio: '4:5', slots: { left: 'Coconut lotion they think we sell', right: 'Coconut lotion we actually sell', band: 'Only 6 clean ingredients. Made in the USA.' } },
  'checklist-split': { ratio: '4:5', slots: { title: 'Ours vs Typical drugstore lotion', oursRows: ['Six ingredients', 'Made in the USA'], theirsLabel: 'Typical drugstore lotion', theirs: ['Long ingredient list', 'Synthetic fragrance'], band: 'Free shipping over $45' } },
  'photo-only': { ratio: '4:5', slots: { band: 'Clean &amp; simple' } },
  'labelled-bundle': { ratio: '1:1', slots: { labels: [{ text: 'Lotion', x: .25, y: .2, tx: .4, ty: .6 }, { text: 'Soap', x: .75, y: .25, tx: .6, ty: .6 }], band: 'Bundle & save' } },
};

test('registry covers exactly the library layouts', () => {
  assert.deepEqual(Object.keys(LAYOUT_REGISTRY).sort(), [...LAYOUTS].sort());
  for (const k of LAYOUTS) { assert.equal(getLayout(k).key, k); assert.ok([1, 2].includes(getLayout(k).plates)); }
  assert.throws(() => getLayout('nope'));
});

test('regions() boxes lie within the frame for every layout and ratio', () => {
  for (const [k, l] of Object.entries(LAYOUT_REGISTRY)) for (const ratio of ['1:1', '4:5']) {
    const { width, height } = l.size(ratio);
    for (const r of l.regions(ratio)) {
      assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= width && r.y + r.h <= height, `${k} ${r.name}`);
    }
  }
});

test('each layout renders escaped slot text at its pixel size without overflow', { timeout: 120000 }, async () => {
  for (const [k, c] of Object.entries(CASES)) {
    const l = getLayout(k);
    const { width, height } = l.size(c.ratio);
    const p = await plate(width, height);
    const html = l.render({ plates: l.plates === 2 ? [p, p] : [p], slots: c.slots, ratio: c.ratio });
    assert.ok(!html.includes('<b>never'), `${k} escapes markup`);
    const r = await renderLayoutHtml({ html, width, height });
    const m = await sharp(r.buffer).metadata();
    assert.equal(m.width, width, k); assert.equal(m.height, height, k);
    assert.equal(r.overflow, false, k);
  }
});

test('slot strings and band text appear (escaped) in the markup', () => {
  const c = CASES['comment-card'];
  const html = getLayout('comment-card').render({ plates: ['data:image/jpeg;base64,AA'], slots: c.slots, ratio: '1:1' });
  assert.match(html, /Soft &amp; &lt;b&gt;never&lt;\/b&gt; greasy &quot;really&quot;/);
  assert.match(html, /Customer review/);
  assert.match(html, /FREE SHIPPING ON ORDERS OVER \$45/);
  assert.match(html, /border-bottom:7px solid #c0392b">winter</);
  assert.match(html, /#C9CDD2/);
  const s = CASES['split-two-panel'];
  const sh = getLayout('split-two-panel').render({ plates: ['x', 'y'], slots: s.slots, ratio: '4:5' });
  assert.match(sh, /#EDE5D8/); assert.match(sh, /Only 6 clean ingredients\./);
});

test('a very long quote and headline shrink to fit instead of overflowing', { timeout: 60000 }, async () => {
  const l = getLayout('comment-card');
  const p = await plate(1080, 1080);
  const html = l.render({ plates: [p], slots: { headline: 'A really quite long headline about winter moisturizer that never ends', emphasis: 'winter', quote: LONG, band: 'FREE SHIPPING ON ORDERS OVER $45 AND A VERY LONG EXTRA CLAUSE HERE' }, ratio: '1:1' });
  const r = await renderLayoutHtml({ html, width: 1080, height: 1080 });
  assert.equal(r.overflow, false);
});

test('overflow is reported when text cannot shrink enough', { timeout: 60000 }, async () => {
  const html = '<div data-fit data-min="40" style="width:100px;height:40px;overflow:hidden;font-size:60px;font-family:Outfit">Something far too long for this tiny box</div>';
  const r = await renderLayoutHtml({ html, width: 400, height: 200 });
  assert.equal(r.overflow, true);
});

test('labelled-bundle needs 2-4 labels', () => {
  assert.throws(() => getLayout('labelled-bundle').render({ plates: ['x'], slots: { labels: [{ text: 'a' }] }, ratio: '1:1' }));
});

test('renderLayoutHtml closes the page and leaves a supplied browser open', async () => {
  const calls = { page: 0, browser: 0 };
  const page = { setViewport: async () => {}, setContent: async () => {}, evaluate: async () => ({ overflow: false }), screenshot: async () => { throw new Error('boom'); }, close: async () => { calls.page++; } };
  const browser = { newPage: async () => page, close: async () => { calls.browser++; } };
  await assert.rejects(renderLayoutHtml({ html: '<div/>', width: 10, height: 10, browser }), /boom/);
  assert.deepEqual(calls, { page: 1, browser: 0 });
});

// ---- fix round 1 ----
import { wrapLayoutHtml } from '../../agents/ad-concepts/typeset.js';
const puppeteer = require('puppeteer');

test('data-fit refits from the declared size on every pass (a later pass can grow back)', { timeout: 60000 }, async () => {
  const b = await puppeteer.launch({ args: ['--no-sandbox'] });
  try {
    const page = await b.newPage();
    await page.setContent(wrapLayoutHtml({ html: '<div id="e" data-fit data-min="10" style="width:150px;height:80px;overflow:hidden;white-space:nowrap;font-family:Outfit;font-size:40px">Hello there world</div>', width: 400, height: 200, fontCss: '' }));
    const first = await page.evaluate(() => parseFloat(document.getElementById('e').style.fontSize));
    assert.ok(first < 40, 'shrank while narrow');
    await page.evaluate(() => { document.getElementById('e').style.width = '600px'; });
    const second = await page.evaluate(() => { window.__fitAll(); return parseFloat(document.getElementById('e').style.fontSize); });
    assert.equal(second, 40);
  } finally { await b.close(); }
});

const LONGWORDS = 'Organic virgin coconut oil and shea butter blended with essential oils for everyday softness';
const FULL = {
  'comment-card': CASES['comment-card'].slots,
  'headline-over-photo': { headline: 'Soft.\nNever greasy.', band: 'Free shipping over $45' },
  'split-two-panel': CASES['split-two-panel'].slots,
  'checklist-split': CASES['checklist-split'].slots,
  'photo-only': { band: 'Free shipping over $45' },
  'labelled-bundle': CASES['labelled-bundle'].slots,
};

test('regions() cover every drawn region and rendered boxes lie inside them (checklist columns exactly)', { timeout: 120000 }, async () => {
  const b = await puppeteer.launch({ args: ['--no-sandbox'] });
  try {
    for (const [k, slots] of Object.entries(FULL)) {
      const l = getLayout(k); const ratio = CASES[k].ratio; const { width, height } = l.size(ratio);
      const p = await plate(width, height);
      const html = l.render({ plates: l.plates === 2 ? [p, p] : [p], slots, ratio });
      const regions = l.regions(ratio, slots);
      const page = await b.newPage();
      await page.setViewport({ width, height });
      await page.setContent(wrapLayoutHtml({ html, width, height }));
      await page.evaluate(() => document.fonts.ready);
      const rects = await page.evaluate(() => [...document.querySelectorAll('[data-region]')].map(e => { const r = e.getBoundingClientRect(); return { name: e.dataset.region, x: r.x, y: r.y, w: r.width, h: r.height }; }));
      await page.close();
      assert.ok(rects.length, `${k} marks regions`);
      for (const r of rects) {
        const reg = regions.find(x => x.name === r.name);
        assert.ok(reg, `${k}: drawn ${r.name} has a region`);
        assert.ok(r.x >= reg.x - 1 && r.y >= reg.y - 1 && r.x + r.w <= reg.x + reg.w + 1 && r.y + r.h <= reg.y + reg.h + 1, `${k} ${r.name} inside region`);
        if (k === 'checklist-split' && r.name.endsWith('column')) assert.deepEqual([r.x, r.y, r.w, r.h], [reg.x, reg.y, reg.w, reg.h]);
      }
    }
  } finally { await b.close(); }
});

test('headline-over-photo and photo-only regions include the band only when drawn', () => {
  for (const k of ['headline-over-photo', 'photo-only']) {
    const l = getLayout(k);
    assert.ok(l.regions('1:1', { band: 'x' }).some(r => r.name === 'band'), k);
    assert.ok(!l.regions('1:1', {}).some(r => r.name === 'band'), k);
  }
});

test('labelled-bundle rejects coordinates outside 0-1', () => {
  const l = getLayout('labelled-bundle');
  for (const bad of [{ x: 1.5 }, { y: -0.1 }, { tx: 2 }, { ty: 'a' }]) {
    assert.throws(() => l.render({ plates: ['x'], slots: { labels: [{ text: 'a', ...bad }, { text: 'b' }] }, ratio: '1:1' }), /0-1 fraction/);
  }
});

test('long text shrinks to fit on the other layouts too', { timeout: 120000 }, async () => {
  const long = {
    'headline-over-photo': { headline: LONGWORDS + ' ' + LONGWORDS, band: LONGWORDS },
    'split-two-panel': { left: LONGWORDS, right: LONGWORDS, band: LONGWORDS },
    'checklist-split': { title: LONGWORDS, oursRows: Array(3).fill(LONGWORDS), theirsLabel: LONGWORDS, theirs: Array(3).fill(LONGWORDS), band: LONGWORDS },
    'labelled-bundle': { labels: [{ text: 'Organic coconut moisturizing body cream jar' }, { text: 'Organic coconut moisturizing body lotion bottle', x: .75, y: .3 }], band: LONGWORDS },
  };
  for (const [k, slots] of Object.entries(long)) {
    const l = getLayout(k); const ratio = CASES[k].ratio; const { width, height } = l.size(ratio);
    const p = await plate(width, height);
    const r = await renderLayoutHtml({ html: l.render({ plates: l.plates === 2 ? [p, p] : [p], slots, ratio }), width, height });
    assert.equal(r.overflow, false, k);
  }
});
