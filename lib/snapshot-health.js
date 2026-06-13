// lib/snapshot-health.js
//
// Detects the *silent* failure mode that error-driven monitoring misses: a
// collector cron that never fires, or exits 0 without writing a snapshot, emits
// no error — so the data just quietly goes stale. (This is how the March 2026
// 17-day rank-snapshot blackout went unnoticed.) These helpers check that each
// expected snapshot directory has produced a recent file, so daily-summary can
// raise an immediate alert when one stops updating.
//
// Threshold-based on purpose: we alert on *sustained* staleness (default: older
// than 2 days), not "today's file is missing". daily-summary runs in the same
// window as some collectors, so a 1-day-old snapshot is normal; only a multi-day
// gap signals a real outage. That catches a blackout with zero timing false
// positives.

import { readdirSync, existsSync } from 'node:fs';

const DAY_MS = 86400000;

// Default staleness threshold (days). Tunable per-entry via `maxAgeDays`.
export const DEFAULT_MAX_AGE_DAYS = 2;

const msOf = (date) => new Date(date + 'T00:00:00Z').getTime();

/**
 * Classify the freshness of each snapshot source.
 *
 * @param {Array<{name:string, newestDate:string|null, maxAgeDays?:number}>} entries
 *        `newestDate` is the most recent snapshot date ('YYYY-MM-DD') or null if none.
 * @param {{today:string, defaultMaxAgeDays?:number}} opts
 * @returns {Array<{name, newestDate, ageDays:number|null, maxAgeDays:number, status:'ok'|'stale'|'missing'}>}
 */
export function checkFreshness(entries, { today, defaultMaxAgeDays = DEFAULT_MAX_AGE_DAYS } = {}) {
  const todayMs = msOf(today);
  return (entries || []).map((e) => {
    const maxAgeDays = e.maxAgeDays ?? defaultMaxAgeDays;
    if (!e.newestDate) {
      return { name: e.name, newestDate: null, ageDays: null, maxAgeDays, status: 'missing' };
    }
    const ageDays = Math.floor((todayMs - msOf(e.newestDate)) / DAY_MS);
    // A future date (clock skew) counts as fresh, never stale.
    const status = ageDays > maxAgeDays ? 'stale' : 'ok';
    return { name: e.name, newestDate: e.newestDate, ageDays, maxAgeDays, status };
  });
}

/** Filter freshness results down to the ones that need attention. */
export function problems(results) {
  return (results || []).filter((r) => r.status !== 'ok');
}

// ── I/O glue (integration-verified, not unit-tested) ──────────────────────────

/**
 * Most-recent snapshot date in a directory, or null. Matches any filename that
 * starts with a YYYY-MM-DD date (covers plain `2026-06-13.json` and
 * device-suffixed `2026-06-13-desktop.json`).
 */
export function newestSnapshotDate(dir) {
  if (!existsSync(dir)) return null;
  let newest = null;
  for (const f of readdirSync(dir)) {
    const m = f.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m && (newest === null || m[1] > newest)) newest = m[1];
  }
  return newest;
}
