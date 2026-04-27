import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregateGa4Window, ga4ForUrl } from '../../../lib/keyword-index/ga4-aggregator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '..', '..', 'fixtures', 'keyword-index', 'ga4');

test('aggregateGa4Window sums sessions/conversions/revenue per page across window', () => {
  const result = aggregateGa4Window({
    snapshotsDir: FIXTURES,
    fromDate: '2026-04-01',
    toDate: '2026-04-03',
  });
  assert.equal(result['/products/coconut-lotion'].sessions, 165);
  assert.equal(result['/products/coconut-lotion'].conversions, 7);
  assert.equal(result['/products/coconut-lotion'].page_revenue, 210.00);
});

test('ga4ForUrl handles full URLs by extracting pathname', () => {
  const ga4Map = {
    '/products/coconut-lotion': { sessions: 100, conversions: 5, page_revenue: 200 },
  };
  const result = ga4ForUrl(ga4Map, 'https://www.realskincare.com/products/coconut-lotion');
  assert.equal(result.sessions, 100);
});

test('ga4ForUrl returns null when path is not in the map', () => {
  const ga4Map = {};
  assert.equal(ga4ForUrl(ga4Map, '/products/missing'), null);
});

test('aggregateGa4Window returns empty when no snapshots in range', () => {
  const result = aggregateGa4Window({
    snapshotsDir: FIXTURES,
    fromDate: '2027-01-01',
    toDate: '2027-01-31',
  });
  assert.deepEqual(result, {});
});
