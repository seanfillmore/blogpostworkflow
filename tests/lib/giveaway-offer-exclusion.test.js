// tests/lib/giveaway-offer-exclusion.test.js
//
// The draw-day consolation email opens "We drew the winner. It wasn't you." and
// goes to the whole entrant list. Without an exclusion it tells the winner, and
// the referral-prize winner, that they lost — three hours after we told them
// they won. These pin the two pure halves of the fix.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { withExcludedList, drawnWinnerEmails } from '../../lib/giveaway/offer-exclusion.js';

test('the exclusion list is added and the included audience is left exactly as it was', () => {
  const out = withExcludedList({ included: ['Y2ukbE'], excluded: [] }, 'WIN123');
  assert.equal(out.changed, true);
  assert.deepEqual(out.audiences, { included: ['Y2ukbE'], excluded: ['WIN123'] });
});

test('existing exclusions are kept, not replaced', () => {
  const out = withExcludedList({ included: ['Y2ukbE'], excluded: ['YuYRCd'] }, 'WIN123');
  assert.deepEqual(out.audiences.excluded, ['YuYRCd', 'WIN123']);
});

test('a campaign already excluding the list is unchanged, so a re-run reverts nothing', () => {
  const out = withExcludedList({ included: ['Y2ukbE'], excluded: ['WIN123'] }, 'WIN123');
  assert.equal(out.changed, false);
});

test('an exclusion list that is also the included audience is refused — it would send to nobody', () => {
  assert.throws(() => withExcludedList({ included: ['WIN123'], excluded: [] }, 'WIN123'), /included/);
});

test('both prize winners are excluded when the referral prize is awarded', () => {
  const emails = drawnWinnerEmails({
    winner: 'Winner@Example.com ',
    referralPrize: { awarded: true, email: 'referrer@example.com', reason: 'all §6 conditions met' },
  });
  assert.deepEqual(emails, ['winner@example.com', 'referrer@example.com']);
});

test('an unawarded referral prize excludes the winner only', () => {
  const emails = drawnWinnerEmails({
    winner: 'winner@example.com',
    referralPrize: { awarded: false, email: null, reason: 'no referrer named' },
  });
  assert.deepEqual(emails, ['winner@example.com']);
});

test('a result with no winner is refused rather than excluding nobody', () => {
  assert.throws(() => drawnWinnerEmails({ referralPrize: { awarded: false } }), /winner/);
});
