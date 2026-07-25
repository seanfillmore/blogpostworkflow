import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  toPackageCostMap, weightedAverage, estimateShipping, contribution,
  FALLBACK_PACKAGE_COSTS,
} from '../../lib/shipping-costs.js';

// ShopifyQL returns numerics as strings — the real shape from the live API.
const ROWS = [
  { package_name: 'Bubble Envelope', shipping_label_costs: '639.72', average_shipping_label_cost: '6.663', shipping_labels: '96' },
  { package_name: '10x5x5', shipping_label_costs: '336.75', average_shipping_label_cost: '7.831', shipping_labels: '43' },
  { package_name: '14x10x4', shipping_label_costs: '85.25', average_shipping_label_cost: '21.312', shipping_labels: '4' },
];

test('toPackageCostMap coerces string numerics and rounds to cents', () => {
  const m = toPackageCostMap(ROWS);
  assert.equal(m['Bubble Envelope'], 6.66);
  assert.equal(m['10x5x5'], 7.83);
  assert.equal(m['14x10x4'], 21.31);
});

test('toPackageCostMap skips rows with missing or non-numeric data', () => {
  const m = toPackageCostMap([
    { package_name: 'Good', average_shipping_label_cost: '5.00' },
    { package_name: null, average_shipping_label_cost: '9.99' },
    { package_name: 'Bad', average_shipping_label_cost: 'n/a' },
    { package_name: 'Missing' },
  ]);
  assert.deepEqual(Object.keys(m), ['Good']);
});

test('weightedAverage weights by label count, not row count', () => {
  // Naive row mean would be (6.663+7.831+21.312)/3 = 11.94 — badly wrong,
  // because the $21 box is only 4 of 143 labels.
  assert.equal(weightedAverage(ROWS), 7.42);
});

test('weightedAverage returns null when there are no labels', () => {
  assert.equal(weightedAverage([]), null);
  assert.equal(weightedAverage([{ shipping_label_costs: '10', shipping_labels: '0' }]), null);
});

test('estimateShipping sends a refill basket to the expensive box', () => {
  // This is the rule that makes refill bundles show up as losses.
  const s = estimateShipping({ units: 2, pounds: 3.42, hasOversizeItem: true });
  assert.equal(s, 21.31);
});

test('estimateShipping picks envelope for small light baskets', () => {
  assert.equal(estimateShipping({ units: 2, pounds: 0.94 }), 6.66);
});

test('estimateShipping picks the 10x5x5 for mid baskets', () => {
  assert.equal(estimateShipping({ units: 4, pounds: 2.19 }), 7.83);
});

test('estimateShipping escalates for large baskets', () => {
  assert.equal(estimateShipping({ units: 12, pounds: 3.84 }), FALLBACK_PACKAGE_COSTS['8x8x4']);
});

test('estimateShipping prefers measured costs over the fallback table', () => {
  const measured = { 'Bubble Envelope': 5.10 };
  assert.equal(estimateShipping({ units: 1, pounds: 0.6 }, measured), 5.10);
  // falls back per-key when the measured map lacks that package
  assert.equal(estimateShipping({ units: 4, pounds: 2 }, measured), 7.83);
});

test('contribution subtracts COGS, freight and payment fees', () => {
  // 90-Day Reset: $99, COGS $19.94, 10x5x5 freight
  const c = contribution({ price: 99, cogs: 19.94, shipping: 7.83 });
  assert.equal(c, 68.06);
});

test('contribution goes negative when freight exceeds the margin', () => {
  // Foam Soap Bundle as priced: $20.02 of revenue against a $21.31 box
  const c = contribution({ price: 20.02, cogs: 17.31, shipping: 21.31 });
  assert.ok(c < 0, `expected a loss, got ${c}`);
  assert.equal(c, -19.48);
});
