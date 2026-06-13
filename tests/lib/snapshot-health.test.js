import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkFreshness, problems, newestSnapshotDate, DEFAULT_MAX_AGE_DAYS } from '../../lib/snapshot-health.js';

const TODAY = '2026-06-13';

test('checkFreshness: a snapshot from today is ok', () => {
  const [r] = checkFreshness([{ name: 'gsc', newestDate: '2026-06-13' }], { today: TODAY });
  assert.equal(r.status, 'ok');
  assert.equal(r.ageDays, 0);
});

test('checkFreshness: yesterday is still ok under the default threshold', () => {
  // daily-summary may run before some same-day collectors, so 1 day old is fine
  const [r] = checkFreshness([{ name: 'gsc', newestDate: '2026-06-12' }], { today: TODAY });
  assert.equal(r.ageDays, 1);
  assert.equal(r.status, 'ok');
});

test('checkFreshness: a multi-day-old snapshot is stale', () => {
  const [r] = checkFreshness([{ name: 'rank-snapshots', newestDate: '2026-06-08' }], { today: TODAY });
  assert.equal(r.ageDays, 5);
  assert.equal(r.status, 'stale');
});

test('checkFreshness: a missing snapshot (no files) is reported as missing', () => {
  const [r] = checkFreshness([{ name: 'ga4', newestDate: null }], { today: TODAY });
  assert.equal(r.status, 'missing');
  assert.equal(r.ageDays, null);
});

test('checkFreshness: per-entry maxAgeDays overrides the default', () => {
  // a weekly source 5 days old is fine when its threshold is 8
  const [r] = checkFreshness([{ name: 'weekly-thing', newestDate: '2026-06-08', maxAgeDays: 8 }], { today: TODAY });
  assert.equal(r.status, 'ok');
});

test('checkFreshness: exactly at the threshold is ok, one day past is stale', () => {
  const at = checkFreshness([{ name: 'x', newestDate: '2026-06-11', maxAgeDays: 2 }], { today: TODAY })[0];
  const past = checkFreshness([{ name: 'x', newestDate: '2026-06-10', maxAgeDays: 2 }], { today: TODAY })[0];
  assert.equal(at.ageDays, 2);
  assert.equal(at.status, 'ok');
  assert.equal(past.ageDays, 3);
  assert.equal(past.status, 'stale');
});

test('checkFreshness: a future date (clock skew) is treated as ok, not stale', () => {
  const [r] = checkFreshness([{ name: 'x', newestDate: '2026-06-15' }], { today: TODAY });
  assert.equal(r.status, 'ok');
});

test('checkFreshness: uses the default threshold when none is given', () => {
  assert.equal(DEFAULT_MAX_AGE_DAYS, 2);
  const [r] = checkFreshness([{ name: 'x', newestDate: '2026-06-10' }], { today: TODAY });
  assert.equal(r.status, 'stale'); // 3 days > default 2
});

test('newestSnapshotDate: returns the latest date across plain and device-suffixed files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'snaps-'));
  writeFileSync(join(dir, '2026-06-10-desktop.json'), '{}');
  writeFileSync(join(dir, '2026-06-12-desktop.json'), '{}');
  writeFileSync(join(dir, '2026-06-12-mobile.json'), '{}');
  writeFileSync(join(dir, 'not-a-snapshot.json'), '{}');
  assert.equal(newestSnapshotDate(dir), '2026-06-12');
});

test('newestSnapshotDate: returns null for an empty or missing directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'snaps-empty-'));
  assert.equal(newestSnapshotDate(dir), null);
  assert.equal(newestSnapshotDate(join(dir, 'does-not-exist')), null);
});

test('problems: returns only stale and missing entries', () => {
  const results = checkFreshness([
    { name: 'ok-one', newestDate: '2026-06-13' },
    { name: 'stale-one', newestDate: '2026-06-01' },
    { name: 'missing-one', newestDate: null },
  ], { today: TODAY });
  const p = problems(results);
  assert.deepEqual(p.map(r => r.name).sort(), ['missing-one', 'stale-one']);
});
