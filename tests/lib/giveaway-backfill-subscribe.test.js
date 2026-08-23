// tests/lib/giveaway-backfill-subscribe.test.js
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  selectBackfillTargets, DEFAULT_LIMIT, BACKFILL_STAMP,
} from '../../scripts/giveaway/backfill-subscribe-entrants.mjs';

const sub = (email, properties = {}) => ({ email, properties });
const run = (submitted, { listed = [], confirmed = [], limit = DEFAULT_LIMIT } = {}) =>
  selectBackfillTargets({
    submitted,
    listedEmails: new Set(listed),
    confirmedEmails: new Set(confirmed),
    limit,
  });

test('an entrant who submitted but never confirmed is subscribed', () => {
  const { due } = run([sub('pending@x.com')]);
  assert.deepEqual(due.map((d) => d.email), ['pending@x.com']);
});

test('a confirmed entrant is never touched', () => {
  const { due, skipped } = run([sub('done@x.com')], { listed: ['done@x.com'], confirmed: ['done@x.com'] });
  assert.deepEqual(due, []);
  assert.equal(skipped[0].why, 'already confirmed');
});

test('someone already on the list is skipped as listed, not as confirmed', () => {
  // These are different states under flow_link and the report has to tell them
  // apart — "on the list" no longer implies "clicked anything".
  const { due, skipped } = run([sub('listed@x.com')], { listed: ['listed@x.com'] });
  assert.deepEqual(due, []);
  assert.equal(skipped[0].why, 'already on the list');
});

test('a previously backfilled profile is not written twice', () => {
  const { due, skipped } = run([sub('again@x.com', { [BACKFILL_STAMP]: '2026-08-23T00:00:00.000Z' })]);
  assert.deepEqual(due, []);
  assert.equal(skipped[0].why, 'already backfilled');
});

test('matching is case-insensitive, so a mixed-case address is not re-subscribed', () => {
  const { due } = run([sub('MiXeD@X.com')], { listed: ['mixed@x.com'] });
  assert.deepEqual(due, [], 'a case difference must not create a duplicate subscribe');
});

test('the batch limit holds back the remainder rather than dropping it', () => {
  // Silent truncation would read as "everyone is done" on a run that covered a
  // fraction of the population.
  const submitted = Array.from({ length: 12 }, (_, i) => sub(`e${i}@x.com`));
  const { due, heldBack } = run(submitted, { limit: 5 });
  assert.equal(due.length, 5);
  assert.equal(heldBack, 7);
});

test('an unusable address is reported, not silently dropped', () => {
  const { due, skipped } = run([sub(''), sub(null)]);
  assert.deepEqual(due, []);
  assert.equal(skipped.length, 2);
  assert.ok(skipped.every((s) => s.why === 'unusable address'));
});

test('the default batch is well under the 330-entrant population', () => {
  // Pins the intent of the header: this is a staged rollout, not one big send.
  assert.ok(DEFAULT_LIMIT <= 100, `DEFAULT_LIMIT ${DEFAULT_LIMIT} is too close to a full-population send`);
});
