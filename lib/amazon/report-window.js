/**
 * Date-window helpers for Amazon Brand Analytics weekly reports.
 *
 * Brand Analytics (Search Terms / Search Query Performance) weekly data is NOT
 * available the instant a week ends — Amazon finalizes it several days later.
 * The weekly cron runs Sundays and used to request the week that ended the day
 * before (Saturday), so every report FATAL'd or sat IN_QUEUE ("data not ready").
 *
 * settledWeekWindow() returns the most recent complete Sun–Sat week that ended
 * at least `lagDays` ago, giving Amazon time to finalize it.
 */

const DAY_MS = 86400000;

/**
 * @param {Date} now
 * @param {number} lagDays - require the week to have ended at least this many days ago
 * @returns {{ dataStartTime: string, dataEndTime: string }} ISO yyyy-mm-dd (Sun → Sat)
 */
export function settledWeekWindow(now = new Date(), lagDays = 7) {
  // Work in whole UTC days.
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const anchorMs = todayUtc - lagDays * DAY_MS;
  const anchorDow = new Date(anchorMs).getUTCDay(); // 0=Sun … 6=Sat
  // Step back to the most recent Saturday on or before the anchor.
  // Sun(0)→1, Mon(1)→2, …, Fri(5)→6, Sat(6)→0
  const backToSaturday = (anchorDow + 1) % 7;
  const satMs = anchorMs - backToSaturday * DAY_MS;
  const sunMs = satMs - 6 * DAY_MS;
  return {
    dataStartTime: new Date(sunMs).toISOString().slice(0, 10),
    dataEndTime: new Date(satMs).toISOString().slice(0, 10),
  };
}
