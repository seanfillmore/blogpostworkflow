// tests/scripts/giveaway-draw-e2e.test.js
//
// The drawing runs ONCE. It has to be rehearsed on a realistic population before
// the day, because there is no second attempt and no undo.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildSnapshot } from '../../lib/giveaway/draw-snapshot.js';
import { drawOrdering, determineReferralPrize } from '../../lib/giveaway/draw.js';

// Shaped like the real 2026-08-22 population: ~21% confirmed, unconfirmed
// entrants holding survey/Instagram/upload rungs (§5 gates none of those on
// confirmation), and one same-person referral pair.
function population() {
  const out = [];
  for (let i = 0; i < 80; i += 1) {
    out.push({
      email: `conf${i}@x.com`,
      subscribed: true,
      properties: {
        gv_entered_at: '2026-08-25T12:00:00.000Z',
        gv_confirmed_at: '2026-08-26T12:00:00.000Z',
        gv_breakdown: { confirmed: true, survey: i % 2 === 0, referrals: 0, instagram: false, upload: false },
      },
    });
  }
  for (let i = 0; i < 200; i += 1) {
    out.push({
      email: `pend${i}@x.com`,
      subscribed: false,
      properties: {
        gv_entered_at: '2026-09-01T12:00:00.000Z',
        // Every third one did the survey without ever confirming — that is the
        // real shape of this population and it is worth ~3x their base entry.
        gv_breakdown: { confirmed: false, survey: i % 3 === 0, referrals: 0, instagram: false, upload: i % 25 === 0 },
      },
    });
  }
  out.push({
    email: 'lisamarob@gmail.com',
    subscribed: true,
    properties: {
      gv_entered_at: '2026-08-21T12:00:00.000Z',
      gv_confirmed_at: '2026-08-21T13:00:00.000Z',
      gv_referred_by: 'lisamarobin@outlook.com',
      gv_breakdown: { confirmed: true, survey: false, referrals: 0, instagram: false, upload: false },
    },
  });
  out.push({
    email: 'lisamarobin@outlook.com',
    subscribed: true,
    properties: {
      gv_entered_at: '2026-08-21T12:00:00.000Z',
      gv_confirmed_at: '2026-08-21T13:00:00.000Z',
      gv_breakdown: { confirmed: true, survey: false, referrals: 1, instagram: false, upload: false },
    },
  });
  // Confirmed AFTER the close — must be demoted to base entry by the gate.
  out.push({
    email: 'toolate@x.com',
    subscribed: true,
    properties: {
      gv_entered_at: '2026-09-14T20:00:00.000Z',
      gv_confirmed_at: '2026-09-15T09:00:00.000Z',
      gv_breakdown: { confirmed: true, survey: true, referrals: 0, instagram: false, upload: false },
    },
  });
  return out;
}

const snap = buildSnapshot(population(), {
  entryClosesAt: '2026-09-14T23:59:59-07:00',
  includeUnconfirmed: true,
  takenAt: '2026-09-15T12:05:00.000Z',
});

test('the rehearsal snapshot is internally consistent', () => {
  assert.equal(snap.totals.entrants, 283);
  assert.equal(snap.totals.entries, snap.entrants.reduce((n, e) => n + e.entries, 0));
  assert.equal(snap.totals.confirmed + snap.totals.unconfirmed, snap.totals.entrants);
});

test('REGRESSION: the post-close confirmer is demoted to a base entry', () => {
  const late = snap.entrants.find((e) => e.email === 'toolate@x.com');
  assert.equal(late.confirmed, false, '§5 requires actions during the Entry Period');
  assert.equal(late.entries, 1 + 3, 'base + the survey they DID complete in time; no +2');
});

test('a full draw completes and is reproducible', () => {
  const a = drawOrdering(snap, '43214.87');
  const b = drawOrdering(snap, '43214.87');
  assert.deepEqual(a, b);
  assert.equal(a.length, snap.totals.entrants, 'everyone is somewhere in the ordering');
  assert.equal(new Set(a).size, a.length, 'no duplicates');
});

test('REGRESSION: the same-person pair never wins the second prize', () => {
  const r = determineReferralPrize(snap, 'lisamarob@gmail.com');
  assert.equal(r.awarded, false);
  assert.equal(r.email, null);
});

test('an unconfirmed entrant can win, and awards no referral prize', () => {
  const r = determineReferralPrize(snap, 'pend7@x.com');
  assert.equal(r.awarded, false, 'they named nobody');
});

test('unconfirmed entrants are a material share of the pool, not a rounding error', () => {
  // The consequence of the draw-pool determination, pinned so nobody later
  // assumes unconfirmed entrants hold one entry each. They do not: §5 gates
  // survey, Instagram and upload on nothing.
  const unconfirmedEntries = snap.entrants.filter((e) => !e.confirmed).reduce((n, e) => n + e.entries, 0);
  assert.ok(
    unconfirmedEntries / snap.totals.entries > 0.5,
    `unconfirmed hold ${unconfirmedEntries}/${snap.totals.entries} entries — the determination is load-bearing`,
  );
});
