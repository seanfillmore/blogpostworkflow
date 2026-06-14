import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  expectedCtr,
  classifyAction,
  clusterByPage,
  analyzeOpportunities,
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
