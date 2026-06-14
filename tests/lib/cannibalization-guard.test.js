import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { findSemanticDuplicate, similarity } from '../../lib/cannibalization-guard.js';

test('similarity: identical keywords = 1', () => {
  assert.equal(similarity('natural deodorant', 'natural deodorant'), 1);
});

test('similarity: token-order-insensitive near-dup is high', () => {
  assert.ok(similarity('sls free toothpaste', 'toothpaste without sls') >= 0.5);
});

test('similarity: unrelated keywords are low', () => {
  assert.ok(similarity('natural deodorant', 'coconut lip balm') < 0.3);
});

test('findSemanticDuplicate: returns the near-duplicate existing keyword', () => {
  const existing = ['toothpaste without sls', 'best natural deodorant'];
  const dup = findSemanticDuplicate('sls free toothpaste', existing, { threshold: 0.5 });
  assert.equal(dup, 'toothpaste without sls');
});

test('findSemanticDuplicate: returns null when nothing is similar enough', () => {
  assert.equal(findSemanticDuplicate('natural lip balm', ['best natural deodorant'], { threshold: 0.5 }), null);
});

test('findSemanticDuplicate: exact match counts as duplicate', () => {
  assert.equal(findSemanticDuplicate('Natural Deodorant', ['natural deodorant'], { threshold: 0.5 }), 'natural deodorant');
});

test('findSemanticDuplicate: ignores stopwords so "best X" ~ "X"', () => {
  // 'the best natural deodorant for men' vs 'natural deodorant for men' — core tokens overlap heavily
  const dup = findSemanticDuplicate('the best natural deodorant for men', ['natural deodorant for men'], { threshold: 0.6 });
  assert.equal(dup, 'natural deodorant for men');
});

test('empty inputs are safe', () => {
  assert.equal(findSemanticDuplicate('', ['x'], {}), null);
  assert.equal(findSemanticDuplicate('x', [], {}), null);
});

import { differentSegments } from '../../lib/cannibalization-guard.js';

test('segment-aware: "natural deodorant" vs "...for women" are NOT duplicates (distinct audience)', () => {
  assert.equal(findSemanticDuplicate('natural deodorant for women', ['natural deodorant'], { threshold: 0.6 }), null);
  assert.equal(findSemanticDuplicate('natural deodorant', ['natural deodorant for women'], { threshold: 0.6 }), null);
});

test('segment-aware: for-women vs for-men are NOT duplicates', () => {
  assert.equal(findSemanticDuplicate('natural deodorant for women', ['natural deodorant for men'], { threshold: 0.6 }), null);
});

test('segment-aware: same segment near-dups still caught', () => {
  assert.equal(findSemanticDuplicate('deodorant for women without aluminum', ['aluminum free deodorant for women'], { threshold: 0.5 }), 'aluminum free deodorant for women');
});

test('differentSegments: detects mismatch and match', () => {
  assert.equal(differentSegments('x for women', 'x for men'), true);
  assert.equal(differentSegments('x for women', 'x'), true);
  assert.equal(differentSegments('x', 'y'), false);
  assert.equal(differentSegments('x for sensitive skin', 'y for sensitive skin'), false);
});
