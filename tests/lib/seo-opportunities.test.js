import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  expectedCtr,
  classifyAction,
  classifyPageType,
  recommendedAgentFor,
  clusterByPage,
  analyzeOpportunities,
  partitionLiveOpportunities,
} from '../../lib/seo-opportunities.js';

// ── expectedCtr ─────────────────────────────────────────────────────────────
test('expectedCtr decreases with worse position and is bounded', () => {
  assert.ok(expectedCtr(1) > expectedCtr(5));
  assert.ok(expectedCtr(5) > expectedCtr(10));
  assert.ok(expectedCtr(10) > expectedCtr(18));
  assert.ok(expectedCtr(1) <= 1 && expectedCtr(50) >= 0);
});

// ── classifyAction ──────────────────────────────────────────────────────────
test('classifyAction: page-1 with poor CTR → meta_rewrite', () => {
  assert.equal(classifyAction({ position: 8, ctr: 0.005 }), 'meta_rewrite');
});
test('classifyAction: page-1 with healthy CTR → monitor', () => {
  assert.equal(classifyAction({ position: 6, ctr: 0.06 }), 'monitor');
});
test('classifyAction: page 2 → rank_push', () => {
  assert.equal(classifyAction({ position: 14, ctr: 0.004 }), 'rank_push');
});
test('classifyAction: deep (21-50) → refresh', () => {
  assert.equal(classifyAction({ position: 35, ctr: 0.001 }), 'refresh');
});

// ── classifyPageType ────────────────────────────────────────────────────────
test('classifyPageType identifies collection / product / content', () => {
  assert.equal(classifyPageType('https://www.realskincare.com/collections/sls-free-toothpaste'), 'collection');
  assert.equal(classifyPageType('https://www.realskincare.com/products/coconut-oil-toothpaste'), 'product');
  assert.equal(classifyPageType('https://www.realskincare.com/blogs/news/best-natural-toothpaste'), 'content');
  assert.equal(classifyPageType('https://www.realskincare.com/'), 'content');
});

// ── recommendedAgentFor ─────────────────────────────────────────────────────
test('recommendedAgentFor routes by page type and action', () => {
  // collection: deep refresh rewrites on-page content; page-2 push adds internal links
  assert.equal(recommendedAgentFor({ pageType: 'collection', action: 'refresh' }), 'collection-content-optimizer');
  assert.equal(recommendedAgentFor({ pageType: 'collection', action: 'rank_push' }), 'collection-linker');
  // products: link blog content into the product page
  assert.equal(recommendedAgentFor({ pageType: 'product', action: 'rank_push' }), 'collection-linker');
  assert.equal(recommendedAgentFor({ pageType: 'product', action: 'refresh' }), 'collection-linker');
  // content (blog/info): always a content refresh — collection-linker can't push a blog post
  assert.equal(recommendedAgentFor({ pageType: 'content', action: 'rank_push' }), 'refresh-runner');
  assert.equal(recommendedAgentFor({ pageType: 'content', action: 'refresh' }), 'refresh-runner');
});

// ── clusterByPage ───────────────────────────────────────────────────────────
test('clusterByPage aggregates queries hitting the same page', () => {
  const rows = [
    { keyword: 'toothpaste without sls', page: '/p/sls', impressions: 2000, clicks: 8, ctr: 0.004, position: 19, volume: 9900 },
    { keyword: 'non sls toothpaste', page: '/p/sls', impressions: 1385, clicks: 12, ctr: 0.009, position: 9.7, volume: 720 },
    { keyword: 'coconut oil deodorant', page: '/p/deo', impressions: 753, clicks: 5, ctr: 0.007, position: 10.2, volume: 6600 },
  ];
  const clusters = clusterByPage(rows);
  const sls = clusters.find((c) => c.page === '/p/sls');
  assert.equal(sls.keywords.length, 2);
  assert.equal(sls.clusterVolume, 9900 + 720);
  assert.equal(sls.impressions, 2000 + 1385);
  // representative position = best (lowest) among the cluster
  assert.equal(sls.position, 9.7);
  // top keyword = highest volume in the cluster
  assert.equal(sls.topKeyword, 'toothpaste without sls');
});

