import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planFromList } from '../../scripts/suppress-judgeme-reviews.mjs';

const R = (id, rating, extra = {}) => ({ id, rating, product_handle: 'p', reviewer: { name: 'n' }, published: true, hidden: false, curated: 'ok', ...extra });

test('planFromList refuses to suppress a negative review', () => {
  assert.throws(() => planFromList([{ id: 1, why: 'x' }], [R(1, 3)]), /negative/);
});

test('planFromList skips already-suppressed and reports missing ids', () => {
  const { plan, missing } = planFromList([{ id: 1, why: 'a' }, { id: 2, why: 'b' }, { id: 9, why: 'c' }],
    [R(1, 5), R(2, 5, { curated: 'spam', hidden: true })]);
  assert.deepEqual(plan.map((p) => p.id), [1]);
  assert.deepEqual(missing, [9]);
});

test('the 2026-10-06 list holds no drug-claim testimonial Sean chose to keep', () => {
  const list = JSON.parse(readFileSync('data/reviews/judgeme-audit-2026-10-06.json', 'utf8')).reviews;
  assert.equal(list.length, 74);
  for (const keep of [610363288, 372138917, 514327170, 762232235, 514327167]) {
    assert.ok(!list.some((e) => e.id === keep), `${keep} must stay published`);
  }
});
