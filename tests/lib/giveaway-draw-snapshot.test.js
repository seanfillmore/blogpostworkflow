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

test('REGRESSION: an entrant who SUBMITTED after entries closed is not in the pool', () => {
  // Nothing closes the form at the deadline and the snapshot runs an hour
  // later, so someone entering at 00:30 PT used to land in the draw with a base
  // entry. §8 draws only from entries "received during the Entry Period".
  const snap = buildSnapshot([
    profile('ontime@x.com'),
    profile('late@x.com', { gv_entered_at: '2026-09-15T07:30:00.000Z' }),
  ], opts);
  assert.equal(row(snap, 'late@x.com'), undefined);
  assert.ok(row(snap, 'ontime@x.com'));
  assert.equal(snap.excluded.lateEntries, 1);
  assert.equal(snap.totals.entrants, 1);
});

test('an entry submitted exactly AT the closing instant is in the pool', () => {
  const snap = buildSnapshot([
    profile('edge@x.com', { gv_entered_at: '2026-09-15T06:59:59.000Z' }),
  ], opts);
  assert.ok(row(snap, 'edge@x.com'));
  assert.equal(snap.excluded.lateEntries, 0);
});

test('an entrant with NO entry stamp is kept — absence is not proof of a late entry', () => {
  const p = profile('unstamped@x.com');
  delete p.properties.gv_entered_at;
  const snap = buildSnapshot([p], opts);
  assert.ok(row(snap, 'unstamped@x.com'));
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

// ---------------------------------------------------------------------------
// §5 fraudulent-entry disqualification.
//
// On 2026-09-15 an automated cohort submitted 2,948 base entries in the final
// three hours of the Entry Period — 40% of the entrant pool, 12.9% of the
// tickets. The aggregate evidence is overwhelming (5,920 of 5,930 requests on a
// single user-agent string across 2,792 IPs, 3 distinct UAs against 70 over the
// preceding five days, a 0.14% confirm rate against the campaign's 47%,
// machine-generated addresses concentrated on one mail domain). Rules §5:
// "Sponsor reserves the right to disqualify any entry it reasonably believes to
// be fraudulent, automated, or otherwise made in violation of these Official
// Rules."
//
// The user agent is never persisted on a profile (it is forwarded to Meta's CAPI
// and dropped), so the per-entrant predicate is the entry stamp. Email-pattern
// classification was measured and REJECTED: the strongest single feature was the
// mail domain at 65.5% of the suspect cohort against 2.1% of the known-good one,
// which is nowhere near the recall needed to disqualify on.
// ---------------------------------------------------------------------------

const FRAUD_WINDOW = {
  from: '2026-09-15T03:59:00.000Z',
  to: '2026-09-15T06:50:00.000Z',
  reason: 'automated entry wave; see data/giveaway/evidence/2026-09-15-entry-fraud/',
};
const dqOpts = { ...opts, fraudWindows: [FRAUD_WINDOW] };

test('an unengaged entry inside a fraud window is disqualified and counted', () => {
  const snap = buildSnapshot([
    profile('bot@outlook.com', { gv_entered_at: '2026-09-15T05:00:00.000Z' }),
  ], dqOpts);
  assert.equal(row(snap, 'bot@outlook.com'), undefined);
  assert.equal(snap.excluded.fraudulent, 1);
  assert.equal(snap.totals.entrants, 0);
});

test('a CONFIRMED entrant inside a fraud window is KEPT — confirming is a human act', () => {
  const snap = buildSnapshot([
    profile('real@x.com', {
      gv_entered_at: '2026-09-15T05:00:00.000Z',
      ...confirmedAt('2026-09-15T06:00:00.000Z'),
      gv_breakdown: { confirmed: true, survey: false, referrals: 0, instagram: false, upload: false },
    }),
  ], dqOpts);
  assert.ok(row(snap, 'real@x.com'), 'a confirmation rescues an in-window entrant');
  assert.equal(snap.excluded.fraudulent, 0);
});

test('an in-window entrant who did the survey is KEPT', () => {
  const snap = buildSnapshot([
    profile('survey@x.com', {
      gv_entered_at: '2026-09-15T05:00:00.000Z',
      gv_breakdown: { confirmed: false, survey: true, referrals: 0, instagram: false, upload: false },
    }),
  ], dqOpts);
  assert.ok(row(snap, 'survey@x.com'));
  assert.equal(snap.excluded.fraudulent, 0);
});

test('an in-window entrant with an Instagram post, an upload or a referral is KEPT', () => {
  for (const rung of ['instagram', 'upload']) {
    const snap = buildSnapshot([
      profile(`${rung}@x.com`, {
        gv_entered_at: '2026-09-15T05:00:00.000Z',
        gv_breakdown: { confirmed: false, survey: false, referrals: 0, instagram: false, upload: false, [rung]: true },
      }),
    ], dqOpts);
    assert.ok(row(snap, `${rung}@x.com`), `${rung} is human engagement`);
  }
  const ref = buildSnapshot([
    profile('ref@x.com', {
      gv_entered_at: '2026-09-15T05:00:00.000Z',
      ...confirmedAt('2026-09-15T06:00:00.000Z'),
      gv_breakdown: { confirmed: true, survey: false, referrals: 2, instagram: false, upload: false },
    }),
  ], dqOpts);
  assert.ok(row(ref, 'ref@x.com'), 'a credited referral is human engagement');
});

test('an unengaged entry OUTSIDE the fraud window is untouched', () => {
  const snap = buildSnapshot([
    profile('legit@x.com', { gv_entered_at: '2026-09-14T22:00:00.000Z' }),
  ], dqOpts);
  assert.ok(row(snap, 'legit@x.com'));
  assert.equal(snap.excluded.fraudulent, 0);
});

test('the fraud window is inclusive of `from` and exclusive of `to`', () => {
  const at = (iso) => buildSnapshot([profile('e@x.com', { gv_entered_at: iso })], dqOpts);
  assert.equal(at('2026-09-15T03:58:59.999Z').excluded.fraudulent, 0, 'one ms before onset is clean');
  assert.equal(at('2026-09-15T03:59:00.000Z').excluded.fraudulent, 1, 'the onset minute is inside');
  assert.equal(at('2026-09-15T06:49:59.999Z').excluded.fraudulent, 1, 'the last attack ms is inside');
  assert.equal(at('2026-09-15T06:50:00.000Z').excluded.fraudulent, 0, 'the window closes before the final 10 minutes');
});

test('an entrant with NO entry stamp is never disqualified — absence is not evidence', () => {
  const p = profile('unstamped@x.com');
  delete p.properties.gv_entered_at;
  const snap = buildSnapshot([p], dqOpts);
  assert.ok(row(snap, 'unstamped@x.com'), 'disqualification must fail OPEN');
  assert.equal(snap.excluded.fraudulent, 0);
});

test('with no fraudWindows nothing is disqualified and the count is still reported', () => {
  const snap = buildSnapshot([
    profile('bot@outlook.com', { gv_entered_at: '2026-09-15T05:00:00.000Z' }),
  ], opts);
  assert.ok(row(snap, 'bot@outlook.com'), 'the default build is unchanged');
  assert.equal(snap.excluded.fraudulent, 0);
});

test('the snapshot records the fraud windows it was built under', () => {
  const snap = buildSnapshot([profile('a@x.com')], dqOpts);
  assert.deepEqual(snap.determinations.fraudWindows, [FRAUD_WINDOW]);
});
