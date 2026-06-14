// lib/report-freshness.js
// Pure decision logic for "which report (if any) should this run surface?".
//
// notifyLatestReport() used to blindly pick the most-recently-modified .md in a
// directory. Two failure modes resulted in confusing daily-digest entries:
//   1. Missing/empty dir → a scary "could not read reports directory" error
//      (e.g. collection-content-optimizer, which returns early on non-queue runs
//      and never writes a .md at all).
//   2. A stale report surfaced as if it were this run's output (e.g. Product
//      Optimizer showing a weeks-old "Run date: May 2" because the agent ran but
//      wrote no fresh report).
//
// This module isolates the choice so it can be unit-tested without I/O.

// Agents that write a report do so immediately before notifying, so anything
// fresh is well under a day old. 36h gives daily jobs slack for slow runs and
// clock skew while still rejecting weeks-old leftovers.
export const DEFAULT_MAX_REPORT_AGE_MS = 36 * 3600 * 1000;

/**
 * @param {Array<{name: string, mtimeMs: number}>} entries directory listing
 * @param {{ now: number, maxAgeMs?: number }} opts
 * @returns {{kind:'report', name:string} | {kind:'none'} | {kind:'stale'}}
 *   - 'report': use entries `name` as this run's report
 *   - 'none':   no .md report exists
 *   - 'stale':  a report exists but is older than the freshness window
 */
export function chooseLatestReport(entries, { now, maxAgeMs = DEFAULT_MAX_REPORT_AGE_MS } = {}) {
  const mds = (Array.isArray(entries) ? entries : []).filter((e) => e && typeof e.name === 'string' && e.name.endsWith('.md'));
  if (!mds.length) return { kind: 'none' };
  const newest = mds.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a));
  if (now - newest.mtimeMs > maxAgeMs) return { kind: 'stale' };
  return { kind: 'report', name: newest.name };
}
