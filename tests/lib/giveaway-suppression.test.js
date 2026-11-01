// tests/lib/giveaway-suppression.test.js
//
// Suppressing the §5-disqualified cohort takes them out of Klaviyo's billable
// active-profile count (suppressed profiles do not contribute to the plan) and
// stops any future send reaching them.
//
// The whole risk of this operation is suppressing the WRONG person: a legitimate
// entrant, an exempt one, the winner, or an alternate. Suppression is reversible
// in principle and invisible in practice — nobody notices they stopped getting
// email — so the guards have to be arithmetic, not vigilance.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  suppressionBatches, assertSafeToSuppress, verificationSample, submitSuppressionJobs,
} from '../../lib/giveaway/suppression.js';

const pool = (emails) => ({ entrants: emails.map((email) => ({ email })) });

test('batches are capped at the API maximum of 100', () => {
  const emails = Array.from({ length: 250 }, (_, i) => `b${i}@outlook.com`);
  const batches = suppressionBatches(emails);
  assert.equal(batches.length, 3);
  assert.equal(batches[0].length, 100);
  assert.equal(batches[2].length, 50);
  assert.deepEqual(batches.flat(), emails, 'no address is dropped or duplicated');
});

test('an empty list yields no batches rather than one empty call', () => {
  assert.deepEqual(suppressionBatches([]), []);
});

test('a batch size above the API maximum is refused', () => {
  assert.throws(() => suppressionBatches(['a@x.com'], 101), /100/);
});

test('REFUSES when an address to suppress is in the draw pool', () => {
  // The two sets are disjoint by construction — 2,948 + 4,419 = 7,367. This
  // turns "by construction" into "verified", so a later edit to the evidence
  // file or the fraud window cannot quietly suppress a real entrant.
  assert.throws(
    () => assertSafeToSuppress(['bot@outlook.com', 'real@gmail.com'], pool(['real@gmail.com']), 2),
    /draw pool/,
  );
});

test('REFUSES when the winner is among them', () => {
  assert.throws(
    () => assertSafeToSuppress(['winner@gmail.com'], pool(['winner@gmail.com', 'x@y.com']), 1),
    /draw pool/,
  );
});

test('passes when the two sets are disjoint', () => {
  assert.equal(
    assertSafeToSuppress(['bot@outlook.com'], pool(['real@gmail.com']), 1),
    true,
  );
});

test('REFUSES when the count disagrees with the evidence record', () => {
  // Catches a truncated or hand-edited evidence file: the list being suppressed
  // must be exactly the list that was disqualified, not a subset of it.
  assert.throws(
    () => assertSafeToSuppress(['a@outlook.com'], pool(['real@gmail.com']), 2948),
    /2948/,
  );
});

test('comparison is case-insensitive, so a recased address cannot slip through', () => {
  assert.throws(
    () => assertSafeToSuppress(['Real@Gmail.com'], pool(['real@gmail.com']), 1),
    /draw pool/,
  );
});

test('REFUSES an empty suppression list rather than reporting a vacuous success', () => {
  assert.throws(() => assertSafeToSuppress([], pool(['a@b.com']), 0), /empty/);
});

test('a verification sample SPREADS across the whole list, not just its head', () => {
  // The flaw this closes, found by verifying the real run rather than trusting
  // it: taking the first N addresses samples only the FIRST batch, so a 25-of-25
  // pass confirmed one batch of 100 and inferred the other twenty-nine.
  const emails = Array.from({ length: 2948 }, (_, i) => `b${i}@outlook.com`);
  const picked = verificationSample(emails, 25);
  assert.equal(picked.length, 25);
  assert.equal(picked[0], emails[0], 'includes the first');
  assert.equal(picked.at(-1), emails.at(-1), 'includes the LAST — the final batch is the one most likely to be cut short');
  const spread = new Set(picked.map((e) => Math.floor(emails.indexOf(e) / 100)));
  assert.ok(spread.size >= 20, `should touch many batches, touched ${spread.size}`);
});

test('a verification sample of a short list is the whole list, without duplicates', () => {
  const emails = ['a@x.com', 'b@x.com', 'c@x.com'];
  const picked = verificationSample(emails, 25);
  assert.deepEqual(picked, emails);
  assert.equal(new Set(picked).size, picked.length);
});

test('submitSuppressionJobs polls each job and SURFACES skipped_count', async () => {
  // The silent-loss case: the queue accepts 200 addresses and quietly skips 15.
  // Without polling that is invisible, which is exactly what happened on the real
  // 1,402-address prune (~8% never took, nothing errored).
  const calls = [];
  const deps = {
    sleep: async () => {},
    log: (m) => calls.push(m),
    request: async (method, path) => {
      if (method === 'POST') return { data: { id: `job-${calls.length}` } };
      return { data: { attributes: { status: 'complete', total_count: 100, completed_count: 93, skipped_count: 7 } } };
    },
  };
  const emails = Array.from({ length: 200 }, (_, i) => `b${i}@x.com`);
  const r = await submitSuppressionJobs({ emails, deps });
  assert.equal(r.submitted, 200);
  assert.equal(r.batches, 2);
  assert.equal(r.completed, 186);
  assert.equal(r.skipped, 14, 'the skipped addresses must be counted, not lost');
  assert.equal(r.unpollable, 0);
});

test('submitSuppressionJobs reports batches it cannot poll rather than assuming success', async () => {
  const deps = {
    sleep: async () => {}, log: () => {},
    request: async (method) => (method === 'POST' ? { ok: true } : { data: { attributes: {} } }),
  };
  const r = await submitSuppressionJobs({ emails: ['a@x.com'], deps });
  assert.equal(r.unpollable, 1, 'a job with no id is unverifiable and must be said so');
  assert.equal(r.completed, 0);
});
