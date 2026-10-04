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
