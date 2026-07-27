import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partitionByTargetHealth, validateFlags, loadAllRedirects } from '../../scripts/consolidate-collections.mjs';

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

test('--apply and --json together is rejected rather than silently no-op-ing', () => {
  assert.throws(() => validateFlags({ apply: true, asJson: true }), /--apply and --json/);
});

test('--apply alone and --json alone are both fine', () => {
  assert.doesNotThrow(() => validateFlags({ apply: true, asJson: false }));
  assert.doesNotThrow(() => validateFlags({ apply: false, asJson: true }));
  assert.doesNotThrow(() => validateFlags({ apply: false, asJson: false }));
});

test('loadAllRedirects pages past a full 250-row first page instead of truncating', async () => {
  const firstPage = Array.from({ length: 250 }, (_, i) => ({ id: i + 1, path: `/a/${i + 1}` }));
  const secondPage = [{ id: 251, path: '/a/251' }, { id: 252, path: '/a/252' }];
  const calls = [];
  const fetchRedirects = async (params) => {
    calls.push(params);
    return calls.length === 1 ? firstPage : secondPage;
  };
  const all = await loadAllRedirects(fetchRedirects);
  assert.equal(calls.length, 2, 'a full page must trigger a second request');
  assert.equal(calls[1].since_id, 250, 'the second request must page from the last id seen');
  assert.equal(all.length, 252, 'both pages must end up in the combined set');
  assert.ok(all.some((r) => r.path === '/a/1'));
  assert.ok(all.some((r) => r.path === '/a/252'));
});

test('loadAllRedirects stops after a single short page', async () => {
  const calls = [];
  const fetchRedirects = async (params) => {
    calls.push(params);
    return [{ id: 1, path: '/a/1' }];
  };
  const all = await loadAllRedirects(fetchRedirects);
  assert.equal(calls.length, 1, 'a page shorter than the limit must not trigger another request');
  assert.equal(all.length, 1);
});
