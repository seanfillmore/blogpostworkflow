import { strict as assert } from 'node:assert';
import {
  buildVerdict,
  daysSince,
  findMeasurementId,
} from '../../scripts/verify-ga4-collect.mjs';

// ── findMeasurementId ────────────────────────────────────────────────────────
// The measurement ID is read from the property's own data streams, never
// hardcoded — that is what makes the check survive a stream being recreated.
assert.equal(
  findMeasurementId({
    dataStreams: [
      { displayName: 'ios', androidAppStreamData: {} },
      { displayName: 'web', webStreamData: { measurementId: 'G-ABC123' } },
    ],
  }),
  'G-ABC123',
);
assert.equal(findMeasurementId({ dataStreams: [] }), null);
assert.equal(findMeasurementId({}), null);

// ── daysSince ────────────────────────────────────────────────────────────────
assert.equal(daysSince('20260801', '2026-08-03'), 2);
assert.equal(daysSince('20260803', '2026-08-03'), 0);
assert.equal(daysSince(null, '2026-08-03'), Infinity);

// ── buildVerdict: the healthy case ───────────────────────────────────────────
const healthy = {
  property: { displayName: 'realskincare.com - GA4' },
  measurementId: 'G-PYV4WG2QL8',
  browser: { hitsSent: 2, events: ['page_view', 'view_item'] },
  realtime: { eventCount: 5 },
  lastSessionDate: '20260803',
  today: '2026-08-03',
};
let v = buildVerdict(healthy);
assert.equal(v.ok, true, 'healthy input should pass');
assert.equal(v.failures.length, 0);

// ── buildVerdict: property in the trash is THE check ─────────────────────────
// This is the failure that cost 8 days. A trashed property still answers the
// Admin API and still returns 204 from /g/collect, so nothing else catches it.
v = buildVerdict({
  ...healthy,
  property: {
    displayName: 'realskincare.com - GA4',
    deleteTime: '2026-07-26T14:01:46Z',
    expireTime: '2026-08-30T14:01:46Z',
  },
  browser: { hitsSent: 2, events: ['page_view'] },
  realtime: { eventCount: 0 },
  lastSessionDate: '20260726',
});
assert.equal(v.ok, false);
assert.match(v.failures[0], /trash/i);
assert.match(v.failures[0], /2026-08-30/, 'must surface the permanent-deletion deadline');
// The trash failure must be reported FIRST — it is the root cause, and the
// zero-realtime and staleness failures below it are downstream symptoms.
assert.equal(v.failures.length > 1, true, 'symptoms are still reported');
assert.match(v.failures[0], /trash/i, 'root cause ranks above its symptoms');

// ── buildVerdict: tag stopped sending ────────────────────────────────────────
v = buildVerdict({ ...healthy, browser: { hitsSent: 0, events: [] }, realtime: { eventCount: 0 } });
assert.equal(v.ok, false);
assert.match(v.failures.join(' '), /no hits/i);

// ── buildVerdict: tag sends but property records nothing ─────────────────────
// Hits sent + nothing recorded is the signature of a discarding property.
v = buildVerdict({ ...healthy, realtime: { eventCount: 0 } });
assert.equal(v.ok, false);
assert.match(v.failures.join(' '), /recorded 0/i);

// ── buildVerdict: stale data ─────────────────────────────────────────────────
v = buildVerdict({ ...healthy, lastSessionDate: '20260730' });
assert.equal(v.ok, false);
assert.match(v.failures.join(' '), /4 days/);

// A one-day gap is normal reporting latency, not a failure.
v = buildVerdict({ ...healthy, lastSessionDate: '20260802' });
assert.equal(v.ok, true, 'one day of latency must not alarm');

// ── buildVerdict: browser step skipped ───────────────────────────────────────
// With --no-browser the tag layer is unknown, so it must not be asserted either
// way; the property checks still run.
v = buildVerdict({ ...healthy, browser: null });
assert.equal(v.ok, true);
assert.match(v.warnings.join(' '), /browser check skipped/i);

v = buildVerdict({ ...healthy, browser: null, property: { deleteTime: '2026-07-26T14:01:46Z' } });
assert.equal(v.ok, false, 'trash check must still fire without the browser step');

console.log('verify-ga4-collect: all assertions passed');
