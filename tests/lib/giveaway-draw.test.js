// tests/lib/giveaway-draw.test.js
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { drawOrdering, determineReferralPrize } from '../../lib/giveaway/draw.js';

const snap = (entrants) => ({
  takenAt: '2026-09-15T12:05:00.000Z',
  entryClosesAt: '2026-09-14T23:59:59-07:00',
  determinations: { drawIncludesUnconfirmedEntrants: true },
  totals: {
    entrants: entrants.length,
    entries: entrants.reduce((n, e) => n + e.entries, 0),
    confirmed: entrants.filter((e) => e.confirmed).length,
    unconfirmed: entrants.filter((e) => !e.confirmed).length,
  },
  entrants,
  excluded: { testProfiles: 0, unconfirmed: 0, unusable: 0 },
});
const e = (email, entries, extra = {}) => ({
  email, entries, confirmed: true, referredBy: null, samePersonSuspected: false, ...extra,
});

test('the same seed reproduces the same ordering exactly', () => {
  const s = snap([e('a@x.com', 3), e('b@x.com', 1), e('c@x.com', 8)]);
  assert.deepEqual(drawOrdering(s, '43214.87'), drawOrdering(s, '43214.87'));
});

test('a different seed generally produces a different winner', () => {
  // Guards a seed that is accepted and silently ignored — the failure mode that
  // looks exactly like success.
  const s = snap(Array.from({ length: 40 }, (_, i) => e(`p${i}@x.com`, 1 + (i % 5))));
  const winners = new Set(
    ['1', '2', '3', '4', '5', '6', '7', '8'].map((seed) => drawOrdering(s, seed)[0]),
  );
  assert.ok(winners.size > 1, 'eight seeds producing one winner means the seed is not being used');
});

test('the ordering contains every entrant exactly once', () => {
  const s = snap([e('a@x.com', 5), e('b@x.com', 1), e('c@x.com', 2)]);
  const order = drawOrdering(s, 'seed');
  assert.equal(order.length, 3);
  assert.deepEqual([...order].sort(), ['a@x.com', 'b@x.com', 'c@x.com']);
});

test('more entries wins proportionally more often', () => {
  // The whole point of a weighted draw. 10:1 should land near 10x across many
  // seeds; the bound is loose because this is a sample, not a proof.
  const s = snap([e('big@x.com', 10), e('small@x.com', 1)]);
  let big = 0;
  const runs = 600;
  for (let i = 0; i < runs; i += 1) if (drawOrdering(s, `seed-${i}`)[0] === 'big@x.com') big += 1;
  const share = big / runs;
  assert.ok(share > 0.8 && share < 0.97, `10:1 weighting should win ~91% of the time, got ${(share * 100).toFixed(1)}%`);
});

test('an entrant with more entries is never dropped from the ordering', () => {
  const s = snap([e('a@x.com', 100), e('b@x.com', 1)]);
  assert.equal(drawOrdering(s, 'x').length, 2, 'the low-weight entrant is still an alternate');
});

test('the referral prize is awarded when every §6 condition holds', () => {
  const s = snap([
    e('winner@x.com', 3, { referredBy: 'friend@x.com' }),
    e('friend@x.com', 3),
  ]);
  const r = determineReferralPrize(s, 'winner@x.com');
  assert.equal(r.awarded, true);
  assert.equal(r.email, 'friend@x.com');
});

test('§6: no referrer named means no second prize', () => {
  const r = determineReferralPrize(snap([e('winner@x.com', 3)]), 'winner@x.com');
  assert.equal(r.awarded, false);
  assert.match(r.reason, /named no referrer/i);
});

test('§6: a referrer who never entered wins nothing', () => {
  const s = snap([e('winner@x.com', 3, { referredBy: 'ghost@x.com' })]);
  const r = determineReferralPrize(s, 'winner@x.com');
  assert.equal(r.awarded, false);
  assert.match(r.reason, /not in the snapshot/i);
});

test('§6(a): an UNCONFIRMED referrer wins nothing', () => {
  // "but only if the named referrer is (a) themselves a confirmed entrant".
  // Note this is the one place confirmation still gates a referral outcome —
  // the +5 ENTRY credit deliberately does not require it (§5).
  const s = snap([
    e('winner@x.com', 3, { referredBy: 'pending@x.com' }),
    e('pending@x.com', 1, { confirmed: false }),
  ]);
  const r = determineReferralPrize(s, 'winner@x.com');
  assert.equal(r.awarded, false);
  assert.match(r.reason, /not a confirmed entrant/i);
});

test('§6(b): a same-person referrer wins nothing, and no substitute is named', () => {
  const s = snap([
    e('lisamarob@gmail.com', 3, { referredBy: 'lisamarobin@outlook.com', samePersonSuspected: true }),
    e('lisamarobin@outlook.com', 3),
  ]);
  const r = determineReferralPrize(s, 'lisamarob@gmail.com');
  assert.equal(r.awarded, false);
  assert.equal(r.email, null, '§6 gives Sponsor no obligation to substitute');
  assert.match(r.reason, /same person/i);
});

test('§6: naming your own address wins nothing', () => {
  const s = snap([e('solo@x.com', 3, { referredBy: 'solo@x.com' })]);
  const r = determineReferralPrize(s, 'solo@x.com');
  assert.equal(r.awarded, false);
  assert.match(r.reason, /own address/i);
});

test('an unknown winner email is refused rather than silently unawarded', () => {
  assert.throws(
    () => determineReferralPrize(snap([e('a@x.com', 1)]), 'nobody@x.com'),
    /not in the snapshot/i,
  );
});
