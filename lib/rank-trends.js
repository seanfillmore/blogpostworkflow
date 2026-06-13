// lib/rank-trends.js
//
// Turns a per-keyword/post position history (one point per rank snapshot) into
// a trajectory: how fast and in which direction a ranking is moving. This is the
// signal that lets decision agents tell apart three positions that all look
// identical in a single snapshot:
//   - a keyword at #15 *climbing* toward page 1 (leave it — it's resolving itself)
//   - a keyword at #15 *stuck* for weeks (needs a push to break out)
//   - a keyword at #15 *falling* (urgent — intervene before it drops off page 2)
//
// Rank convention: a lower position number is better (#1 beats #20). "Improvement"
// therefore means the position number *decreased*. To keep every consumer's sign
// intuitive, all deltas and velocities here are expressed as IMPROVEMENT:
// positive = climbing toward #1, negative = falling away from it. This matches
// the dashboard's change column (prev − current).

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DAY_MS = 86400000;

// Classification thresholds — tuned for daily snapshots. Exported so they can be
// inspected/adjusted in one place rather than scattered as magic numbers.
export const TREND_THRESHOLDS = {
  MIN_SAMPLES: 4,        // fewer real data points than this → "new" (not enough to judge)
  MIN_SPAN_DAYS: 14,     // shorter history than this → "new"
  CLIMB_PER_WEEK: 1.0,   // |velocity| at/above this (positions/week) → a real trend
  VOLATILE_STDEV: 8,     // position std-dev at/above this with no net trend → "volatile"
};

// ── pure math (unit-tested) ───────────────────────────────────────────────────

/**
 * Classify a trajectory from its summary stats. Separated from computeTrajectory
 * so the threshold logic can be tested directly.
 */
export function classify({ velocityPerWeek, samples, spanDays, stdev }) {
  const { MIN_SAMPLES, MIN_SPAN_DAYS, CLIMB_PER_WEEK, VOLATILE_STDEV } = TREND_THRESHOLDS;
  if (!samples) return 'unknown';
  if (samples < MIN_SAMPLES || spanDays < MIN_SPAN_DAYS || velocityPerWeek == null) return 'new';
  if (Math.abs(velocityPerWeek) < CLIMB_PER_WEEK && stdev >= VOLATILE_STDEV) return 'volatile';
  if (velocityPerWeek >= CLIMB_PER_WEEK) return 'climbing';
  if (velocityPerWeek <= -CLIMB_PER_WEEK) return 'falling';
  return 'stuck';
}

/**
 * Score multiplier applied to a quick-win opportunity based on its trajectory.
 * Falling rankings are the most urgent (we're losing ground we already earned);
 * stuck rankings need an external push; climbing rankings are deprioritized
 * because they're already trending the right way on their own.
 */
export function trendMultiplier(classification) {
  switch (classification) {
    case 'falling':  return 1.4;
    case 'stuck':    return 1.2;
    case 'climbing': return 0.8;
    default:         return 1; // volatile / new / unknown → neutral
  }
}

/**
 * Compute a trajectory from a position series.
 *
 * @param {Array<{date:string, position:number|null}>} series  unsorted is fine;
 *        `date` is 'YYYY-MM-DD'; null positions (snapshot present but keyword not
 *        ranking) are ignored.
 * @returns {{
 *   samples:number, spanDays:number, current:number|null,
 *   best:number|null, worst:number|null,
 *   delta7:number|null, delta30:number|null, delta90:number|null,
 *   velocityPerWeek:number|null, stdev:number|null, classification:string
 * }}
 */
