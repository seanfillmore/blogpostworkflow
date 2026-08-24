import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { summarizeEntrants } from '../../lib/giveaway/summarize.js';

const p = (props) => ({ id: 'x', email: `${Math.random()}@x.com`, properties: props });

test('counts entrants and sums server-side entry totals', () => {
  const s = summarizeEntrants([
    p({ gv_entries: 1, gv_breakdown: { confirmed: false, survey: false, referrals: 0 } }),
    p({ gv_entries: 8, gv_breakdown: { confirmed: true, survey: false, referrals: 1 } }),
  ]);
  assert.equal(s.total, 2);
  assert.equal(s.entriesTotal, 9);
});

test('tallies the answer mix, which is the day-5 lead-quality gate', () => {
  const s = summarizeEntrants([
    p({ gv_entries: 1, gv_frustration: 'reactive' }),
    p({ gv_entries: 1, gv_frustration: 'reactive' }),
    p({ gv_entries: 1, gv_frustration: 'dry' }),
  ]);
  assert.equal(s.answers.frustration.reactive, 2);
  assert.equal(s.answers.frustration.dry, 1);
});

test('reports referral participation, the day-10 gate', () => {
  const s = summarizeEntrants([
    p({ gv_entries: 6, gv_breakdown: { referrals: 1 } }),
    p({ gv_entries: 1, gv_breakdown: { referrals: 0 } }),
  ]);
  assert.equal(s.ladder.referrals, 1);
  assert.equal(s.ladder.entrantsWithReferrals, 1);
});

test('a missing gv_entries falls back to 1 rather than NaN', () => {
  const s = summarizeEntrants([p({})]);
  assert.equal(s.entriesTotal, 1);
});

test('a corrupt gv_entries falls back to 1 instead of poisoning the whole total', () => {
  // NaN + x is NaN for every later addition, so one bad row would blank the
  // entire report -- and the day-5 spend decision is made from this number.
  const s = summarizeEntrants([p({ gv_entries: 'unknown' }), p({ gv_entries: 5 })]);
  assert.equal(s.entriesTotal, 6);
});

test('INTEGRATION: a profile shaped the way the endpoint actually writes it yields a populated answer mix', () => {
  // This is the test whose absence let a real defect ship. summarizeEntrants
  // reads TOP-LEVEL gv_* properties; an earlier version of the endpoint stored
  // survey answers inside gv_breakdown instead. Both sides' unit tests passed
  // while answers.* was permanently empty in production, which would have made
  // the day-5 answer-mix gate fire a false alarm on every single run.
  const asEndpointWrites = {
    gv_entrant: true,
    gv_entries: 4,
    gv_breakdown: { confirmed: false, survey: true, referrals: 0, instagram: false, upload: false },
    gv_household: 'family',
    gv_frustration: 'fragrance',
    gv_current_brand: 'cerave',
  };
  const s = summarizeEntrants([{ id: 'x', email: 'a@x.com', properties: asEndpointWrites }]);
  assert.equal(s.answers.frustration.fragrance, 1, 'the report must see the answers the endpoint wrote');
  assert.equal(s.answers.household.family, 1);
  assert.equal(s.answers.currentBrand.cerave, 1);
  assert.equal(s.ladder.survey, 1, 'and the ladder rung still comes from the breakdown');
});

test('test profiles are excluded from every count, so they cannot skew the day-5 gate', () => {
  const real = { id: 'r', email: 'real@x.com', properties: {
    gv_entries: 8, gv_frustration: 'reactive',
    gv_breakdown: { confirmed: true, survey: true, referrals: 1, instagram: false, upload: false },
  } };
  const fake = { id: 't', email: 'test@x.com', properties: {
    gv_test: true, gv_entries: 24, gv_frustration: 'dry',
    gv_breakdown: { confirmed: true, survey: true, referrals: 1, instagram: true, upload: true },
  } };
  const s = summarizeEntrants([real, fake]);
  assert.equal(s.total, 1, 'only the real entrant counts');
  assert.equal(s.entriesTotal, 8, 'the fake 24 must not be summed');
  assert.equal(s.answers.frustration.dry, undefined, 'the fake answer must not enter the mix');
  assert.equal(s.answers.frustration.reactive, 1);
  assert.equal(s.ladder.upload, 0, 'the fake upload must not be counted');
  assert.equal(s.excludedTestProfiles, 1, 'and the exclusion is reported, not silent');
});

test('with no test profiles present the exclusion count is zero rather than absent', () => {
  const s = summarizeEntrants([{ id: 'r', email: 'r@x.com', properties: { gv_entries: 1 } }]);
  assert.equal(s.excludedTestProfiles, 0);
});

// ── confirmation is only readable on a MATURED cohort ────────────────────────
// The daily report divided all-time confirmations by all-time submissions. On
// 2026-08-21 that printed 26% while the ENTIRE entrant population was under 31
// hours old and nobody had yet reached the 48h mark where the first
// re-confirmation nudge fires. Confirmation rose monotonically with age
// (18% under 6h, 24% at 6-24h, 36% at 24-48h), so the headline number was
// measuring recency, not consent — and it understates for as long as fresh
// entrants keep arriving, which is the whole point of running ads.
import { confirmationFunnel, CONFIRM_MATURITY_HOURS } from '../../lib/giveaway/summarize.js';
import { MIN_HOURS_BETWEEN } from '../../scripts/giveaway/nudge-unconfirmed.mjs';

