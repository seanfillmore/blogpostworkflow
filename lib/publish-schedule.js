// lib/publish-schedule.js
// Canonical publish-day scheduling. formatPublishAt was previously defined inside
// calendar-runner; it is the single authority for which days posts publish on, so
// the prioritizer reuses it to assign slots — runner and prioritizer can never
// disagree.

/**
 * Snap `date` forward to the next allowed publish day (Mon/Wed/Fri), 08:00 PT,
 * and ensure it is in the future relative to `now`.
 * @returns {string} ISO-like 'YYYY-MM-DDT08:00:00-07:00'
 */
export function formatPublishAt(date, now = new Date()) {
  const PUBLISH_DAYS = new Set([1, 3, 5]); // Mon, Wed, Fri
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
