// tests/dashboard/giveaway-routes.test.js
// The endpoint is public and paid-for: every dropped entry is ~$2.50 of ad
// spend. These tests pin the validation and the server-authority rule.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { validateEntryPayload, mergeBreakdown } from '../../agents/dashboard/routes/giveaway.js';

test('a client-supplied entry total is ignored — the server is the only authority', () => {
  const merged = mergeBreakdown(
    { confirmed: false, survey: false, referrals: 0, instagram: false, upload: false },
    { survey: true, gv_entries: 9999, referrals: 500 },
  );
  assert.equal(merged.survey, true);
  assert.equal(merged.referrals, 0, 'referrals are credited only by the reconciler, never by a request');
  assert.equal(merged.gv_entries, undefined, 'a client entry total must not survive the merge');
});

test('a missing or malformed email is a 400, not a silent drop', () => {
  assert.equal(validateEntryPayload({ email: 'a@b.com', firstName: 'A' }).ok, true);
  assert.equal(validateEntryPayload({ email: 'nope', firstName: 'A' }).ok, false);
  assert.equal(validateEntryPayload({ firstName: 'A' }).ok, false);
});

test('firstName is required, because every nurture email personalises on it', () => {
  const r = validateEntryPayload({ email: 'a@b.com' });
  assert.equal(r.ok, false);
  assert.match(r.error, /firstName/);
});

test('a self-referral in the entry payload is stripped rather than rejecting the entry', () => {
  // Losing a paid entry over a bad referral field would be the expensive
  // failure. Keep the entry, drop the referral.
  const r = validateEntryPayload({ email: 'a@b.com', firstName: 'A', referredBy: 'A@B.com' });
  assert.equal(r.ok, true);
  assert.equal(r.value.referredBy, null);
});

test('answer values outside the allowed enum are dropped, not stored', () => {
  const merged = mergeBreakdown(
    { confirmed: false, survey: false, referrals: 0, instagram: false, upload: false },
    { household: 'martian', frustration: 'reactive' },
  );
  assert.equal(merged.household, undefined, 'an unknown enum value must not reach the profile');
  assert.equal(merged.frustration, 'reactive');
});
