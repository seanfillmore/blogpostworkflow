// lib/publish-schedule.js
// Canonical publish-day scheduling. formatPublishAt was previously defined inside
// calendar-runner; it is the single authority for which days posts publish on, so
// the prioritizer reuses it to assign slots — runner and prioritizer can never
// disagree.

/**
 * The publish days, as JS day numbers: Monday, Tuesday, Thursday, Friday.
 * Four a week, one post a day (operator decision 2026-10-14, raised from two).
 * THE ONE SOURCE: content-strategist's slot walker, lib/calendar-carry.js and the
 * runner/prioritizer all read it. Before this, the strategist dated items Mon/Thu
 * while this file snapped them to Mon/Wed/Fri, so every Thursday post silently
 * published on Friday.
 */
export const PUBLISH_DAYS = Object.freeze(new Set([1, 2, 4, 5]));

/**
 * A generator of publish slots (Date at 15:00 UTC, 8 AM PDT) on PUBLISH_DAYS,
 * from `from` (inclusive of that day) forward, skipping YYYY-MM-DD in `taken`.
 * Each call returns the next slot and marks it taken.
 */
export function slotsFrom(from, taken = new Set()) {
  const d = new Date(from);
  d.setUTCHours(15, 0, 0, 0);
  return () => {
    for (;;) {
      const t = new Date(d);
      d.setUTCDate(d.getUTCDate() + 1);
      const key = t.toISOString().slice(0, 10);
      if (PUBLISH_DAYS.has(t.getUTCDay()) && !taken.has(key)) { taken.add(key); return t; }
    }
  };
}

/**
 * Snap `date` forward to the next allowed publish day (PUBLISH_DAYS), 08:00 PT,
 * and ensure it is in the future relative to `now`.
 * @returns {string} ISO-like 'YYYY-MM-DDT08:00:00-07:00'
 */
export function formatPublishAt(date, now = new Date()) {
  const d = new Date(date);
  while (!PUBLISH_DAYS.has(d.getDay())) d.setDate(d.getDate() + 1);
  while (d < now) d.setDate(d.getDate() + 7);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const dy = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${dy}T08:00:00-07:00`;
}

/**
 * Next publish slot whose date (YYYY-MM-DD) is not already in `takenDates`.
 * @param {Set<string>} takenDates  set of 'YYYY-MM-DD' already assigned
 */
export function nextOpenSlot(takenDates, fromDate, now = new Date()) {
  let slot = formatPublishAt(fromDate, now);
  const taken = takenDates || new Set();
  while (taken.has(slot.slice(0, 10))) {
    const d = new Date(slot);
    d.setDate(d.getDate() + 1);
    slot = formatPublishAt(d, now);
  }
  return slot;
}
