import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partitionByTargetHealth } from '../../scripts/consolidate-collections.mjs';

const plan = [
  { handle: 'vegan-deodorant', target: '/products/coconut-oil-deodorant' },
  { handle: 'rose-lotion', target: '/collections/non-toxic-body-lotion' },
  { handle: 'orphan', target: '/collections/does-not-exist' },
];

test('a target that is not live blocks its redirect instead of writing it', async () => {
  const isLive = async (p) => p !== '/collections/does-not-exist';
  const { ready, blocked } = await partitionByTargetHealth(plan, isLive);
  assert.equal(ready.length, 2);
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].handle, 'orphan');
});

test('each distinct target is health-checked once, not once per source', async () => {
  const seen = [];
  const isLive = async (p) => { seen.push(p); return true; };
  const many = [
    { handle: 'a', target: '/collections/non-toxic-body-lotion' },
    { handle: 'b', target: '/collections/non-toxic-body-lotion' },
    { handle: 'c', target: '/collections/non-toxic-body-lotion' },
  ];
  await partitionByTargetHealth(many, isLive);
  assert.equal(seen.length, 1, 'target health must be cached per distinct target');
});

test('all targets dead means nothing is ready and nothing throws', async () => {
  const { ready, blocked } = await partitionByTargetHealth(plan, async () => false);
  assert.equal(ready.length, 0);
  assert.equal(blocked.length, 3);
});
