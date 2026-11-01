import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planMove } from '../../scripts/reorder-product-media.mjs';

const NODES = [
  { id: 'm1', url: 'https://cdn/body_lotion_coconut.webp' },
  { id: 'm2', url: 'https://cdn/body_lotion_unscented.webp' },
  { id: 'm3', url: 'https://cdn/lotion-beach-real.jpg' },
  { id: 'm4', url: 'https://cdn/coconut-lotion-ingredients-pdp.jpg' },
];

test('plans a 1-based move for exactly one match', () => {
  assert.deepEqual(planMove(NODES, 'ingredients-pdp', 3), { id: 'm4', from: 4, to: 3 });
});

test('position 1 is refused — it is the featured image Shopping and collection cards use', () => {
  assert.throws(() => planMove(NODES, 'ingredients-pdp', 1), /featured image/);
});

test('an ambiguous or missing match is refused rather than guessed', () => {
  assert.throws(() => planMove(NODES, 'body_lotion', 2), /matched 2/);
  assert.throws(() => planMove(NODES, 'nope', 2), /matched 0/);
});

test('a position past the end is refused', () => {
  assert.throws(() => planMove(NODES, 'beach', 9), /past the last/);
});
