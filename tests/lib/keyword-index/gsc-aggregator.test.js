import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregateGscWindow } from '../../../lib/keyword-index/gsc-aggregator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '..', '..', 'fixtures', 'keyword-index', 'gsc');

test('aggregateGscWindow sums impressions and clicks across the date range', () => {
  const result = aggregateGscWindow({
    snapshotsDir: FIXTURES,
    fromDate: '2026-04-01',
    toDate: '2026-04-03',
  });
  assert.ok(result['coconut lotion']);
  // 80 + 20 + 90 + 100 = 290 impressions across the 3 days
  // (note: case-variant "Coconut Lotion" in 04-01 collapses to same key via normalize)
  assert.equal(result['coconut lotion'].impressions, 80 + 20 + 90 + 100);
  // 4 + 1 + 5 + 7 = 17 clicks
  assert.equal(result['coconut lotion'].clicks, 4 + 1 + 5 + 7);
});

test('aggregateGscWindow computes mean position across the window', () => {
  const result = aggregateGscWindow({
    snapshotsDir: FIXTURES,
    fromDate: '2026-04-01',
    toDate: '2026-04-03',
  });
  // positions: 7.5, 8.0, 7.0, 6.5 → mean 7.25
  assert.equal(result['coconut lotion'].position.toFixed(2), '7.25');
});

test('aggregateGscWindow picks the page with most clicks as top_page', () => {
  const result = aggregateGscWindow({
    snapshotsDir: FIXTURES,
    fromDate: '2026-04-01',
    toDate: '2026-04-03',
  });
  assert.equal(result['coconut lotion'].top_page, 'https://www.realskincare.com/products/coconut-lotion');
});

test('aggregateGscWindow recomputes CTR from the totals (not averaged)', () => {
  const result = aggregateGscWindow({
    snapshotsDir: FIXTURES,
    fromDate: '2026-04-01',
    toDate: '2026-04-03',
  });
  // 17 clicks / 290 impressions
  const expected = 17 / 290;
  assert.equal(result['coconut lotion'].ctr.toFixed(4), expected.toFixed(4));
});

test('aggregateGscWindow returns empty object when no snapshots in range', () => {
  const result = aggregateGscWindow({
    snapshotsDir: FIXTURES,
    fromDate: '2027-01-01',
    toDate: '2027-01-31',
  });
  assert.deepEqual(result, {});
});

test('aggregateGscWindow normalizes keys via normalize()', () => {
  const result = aggregateGscWindow({
    snapshotsDir: FIXTURES,
    fromDate: '2026-04-01',
    toDate: '2026-04-01',
  });
  // "coconut lotion" and "Coconut Lotion" should collapse to same key
  assert.equal(Object.keys(result).filter((k) => k === 'coconut lotion').length, 1);
});
