// tests/lib/giveaway-draw-snapshot.test.js
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildSnapshot } from '../../lib/giveaway/draw-snapshot.js';

const CLOSES = '2026-09-14T23:59:59-07:00';
const TAKEN = '2026-09-15T12:05:00.000Z';
const opts = { entryClosesAt: CLOSES, includeUnconfirmed: true, takenAt: TAKEN };

const profile = (email, props = {}, { subscribed = true } = {}) => ({
  id: `id-${email}`,
  email,
  subscribed,
  properties: {
    gv_entrant: true,
    gv_entered_at: '2026-08-20T12:00:00.000Z',
    gv_breakdown: { confirmed: false, survey: false, referrals: 0, instagram: false, upload: false },
    ...props,
  },
});
const confirmedAt = (iso) => ({ gv_confirmed_at: iso });
const row = (snap, email) => snap.entrants.find((e) => e.email === email);

test('a confirmed entrant carries their full entry count', () => {
  const snap = buildSnapshot([
    profile('a@x.com', {
      ...confirmedAt('2026-09-01T10:00:00.000Z'),
      gv_breakdown: { confirmed: true, survey: true, referrals: 0, instagram: false, upload: false },
    }),
  ], opts);
  assert.equal(row(snap, 'a@x.com').entries, 1 + 2 + 3, 'base + confirm + survey');
  assert.equal(row(snap, 'a@x.com').confirmed, true);
});

test('REGRESSION: a confirmation made AFTER entries closed does not count', () => {
  // reconcile.js has no concept of the Entry Period and would credit this. §5
  // requires every entry action to be completed "during the Entry Period".
  const snap = buildSnapshot([
    profile('late@x.com', {
      ...confirmedAt('2026-09-15T08:00:00.000Z'), // after the close
      gv_breakdown: { confirmed: true, survey: false, referrals: 0, instagram: false, upload: false },
    }),
  ], opts);
  const r = row(snap, 'late@x.com');
  assert.equal(r.confirmed, false, 'confirmed after the close is not confirmed for the draw');
  assert.equal(r.entries, 1, 'they keep their base entry and nothing more');
});

test('a confirmation exactly AT the closing instant counts', () => {
  const snap = buildSnapshot([
    profile('edge@x.com', {
      ...confirmedAt('2026-09-14T23:59:59-07:00'),
      gv_breakdown: { confirmed: true, survey: false, referrals: 0, instagram: false, upload: false },
    }),
  ], opts);
  assert.equal(row(snap, 'edge@x.com').confirmed, true, 'the boundary is inclusive');
});

test('unconfirmed entrants are included at their base entry when the determination says so', () => {
  const snap = buildSnapshot([
    profile('pending@x.com', {}, { subscribed: false }),
  ], opts);
  assert.equal(row(snap, 'pending@x.com').entries, 1);
  assert.equal(row(snap, 'pending@x.com').confirmed, false);
});

test('unconfirmed entrants are excluded when the determination is flipped', () => {
  const snap = buildSnapshot(
    [profile('pending@x.com', {}, { subscribed: false })],
    { ...opts, includeUnconfirmed: false },
  );
  assert.equal(row(snap, 'pending@x.com'), undefined);
});

test('a referral is carried through with its same-person flag', () => {
  const snap = buildSnapshot([
    profile('lisamarob@gmail.com', {
      ...confirmedAt('2026-09-01T10:00:00.000Z'),
      gv_referred_by: 'lisamarobin@outlook.com',
      gv_breakdown: { confirmed: true, survey: false, referrals: 0, instagram: false, upload: false },
    }),
  ], opts);
  const r = row(snap, 'lisamarob@gmail.com');
  assert.equal(r.referredBy, 'lisamarobin@outlook.com');
  assert.equal(r.samePersonSuspected, true);
});

test('test identities are excluded and counted', () => {
  const snap = buildSnapshot([
    profile('real@x.com', confirmedAt('2026-09-01T10:00:00.000Z')),
    profile('tester@x.com', { gv_test: true }),
  ], opts);
  assert.equal(row(snap, 'tester@x.com'), undefined);
  assert.equal(snap.excluded.testProfiles, 1);
});

test('totals agree with the rows, and entrants are sorted by email', () => {
  const snap = buildSnapshot([
    profile('c@x.com', confirmedAt('2026-09-01T10:00:00.000Z')),
    profile('a@x.com', {}, { subscribed: false }),
    profile('b@x.com', confirmedAt('2026-09-01T10:00:00.000Z')),
  ], opts);
  assert.deepEqual(snap.entrants.map((e) => e.email), ['a@x.com', 'b@x.com', 'c@x.com']);
  assert.equal(snap.totals.entrants, 3);
  assert.equal(snap.totals.entries, snap.entrants.reduce((n, e) => n + e.entries, 0));
  assert.equal(snap.totals.confirmed, 2);
  assert.equal(snap.totals.unconfirmed, 1);
});

test('the snapshot records the determination it was built under', () => {
  const snap = buildSnapshot([profile('a@x.com')], opts);
  assert.equal(snap.determinations.drawIncludesUnconfirmedEntrants, true);
  assert.equal(snap.entryClosesAt, CLOSES);
  assert.equal(snap.takenAt, TAKEN);
});

test('two builds of the same input are byte-identical', () => {
  const input = [
    profile('b@x.com', confirmedAt('2026-09-01T10:00:00.000Z')),
    profile('a@x.com', {}, { subscribed: false }),
  ];
  assert.equal(
    JSON.stringify(buildSnapshot(input, opts)),
    JSON.stringify(buildSnapshot(input, opts)),
    'the snapshot is the evidence record; it must not vary run to run',
  );
});
