// tests/lib/giveaway-referral-audit.test.js
//
// The classifier is pure and runs without credentials, for the same reason
// planEntryUpdates is: these are the rules that decide who receives real email
// about a real $536.40 prize, and they have to be provable somewhere other than
// production.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { classifyReferrals, mergeEntrantProfiles } from '../../lib/giveaway/referral-audit.js';

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

test('REGRESSION: the lisamarob pair is a NORMAL referral that happens to be flagged', () => {
  // The live 2026-08-21 case that prompted this work. Operator determination
  // 2026-08-22: two addresses belonging to one person are still a valid
  // referral. §6's entry-crediting void has never been enforced by
  // reconcile.js either — validateReferral blocks only an EXACT address match —
  // so suppressing here was the audit disagreeing with the payment path.
  //
  // The flag survives because §6's PRIZE half is explicitly "any email address
  // Sponsor determines resolves to the same person", and that determination is
  // made at the draw, on a $536.40 second prize. Losing the signal entirely
  // would leave nothing to determine from.
  const rows = classifyReferrals([
    confirmed('lisamarob@gmail.com', { gv_referred_by: 'lisamarobin@outlook.com' }),
  ]);
  const r = forReferee(rows, 'lisamarob@gmail.com');
  assert.equal(r.status, 'referrer_missing', 'classified on the merits: that address has not entered');
  assert.equal(r.samePersonSuspected, true, 'but still flagged for the §6 prize determination');
  assert.equal(r.notify, 'referee', 'and the entrant IS told their friend needs to enter');
});

test('an identical local part on a different domain is flagged but still credited normally', () => {
  const rows = classifyReferrals([
    confirmed('johnsmith@yahoo.com'),
    confirmed('johnsmith@gmail.com', { gv_referred_by: 'johnsmith@yahoo.com' }),
  ]);
  const r = forReferee(rows, 'johnsmith@gmail.com');
  assert.equal(r.status, 'creditable');
  assert.equal(r.samePersonSuspected, true);
});

test('an EXACT self-referral is still void — naming your own address is not two addresses', () => {
  // The operator determination covers one person with TWO addresses. Naming the
  // very address you entered with is the unambiguous §6 case and stays void, as
  // it is in validateReferral.
  const rows = classifyReferrals([confirmed('solo@x.com', { gv_referred_by: 'solo@x.com' })]);
  const r = forReferee(rows, 'solo@x.com');
  assert.equal(r.status, 'self_referral');
  assert.equal(r.notify, null);
});

test('a SHORT shared prefix does not even raise the flag', () => {
  // 'sam' is a prefix of 'samuel' but they are plainly two people.
  const rows = classifyReferrals([
    confirmed('samuel@x.com'),
    confirmed('sam@x.com', { gv_referred_by: 'samuel@x.com' }),
  ]);
  const r = forReferee(rows, 'sam@x.com');
  assert.equal(r.status, 'creditable');
  assert.equal(r.samePersonSuspected, false);
});

test('REGRESSION: an UNCONFIRMED entrant who named a referrer is visible to the audit', () => {
  // The defect that shipped in PR #585. Klaviyo only adds a profile to the
  // giveaway list once double opt-in completes, so the list IS the confirmed
  // set — measured 2026-08-22: 278 submitted, 77 on the list. Feeding the
  // classifier the list alone hid 6 of 7 referral pairs, and made the
  // referee_unconfirmed branch unreachable in production despite being tested.
  const rows = classifyReferrals([
    confirmed('friend@x.com'),
    // subscribed:false and no stamp — exactly how a submitted-but-unconfirmed
    // profile arrives once it is merged in from listEntrantProfiles.
    profile('pending@x.com', { gv_referred_by: 'friend@x.com' }, { subscribed: false }),
  ]);
  const r = forReferee(rows, 'pending@x.com');
  assert.ok(r, 'an unconfirmed entrant naming a referrer must produce a row');
  assert.equal(r.status, 'referee_unconfirmed');
});

test('mergeEntrantProfiles marks submitted-but-unlisted profiles as not subscribed', () => {
  // The merge is where the blind spot is actually closed, and the subscribed
  // flag is the load-bearing part: listEntrantProfiles does not return one, and
  // confirmedEver treats a missing flag as TRUE. Merging naively would mark all
  // 278 submitted profiles confirmed and credit the +2 rung to people who never
  // clicked anything.
  const listed = [{ id: '1', email: 'confirmed@x.com', subscribed: true, properties: { gv_confirmed_at: '2026-08-20T13:00:00.000Z' } }];
  const submitted = [
    { id: '1', email: 'confirmed@x.com', properties: { gv_entered_at: '2026-08-20T12:00:00.000Z' } },
    { id: '2', email: 'pending@x.com', properties: { gv_entered_at: '2026-08-20T12:00:00.000Z' } },
  ];
  const merged = mergeEntrantProfiles(listed, submitted);
  assert.equal(merged.length, 2, 'the union, not either side alone');
  const pending = merged.find((p) => p.email === 'pending@x.com');
  assert.equal(pending.subscribed, false, 'not on the list means not confirmed');
  const already = merged.find((p) => p.email === 'confirmed@x.com');
  assert.equal(already.subscribed, true, 'the listed copy wins — it is the one carrying consent');
  assert.equal(already.properties.gv_confirmed_at, '2026-08-20T13:00:00.000Z', 'and its properties are preserved');
});

test('mergeEntrantProfiles is case-insensitive, so one person is never counted twice', () => {
  const merged = mergeEntrantProfiles(
    [{ id: '1', email: 'Person@X.com', subscribed: true, properties: {} }],
    [{ id: '1', email: 'person@x.com', properties: { gv_entered_at: '2026-08-20T12:00:00.000Z' } }],
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].subscribed, true);
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
