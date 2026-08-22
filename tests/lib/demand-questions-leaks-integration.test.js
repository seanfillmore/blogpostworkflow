// tests/lib/demand-questions-leaks-integration.test.js
//
// The Fix 1 bug (agents/gsc-query-miner/leaks-feed.js destructuring `query` off rows
// that only ever carry `keyword`) shipped past every existing test because no test
// ran a real-shaped row through the FULL chain: lib/gsc.js row shape ->
// buildImpressionLeaksFeed -> (agents/demand-miner's filterLeaksToSkinCluster) ->
// deriveSeeds. Each stage's own unit tests used a fixture already shaped the way
// that stage expects its input, so the seam between gsc-query-miner's output and
// demand-miner's input was never actually exercised. This file exists to close that
// gap — the shape a unit test hands a function is a claim, and this proves the claim
// is true of what gsc-query-miner really produces.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildImpressionLeaksFeed } from '../../agents/gsc-query-miner/leaks-feed.js';
import { deriveSeeds, filterLeaksToSkinCluster } from '../../lib/demand-questions.js';

// The real row shape lib/gsc.js's getTopKeywords/findImpressionLeaks produce — see
// lib/gsc.js's own "Returns: [{ keyword, clicks, impressions, ctr, position }]"
// docstrings. Never `query`.
const REAL_GSC_ROWS = [
  { keyword: 'is coconut oil good for dry skin', clicks: 0, impressions: 500, ctr: 0, position: 14.2 },
  { keyword: 'natural lotion for eczema', clicks: 0, impressions: 200, ctr: 0, position: 9.5 },
];

test('a real-shaped GSC leak row survives buildImpressionLeaksFeed -> deriveSeeds and comes out with its actual query text', () => {
  const feed = buildImpressionLeaksFeed(REAL_GSC_ROWS, { minImpr: 50, now: '2026-08-21T00:00:00.000Z' });

  // The feed itself must carry real text, not just structurally-present-but-empty.
  for (const leak of feed.leaks) {
    assert.equal(typeof leak.query, 'string');
    assert.ok(leak.query.length > 0);
  }

  const { seeds, partial } = deriveSeeds({ leaks: filterLeaksToSkinCluster(feed.leaks), personas: [] });

  const leakSeeds = seeds.filter((s) => s.origin === 'gsc_leak');
  assert.equal(leakSeeds.length, 2, `expected both leaks to survive as seeds, got ${JSON.stringify(seeds)}`);
  assert.deepEqual(
    leakSeeds.map((s) => s.text).sort(),
    ['is coconut oil good for dry skin', 'natural lotion for eczema'].sort(),
  );
  // No personas were supplied, so the run is partial — but the leak half must not be.
  assert.equal(partial, true);
});

test('without the fix (a leak carrying no query text) deriveSeeds silently discards it — pinning why Fix 1 mattered', () => {
  // This reproduces the pre-fix bug shape directly: a "leak" object with an
  // undefined `query`, as buildImpressionLeaksFeed used to emit before the fix.
  const brokenLeaks = [{ query: undefined, impressions: 500, clicks: 0, position: 14.2 }];
  const { seeds } = deriveSeeds({ leaks: brokenLeaks, personas: [] });
  assert.deepEqual(seeds, [], 'a leak with no query text must not produce a seed — this is deriveSeeds\' existing blank-check, not new behavior');
});
