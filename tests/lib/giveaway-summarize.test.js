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
