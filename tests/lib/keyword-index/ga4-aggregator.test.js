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

test('aggregateGa4Window reads from topLandingPages with `revenue` (real ga4-collector shape)', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const tmp = mkdtempSync(join(tmpdir(), 'ga4-real-'));
  try {
    const snapDir = join(tmp, 'ga4');
    mkdirSync(snapDir, { recursive: true });
    writeFileSync(join(snapDir, '2026-04-15.json'), JSON.stringify({
      date: '2026-04-15',
      sessions: 200, conversions: 5, revenue: 250,
      topLandingPages: [
        { page: '/products/coconut-lotion', sessions: 50, conversions: 3, revenue: 120.00 },
        { page: '/blogs/news/x',             sessions: 30, conversions: 1, revenue: 40.00 },
      ],
    }));
    const result = aggregateGa4Window({ snapshotsDir: snapDir, fromDate: '2026-04-15', toDate: '2026-04-15' });
    assert.equal(result['/products/coconut-lotion'].sessions, 50);
    assert.equal(result['/products/coconut-lotion'].conversions, 3);
    assert.equal(result['/products/coconut-lotion'].page_revenue, 120.00);
    assert.equal(result['/blogs/news/x'].page_revenue, 40.00);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
