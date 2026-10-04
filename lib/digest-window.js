/**
 * The daily digest's time window: rows written AFTER the previous digest was
 * sent, up to and including the moment this one sends. Pure; the agent reads
 * the files and the last-sent marker.
 */

/** Rows with `since < ts <= until` (ISO strings compare correctly as text). */
export function rowsInWindow(rows, { since, until }) {
  return rows.filter((r) => typeof r.ts === 'string' && r.ts > since && r.ts <= until);
}

/** Every YYYY-MM-DD from `from` to `to`, inclusive. */
export function daysBetween(from, to) {
  const out = [];
  for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= to; d = new Date(d.getTime() + 86_400_000)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
