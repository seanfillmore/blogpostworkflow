/**
 * The one record of IDENTIFIED automated-traffic events, so every analysis
 * excludes the same periods instead of each deciding for itself.
 *
 * WHY THIS IS A DECLARED LIST AND NOT A DETECTOR. The obvious move is a rule —
 * "a day at N times the median is a bot day" — and it is measurably wrong here.
 * The site's real paid giveaway campaign (2026-08-19 -> 08-29) ran at **3.5x to
 * 15x the median day**, and the worst bot day ran at 27.5x. There is no
 * threshold between them that does not either discard a real campaign or keep a
 * bot wave, and discarding a real campaign is how a measurement system starts
 * lying about the one period somebody paid for. So an event is listed only when
 * something OTHER than its size identifies it — a single user agent across
 * thousands of IPs, an exactly-2-requests-per-IP fan-out, a 5.7% bounce rate —
 * and `config/bot-traffic-events.json` carries that evidence next to the dates.
 *
 * WHAT WAS ACTUALLY CONTAMINATED, measured 2026-09-19, because the answer is
 * narrower than it first looks and the narrowness is the useful part:
 *   - 3,145 of the 2026-09-14 wave's 3,150 sessions landed on ONE page,
 *     `/pages/free-soap-giveaway`. Commercial pages were untouched.
 *   - `lib/commercial-cvr.js` already excludes the whole giveaway funnel, so
 *     the CVR figure paid-media decisions are made from was never affected.
 *     Do not add an exclusion there; it would double-count.
 *   - What IS affected is anything reading whole-site or per-page GA4 sessions:
 *     a 3,145-session page with zero conversions reads as the site's biggest
 *     "high-traffic, low-conversion" problem, which is a phantom finding
 *     competing for attention in the report a human actually reads.
 *
 * GRAIN. GA4 snapshots are daily, so the unit of exclusion is a DAY. That drops
 * roughly 250 real sessions along with ~3,130 fake ones, which is the right
 * trade inside a 28- or 90-day window and would not be at a finer grain.
 *
 * IT FAILS OPEN. A missing, unreadable, malformed or empty config excludes
 * NOTHING and every caller reports that it excluded nothing. Same doctrine as
 * lib/rum-bot.js: the dangerous direction is not a bot left in a percentile,
 * it is silently deleting real days until the numbers flatter us.
 *
 * NOTHING HERE DELETES DATA. The snapshots stay on disk exactly as collected;
 * this only decides which files an analysis reads, and every caller prints what
 * it skipped.
 *
 * RUM has its own mechanism (`lib/rum-bot.js`) and does not read this file —
 * it identifies bursts from the beacons themselves, retrospectively, with no
 * list to maintain. This file is for the daily aggregate feeds, which carry no
 * per-request detail to detect anything from.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const BOT_EVENTS_PATH = join(ROOT, 'config', 'bot-traffic-events.json');

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Read the declared events. Never throws: returns
 * `{ available, events, reason }`, and `available: false` means nothing is
 * excluded anywhere.
 */
export function loadBotTrafficEvents({ path = BOT_EVENTS_PATH } = {}) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    return { available: false, events: [], reason: `config not readable (${err.code || 'error'})` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { available: false, events: [], reason: 'config is not valid JSON' };
  }
  const events = Array.isArray(parsed?.events) ? parsed.events.filter((e) => e && typeof e === 'object') : null;
  if (!events) return { available: false, events: [], reason: 'config has no events array' };
  if (!events.length) return { available: true, events: [], reason: 'no events declared' };
  return { available: true, events, reason: null };
}

/**
 * The set of snapshot days a dataset should skip. An event contributes only the
 * days it explicitly declares — a window alone never implies a day, because the
 * UTC-to-Pacific conversion is exactly the step that gets this wrong.
 */
export function contaminatedDays(events, dataset = 'ga4') {
  const days = new Set();
  for (const e of events || []) {
    const affects = Array.isArray(e.affects) ? e.affects : [];
    if (affects.length && !affects.includes(dataset)) continue;
    const declared = dataset === 'ga4' ? e.ga4_days : e[`${dataset}_days`];
    for (const d of Array.isArray(declared) ? declared : []) {
      if (typeof d === 'string' && DAY.test(d)) days.add(d);
    }
  }
  return days;
}

/** The `YYYY-MM-DD` in a snapshot filename or day string, or null. */
export function dayOf(value) {
  if (typeof value !== 'string') return null;
  const m = value.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/**
 * Split snapshot days (or filenames) into what an analysis should read and what
 * it should skip. Anything whose day cannot be read is KEPT.
 */
export function partitionSnapshotDays(items, { dataset = 'ga4', path = BOT_EVENTS_PATH, load = loadBotTrafficEvents } = {}) {
  const list = Array.isArray(items) ? items : [];
  const loaded = load({ path });
  const days = loaded.available ? contaminatedDays(loaded.events, dataset) : new Set();

  const kept = [];
  const excluded = [];
  for (const item of list) {
    const day = dayOf(item);
    if (day && days.has(day)) excluded.push(item);
    else kept.push(item);
  }
  return { kept, excluded, available: loaded.available, reason: loaded.reason, dataset };
}

/** One line for a console log or report body, naming what was skipped and why. */
export function exclusionLine({ excluded = [], available, reason, dataset = 'ga4' } = {}) {
  if (!available) {
    return `Bot-traffic exclusions are OFF for ${dataset}: ${reason || 'unavailable'} — nothing was skipped.`;
  }
  if (!excluded.length) return `Bot-traffic exclusions: none applied to ${dataset}.`;
  const days = excluded.map(dayOf).filter(Boolean).join(', ');
  return `Bot-traffic exclusions: skipped ${excluded.length} ${dataset} day(s) of identified automated traffic (${days}).`;
}
