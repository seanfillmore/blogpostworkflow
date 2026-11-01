/**
 * Which GSC snapshot dates should the collector fetch on this run?
 *
 * The collector used to fetch exactly one date (3 days ago) and, when Search
 * Console returned no rows for it, skip it forever. On 2026-10-03 and 10-04
 * Google's reporting ran late, both runs got zero rows, and 2026-09-30 and
 * 2026-10-01 were never collected. GSC had full data for both a day later.
 *
 * So a run fetches the normal lag date PLUS every date in the lookback window
 * that has no snapshot yet. On a healthy day that is one date, exactly as
 * before; after a Google delay it is the delayed dates too, retried on every
 * run until they land or age out of the window.
 *
 * Pure: no I/O, so it is testable without stubbing the filesystem or GSC.
 */

export const LAG_DAYS = 3;
export const LOOKBACK_DAYS = 10;

/** YYYY-MM-DD for `now` minus `n` days, in Pacific time (GSC's reporting day). */
export function pacificDateDaysAgo(n, now = Date.now()) {
  return new Date(now - n * 24 * 60 * 60 * 1000)
    .toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

/**
 * @param {object}   opts
 * @param {string[]} opts.existing  dates that already have a snapshot (YYYY-MM-DD)
 * @param {number}   [opts.now]
 * @param {number}   [opts.lagDays]
 * @param {number}   [opts.lookbackDays]
 * @returns {string[]} dates to fetch, newest first. The lag date is always
 *   included, even if a snapshot exists, so a normal run behaves as it always has.
 */
export function datesToCollect({ existing, now = Date.now(), lagDays = LAG_DAYS, lookbackDays = LOOKBACK_DAYS }) {
  const have = new Set(existing);
  const dates = [pacificDateDaysAgo(lagDays, now)];
  for (let n = lagDays + 1; n <= lookbackDays; n++) {
    const d = pacificDateDaysAgo(n, now);
    if (!have.has(d)) dates.push(d);
  }
  return dates;
}
