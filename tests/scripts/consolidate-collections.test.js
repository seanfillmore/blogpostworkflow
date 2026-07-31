import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  partitionByTargetHealth, validateFlags, loadAllRedirects,
  diffRedirectsAgainstPlan, findChainedRedirects,
} from '../../scripts/consolidate-collections.mjs';

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

// --- diffRedirectsAgainstPlan (Important 5 & 6: target-aware idempotency) ---

test('a source with no existing redirect is toCreate', () => {
  const readyPlan = [{ handle: 'vegan-deodorant', target: '/products/coconut-oil-deodorant', live: true }];
  const { toCreate, toRewrite, alreadyCorrect } = diffRedirectsAgainstPlan(readyPlan, []);
  assert.equal(toCreate.length, 1);
  assert.equal(toRewrite.length, 0);
  assert.equal(alreadyCorrect.length, 0);
});

test('a source whose existing redirect already matches the plan target is alreadyCorrect, not skipped by path alone', () => {
  const readyPlan = [{ handle: 'vegan-deodorant', target: '/products/coconut-oil-deodorant', live: true }];
  const existing = [{ id: 1, path: '/collections/vegan-deodorant', target: '/products/coconut-oil-deodorant' }];
  const { toCreate, toRewrite, alreadyCorrect } = diffRedirectsAgainstPlan(readyPlan, existing);
  assert.equal(toCreate.length, 0);
  assert.equal(toRewrite.length, 0);
  assert.equal(alreadyCorrect.length, 1);
});

// Regression guard: a path-only idempotency check treated "a redirect exists"
// as "the redirect is correct" — live audit found 22 of 23 previously-skipped
// sources had a stale target. This must be caught and rewritten.
test('a source whose existing redirect points at a stale target is toRewrite, carrying the old redirect id and stale target', () => {
  const readyPlan = [{ handle: 'natural-toothpaste', target: '/products/coconut-oil-toothpaste', live: true }];
  const existing = [{ id: 42, path: '/collections/natural-toothpaste', target: '/collections/sls-free-toothpaste' }];
  const { toCreate, toRewrite, alreadyCorrect } = diffRedirectsAgainstPlan(readyPlan, existing);
  assert.equal(toCreate.length, 0);
  assert.equal(alreadyCorrect.length, 0);
  assert.equal(toRewrite.length, 1);
  assert.equal(toRewrite[0].existingRedirectId, 42);
  assert.equal(toRewrite[0].staleTarget, '/collections/sls-free-toothpaste');
  assert.equal(toRewrite[0].target, '/products/coconut-oil-toothpaste');
});

// --- findChainedRedirects (Important 5: collapse redirect chains) ---

test('an existing redirect whose target is a plan source is flagged to repoint at the final target', () => {
  const readyPlan = [{ handle: 'natural-toothpaste', target: '/products/coconut-oil-toothpaste', live: true }];
  const existing = [{ id: 7, path: '/collections/toothpaste', target: '/collections/natural-toothpaste' }];
  const chained = findChainedRedirects(readyPlan, existing);
  assert.equal(chained.length, 1);
  assert.equal(chained[0].path, '/collections/toothpaste');
  assert.equal(chained[0].staleTarget, '/collections/natural-toothpaste');
  assert.equal(chained[0].newTarget, '/products/coconut-oil-toothpaste');
});

test('an existing redirect whose target is not a plan source is left alone', () => {
  const readyPlan = [{ handle: 'natural-toothpaste', target: '/products/coconut-oil-toothpaste', live: true }];
  const existing = [{ id: 8, path: '/some/old/page', target: '/products/coconut-oil-deodorant' }];
  assert.deepEqual(findChainedRedirects(readyPlan, existing), []);
});

test('findChainedRedirects is scoped to ready sources so it never repoints at a blocked target', () => {
  // Only the ready plan is passed in — a source whose target failed the
  // health check must never appear as a chain's newTarget.
  const readyPlan = [{ handle: 'natural-deodorant', target: '/products/coconut-oil-deodorant', live: true }];
  const existing = [{ id: 9, path: '/collections/deodorant', target: '/collections/natural-toothpaste' }];
  assert.deepEqual(findChainedRedirects(readyPlan, existing), []);
});

// --- Blocker 1 regression: chained and toRewrite must never double-process
// the same redirect record. Live audit found all 22 toRewrite rows also
// satisfied findChainedRedirects's predicate (e.g.
// /collections/no-sls-toothpaste -> /collections/sls-free-toothpaste, where
// both are plan sources). Under --apply that meant the chain loop deleted
// the record and recreated it under a new id, then the rewrite loop tried to
// delete the already-gone id (404) or create an already-existing path (422)
// — a deterministic crash after 50 chain fixes, before any of the 61 new
// redirects or 58 unpublishes ran.
test('a redirect record whose path AND target are both plan sources is excluded from chained — toRewrite handles it instead', () => {
  const readyPlan = [
    { handle: 'no-sls-toothpaste', target: '/products/coconut-oil-toothpaste', live: false },
    { handle: 'sls-free-toothpaste', target: '/products/coconut-oil-toothpaste', live: false },
  ];
  const existing = [
    { id: 100, path: '/collections/no-sls-toothpaste', target: '/collections/sls-free-toothpaste' },
  ];

  const chained = findChainedRedirects(readyPlan, existing);
  const { toRewrite } = diffRedirectsAgainstPlan(readyPlan, existing);

  const inChained = chained.some((c) => c.id === 100);
  const inToRewrite = toRewrite.some((r) => r.existingRedirectId === 100);

  assert.notEqual(inChained, inToRewrite, 'record 100 must appear in exactly one of the two work lists, never both, never neither');
  assert.equal(inToRewrite, true, 'toRewrite is the authoritative loop for a record whose own path is a plan source');
  assert.equal(chained.length, 0);
  assert.equal(toRewrite.length, 1);
  assert.equal(toRewrite[0].existingRedirectId, 100);
  assert.equal(toRewrite[0].target, '/products/coconut-oil-toothpaste');
});