{
  // The two constants must not drift: maturity means "the nudge has had its
  // first chance", so it is defined by the nudge's own gap.
  assert.equal(CONFIRM_MATURITY_HOURS, MIN_HOURS_BETWEEN,
    'maturity threshold tracks the nudge gap — a matured entrant is one the nudge could have reached');
}

{
  const now = Date.parse('2026-08-21T12:00:00Z');
  const h = (n) => new Date(now - n * 3600_000).toISOString();
  const submitted = [
    { email: 'old-yes@x.com', properties: { gv_entered_at: h(72) } },
    { email: 'old-no@x.com', properties: { gv_entered_at: h(60) } },
    { email: 'mid-yes@x.com', properties: { gv_entered_at: h(30) } },
    { email: 'new-no@x.com', properties: { gv_entered_at: h(2) } },
    { email: 'new-no2@x.com', properties: { gv_entered_at: h(1) } },
  ];
  const confirmed = new Set(['old-yes@x.com', 'mid-yes@x.com']);
  const f = confirmationFunnel({ submitted, confirmedEmails: confirmed, now });

  assert.equal(f.submitted, 5);
  assert.equal(f.confirmed, 2);
  assert.equal(f.unconfirmed, 3);
  assert.equal(f.confirmationRate, 0.4, 'raw rate is still reported, unchanged');

  // Only the two past 48h count toward the readable number: 1 of 2.
  assert.equal(f.matured.submitted, 2, 'only entrants past the nudge gap are mature');
  assert.equal(f.matured.confirmed, 1);
  assert.equal(f.matured.rate, 0.5, 'the rate that can actually be judged');
  // pending = unconfirmed AND still inside the window. mid-yes is young but
  // already confirmed, so it is not pending — only the two fresh non-confirmers are.
  assert.equal(f.pending, 2, 'still inside the window — not yet a loss');
}

{
  // The state that produced the false alarm: nobody mature yet.
  const now = Date.parse('2026-08-21T12:00:00Z');
  const submitted = [
    { email: 'a@x.com', properties: { gv_entered_at: new Date(now - 30 * 3600_000).toISOString() } },
    { email: 'b@x.com', properties: { gv_entered_at: new Date(now - 3 * 3600_000).toISOString() } },
  ];
  const f = confirmationFunnel({ submitted, confirmedEmails: new Set(), now });
  assert.equal(f.matured.submitted, 0);
  assert.equal(f.matured.rate, null,
    'no mature cohort means NO RATE — never 0%, which would read as total failure');
  assert.equal(f.pending, 2);
}

{
  // A profile with no gv_entered_at cannot be aged; it must not silently count
  // as mature (which would drag the readable rate toward the raw one).
  const now = Date.parse('2026-08-21T12:00:00Z');
  const f = confirmationFunnel({
    submitted: [{ email: 'nodate@x.com', properties: {} }],
    confirmedEmails: new Set(), now,
  });
  assert.equal(f.matured.submitted, 0, 'undateable entrants are excluded from the mature cohort');
  assert.equal(f.undateable, 1, 'and are counted so the exclusion is visible');
}

console.log('✓ giveaway confirmation-funnel tests pass');

test('referralsNamed counts everyone who TYPED a referrer, credited or not', () => {
  // The reporting artifact this exists to stop. `referrals` and
  // `entrantsWithReferrals` are CREDITED counts — a rung pays only once both
  // parties confirm — so mid-campaign they sit at 0 while people are referring
  // steadily. On 2026-08-24 that was 41 named against 0 credited, and the 0 was
  // read as "zero referral participation" and reported to the operator as a CTA
  // failure. Named is the denominator that makes the credited figure legible.
  const s = summarizeEntrants([
    p({ gv_entries: 1, gv_referred_by: 'a@x.com', gv_breakdown: { referrals: 0 } }),
    p({ gv_entries: 1, gv_referred_by: 'b@x.com', gv_breakdown: { referrals: 0 } }),
    p({ gv_entries: 6, gv_referred_by: 'c@x.com', gv_breakdown: { referrals: 1 } }),
    p({ gv_entries: 1, gv_breakdown: { referrals: 0 } }),
  ]);
  assert.equal(s.ladder.referralsNamed, 3, 'three entrants named someone');
  assert.equal(s.ladder.referrals, 1, 'only one of them has been credited');
  assert.equal(s.ladder.entrantsWithReferrals, 1);
});

test('a blank or whitespace referrer field is not an attempt', () => {
  // The form submits the optional field whether or not it was filled in, so a
  // truthiness check on the raw value would count every entrant as a referrer
  // and make the denominator meaningless in the opposite direction.
  const s = summarizeEntrants([
    p({ gv_entries: 1, gv_referred_by: '', gv_breakdown: { referrals: 0 } }),
    p({ gv_entries: 1, gv_referred_by: '   ', gv_breakdown: { referrals: 0 } }),
    p({ gv_entries: 1, gv_breakdown: { referrals: 0 } }),
  ]);
  assert.equal(s.ladder.referralsNamed, 0);
});
