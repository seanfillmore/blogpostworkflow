import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  computeTrajectory,
  classify,
  trendMultiplier,
} from '../../lib/rank-trends.js';

// Helper: build a daily series starting at `start`, one sample per day,
// positions taken from the array (null allowed for gaps).
function dailySeries(start, positions) {
  const startMs = new Date(start + 'T00:00:00Z').getTime();
  return positions.map((position, i) => ({
    date: new Date(startMs + i * 86400000).toISOString().slice(0, 10),
    position,
  }));
}

// ── computeTrajectory: degenerate inputs ──────────────────────────────────────

test('computeTrajectory: empty series is unknown with no samples', () => {
  const t = computeTrajectory([]);
  assert.equal(t.samples, 0);
  assert.equal(t.current, null);
  assert.equal(t.delta7, null);
  assert.equal(t.delta30, null);
  assert.equal(t.velocityPerWeek, null);
  assert.equal(t.classification, 'unknown');
});

test('computeTrajectory: a single sample has no velocity and is new', () => {
  const t = computeTrajectory(dailySeries('2026-05-01', [15]));
  assert.equal(t.samples, 1);
  assert.equal(t.current, 15);
  assert.equal(t.velocityPerWeek, null);
  assert.equal(t.classification, 'new');
});

// ── computeTrajectory: direction ──────────────────────────────────────────────

test('computeTrajectory: steadily improving rank is climbing', () => {
  // position falls 40 -> 10 over 30 days (lower rank number = better)
  const positions = Array.from({ length: 31 }, (_, i) => 40 - i);
  const t = computeTrajectory(dailySeries('2026-05-01', positions));
  assert.equal(t.samples, 31);
  assert.equal(t.current, 10);
  assert.equal(t.delta30, 30);              // improved by 30 positions vs 30 days ago
  assert.equal(t.velocityPerWeek, 7);       // -1 pos/day improvement = +7/week
  assert.equal(t.classification, 'climbing');
});

test('computeTrajectory: steadily worsening rank is falling', () => {
  const positions = Array.from({ length: 31 }, (_, i) => 10 + i); // 10 -> 40
  const t = computeTrajectory(dailySeries('2026-05-01', positions));
  assert.equal(t.current, 40);
  assert.equal(t.delta30, -30);
  assert.equal(t.velocityPerWeek, -7);
  assert.equal(t.classification, 'falling');
});

test('computeTrajectory: flat rank is stuck', () => {
  const positions = Array.from({ length: 31 }, () => 15);
  const t = computeTrajectory(dailySeries('2026-05-01', positions));
  assert.equal(t.delta30, 0);
  assert.equal(t.velocityPerWeek, 0);
  assert.equal(t.classification, 'stuck');
});

test('computeTrajectory: a strong trend beats high variance (not volatile)', () => {
  // big swing but clearly improving overall
  const positions = Array.from({ length: 31 }, (_, i) => 40 - i);
  const t = computeTrajectory(dailySeries('2026-05-01', positions));
  assert.equal(t.classification, 'climbing');
});

test('computeTrajectory: bouncing rank with no net trend is volatile', () => {
  const positions = Array.from({ length: 31 }, (_, i) => (i % 2 === 0 ? 8 : 26));
  const t = computeTrajectory(dailySeries('2026-05-01', positions));
  assert.ok(Math.abs(t.velocityPerWeek) < 1, `velocity ${t.velocityPerWeek} should be ~0`);
  assert.equal(t.classification, 'volatile');
});

// ── computeTrajectory: history-length guards ──────────────────────────────────

test('computeTrajectory: too little history is new regardless of direction', () => {
  const positions = Array.from({ length: 10 }, (_, i) => 20 - i); // 10 days only
  const t = computeTrajectory(dailySeries('2026-05-01', positions));
  assert.ok(t.spanDays < 14);
  assert.equal(t.classification, 'new');
});

test('computeTrajectory: window delta is null when history is shorter than the window', () => {
  const positions = Array.from({ length: 31 }, (_, i) => 40 - i); // 30-day span
  const t = computeTrajectory(dailySeries('2026-05-01', positions));
  assert.equal(t.delta90, null);   // no sample 90 days old
  assert.equal(t.delta7, 7);       // 7-day window present
});

// ── computeTrajectory: gaps / nulls ───────────────────────────────────────────

test('computeTrajectory: null positions are ignored, current is the latest real value', () => {
  const series = dailySeries('2026-05-01', [20, null, 18, null, 16, 14]);
  const t = computeTrajectory(series);
  assert.equal(t.samples, 4);   // four non-null positions
  assert.equal(t.current, 14);
  assert.equal(t.best, 14);
  assert.equal(t.worst, 20);
});

// ── classify: threshold edges ─────────────────────────────────────────────────

test('classify: requires minimum samples and span before assigning a direction', () => {
  assert.equal(classify({ velocityPerWeek: 5, samples: 2, spanDays: 30, stdev: 1 }), 'new');
  assert.equal(classify({ velocityPerWeek: 5, samples: 10, spanDays: 5, stdev: 1 }), 'new');
});

test('classify: maps clear velocity to climbing/falling/stuck', () => {
  const base = { samples: 20, spanDays: 30, stdev: 2 };
  assert.equal(classify({ ...base, velocityPerWeek: 3 }), 'climbing');
  assert.equal(classify({ ...base, velocityPerWeek: -3 }), 'falling');
  assert.equal(classify({ ...base, velocityPerWeek: 0.2 }), 'stuck');
});

test('classify: flat but noisy is volatile', () => {
  assert.equal(classify({ velocityPerWeek: 0.1, samples: 20, spanDays: 30, stdev: 12 }), 'volatile');
});

// ── trendMultiplier: priority weighting ───────────────────────────────────────

test('trendMultiplier: falling is most urgent, climbing is deprioritized', () => {
  assert.ok(trendMultiplier('falling') > trendMultiplier('stuck'));
  assert.ok(trendMultiplier('stuck') > trendMultiplier('climbing'));
  assert.equal(trendMultiplier('climbing'), 0.8);
  assert.equal(trendMultiplier('falling'), 1.4);
  assert.equal(trendMultiplier('stuck'), 1.2);
});

test('trendMultiplier: unknown/new/volatile are neutral', () => {
  assert.equal(trendMultiplier('unknown'), 1);
  assert.equal(trendMultiplier('new'), 1);
  assert.equal(trendMultiplier('volatile'), 1);
});
