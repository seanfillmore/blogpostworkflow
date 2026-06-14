import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { aggregatePerformance, pathMatchesSlug } from '../../lib/priority-tuning.js';

const TODAY = '2026-06-14';
const LAG = 28;

test('pathMatchesSlug matches blog path suffix', () => {
  assert.equal(pathMatchesSlug('/blogs/news/coconut-oil-stretch-marks', 'coconut-oil-stretch-marks'), true);
  assert.equal(pathMatchesSlug('/blogs/news/other-post', 'coconut-oil-stretch-marks'), false);
});

test('aggregatePerformance: only counts records older than the lag window', () => {
  const ledger = [
    { slug: 'old', signal_type: 'unmapped', date: '2026-05-01', action: 'inject' }, // 44d ago — measurable
    { slug: 'new', signal_type: 'unmapped', date: '2026-06-10', action: 'inject' }, // 4d ago — too recent
  ];
  const wins = [{ path: '/blogs/news/old', revenueDelta: 50 }];
  const perf = aggregatePerformance(ledger, wins, { today: TODAY, measureLagDays: LAG });
  assert.equal(perf.unmapped.measured, 1);   // only 'old'
  assert.equal(perf.unmapped.wins, 1);
  assert.equal(perf.unmapped.revenue, 50);
  assert.equal(perf.unmapped.score, 50);     // revenue / measured
});

test('aggregatePerformance: a measured post with no win counts toward measured, not wins', () => {
  const ledger = [{ slug: 'flop', signal_type: 'rank_drop', date: '2026-05-01', action: 'promote' }];
  const perf = aggregatePerformance(ledger, [], { today: TODAY, measureLagDays: LAG });
  assert.equal(perf.rank_drop.measured, 1);
  assert.equal(perf.rank_drop.wins, 0);
  assert.equal(perf.rank_drop.revenue, 0);
  assert.equal(perf.rank_drop.score, 0);
});

test('aggregatePerformance: dedups a slug attributed to the same signal twice (inject + promote)', () => {
  const ledger = [
    { slug: 'p', signal_type: 'unmapped', date: '2026-05-01', action: 'inject' },
    { slug: 'p', signal_type: 'unmapped', date: '2026-05-02', action: 'promote' },
  ];
  const wins = [{ path: '/blogs/news/p', revenueDelta: 30 }];
  const perf = aggregatePerformance(ledger, wins, { today: TODAY, measureLagDays: LAG });
  assert.equal(perf.unmapped.measured, 1); // counted once
  assert.equal(perf.unmapped.revenue, 30);
});

test('aggregatePerformance: a slug under two different signals counts for each', () => {
  const ledger = [
    { slug: 'p', signal_type: 'unmapped', date: '2026-05-01', action: 'inject' },
    { slug: 'p', signal_type: 'revenue_cluster', date: '2026-05-01', action: 'promote' },
  ];
  const wins = [{ path: '/blogs/news/p', revenueDelta: 40 }];
  const perf = aggregatePerformance(ledger, wins, { today: TODAY, measureLagDays: LAG });
  assert.equal(perf.unmapped.measured, 1);
  assert.equal(perf.revenue_cluster.measured, 1);
});

import { proposeWeightChanges } from '../../lib/priority-tuning.js';

const CFG = {
  signals: {
    unmapped:        { perImpression: 0.01 },
    rank_drop:       { perPosition: 3 },
    revenue_cluster: { perDollar: 0.2 },
    competitor_gap:  { boost: 15 },
    ai_gap:          { boost: 12 },
  },
  tuning: {
    minSamplesPerSignal: 3, totalFloor: 8, maxStepPct: 0.10,
    paramBounds: {
      'unmapped.perImpression':    { min: 0.002, max: 0.05 },
      'rank_drop.perPosition':     { min: 1, max: 8 },
      'revenue_cluster.perDollar': { min: 0.05, max: 0.6 },
      'competitor_gap.boost':      { min: 5, max: 30 },
      'ai_gap.boost':              { min: 4, max: 24 },
    },
  },
};

test('proposeWeightChanges: above-mean signal nudged up, below-mean nudged down (bounded)', () => {
  const perf = {
    unmapped:  { measured: 5, wins: 4, revenue: 200, score: 40 }, // high
    rank_drop: { measured: 5, wins: 1, revenue: 20,  score: 4 },  // low  (mean = 22)
  };
  const changes = proposeWeightChanges(perf, CFG);
  const up = changes.find((c) => c.signal_type === 'unmapped');
  const down = changes.find((c) => c.signal_type === 'rank_drop');
  assert.ok(up.to > up.from);                 // 0.01 → 0.011 (+10% capped)
  assert.equal(up.to, 0.011);
  assert.ok(down.to < down.from);             // 3 → 2.7
  assert.equal(down.to, 2.7);
});

test('proposeWeightChanges: signal below minSamplesPerSignal is not changed', () => {
  const perf = {
    unmapped:  { measured: 5, wins: 4, revenue: 200, score: 40 },
    rank_drop: { measured: 5, wins: 0, revenue: 0,   score: 0 },
    ai_gap:    { measured: 1, wins: 1, revenue: 99,  score: 99 }, // too few samples
  };
  const changes = proposeWeightChanges(perf, CFG);
  assert.ok(!changes.find((c) => c.signal_type === 'ai_gap'));
});

test('proposeWeightChanges: no-op when fewer than 2 signals qualify', () => {
  const perf = { unmapped: { measured: 5, wins: 4, revenue: 200, score: 40 } };
  assert.deepEqual(proposeWeightChanges(perf, CFG), []);
});

test('proposeWeightChanges: no-op when total measured below totalFloor', () => {
  const perf = {
    unmapped:  { measured: 3, wins: 1, revenue: 30, score: 10 },
    rank_drop: { measured: 3, wins: 1, revenue: 60, score: 20 }, // total 6 < floor 8
  };
  assert.deepEqual(proposeWeightChanges(perf, CFG), []);
});

test('proposeWeightChanges: clamps to param max', () => {
  const cfg = JSON.parse(JSON.stringify(CFG));
  cfg.signals.unmapped.perImpression = 0.05; // already at max
  const perf = {
    unmapped:  { measured: 5, wins: 5, revenue: 500, score: 100 },
    rank_drop: { measured: 5, wins: 1, revenue: 20,  score: 4 },
  };
  const changes = proposeWeightChanges(perf, cfg);
  const up = changes.find((c) => c.signal_type === 'unmapped');
  // would go above max → clamped to 0.05 → from===to → omitted
  assert.ok(!up || up.to <= 0.05);
});
