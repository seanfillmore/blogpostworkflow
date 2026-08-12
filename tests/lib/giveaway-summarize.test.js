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
