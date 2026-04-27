import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rollUpCompetitorsByCluster } from '../../../lib/keyword-index/competitors.js';

test('rollUpCompetitorsByCluster groups by cluster and computes weighted shares', () => {
  const entries = {
    'kw1': {
      cluster: 'deodorant',
      amazon: {
        purchases: 100,
        competitors: [
          { asin: 'B0NATIVE', brand: 'Native', click_share: 0.20, conversion_share: 0.25 },
          { asin: 'B0DOVE', brand: 'Dove', click_share: 0.10, conversion_share: 0.08 },
        ],
      },
    },
    'kw2': {
      cluster: 'deodorant',
      amazon: {
        purchases: 50,
        competitors: [
          { asin: 'B0NATIVE', brand: 'Native', click_share: 0.30, conversion_share: 0.35 },
        ],
      },
    },
  };
  const result = rollUpCompetitorsByCluster(entries);
  assert.ok(result.deodorant);
  assert.equal(result.deodorant.total_purchases, 150);
  assert.equal(result.deodorant.keyword_count, 2);
  // Native's weighted_click_share:
  //   numerator = 100*0.20 + 50*0.30 = 20 + 15 = 35
  //   denominator = 100 + 50 = 150
  //   weighted = 35/150 = 0.2333
  const native = result.deodorant.competitors.find((c) => c.asin === 'B0NATIVE');
  assert.equal(native.weighted_click_share.toFixed(4), '0.2333');
  assert.equal(native.appears_in_keywords, 2);
});

test('rollUpCompetitorsByCluster ignores entries without amazon data', () => {
  const entries = {
    'kw1': { cluster: 'soap', amazon: null },
  };
  const result = rollUpCompetitorsByCluster(entries);
  assert.deepEqual(result, {});
});

test('rollUpCompetitorsByCluster sorts competitors by weighted_click_share desc, top N=10', () => {
  const entries = {};
  // 12 competitors in one cluster — only top 10 should be kept
  for (let i = 0; i < 12; i++) {
    entries[`kw${i}`] = {
      cluster: 'cluster',
      amazon: {
        purchases: 100,
        competitors: [{ asin: `B0${i}`, brand: `B${i}`, click_share: i / 100, conversion_share: 0.1 }],
      },
    };
  }
  const result = rollUpCompetitorsByCluster(entries);
  assert.equal(result.cluster.competitors.length, 10);
  // Highest click share first
  assert.equal(result.cluster.competitors[0].asin, 'B011');
});
