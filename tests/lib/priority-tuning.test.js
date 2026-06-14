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
