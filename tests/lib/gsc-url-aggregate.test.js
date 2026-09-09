// The store's HERO PRODUCT was invisible to agents/product-optimizer because
// GSC splits a Shopify product across variant/utm URLs and the agent kept
// whichever row arrived first. Measured on production 2026-09-09 — every
// fixture below is a real row from that pull.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  canonicalPageKey, aggregateByPage, buildPageMetricsMap,
} from '../../lib/gsc-url-aggregate.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const B = 'https://www.realskincare.com';

// The real rows. The clean URL is last and smallest — first-wins kept it.
const HERO_ROWS = [
  { url: `${B}/products/coconut-lotion?variant=45828179165354&utm_content=sag_organic`, impressions: 201, clicks: 3, position: 1 },
  { url: `${B}/products/coconut-lotion?variant=45828179198122&utm_content=sag_organic`, impressions: 84, clicks: 1, position: 1 },
  { url: `${B}/products/coconut-lotion?variant=45828179198122&utm_content=sag_organic&com_cvv=8fb3`, impressions: 82, clicks: 0, position: 1 },
  { url: `${B}/products/coconut-lotion?variant=44414530781354&utm_content=sag_organic`, impressions: 40, clicks: 0, position: 1 },
  { url: `${B}/products/coconut-lotion`, impressions: 1, clicks: 0, position: 26 },
];

test('canonicalPageKey drops the query string and trailing slash', () => {
  const k = `${B}/products/coconut-lotion`;
  assert.equal(canonicalPageKey(`${B}/products/coconut-lotion?variant=1&utm_source=google`), k);
  assert.equal(canonicalPageKey(`${B}/products/coconut-lotion/`), k);
  assert.equal(canonicalPageKey(`${B}/products/coconut-lotion#reviews`), k);
  assert.equal(canonicalPageKey(''), '');
});

test('a relative path is keyed, not dropped', () => {
  assert.equal(canonicalPageKey('/products/x?variant=9'), '/products/x');
});

test('THE HERO PRODUCT: five rows become one page with its real impressions', () => {
  const m = aggregateByPage(HERO_ROWS);
  assert.equal(m.size, 1);
  const e = m.get(`${B}/products/coconut-lotion`);
  assert.equal(e.impressions, 408, '201+84+82+40+1 — not the 1 first-wins kept');
  assert.equal(e.clicks, 4);
  assert.equal(e.rows, 5);
});

test('position is impression-WEIGHTED, not a flat average', () => {
  // Flat would be (1+1+1+1+26)/5 = 6.0 — which reads as a quick-win candidate
  // this page is not. Weighted, the 1-impression row at position 26 barely
  // moves it.
  const e = aggregateByPage(HERO_ROWS).get(`${B}/products/coconut-lotion`);
  assert.ok(e.position > 1 && e.position < 1.1, `expected ~1.06, got ${e.position}`);
  assert.equal(e.ctr, 4 / 408, 'CTR is recomputed from the sums, never averaged');
});

test('a collection-scoped product path is NOT folded into the bare product', () => {
  // Shopify serves both and they can rank separately; folding them would
  // overstate a product by every collection path it hangs from.
  const m = aggregateByPage([
    { url: `${B}/products/y`, impressions: 10, position: 5 },
    { url: `${B}/collections/x/products/y`, impressions: 4, position: 12 },
  ]);
  assert.equal(m.size, 2);
});

test('the keyword comes from the biggest row, not the first', () => {
  const m = aggregateByPage([
    { url: `${B}/products/z?variant=1`, impressions: 5, position: 30, keyword: 'tiny tail' },
    { url: `${B}/products/z?variant=2`, impressions: 900, position: 4, keyword: 'the real query' },
  ]);
  assert.equal(m.get(`${B}/products/z`).keyword, 'the real query');
});

test('an all-zero-impression page does not report position 0', () => {
  // position 0 sorts first for any consumer ordering ascending — it would read
  // as "ranking top" when nothing is known.
  const e = aggregateByPage([{ url: `${B}/products/q`, impressions: 0, position: 42 }]).get(`${B}/products/q`);
  assert.equal(e.position, 42);
});

test('empty and malformed input do not throw', () => {
  for (const input of [[], null, undefined, [{}], [{ url: null }]]) {
    assert.doesNotThrow(() => aggregateByPage(input));
  }
});

test('buildPageMetricsMap keeps quick-win rows over top-page rows', () => {
  const m = buildPageMetricsMap(
    [{ url: `${B}/products/a`, impressions: 10, position: 7, keyword: 'quick win kw' }],
    [{ page: `${B}/products/a`, impressions: 999, position: 2 }],
  );
  assert.equal(m.get(`${B}/products/a`).keyword, 'quick win kw');
  assert.equal(m.get(`${B}/products/a`).impressions, 10, 'quick-win row wins outright, as before');
});

test('buildPageMetricsMap reads topPages from `page`, not `url`', () => {
  const m = buildPageMetricsMap([], [{ page: `${B}/products/b?variant=1`, impressions: 50, position: 3 }]);
  assert.equal(m.get(`${B}/products/b`).impressions, 50);
});

test('product-optimizer has ONE builder and no raw URL lookups', () => {
  // Four byte-identical first-wins builders lived here, so the defect applied
  // to the default path, --optimize-titles, --from-gsc and --pages-from-gsc.
  const src = readFileSync(join(ROOT, 'agents/product-optimizer/index.js'), 'utf8');
  const builders = src.match(/buildPageMetricsMap\(gscPages, topPages\)/g) || [];
  assert.equal(builders.length, 4, 'all four call sites use the shared builder');
  assert.doesNotMatch(src, /if \(!gscMap\.has\(p\.url\)\) gscMap\.set/,
    'the first-wins builder must not come back');
  assert.doesNotMatch(src, /gscMap\.get\((?:p|page)\.url\)/,
    'every lookup must go through canonicalPageKey');
});
