// lib/calendar-carry.js
//
// Carry PAID-FOR calendar items across a content-strategist re-plan.
//
// The re-plan REPLACES data/calendar/calendar.json with whatever the planner
// proposed this run. An item the planner simply did not re-propose, with no
// filter firing, disappeared ("not_reproposed"). Measured 2026-10-14 over every
// re-plan since 2026-08-23: 98 distinct items lost that way, 80 still gone, about
// 30 of them holding a paid content-researcher brief and 3 a written draft. The
// digest named each one, as a warning row nobody acted on.
//
// Rule: an item whose clearing reason is `not_reproposed`, that has paid work
// behind it (a brief or a draft), is carried. Every other reason is a filter's
// deliberate verdict (already covered, rejected, $0 cluster, possible duplicate,
// completed) and stays cleared. An item with no paid work is just an idea, and
// letting the planner rotate ideas costs nothing.
//
// Dates: an UNDATED item (pipeline-prioritizer backlog) stays undated. A dated
// carried item keeps its slot when that slot is in the future and free.
// Otherwise it takes the next free publish-day 8 AM PT slot AFTER every scheduled
// item, so carrying can never hand calendar-runner a batch of overdue items to
// draft at once (one post per slot, never two in a day).
//
// Pure: callers pass `hasPaidWork(slug)`. lib/calendar-coverage.js is left alone
// on purpose; it decides what is CLEARED, this only decides what is KEPT.

import { slotsFrom } from './publish-schedule.js';

const DAY = 86400000;

// Slots strictly after fromMs, on lib/publish-schedule.js's PUBLISH_DAYS.
function slotsAfter(fromMs, taken) {
  const next = slotsFrom(new Date(fromMs + DAY), taken);
  return next;
}

/**
 * @param {object} p
 * @param {object[]} p.newItems   the calendar the re-plan is about to write
 * @param {object[]} p.cleared    classifyClearedItems() output for that calendar
 * @param {object[]} p.previous   the calendar before the re-plan
 * @param {(slug:string)=>boolean} p.hasPaidWork
 * @param {Date} [p.now]
 * @returns {object[]} carried items (re-dated where needed), oldest slot first
 */
export function carryPaidItems({ newItems = [], cleared = [], previous = [], hasPaidWork, now = new Date() } = {}) {
  const eligible = new Set(
    cleared
      .filter((c) => c.reason === 'not_reproposed' && !c.postLive)
      .map((c) => c.slug)
      .filter((slug) => { try { return Boolean(hasPaidWork(slug)); } catch { return false; } }),
  );
  if (!eligible.size) return [];

  const candidates = previous
    .filter((i) => i?.slug && eligible.has(i.slug))
    .sort((a, b) => String(a.publish_date || '').localeCompare(String(b.publish_date || '')));

  const taken = new Set(newItems.filter((i) => i?.publish_date).map((i) => i.publish_date.slice(0, 10)));
  const lastMs = Math.max(now.getTime(), ...newItems.map((i) => Date.parse(i?.publish_date)).filter(Number.isFinite));
  const next = slotsAfter(lastMs, taken);
  const nowIso = now.toISOString();

  const out = [];
  for (const item of candidates) {
    // An undated item is backlog: it stays undated and pipeline-prioritizer
    // decides when it is written. Giving it a date here would bypass that.
    if (!item.publish_date) {
      out.push({ ...item, carried_at: nowIso, carried_reason: 'paid work (brief or draft) not re-proposed by the planner' });
      continue;
    }
    const t = Date.parse(item.publish_date);
    const keep = Number.isFinite(t) && t > now.getTime() && !taken.has(item.publish_date.slice(0, 10));
    const publish = keep ? new Date(t) : next();
    taken.add(publish.toISOString().slice(0, 10));
    out.push({
      ...item,
      publish_date: publish.toISOString(),
      carried_at: nowIso,
      carried_reason: 'paid work (brief or draft) not re-proposed by the planner',
    });
  }
  return out;
}
