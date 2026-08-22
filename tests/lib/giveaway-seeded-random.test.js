// tests/lib/giveaway-seeded-random.test.js
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { seedFromString, mulberry32, shuffle } from '../../lib/giveaway/seeded-random.js';

test('the same seed string always produces the same numeric seed', () => {
  assert.equal(seedFromString('43214.87'), seedFromString('43214.87'));
  assert.notEqual(seedFromString('43214.87'), seedFromString('43214.88'));
});

test('mulberry32 is deterministic and stays in [0,1)', () => {
  const a = mulberry32(12345);
  const b = mulberry32(12345);
  const first = Array.from({ length: 20 }, () => a());
  const second = Array.from({ length: 20 }, () => b());
  assert.deepEqual(first, second, 'same seed must replay exactly');
  for (const n of first) {
    assert.ok(n >= 0 && n < 1, `${n} out of range`);
  }
});

test('two different seeds diverge', () => {
  const a = mulberry32(1);
  const b = mulberry32(2);
  assert.notEqual(a(), b());
});

test('shuffle is deterministic for a given generator and does not mutate input', () => {
  const input = ['a', 'b', 'c', 'd', 'e', 'f'];
  const frozen = [...input];
  const one = shuffle(input, mulberry32(99));
  const two = shuffle(input, mulberry32(99));
  assert.deepEqual(one, two, 'same seed must produce the same order');
  assert.deepEqual(input, frozen, 'the input array must not be mutated');
  assert.equal(one.length, input.length);
  assert.deepEqual([...one].sort(), [...frozen].sort(), 'shuffle must be a permutation');
});

test('shuffle actually moves things', () => {
  // A "shuffle" that returned its input unchanged would pass every test above.
  const input = Array.from({ length: 50 }, (_, i) => i);
  const out = shuffle(input, mulberry32(7));
  assert.notDeepEqual(out, input, 'a 50-element shuffle returning identity is a bug, not luck');
});

test('shuffle is unbiased enough that every position is reachable', () => {
  // Fisher-Yates implemented with the wrong loop bound leaves element 0 fixed.
  const seen = new Set();
  for (let s = 0; s < 200; s += 1) {
    seen.add(shuffle(['a', 'b', 'c'], mulberry32(s))[0]);
  }
  assert.deepEqual([...seen].sort(), ['a', 'b', 'c'], 'every element must be able to land first');
});
