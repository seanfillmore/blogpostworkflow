// lib/culina-forecast.js
//
// Pure forecast and ship-plan math for the Culina monthly inventory report.
// Dates are UTC calendar days as 'YYYY-MM-DD' strings. No I/O.

import { components, isSourced } from './culina-catalog.js';

const DAY = 86400000;
const MAX_HORIZON = 3650;

const toMs = (d) => Date.parse(`${d}T00:00:00Z`);
const fromMs = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (d, n) => fromMs(toMs(d) + n * DAY);
const diffDays = (a, b) => Math.round((toMs(a) - toMs(b)) / DAY);
const monthOf = (d) => Number(d.slice(5, 7));
const seasonOf = (seasonal, d) => seasonal?.[monthOf(d)] ?? 1;

export function inStockDays(daily, stockoutDates) {
  return (daily || []).filter((r) => !stockoutDates?.has(r.date));
}

/** Exponentially weighted units/day; age measured from the newest day given. */
export function dailyPace(allDaily, { halfLifeDays = 14, stockoutDates = null } = {}) {
  const daily = stockoutDates ? inStockDays(allDaily, stockoutDates) : allDaily;
  if (!daily?.length) return null;
  const latest = daily.reduce((m, r) => (r.date > m ? r.date : m), daily[0].date);
  let num = 0;
  let den = 0;
  for (const r of daily) {
    const w = Math.pow(0.5, diffDays(latest, r.date) / halfLifeDays);
    num += w * r.units;
    den += w;
  }
  return den > 0 ? num / den : null;
}

export function seasonalIndex(monthlySearches) {
  const flat = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i + 1, 1]));
  const sums = {}; // month -> year -> volume summed over keywords
  for (const series of monthlySearches || []) {
    for (const r of series || []) {
      const v = Number(r.search_volume);
      if (!Number.isFinite(v)) continue;
      ((sums[r.month] ||= {})[r.year] ||= 0);
      sums[r.month][r.year] += v;
    }
  }
  const perMonth = [];
  for (let m = 1; m <= 12; m++) {
    const years = Object.values(sums[m] || {});
    if (!years.length) return flat;
    perMonth.push(years.reduce((a, b) => a + b, 0) / years.length);
  }
  const mean = perMonth.reduce((a, b) => a + b, 0) / 12;
  if (!(mean > 0)) return flat;
  return Object.fromEntries(perMonth.map((v, i) => [i + 1, v / mean]));
}

export function forecastUnits(pace, startDate, days, seasonal) {
  let total = 0;
  for (let i = 0; i < days; i++) total += pace * seasonOf(seasonal, addDays(startDate, i));
  return total;
}

const ceilUnits = (x) => Math.max(0, Math.ceil(x - 1e-9));

function coverOn(stock, pace, date, seasonal) {
  let remaining = stock;
  let days = 0;
  while (remaining > 0 && days < MAX_HORIZON) {
    const use = pace * seasonOf(seasonal, addDays(date, days));
    if (use <= 0) { days++; continue; }
    if (remaining < use) return days + remaining / use;
    remaining -= use;
    days++;
  }
  return days;
}

export function shipPlan({ pace, onHand, today, seasonal, config }) {
  if (pace === null || pace === undefined) {
    return { coverDays: null, forecast30: null, forecast60: null, forecast90: null, shipBy: null, shipQty: null };
  }
  const forecast = (d) => Math.round(forecastUnits(pace, today, d, seasonal));
  const base = { forecast30: forecast(30), forecast60: forecast(60), forecast90: forecast(90) };
  if (!(pace > 0)) return { coverDays: null, ...base, shipBy: null, shipQty: 0 };

  const lead = config?.lead_time_days ?? 14;
  const [floorDays, targetDays] = config?.cover_target_days ?? [90, 120];
  const coverDays = Math.round(coverOn(onHand, pace, today, seasonal));

  // First day the remaining stock lasts no more than floorDays, O(horizon):
  // cumulative usage plus a rolling floorDays window over one usage array.
  const n = MAX_HORIZON + floorDays;
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + pace * seasonOf(seasonal, addDays(today, i));
  let crossingIdx = -1;
  for (let i = 0; i < MAX_HORIZON; i++) {
    if (onHand - cum[i] <= cum[i + floorDays] - cum[i] + 1e-9) { crossingIdx = i; break; }
  }
  if (crossingIdx < 0) return { coverDays, ...base, shipBy: null, shipQty: 0 };
  let shipBy = addDays(today, crossingIdx - lead);
  if (shipBy < today) shipBy = today;

  const arrival = addDays(shipBy, lead);
  const left = Math.max(0, onHand - forecastUnits(pace, today, diffDays(arrival, today), seasonal));
  const shipQty = ceilUnits(forecastUnits(pace, arrival, targetDays, seasonal) - left);
  return { coverDays, ...base, shipBy, shipQty };
}

