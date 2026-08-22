// tests/lib/giveaway-referral-audit.test.js
//
// The classifier is pure and runs without credentials, for the same reason
// planEntryUpdates is: these are the rules that decide who receives real email
// about a real $536.40 prize, and they have to be provable somewhere other than
// production.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { classifyReferrals } from '../../lib/giveaway/referral-audit.js';

// Mirrors tests/lib/giveaway-reconcile.js's fixture shape: state AS STORED.
// `subscribed` is current consent, `gv_confirmed_at` is the durable proof.
const profile = (email, props = {}, { subscribed = true } = {}) => ({
  id: `id-${email}`,
  email,
  subscribed,
  properties: {
    gv_entrant: true,
    gv_entered_at: '2026-08-20T12:00:00.000Z',
    ...props,
  },
});
const confirmed = (email, props = {}, opts) =>
  profile(email, { gv_confirmed_at: '2026-08-20T13:00:00.000Z', ...props }, opts);

const forReferee = (rows, email) => rows.find((r) => r.referee === email);

test('a profile that named nobody produces no row at all', () => {
  const rows = classifyReferrals([confirmed('a@x.com'), confirmed('b@x.com')]);
  assert.deepEqual(rows, [], 'the audit only ever speaks about actual referral pairs');
});

test('a referral that already pays is creditable and is never emailed about', () => {
  const rows = classifyReferrals([
    confirmed('referrer@x.com'),
    confirmed('friend@x.com', { gv_referred_by: 'referrer@x.com' }),
  ]);
  const r = forReferee(rows, 'friend@x.com');
  assert.equal(r.status, 'creditable');
  assert.equal(r.notify, null, 'nothing is wrong, so nobody is disturbed');
});

test('a named referrer who has not entered is PENDING, not dead — the referee is told', () => {
  // The whole point of the audit: reconcile.js re-evaluates every night, so this
  // referral starts paying the moment that person enters and confirms. Telling
  // the referee converts a dead field into a free acquisition channel.
  const rows = classifyReferrals([
    confirmed('friend@x.com', { gv_referred_by: 'ghost@x.com' }),
  ]);
  const r = forReferee(rows, 'friend@x.com');
  assert.equal(r.status, 'referrer_missing');
  assert.equal(r.notify, 'referee');
  assert.equal(r.suggestion, null, 'no entrant resembles this address, so nothing is proposed');
});

test('a named referrer who entered but never confirmed is its own status', () => {
  const rows = classifyReferrals([
    profile('lapsed@x.com', {}, { subscribed: false }), // on the list, no gv_confirmed_at
    confirmed('friend@x.com', { gv_referred_by: 'lapsed@x.com' }),
  ]);
  const r = forReferee(rows, 'friend@x.com');
  assert.equal(r.status, 'referrer_unconfirmed');
  assert.equal(r.notify, 'referee', 'the referee can nudge them; the referrer cannot be mailed');
});

test('an unconfirmed REFEREE blocks the credit and cannot lawfully be emailed', () => {
  // Klaviyo will not deliver marketing email to a profile that has not consented.
  // scripts/giveaway/nudge-unconfirmed.mjs owns this population via a re-issued
  // opt-in, which is a consent request rather than marketing.
  const rows = classifyReferrals([
    confirmed('referrer@x.com'),
    profile('pending@x.com', { gv_referred_by: 'referrer@x.com' }, { subscribed: false }),
  ]);
  const r = forReferee(rows, 'pending@x.com');
  assert.equal(r.status, 'referee_unconfirmed');
  assert.equal(r.notify, null, 'unreachable by marketing email — report only');
});

test('an exactly self-referred entry is void and silent', () => {
  const rows = classifyReferrals([confirmed('solo@x.com', { gv_referred_by: 'solo@x.com' })]);
  const r = forReferee(rows, 'solo@x.com');
  assert.equal(r.status, 'self_referral');
  assert.equal(r.notify, null);
});

test('REGRESSION: the lisamarob pair is flagged same-person and never gets a suggestion', () => {
  // The live 2026-08-21 case that prompted this work. Official Rules §6 voids
  // "any other entry you control" and "any email address Sponsor determines
  // resolves to the same person". Mailing this entrant "did you mean X?" would
  // be inviting them to launder a void referral, so it goes to a human instead.
  const rows = classifyReferrals([
    confirmed('lisamarob@gmail.com', { gv_referred_by: 'lisamarobin@outlook.com' }),
  ]);
  const r = forReferee(rows, 'lisamarob@gmail.com');
  assert.equal(r.status, 'self_referral_suspected');
  assert.equal(r.notify, null, 'no email, ever, on a suspected same-person pair');
  assert.equal(r.suggestion, null);
});

test('an identical local part on a different domain is the same-person heuristic too', () => {
  const rows = classifyReferrals([
    confirmed('johnsmith@gmail.com', { gv_referred_by: 'johnsmith@yahoo.com' }),
  ]);
  assert.equal(forReferee(rows, 'johnsmith@gmail.com').status, 'self_referral_suspected');
});