// ── analyzeOpportunities ────────────────────────────────────────────────────
test('analyzeOpportunities ranks by monthly-click potential and boosts product matches', () => {
  const rows = [
    // big SLS cluster on page 2 → rank_push, high volume
    { keyword: 'toothpaste without sls', page: '/blogs/news/sls', impressions: 2000, clicks: 8, ctr: 0.004, position: 19, volume: 9900 },
    { keyword: 'non sls toothpaste', page: '/blogs/news/sls', impressions: 1385, clicks: 12, ctr: 0.009, position: 9.7, volume: 720 },
    // tiny low-value cluster
    { keyword: 'best coconut body butter', page: '/blogs/news/butter', impressions: 259, clicks: 1, ctr: 0.004, position: 14, volume: 40 },
    // commercial: maps to a product we sell
    { keyword: 'coconut oil toothpaste', page: '/products/coconut-oil-toothpaste', impressions: 3000, clicks: 6, ctr: 0.002, position: 9.7, volume: 2400 },
  ];
  const opps = analyzeOpportunities(rows, { productHandles: ['coconut-oil-toothpaste'] });
  // every opportunity carries an action + score + commercial flag
  for (const o of opps) {
    assert.ok(['meta_rewrite', 'rank_push', 'refresh', 'monitor'].includes(o.action));
    assert.equal(typeof o.score, 'number');
  }
  // the tiny 40-vol cluster ranks below the big ones
  const butter = opps.find((o) => o.page.includes('butter'));
  assert.equal(opps[opps.length - 1].page, butter.page);
  // the product page is flagged commercial
  const prod = opps.find((o) => o.page.includes('coconut-oil-toothpaste'));
  assert.equal(prod.commercial, true);
});

test('analyzeOpportunities: product match boosts score above an equivalent non-commercial cluster', () => {
  const base = { impressions: 1000, clicks: 2, ctr: 0.002, position: 9, volume: 1000 };
  const rows = [
    { ...base, keyword: 'a', page: '/products/sellable' },
    { ...base, keyword: 'b', page: '/blogs/news/info' },
  ];
  const opps = analyzeOpportunities(rows, { productHandles: ['sellable'] });
  const prod = opps.find((o) => o.page.includes('sellable'));
  const info = opps.find((o) => o.page.includes('info'));
  assert.ok(prod.score > info.score);
});

test('analyzeOpportunities: collections are commercial WITHOUT needing a product-handle match', () => {
  // collection handles are NOT in the product handle list (which is products-only),
  // yet collections drive the majority of SEO revenue — they must still score as commercial.
  const rows = [
    { keyword: 'sls free toothpaste', page: '/collections/sls-free-toothpaste', impressions: 1000, clicks: 2, ctr: 0.002, position: 14, volume: 1000 },
  ];
  const opps = analyzeOpportunities(rows, { productHandles: ['coconut-oil-toothpaste'] });
  const coll = opps.find((o) => o.page.includes('collections'));
  assert.equal(coll.commercial, true);
  assert.equal(coll.page_type, 'collection');
});

test('analyzeOpportunities: collection outscores an equivalent product (collections drive ~80% of SEO revenue)', () => {
  const base = { impressions: 1000, clicks: 2, ctr: 0.002, position: 14, volume: 1000 };
  const rows = [
    { ...base, keyword: 'a', page: '/collections/sellable-things' },
    { ...base, keyword: 'b', page: '/products/sellable' },
    { ...base, keyword: 'c', page: '/blogs/news/info' },
  ];
  const opps = analyzeOpportunities(rows, { productHandles: ['sellable'] });
  const coll = opps.find((o) => o.page_type === 'collection');
  const prod = opps.find((o) => o.page_type === 'product');
  const info = opps.find((o) => o.page_type === 'content');
  assert.ok(coll.score >= prod.score, 'collection should score >= product');
  assert.ok(prod.score > info.score, 'product should score > non-commercial content');
});

// ── partitionLiveOpportunities ───────────────────────────────────────────────

test('partitionLiveOpportunities: 2xx targets are live', () => {
  const opps = [{ page: '/a' }, { page: '/b' }];
  const { live, dead } = partitionLiveOpportunities(opps, { '/a': 200, '/b': 200 });
  assert.equal(live.length, 2);
  assert.equal(dead.length, 0);
});

test('partitionLiveOpportunities: 3xx (redirect) and 4xx targets are dead', () => {
  const opps = [{ page: '/redir' }, { page: '/gone' }, { page: '/ok' }];
  const { live, dead } = partitionLiveOpportunities(opps, { '/redir': 301, '/gone': 404, '/ok': 200 });
  assert.deepEqual(live.map((o) => o.page), ['/ok']);
  assert.deepEqual(dead.map((o) => o.page), ['/redir', '/gone']);
});

test('partitionLiveOpportunities: status 0 (unreachable) is dead', () => {
  const { live, dead } = partitionLiveOpportunities([{ page: '/x' }], { '/x': 0 });
  assert.equal(live.length, 0);
  assert.equal(dead.length, 1);
});

test('partitionLiveOpportunities: unknown/missing status is kept live (never drop on a failed check)', () => {
  const { live, dead } = partitionLiveOpportunities([{ page: '/unchecked' }], {});
  assert.deepEqual(live.map((o) => o.page), ['/unchecked']);
  assert.equal(dead.length, 0);
});

test('partitionLiveOpportunities: empty/nullish input is safe', () => {
  assert.deepEqual(partitionLiveOpportunities(null, {}), { live: [], dead: [] });
  assert.deepEqual(partitionLiveOpportunities([], {}), { live: [], dead: [] });
});
