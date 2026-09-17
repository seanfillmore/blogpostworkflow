// tests/lib/giveaway-offer-exclusion.test.js
//
// The draw-day consolation email opens "We drew the winner. It wasn't you." and
// goes to the whole entrant list. Without an exclusion it tells the winner, and
// the referral-prize winner, that they lost — three hours after we told them
// they won. These pin the two pure halves of the fix.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  withExcludedList, drawnWinnerEmails, disqualifiedEmails, missingFromMembership, withIncludedAudience,
} from '../../lib/giveaway/offer-exclusion.js';

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

// ---------------------------------------------------------------------------
// §5-disqualified entrants are excluded from the consolation sends too.
//
// The three offer campaigns target the whole entrant list. 2,948 of its members
// are the automated cohort disqualified from the drawing (PR #889) — they will
// never buy, they confirmed at 0.14%, and mailing them flattens every rate the
// offer is measured on. They go onto the SAME list the winners go onto, which is
// already excluded on all three campaigns, so nothing has to edit a scheduled
// send.
// ---------------------------------------------------------------------------

test('disqualifiedEmails reads the committed evidence record', () => {
  const emails = disqualifiedEmails({
    disqualified: [{ email: 'Bot1@Outlook.com' }, { email: 'bot2@outlook.com' }],
  });
  assert.deepEqual(emails, ['bot1@outlook.com', 'bot2@outlook.com'], 'normalized');
});

test('disqualifiedEmails dedupes', () => {
  const emails = disqualifiedEmails({
    disqualified: [{ email: 'bot@outlook.com' }, { email: 'BOT@outlook.com' }],
  });
  assert.deepEqual(emails, ['bot@outlook.com']);
});

test('disqualifiedEmails NEVER returns an exempt entrant', () => {
  // The exemptions are the whole reason the rule is safe. An exempt entrant
  // leaking into the exclusion list would silently withhold the offer from
  // someone the rule deliberately spared.
  const rec = {
    disqualified: [{ email: 'bot@outlook.com' }],
    exempt: [{ email: 'real@gmail.com', exempt_because: 'confirmed' }],
  };
  const emails = disqualifiedEmails(rec);
  assert.ok(!emails.includes('real@gmail.com'));
  assert.deepEqual(emails, ['bot@outlook.com']);
});

test('disqualifiedEmails refuses a record with no disqualified array', () => {
  assert.throws(() => disqualifiedEmails({}), /disqualified/);
  assert.throws(() => disqualifiedEmails({ disqualified: 'nope' }), /disqualified/);
});

test('disqualifiedEmails refuses a row with no usable email', () => {
  assert.throws(() => disqualifiedEmails({ disqualified: [{ email: '' }] }), /email/);
});

test('missingFromMembership compares against the WHOLE membership, not one page', () => {
  // The bug this exists to stop: the read-back paged at 100 while the list now
  // holds thousands, so the winners were reported absent right after being added.
  const members = Array.from({ length: 250 }, (_, i) => `f${i}@x.com`);
  members.push('winner@x.com');
  assert.deepEqual(missingFromMembership(['winner@x.com'], members), []);
  assert.deepEqual(missingFromMembership(['winner@x.com'], members.slice(0, 100)), ['winner@x.com']);
});

test('missingFromMembership is case-insensitive on both sides', () => {
  assert.deepEqual(missingFromMembership(['Winner@X.com'], ['winner@x.com']), []);
  assert.deepEqual(missingFromMembership(['winner@x.com'], ['WINNER@X.COM']), []);
});

// ---------------------------------------------------------------------------
// Re-pointing a scheduled campaign's INCLUDED audience.
//
// The draw-day send went to `--audience all` — the whole entrant list, including
// the ~2,283 who never confirmed anything. It returned 0.31% CTR and a 4.32%
// unsubscribe rate. The two remaining sends move to an engaged segment.
//
// Replacing the included audience is more dangerous than adding an exclusion:
// get it wrong and the campaign sends to NOBODY, silently, at its scheduled time.
// ---------------------------------------------------------------------------

test('the included audience is replaced and the exclusions are preserved', () => {
  const out = withIncludedAudience({ included: ['Y2ukbE'], excluded: ['UigAyc'] }, 'ENG123');
  assert.deepEqual(out.audiences, { included: ['ENG123'], excluded: ['UigAyc'] });
  assert.equal(out.changed, true);
});

test('re-pointing to the audience already targeted is a no-op', () => {
  // Must not revert and requeue a scheduled campaign for nothing.
  const out = withIncludedAudience({ included: ['ENG123'], excluded: ['UigAyc'] }, 'ENG123');
  assert.equal(out.changed, false);
  assert.deepEqual(out.audiences, { included: ['ENG123'], excluded: ['UigAyc'] });
});

test('REFUSES an empty audience id — that would send to nobody', () => {
  assert.throws(() => withIncludedAudience({ included: ['Y2ukbE'], excluded: [] }, ''), /required/);
  assert.throws(() => withIncludedAudience({ included: ['Y2ukbE'], excluded: [] }, null), /required/);
});

test('REFUSES an audience that is also EXCLUDED — it would send to nobody', () => {
  // The exact shape that produces a silent zero-recipient send: the exclusion
  // wins, so the campaign goes out to an empty audience and simply reports 0.
  assert.throws(
    () => withIncludedAudience({ included: ['Y2ukbE'], excluded: ['ENG123'] }, 'ENG123'),
    /excluded/i,
  );
});

test('replaces MULTIPLE included audiences with the single engaged one', () => {
  const out = withIncludedAudience({ included: ['Y2ukbE', 'Tamb9u'], excluded: ['UigAyc'] }, 'ENG123');
  assert.deepEqual(out.audiences.included, ['ENG123']);
});
