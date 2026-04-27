import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sortProductCandidates } from '../../agents/product-optimizer/lib/sort.js';

test('sortProductCandidates orders amazon → cluster → no-signal', () => {
  const rows = [
    { handle: 'no-signal',  gsc: { impressions: 1000 }, idx: { validationTag: null, cluster: null, amazonPurchases: 0 } },
    { handle: 'cluster',    gsc: { impressions: 200 },  idx: { validationTag: 'gsc_ga4', cluster: 'soap', amazonPurchases: 0 } },
    { handle: 'amz-low',    gsc: { impressions: 50 },   idx: { validationTag: 'amazon', cluster: 'deodorant', amazonPurchases: 5 } },
    { handle: 'amz-high',   gsc: { impressions: 30 },   idx: { validationTag: 'amazon', cluster: 'deodorant', amazonPurchases: 50 } },
  ];
  const sorted = sortProductCandidates(rows);
  assert.deepEqual(sorted.map((r) => r.handle), ['amz-high', 'amz-low', 'cluster', 'no-signal']);
});

test('sortProductCandidates within amazon band sorts by amazonPurchases desc', () => {
  const rows = [
    { handle: 'a', gsc: { impressions: 1000 }, idx: { validationTag: 'amazon', amazonPurchases: 10 } },
    { handle: 'b', gsc: { impressions: 100 },  idx: { validationTag: 'amazon', amazonPurchases: 30 } },
    { handle: 'c', gsc: { impressions: 500 },  idx: { validationTag: 'amazon', amazonPurchases: 20 } },
  ];
  const sorted = sortProductCandidates(rows);
  assert.deepEqual(sorted.map((r) => r.handle), ['b', 'c', 'a']);
});

test('sortProductCandidates within non-amazon band sorts by impressions desc', () => {
  const rows = [
    { handle: 'a', gsc: { impressions: 100 }, idx: { validationTag: null, cluster: 'soap' } },
    { handle: 'b', gsc: { impressions: 500 }, idx: { validationTag: null, cluster: 'soap' } },
    { handle: 'c', gsc: { impressions: 300 }, idx: { validationTag: null, cluster: null } },
  ];
  const sorted = sortProductCandidates(rows);
  assert.deepEqual(sorted.map((r) => r.handle), ['b', 'a', 'c']);
});

test('sortProductCandidates handles missing idx field', () => {
  const rows = [
    { handle: 'a', gsc: { impressions: 100 } },
    { handle: 'b', gsc: { impressions: 500 }, idx: { validationTag: 'amazon', amazonPurchases: 10 } },
  ];
  const sorted = sortProductCandidates(rows);
  assert.deepEqual(sorted.map((r) => r.handle), ['b', 'a']);
});
