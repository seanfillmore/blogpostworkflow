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

test('emails are normalised so referral matching cannot miss on case or whitespace', () => {
  assert.equal(normalizeEmail('  Sean@Example.COM '), 'sean@example.com');
  assert.throws(() => normalizeEmail('not-an-email'), /invalid email/i);
  assert.throws(() => normalizeEmail('a@b'), /invalid email/i);
});

test('self-referral is rejected regardless of case', () => {
  const r = validateReferral({
    referrerEmail: 'Sean@Example.com',
    entrantEmail: 'sean@example.com',
    referrerIsConfirmedEntrant: true,
    referrerReferralCredits: 0,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /self-referral/i);
});

test('an unconfirmed referrer earns nothing — a prize cannot go to someone who never accepted the rules', () => {
  const r = validateReferral({
    referrerEmail: 'friend@example.com',
    entrantEmail: 'entrant@example.com',
    referrerIsConfirmedEntrant: false,
    referrerReferralCredits: 0,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /not a confirmed entrant/i);
});

test('a referrer already at the cap earns nothing more', () => {
  const r = validateReferral({
    referrerEmail: 'friend@example.com',
    entrantEmail: 'entrant@example.com',
    referrerIsConfirmedEntrant: true,
    referrerReferralCredits: REFERRAL_CAP,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /cap/i);
});

test('a valid referral is accepted', () => {
  const r = validateReferral({
    referrerEmail: 'friend@example.com',
    entrantEmail: 'entrant@example.com',
    referrerIsConfirmedEntrant: true,
    referrerReferralCredits: 3,
  });
  assert.deepEqual(r, { ok: true, reason: null });
});

test('a purchase cannot appear in the ladder — there is no purchase key', () => {
  assert.equal(Object.keys(ENTRY_VALUES).includes('purchase'), false);
});