test('a SHORT shared prefix is not enough to accuse someone of self-referral', () => {
  // 'sam' is a prefix of 'samuel' but they are plainly two people. Requiring a
  // minimum stem length is what keeps the heuristic from suppressing genuine
  // referrals between friends with similar names.
  const rows = classifyReferrals([
    confirmed('samuel@x.com'),
    confirmed('sam@x.com', { gv_referred_by: 'samuel@x.com' }),
  ]);
  assert.equal(forReferee(rows, 'sam@x.com').status, 'creditable');
});

test('a near-miss of exactly one confirmed entrant is reported with the likely address', () => {
  const rows = classifyReferrals([
    confirmed('sara.jones@gmail.com'),
    confirmed('friend@x.com', { gv_referred_by: 'sara.jones@gmial.com' }),
  ]);
  const r = forReferee(rows, 'friend@x.com');
  assert.equal(r.status, 'referrer_near_miss');
  assert.equal(r.suggestion.email, 'sara.jones@gmail.com');
  assert.equal(r.notify, null, '§5 forbids changing the address, so this is a report line only');
});

test('an AMBIGUOUS near-miss proposes nothing', () => {
  // Two confirmed entrants sit one edit away from the typo. Guessing between
  // them would be inventing a referral, so the row degrades to referrer_missing.
  const rows = classifyReferrals([
    confirmed('katie@x.com'),
    confirmed('katia@x.com'),
    confirmed('friend@x.com', { gv_referred_by: 'katix@x.com' }),
  ]);
  const r = forReferee(rows, 'friend@x.com');
  assert.equal(r.status, 'referrer_missing');
  assert.equal(r.suggestion, null, 'a tie is not a suggestion');
});

test('a near-miss only ever points at a CONFIRMED entrant', () => {
  // An unconfirmed profile cannot be credited as a referrer, so proposing it
  // would describe a fix that still pays nothing.
  const rows = classifyReferrals([
    profile('sara.jones@gmail.com', {}, { subscribed: false }),
    confirmed('friend@x.com', { gv_referred_by: 'sara.jones@gmial.com' }),
  ]);
  assert.equal(forReferee(rows, 'friend@x.com').status, 'referrer_missing');
});

test('the suggestion records whether that entrant was ALREADY confirmed when the referee entered', () => {
  // Not a gate any more (nothing is rewritten), but it is the difference between
  // "an obvious typo of someone who was already in" and a coincidental later
  // match, and the human reading the report needs to see which one it is.
  const rows = classifyReferrals([
    confirmed('sara.jones@gmail.com', { gv_confirmed_at: '2026-08-25T10:00:00.000Z' }),
    confirmed('friend@x.com', { gv_referred_by: 'sara.jones@gmial.com', gv_entered_at: '2026-08-20T12:00:00.000Z' }),
  ]);
  const s = forReferee(rows, 'friend@x.com').suggestion;
  assert.equal(s.email, 'sara.jones@gmail.com');
  assert.equal(s.confirmedBeforeEntry, false, 'they confirmed five days AFTER this referee entered');
});

test('an unsubscribed referee is never emailed even though the referral is genuinely broken', () => {
  // Confirmation survives an unsubscribe (§12), so this row is still classified
  // correctly — but consent decides delivery, and they withdrew it.
  const rows = classifyReferrals([
    confirmed('quiet@x.com', { gv_referred_by: 'ghost@x.com' }, { subscribed: false }),
  ]);
  const r = forReferee(rows, 'quiet@x.com');
  assert.equal(r.status, 'referrer_missing', 'still broken, still reported');
  assert.equal(r.notify, null, 'but marketing email needs consent they have withdrawn');
});

test('matching is case- and whitespace-insensitive, like every other giveaway path', () => {
  const rows = classifyReferrals([
    confirmed('referrer@x.com'),
    confirmed('friend@x.com', { gv_referred_by: '  ReFerrer@X.com ' }),
  ]);
  assert.equal(forReferee(rows, 'friend@x.com').status, 'creditable');
});

test('an unparseable referrer field is reported, not thrown on', () => {
  // A hand-edited profile or a bad import must not take the nightly run down.
  const rows = classifyReferrals([
    confirmed('friend@x.com', { gv_referred_by: 'not-an-email' }),
  ]);
  const r = forReferee(rows, 'friend@x.com');
  assert.equal(r.status, 'referrer_unparseable');
  assert.equal(r.notify, null);
});

test('every row carries the referee and the address as typed, for the report', () => {
  const rows = classifyReferrals([
    confirmed('friend@x.com', { gv_referred_by: 'Ghost@X.com' }),
  ]);
  const r = forReferee(rows, 'friend@x.com');
  assert.equal(r.referee, 'friend@x.com');
  assert.equal(r.namedReferrer, 'ghost@x.com', 'normalized for matching');
  assert.equal(r.namedRaw, 'Ghost@X.com', 'and kept verbatim, because §5 makes the typed value the identifier');
});
