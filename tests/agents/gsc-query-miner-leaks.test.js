// tests/agents/gsc-query-miner-leaks.test.js
//
// The leak set is computed already and thrown away — it survives only as prose rows
// inside an LLM-written markdown report. This pins the structured feed that replaces
// that, using the same shape as the existing untapped-candidates.json feed.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildImpressionLeaksFeed } from '../../agents/gsc-query-miner/leaks-feed.js';

const LEAKS = [
  { query: 'is coconut oil bad for acne', impressions: 900, clicks: 0, position: 12.4 },
  { query: 'natural deodorant rash', impressions: 300, clicks: 0, position: 8.1 },
];

test('the feed carries the leaks and its own provenance', () => {
  const feed = buildImpressionLeaksFeed(LEAKS, { minImpr: 50, now: '2026-08-21T00:00:00.000Z' });
  assert.equal(feed.source, 'gsc-query-miner');
  assert.equal(feed.generated_at, '2026-08-21T00:00:00.000Z');
  assert.equal(feed.min_impressions, 50);
  assert.deepEqual(feed.leaks, LEAKS);
});

test('leaks are ordered highest-impression first, so a consumer capping the list takes the biggest', () => {
  const feed = buildImpressionLeaksFeed([LEAKS[1], LEAKS[0]], { minImpr: 50, now: 'x' });
  assert.deepEqual(feed.leaks.map((l) => l.impressions), [900, 300]);
});

test('an empty cycle still produces a feed, so generated_at stays a liveness signal', () => {
  // Same reasoning the untapped-candidates feed documents: a consumer's staleness
  // guard must be able to tell "ran, found nothing" from "did not run".
  const feed = buildImpressionLeaksFeed([], { minImpr: 50, now: 'x' });
  assert.deepEqual(feed.leaks, []);
  assert.equal(feed.generated_at, 'x');
});

test('only the four fields a consumer needs are carried', () => {
  const noisy = [{ query: 'q', impressions: 100, clicks: 0, position: 5, ctr: 0, extra: 'drop me' }];
  const feed = buildImpressionLeaksFeed(noisy, { minImpr: 50, now: 'x' });
  assert.deepEqual(Object.keys(feed.leaks[0]).sort(), ['clicks', 'impressions', 'position', 'query']);
});
