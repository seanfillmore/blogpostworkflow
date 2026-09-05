import test from 'node:test';
import assert from 'node:assert/strict';

import { groupTrueDuplicates, chooseKeeper, planSuppressions } from '../../scripts/dedupe-judgeme-reviews.mjs';

const rev = (o) => ({
  id: 1, body: 'Lovely soap, lathers well and does not dry my hands.', rating: 5,
  product_title: 'Moisturizing Coconut Soap | 3.4oz', reviewer: { name: 'Ada L.' },
  published: true, hidden: false, curated: 'ok', has_published_pictures: false, verified: 'buyer', ...o,
});

test('same body + same product + same reviewer is a true duplicate', () => {
  const g = groupTrueDuplicates([rev({ id: 1 }), rev({ id: 2 })]);
  assert.equal(g.length, 1);
  assert.equal(g[0].length, 2);
});

test('SAME BODY on a DIFFERENT PRODUCT is never grouped', () => {
  // 56 such groups exist live. Suppressing the wrong one strips real proof off
  // a PDP, and only a human can say which product the review was written about.
  const g = groupTrueDuplicates([rev({ id: 1 }), rev({ id: 2, product_title: 'Organic Body Lotion' })]);
  assert.equal(g.length, 0);
});

test('same body from a DIFFERENT reviewer is never grouped', () => {
  const g = groupTrueDuplicates([rev({ id: 1 }), rev({ id: 2, reviewer: { name: 'Bo T.' } })]);
  assert.equal(g.length, 0);
});

test('whitespace and case differences still count as the same body', () => {
  const g = groupTrueDuplicates([rev({ id: 1 }), rev({ id: 2, body: '  LOVELY soap,   lathers well and does not dry my hands.  ' })]);
  assert.equal(g.length, 1);
});

test('an empty body is never grouped', () => {
  assert.equal(groupTrueDuplicates([rev({ id: 1, body: '' }), rev({ id: 2, body: '   ' })]).length, 0);
});

test('A COPY WITH A PHOTO IS ALWAYS THE KEEPER, even with a higher id', () => {
  // 27 of the 64 live groups differ on pictures. A photo review is worth
  // strictly more and must never be the one hidden.
  const keeper = chooseKeeper([rev({ id: 10 }), rev({ id: 99, has_published_pictures: true })]);
  assert.equal(keeper.id, 99);
});

test('with no photo either way, the lowest id wins — stable across runs', () => {
  assert.equal(chooseKeeper([rev({ id: 99 }), rev({ id: 10 })]).id, 10);
  assert.equal(chooseKeeper([rev({ id: 10 }), rev({ id: 99 })]).id, 10);
});

test('exactly one record per group survives', () => {
  const plan = planSuppressions([rev({ id: 1 }), rev({ id: 2 }), rev({ id: 3 })]);
  assert.equal(plan.length, 2);
  assert.deepEqual([...new Set(plan.map((p) => p.keepId))], [1]);
  assert.ok(!plan.some((p) => p.id === p.keepId), 'never suppress the keeper');
});

test('an already-suppressed duplicate is not touched again', () => {
  const plan = planSuppressions([rev({ id: 1 }), rev({ id: 2, curated: 'spam', hidden: true, published: false })]);
  assert.equal(plan.length, 0);
});

test('a unique review is never in the plan', () => {
  assert.equal(planSuppressions([rev({ id: 1 }), rev({ id: 2, body: 'A completely different review.' })]).length, 0);
});

test('the plan records prior state so a restore can be verified', () => {
  const plan = planSuppressions([rev({ id: 1 }), rev({ id: 2 })]);
  assert.deepEqual(plan[0].was, { published: true, hidden: false, curated: 'ok' });
  assert.ok(plan[0].excerpt.length > 10, 'an excerpt makes the run record readable cold');
});

test('no reviewer PII reaches the plan', () => {
  const plan = planSuppressions([
    rev({ id: 1, reviewer: { name: 'Ada L.', email: 'a@b.com', phone: '15551234567', id: 999 } }),
    rev({ id: 2, reviewer: { name: 'Ada L.', email: 'a@b.com', phone: '15551234567', id: 999 } }),
  ]);
  const blob = JSON.stringify(plan);
  assert.doesNotMatch(blob, /@/, 'no email');
  assert.doesNotMatch(blob, /15551234567/, 'no phone');
  assert.match(blob, /Ada L\./, 'the display name is kept — it is what makes the record legible');
});