/**
 * A run of 3+ zero-sale days is read as a stockout only for an item averaging at
 * least INFER_MIN_DAILY units a day over the whole window: at 2 a day, three quiet
 * days in a row by chance is about e^-6 (0.25%). Slower items have quiet weeks as a
 * matter of course, so only a snapshot showing 0 FBA stock marks their stockouts.
 * (The first version averaged only the selling days, which is always >= 1 for whole
 * units, and inflated slow sellers' pace several-fold.)
 */
export const INFER_MIN_DAILY = 2;

export function inferStockoutDates(daily, snapshots = {}) {
  const rows = [...(daily || [])].sort((a, b) => (a.date < b.date ? -1 : 1));
  const out = new Set();
  const mean = rows.length ? rows.reduce((s, r) => s + r.units, 0) / rows.length : 0;
  const inferred = new Set();
  if (mean >= INFER_MIN_DAILY) {
    let run = [];
    const flush = () => { if (run.length >= 3) run.forEach((d) => inferred.add(d)); run = []; };
    for (const r of rows) {
      const contiguous = run.length === 0 || diffDays(r.date, run[run.length - 1]) === 1;
      const zero = r.units === 0 && !(snapshots[r.date] > 0);
      if (zero && contiguous) run.push(r.date);
      else { flush(); if (zero) run.push(r.date); }
    }
    flush();
  }
  for (const r of rows) {
    if (Object.prototype.hasOwnProperty.call(snapshots, r.date)) {
      if (snapshots[r.date] === 0) out.add(r.date);
    } else if (inferred.has(r.date)) out.add(r.date);
  }
  return out;
}

/**
 * `today` (required) clamps sourced orderBy dates that would fall in the past. shipQty and
 * needBy (earliest ship date) come only from items whose shipBy is within today + 90 days.
 */
export function componentPlan(itemPlans, cogsTable, config, today) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today || '')) throw new Error('componentPlan requires today as YYYY-MM-DD');
  // Only ship plans due inside the 90-day window count toward a component's need;
  // a kit that ships in five months must not inflate what to make now.
  const horizon = addDays(today, 90);
  const byName = new Map();
  for (const it of itemPlans || []) {
    const due = it.shipBy && it.shipBy <= horizon;
    for (const name of components(it.asin, cogsTable)) {
      const c = byName.get(name) || { name, pace: 0, onHand: 0, shipQty: 0, earliest: null };
      c.pace += it.pace ?? 0;
      c.onHand += it.onHand ?? 0;
      if (due) {
        c.shipQty += it.shipQty ?? 0;
        if (!c.earliest || it.shipBy < c.earliest) c.earliest = it.shipBy;
      }
      byName.set(name, c);
    }
  }
  return [...byName.values()].map((c) => {
    const sourced = isSourced(c.name, config);
    let orderBy = null;
    if (sourced && c.earliest) {
      orderBy = addDays(c.earliest, -(config?.sourced_lead_time_days ?? 45));
      if (orderBy < today) orderBy = today;
    }
    return {
      name: c.name,
      pace: c.pace,
      onHand: c.onHand,
      coverDays: c.pace > 0 ? c.onHand / c.pace : null,
      shipQty: c.shipQty,
      sourced,
      needBy: c.earliest,
      orderBy,
    };
  });
}
