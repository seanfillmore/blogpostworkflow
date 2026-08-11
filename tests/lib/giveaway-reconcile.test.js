// tests/lib/giveaway-reconcile.test.js
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { planEntryUpdates } from '../../lib/giveaway/reconcile.js';
import { REFERRAL_CAP } from '../../lib/giveaway/entries.js';

// Every profile passed to planEntryUpdates came from listSubscribedProfiles, so
// it is double-opt-in confirmed. The fixtures below therefore represent the
// state AS STORED, which starts with confirmed:false straight from entry.
const profile = (email, props = {}) => ({
  id: `id-${email}`,
  email,
  properties: {
    gv_entrant: true,
    gv_breakdown: { confirmed: false, survey: false, referrals: 0, instagram: false, upload: false },
    ...props,
  },
});
const forEmail = (updates, email) => updates.find((u) => u.email === email);

test('REGRESSION: confirmation is credited — being in the SUBSCRIBED set IS the confirmation', () => {
  // Nothing in a request can know someone clicked the opt-in link, so if this
  // function does not credit it, the advertised +2 rung never pays and the
  // ladder shown on the entered page is a lie.
  const updates = planEntryUpdates([profile('a@x.com')]);
  const u = forEmail(updates, 'a@x.com');
  assert.ok(u, 'a profile stored as unconfirmed must produce an update');
  assert.equal(u.breakdown.confirmed, true);
  assert.equal(u.entries, 3, 'base 1 + confirm 2');
});

test('a confirmed entrant credits the referrer they named', () => {
  const updates = planEntryUpdates([
    profile('referrer@x.com'),
    profile('friend@x.com', { gv_referred_by: 'referrer@x.com' }),
  ]);
  const r = forEmail(updates, 'referrer@x.com');
  assert.equal(r.breakdown.referrals, 1);
  assert.equal(r.entries, 8, 'base 1 + confirm 2 + one referral 5');
});

test('a referrer who is not a confirmed entrant is never credited', () => {
  const updates = planEntryUpdates([profile('friend@x.com', { gv_referred_by: 'ghost@x.com' })]);
  assert.equal(forEmail(updates, 'ghost@x.com'), undefined, 'ghost is not in the confirmed set');
  assert.equal(forEmail(updates, 'friend@x.com').breakdown.referrals, 0);
});

test('self-referral credits nobody', () => {
  const updates = planEntryUpdates([profile('solo@x.com', { gv_referred_by: 'solo@x.com' })]);
  assert.equal(forEmail(updates, 'solo@x.com').breakdown.referrals, 0);
});

test('credits stop at the cap even with more confirmed referees', () => {
  const referees = Array.from({ length: 14 }, (_, i) => profile(`f${i}@x.com`, { gv_referred_by: 'r@x.com' }));
  const updates = planEntryUpdates([profile('r@x.com'), ...referees]);
  const r = forEmail(updates, 'r@x.com');
  assert.equal(r.breakdown.referrals, REFERRAL_CAP, 'capped');
  assert.equal(r.entries, 1 + 2 + 50);
});

test('the run is idempotent — a profile already in its final state produces no update', () => {
  const updates = planEntryUpdates([
    profile('r@x.com', { gv_breakdown: { confirmed: true, survey: false, referrals: 1, instagram: false, upload: false } }),
    profile('f1@x.com', { gv_breakdown: { confirmed: true, survey: false, referrals: 0, instagram: false, upload: false }, gv_referred_by: 'r@x.com' }),
  ]);
  assert.deepEqual(updates, [], 'nothing left to change means no writes');
});

test('other rungs already earned are preserved, not reset', () => {
  const updates = planEntryUpdates([
    profile('a@x.com', { gv_breakdown: { confirmed: false, survey: true, referrals: 0, instagram: true, upload: true } }),
  ]);
  const u = forEmail(updates, 'a@x.com');
  assert.equal(u.breakdown.survey, true);
  assert.equal(u.breakdown.upload, true);
  assert.equal(u.entries, 1 + 2 + 3 + 3 + 10, 'crediting confirmation must not clobber survey/instagram/upload');
});

test('matching is case-insensitive, so a mixed-case referral field still pays', () => {
  const updates = planEntryUpdates([
    profile('referrer@x.com'),
    profile('friend@x.com', { gv_referred_by: 'ReFerrer@X.com' }),
  ]);
  assert.equal(forEmail(updates, 'referrer@x.com').breakdown.referrals, 1);
});
