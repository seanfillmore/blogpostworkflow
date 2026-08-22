import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  ENTRY_VALUES, REFERRAL_CAP, normalizeEmail, entryTotal, validateReferral,
} from '../../lib/giveaway/entries.js';

test('a bare entry is worth exactly one', () => {
  assert.equal(entryTotal({ confirmed: false, survey: false, referrals: 0, instagram: false, upload: false }), 1);
});

test('the maximum ladder is 69 entries', () => {
  const max = entryTotal({ confirmed: true, survey: true, referrals: REFERRAL_CAP, instagram: true, upload: true });
  assert.equal(max, 1 + 2 + 3 + 50 + 3 + 10);
  assert.equal(max, 69);
});

test('referrals are capped, so an 11th referral pays nothing', () => {
  const at = entryTotal({ confirmed: true, survey: true, referrals: 10, instagram: false, upload: false });
  const over = entryTotal({ confirmed: true, survey: true, referrals: 25, instagram: false, upload: false });
  assert.equal(at, over, 'past the cap the total must not move');
});

test('REGRESSION: a corrupt referrals value never poisons the total into NaN', () => {
  // Math.max(0, NaN) is NaN, NaN * 5 is NaN, and the sum is NaN — which the
  // reconciler would write straight to Klaviyo as `gv_entries: NaN`. Klaviyo
  // serialises that to null, so the entrant's ladder shows no count at all and
  // the daily report's entriesTotal is broken for everyone. The READ side
  // (lib/giveaway/summarize.js) already guarded this; the WRITER has to as well,
  // or the corrupt value is what gets stored in the first place.
  for (const bad of [undefined, null, NaN, 'three', {}, [], Infinity, -Infinity]) {
    const total = entryTotal({ confirmed: true, survey: false, referrals: bad, instagram: false, upload: false });
    assert.ok(Number.isFinite(total), `referrals=${String(bad)} produced ${total}`);
    assert.equal(total, 3, 'an unusable referral count is worth zero referrals, not NaN');
  }
  // A numeric string is still a number's worth of referrals, not a zero.
  assert.equal(entryTotal({ confirmed: false, referrals: '2' }), 1 + 10);
  // Negatives and fractions clamp as before.
  assert.equal(entryTotal({ confirmed: false, referrals: -5 }), 1);
  assert.equal(entryTotal({ confirmed: false, referrals: 1.9 }), 1 + 5);
});

test('emails are normalised so referral matching cannot miss on case or whitespace', () => {
  assert.equal(normalizeEmail('  Sean@Example.COM '), 'sean@example.com');
  assert.throws(() => normalizeEmail('not-an-email'), /invalid email/i);
  assert.throws(() => normalizeEmail('a@b'), /invalid email/i);
});

test('self-referral is rejected regardless of case', () => {
  const r = validateReferral({
    referrerEmail: 'Sean@Example.com',
    entrantEmail: 'sean@example.com',
    referrerIsEntrant: true,
    referrerReferralCredits: 0,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /self-referral/i);
});

test('a referrer who never entered earns nothing — there is no entry to credit', () => {
  // Not a confirmation test. §5 pays "+5 entries per confirmed friend" onto the
  // REFERRER's entry, so the referrer must have one; someone who never
  // submitted the form has no entry for the bonus to stack on (§4/§5).
  const r = validateReferral({
    referrerEmail: 'friend@example.com',
    entrantEmail: 'entrant@example.com',
    referrerIsEntrant: false,
    referrerReferralCredits: 0,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /has not entered/i);
});

test('REGRESSION: an UNCONFIRMED referrer still earns the +5 their friend generated', () => {
  // §5's referral bullet conditions the bonus on the FRIEND confirming — "Each
  // referred friend who confirms their own entry ... +5 entries per confirmed
  // friend". It says nothing about the referrer's own confirmation.
  //
  // Only §6's PRIZE clause requires a confirmed referrer ("but only if the named
  // referrer is (a) themselves a confirmed entrant"), and that is a draw-time
  // test, not an entry-crediting one. Requiring confirmation here withheld
  // entries the published rules had already granted.
  const r = validateReferral({
    referrerEmail: 'friend@example.com',
    entrantEmail: 'entrant@example.com',
    referrerIsEntrant: true,
    referrerReferralCredits: 0,
  });
  assert.deepEqual(r, { ok: true, reason: null });
});

test('a referrer already at the cap earns nothing more', () => {
  const r = validateReferral({
    referrerEmail: 'friend@example.com',
    entrantEmail: 'entrant@example.com',
    referrerIsEntrant: true,
    referrerReferralCredits: REFERRAL_CAP,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /cap/i);
});

test('a valid referral is accepted', () => {
  const r = validateReferral({
    referrerEmail: 'friend@example.com',
    entrantEmail: 'entrant@example.com',
    referrerIsEntrant: true,
    referrerReferralCredits: 3,
  });
  assert.deepEqual(r, { ok: true, reason: null });
});

test('a purchase cannot appear in the ladder — there is no purchase key', () => {
  assert.equal(Object.keys(ENTRY_VALUES).includes('purchase'), false);
});
