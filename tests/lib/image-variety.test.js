import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickPool, shotTypePool, SHOT_TYPES } from '../../lib/image-variety.js';

const items = [{ key: 'a' }, { key: 'b' }, { key: 'c' }, { key: 'd' }, { key: 'e' }];

test('excludes recently-used keys', () => {
  const pool = pickPool(items, ['a', 'b'], 2);
  assert.deepEqual(pool.map((i) => i.key).sort(), ['c', 'd', 'e']);
});

test('forgives the oldest exclusions when the pool gets too small', () => {
  // used (oldest→newest) = a,b,c,d; only "e" left < minPool 3, so forgive
  // oldest (a, then b) until >=3 remain → c,d forgiven? no: forgive a → b,c,d excluded → e only (1);
  // forgive b → c,d excluded → a,e (2); forgive c → d excluded → a,b,e (3) ✓
  const pool = pickPool(items, ['a', 'b', 'c', 'd'], 3);
  assert.equal(pool.length >= 3, true);
  // the most-recent exclusion (d) is still excluded
  assert.equal(pool.some((i) => i.key === 'd'), false);
});

test('keeps the newest exclusion out the longest', () => {
  const pool = pickPool(items, ['a', 'b', 'c', 'd', 'e'], 2);
  // everything excluded → must forgive oldest first; newest (e) excluded longest
  assert.equal(pool.some((i) => i.key === 'e'), false);
  assert.equal(pool.length >= 2, true);
});

test('no exclusions → full set', () => {
  assert.deepEqual(pickPool(items, [], 3).map((i) => i.key), ['a', 'b', 'c', 'd', 'e']);
});

test('falls back to all items if minPool cannot be met', () => {
  const two = [{ key: 'x' }, { key: 'y' }];
  const pool = pickPool(two, ['x', 'y'], 3);
  assert.equal(pool.length, 2); // can't reach 3; returns what it can (all)
});

test('shotTypePool: after a surface shot, the pool is all non-surface', () => {
  const pool = shotTypePool(['styled-angle']);
  assert.ok(pool.length > 0);
  assert.ok(pool.every((s) => s.surface === false), 'no surface shot may follow a surface shot');
});

test('shotTypePool: after a non-surface shot, surface shots are allowed again', () => {
  const pool = shotTypePool(['macro-detail']);
  assert.ok(pool.some((s) => s.surface === true), 'surface shots can follow a non-surface shot');
});

test('shotTypePool: empty history allows the full range', () => {
  const pool = shotTypePool([]);
  assert.ok(pool.some((s) => s.surface === true) && pool.some((s) => s.surface === false));
});

test('SHOT_TYPES covers distinct genres incl. non-surface shots', () => {
  const keys = SHOT_TYPES.map((s) => s.key);
  assert.ok(keys.length >= 5, 'expected at least 5 shot genres');
  // must include genres that are NOT object-on-a-surface
  assert.ok(keys.includes('in-use'));
  assert.ok(keys.includes('macro-detail'));
  assert.ok(keys.includes('environmental'));
  // each surface flag is a boolean
  for (const s of SHOT_TYPES) assert.equal(typeof s.surface, 'boolean');
});
