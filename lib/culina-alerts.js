/**
 * Culina stock-alert decisions. Pure: no I/O, never mutates its input.
 * Dates are UTC 'YYYY-MM-DD'.
 *
 * Per key, state is { lastAlertAt, level: 'out_of_stock' | 'below_threshold' }.
 * - onHand 0 -> out_of_stock (even when coverDays is null).
 * - coverDays null with stock on hand -> no measurable demand, never alerted.
 * - coverDays < config.alert_below_days -> below_threshold.
 * - A new level alerts immediately; the same level reminds after 7 days.
 * - Recovered items are dropped from the state.
 */
const REMINDER_DAYS = 7;
const DAY_MS = 86400000;

function daysBetween(from, to) {
  return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / DAY_MS);
}

function levelFor(item, threshold) {
  if (item.onHand === 0) return 'out_of_stock';
  if (item.coverDays === null || item.coverDays === undefined) return null;
  return item.coverDays < threshold ? 'below_threshold' : null;
}

export function decideAlerts({ items, state = {}, today, config }) {
  const threshold = config.alert_below_days;
  const rows = [];
  const nextState = {};

  for (const item of items) {
    const level = levelFor(item, threshold);
    if (!level) continue; // recovered or unmeasurable: state cleared
    const prev = state[item.key];
    const row = { key: item.key, label: item.label, coverDays: item.coverDays, onHand: item.onHand };

    if (!prev || prev.level !== level) {
      rows.push({ ...row, reason: level });
      nextState[item.key] = { lastAlertAt: today, level };
    } else if (daysBetween(prev.lastAlertAt, today) >= REMINDER_DAYS) {
      rows.push({ ...row, reason: level === 'out_of_stock' ? 'out_of_stock' : 'reminder' });
      nextState[item.key] = { lastAlertAt: today, level };
    } else {
      nextState[item.key] = { ...prev };
    }
  }

  return { send: rows.length > 0, rows, nextState };
}