export function computeTrajectory(series = []) {
  const points = (series || [])
    .filter((p) => p && p.position != null && Number.isFinite(p.position))
    .map((p) => ({ ms: new Date(p.date + 'T00:00:00Z').getTime(), position: p.position }))
    .filter((p) => Number.isFinite(p.ms))
    .sort((a, b) => a.ms - b.ms);

  const empty = {
    samples: 0, spanDays: 0, current: null, best: null, worst: null,
    delta7: null, delta30: null, delta90: null,
    velocityPerWeek: null, stdev: null, classification: 'unknown',
  };
  if (!points.length) return empty;

  const positions = points.map((p) => p.position);
  const last = points[points.length - 1];
  const first = points[0];
  const current = last.position;
  const spanDays = Math.round((last.ms - first.ms) / DAY_MS);

  // Improvement vs the most recent sample that is at least W days older than the
  // latest sample. Null when the history doesn't reach back that far.
  const deltaFor = (windowDays) => {
    const cutoff = last.ms - windowDays * DAY_MS;
    let baseline = null;
    for (const p of points) { if (p.ms <= cutoff) baseline = p; else break; }
    return baseline ? baseline.position - current : null;
  };

  // Least-squares slope of position vs day-index; negate so positive = improving.
  let velocityPerWeek = null;
  if (points.length >= 2) {
    const xs = points.map((p) => (p.ms - first.ms) / DAY_MS);
    const xMean = xs.reduce((s, x) => s + x, 0) / xs.length;
    const yMean = positions.reduce((s, y) => s + y, 0) / positions.length;
    let num = 0, den = 0;
    for (let i = 0; i < xs.length; i++) {
      num += (xs[i] - xMean) * (positions[i] - yMean);
      den += (xs[i] - xMean) ** 2;
    }
    if (den > 0) {
      const slopePerDay = num / den;
      velocityPerWeek = (Math.round(-slopePerDay * 7 * 100) / 100) || 0; // normalize -0 → 0
    }
  }

  const yMean = positions.reduce((s, y) => s + y, 0) / positions.length;
  const stdev = Math.sqrt(positions.reduce((s, y) => s + (y - yMean) ** 2, 0) / positions.length);

  const classification = classify({ velocityPerWeek, samples: points.length, spanDays, stdev });

  return {
    samples: points.length,
    spanDays,
    current,
    best: Math.min(...positions),
    worst: Math.max(...positions),
    delta7: deltaFor(7),
    delta30: deltaFor(30),
    delta90: deltaFor(90),
    velocityPerWeek,
    stdev: Math.round(stdev * 100) / 100,
    classification,
  };
}

// ── history loader (integration glue) ─────────────────────────────────────────

/**
 * Build a slug→position-series map from the rank-snapshot files for one device.
 * Reads at most `maxSnapshots` most-recent snapshots (bounds work for the long
 * history). Legacy plain-date files (YYYY-MM-DD.json) count as desktop.
 *
 * @returns {Map<string, Array<{date:string, position:number|null}>>}
 */
export function loadPositionHistory(snapshotsDir, { device = 'desktop', maxSnapshots = 120, key = 'posts', idField = 'slug' } = {}) {
  const history = new Map();
  if (!existsSync(snapshotsDir)) return history;

  const all = readdirSync(snapshotsDir).filter((f) => f.endsWith('.json'));
  const deviceRe = new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${device}\\.json$`);
  const legacyRe = /^\d{4}-\d{2}-\d{2}\.json$/;
  const files = [
    ...all.filter((f) => deviceRe.test(f)),
    ...(device === 'desktop' ? all.filter((f) => legacyRe.test(f)) : []),
  ]
    .sort((a, b) => a.slice(0, 10).localeCompare(b.slice(0, 10)))
    .slice(-maxSnapshots);

  for (const f of files) {
    const date = f.slice(0, 10);
    let snap;
    try { snap = JSON.parse(readFileSync(join(snapshotsDir, f), 'utf8')); } catch { continue; }
    for (const row of (snap[key] || [])) {
      const id = row[idField];
      if (!id) continue;
      if (!history.has(id)) history.set(id, []);
      history.get(id).push({ date, position: row.position ?? null });
    }
  }
  return history;
}
