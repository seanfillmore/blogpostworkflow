import { test } from 'node:test';
import assert from 'node:assert/strict';
import { datesToCollect, pacificDateDaysAgo, LAG_DAYS, LOOKBACK_DAYS } from '../../lib/gsc-backfill.js';

// 2026-10-05 13:15 UTC = 06:15 PDT, when the collector cron fires.
const NOW = Date.parse('2026-10-05T13:15:00Z');

function windowDates() {
  const out = [];
  for (let n = LAG_DAYS; n <= LOOKBACK_DAYS; n++) out.push(pacificDateDaysAgo(n, NOW));
  return out;
}

test('lag date is 3 days ago in Pacific time', () => {
  assert.equal(pacificDateDaysAgo(3, NOW), '2026-10-02');
});

test('healthy day: only the lag date is fetched', () => {
  const existing = windowDates().slice(1); // everything but the lag date
  assert.deepEqual(datesToCollect({ existing, now: NOW }), ['2026-10-02']);
});

test('the 2026-10 incident: two skipped dates are retried', () => {
  const existing = windowDates().filter(d => d !== '2026-09-30' && d !== '2026-10-01' && d !== '2026-10-02');
  assert.deepEqual(datesToCollect({ existing, now: NOW }), ['2026-10-02', '2026-10-01', '2026-09-30']);
});

test('lag date is fetched even when its snapshot already exists', () => {
  assert.deepEqual(datesToCollect({ existing: windowDates(), now: NOW }), ['2026-10-02']);
});

test('dates older than the lookback window are not retried', () => {
  const dates = datesToCollect({ existing: [], now: NOW });
  assert.equal(dates.length, LOOKBACK_DAYS - LAG_DAYS + 1);
  assert.equal(dates.at(-1), pacificDateDaysAgo(LOOKBACK_DAYS, NOW));
});
