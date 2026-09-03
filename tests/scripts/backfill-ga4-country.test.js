// The retention guard is the whole point of this script, and it is invisible in the
// API response: past GA4's retention window a country report returns HTTP 200 with zero
// rows, which is byte-identical to a genuine no-traffic day. Writing `sessionsByCountry: []`
// there would permanently record "nobody visited" for a day that had traffic — and unlike
// an absent field, that is a lie a future reader cannot detect.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { needsBackfill, decideBackfill } from '../../scripts/backfill-ga4-country.mjs';

const rows = (n) => ({ sessionsByCountry: Array.from({ length: n }, (_, i) => ({
  country: `C${i}`, sessions: 10, conversions: 0, revenue: 0 })) });

test('a snapshot without sessionsByCountry needs backfill; one with it does not', () => {
  assert.equal(needsBackfill({ date: '2026-05-01', sessions: 40 }), true);
  assert.equal(needsBackfill({ sessions: 40, sessionsByCountry: [] }), false);
});

test('RETENTION MISS: traffic in the snapshot but no country rows is skipped, never written', () => {
  const d = decideBackfill({ sessions: 412 }, rows(0));
  assert.equal(d.action, 'skip');
  assert.match(d.reason, /retention miss/);
  assert.match(d.reason, /412/, 'the reason must name the session count so it can be checked');
});

test('a GENUINE zero-traffic day is written, not mistaken for a retention miss', () => {
  // 0 sessions and 0 country rows agree with each other — nothing is being lost.
  assert.equal(decideBackfill({ sessions: 0 }, rows(0)).action, 'write');
});

test('a normal day writes', () => {
  assert.equal(decideBackfill({ sessions: 300 }, rows(12)).action, 'write');
});

test('a snapshot that already has country data is never re-fetched or rewritten', () => {
  // Idempotence: GA4 numbers move after the fact, so a second run must not overwrite.
  const d = decideBackfill({ sessions: 300, sessionsByCountry: [] }, rows(9));
  assert.equal(d.action, 'skip');
  assert.match(d.reason, /already/);
});

test('a missing sessions field is treated as 0, not NaN', () => {
  // NaN > 0 is false, so this would coincidentally "work" — pin it so it stays deliberate.
  assert.equal(decideBackfill({}, rows(0)).action, 'write');
});
