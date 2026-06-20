import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settledWeekWindow } from '../../../lib/amazon/report-window.js';

const DAY_MS = 86400000;
const dow = (iso) => new Date(`${iso}T00:00:00Z`).getUTCDay();

test('Sunday cron requests a fully-settled prior week (not yesterday\'s)', () => {
  // 2026-06-21 is a Sunday — the old code requested Jun 14–20 (just ended).
  const w = settledWeekWindow(new Date('2026-06-21T15:00:00Z'), 7);
  assert.equal(w.dataStartTime, '2026-06-07');
  assert.equal(w.dataEndTime, '2026-06-13');
});

test('end is always a Saturday and start its Sunday', () => {
  for (const d of ['2026-06-21', '2026-06-20', '2026-06-17', '2026-07-01', '2026-12-31']) {
    const w = settledWeekWindow(new Date(`${d}T12:00:00Z`), 7);
    assert.equal(dow(w.dataEndTime), 6, `${d}: end should be Saturday`);
    assert.equal(dow(w.dataStartTime), 0, `${d}: start should be Sunday`);
    // exactly a 6-day span (Sun..Sat inclusive)
    const span = (Date.parse(w.dataEndTime) - Date.parse(w.dataStartTime)) / DAY_MS;
    assert.equal(span, 6, `${d}: span should be 6 days`);
  }
});

test('the requested week ended at least lagDays before now', () => {
  for (const d of ['2026-06-21', '2026-06-22', '2026-06-25', '2026-07-04']) {
    const now = new Date(`${d}T00:00:00Z`);
    const w = settledWeekWindow(now, 7);
    const lag = (Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - Date.parse(w.dataEndTime)) / DAY_MS;
    assert.ok(lag >= 7, `${d}: lag ${lag} should be >= 7`);
  }
});

test('larger lag shifts the window further back', () => {
  const w7 = settledWeekWindow(new Date('2026-06-21T00:00:00Z'), 7);
  const w14 = settledWeekWindow(new Date('2026-06-21T00:00:00Z'), 14);
  assert.ok(Date.parse(w14.dataEndTime) < Date.parse(w7.dataEndTime));
});
