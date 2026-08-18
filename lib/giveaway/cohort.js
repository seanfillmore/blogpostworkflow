// lib/giveaway/cohort.js
/**
 * Entry -> purchase cohort rates for the giveaway.
 *
 * WHY THIS EXISTS: cost per entry is meaningless on its own. The number that
 * sets a CAC ceiling is what share of entrants ever buy, and Meta cannot supply
 * it. Meta attributes on a 7-day-click / 1-day-view window; this giveaway's
 * nurture sends on days 0, 2, 6 and 12 and the offer lands around day 30, so the
 * purchases it is built to produce fall outside Meta's window entirely — and
 * when they do arrive they come from an email click, which Shopify attributes to
 * email rather than to Meta. Reading Meta's ROAS as the verdict would say kill a
 * campaign that is working.
 *
 * So this is deliberately channel-agnostic: of the people who entered, how many
 * later bought anything, by any route.
 *
 * THE TRAP THIS AVOIDS — cohort maturity. Dividing purchasers by ALL entrants
 * counts someone who entered yesterday as a failed 30-day conversion. Early in a
 * campaign almost every entrant is immature, so that denominator drives the rate
 * toward zero and reads as "the giveaway does not convert" precisely when the
 * data cannot say anything yet. Each window therefore counts only entrants whose
 * window has actually elapsed. It is the same denominator error the survey-drift
 * gate in report.mjs already guards against.
 */
import { normalizeEmail } from './entries.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const WINDOWS = [30, 60, 90];

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * @param {Array<{email: string, properties?: object}>} profiles entrants, from listProfilesWithConsent
 * @param {Array<{email?: string, created_at?: string, total_price?: string|number}>} orders raw Shopify orders
 * @param {{now?: Date}} [opts]
 */
export function computeEntryPurchaseCohort(profiles = [], orders = [], { now = new Date() } = {}) {
  const nowMs = now.getTime();

  // Orders by normalized email, ascending by time. An order with no email cannot
  // be joined to an entrant and is dropped rather than guessed at.
  const ordersByEmail = new Map();
  let unjoinableOrders = 0;
  for (const o of orders) {
    if (!o?.email) { unjoinableOrders++; continue; }
    let email;
    try { email = normalizeEmail(o.email); } catch { unjoinableOrders++; continue; }
    const at = Date.parse(o.created_at);
    if (!Number.isFinite(at)) { unjoinableOrders++; continue; }
    const amount = Number.parseFloat(o.total_price ?? 0) || 0;
    if (!ordersByEmail.has(email)) ordersByEmail.set(email, []);
    ordersByEmail.get(email).push({ at, amount });
  }
  for (const list of ordersByEmail.values()) list.sort((a, b) => a.at - b.at);

  // Entrants, dated. An entrant with no gv_entered_at predates the timestamp or
  // was written by an older code path; it cannot be placed in a window, so it is
  // reported separately rather than silently counted as a non-purchaser.
  const dated = [];
  let undated = 0;
  for (const p of profiles) {
    if (!p?.email) { undated++; continue; }
    const raw = p.properties?.gv_entered_at;
    const at = raw ? Date.parse(raw) : NaN;
    if (!Number.isFinite(at)) { undated++; continue; }
    let email;
    try { email = normalizeEmail(p.email); } catch { undated++; continue; }
    dated.push({ email, at });
  }

  const windows = {};
  for (const days of WINDOWS) {
    const span = days * DAY_MS;
    // Only entrants whose window has fully elapsed.
    const matured = dated.filter((e) => nowMs - e.at >= span);
    let purchasers = 0;
    let revenue = 0;
    for (const e of matured) {
      const hits = (ordersByEmail.get(e.email) ?? [])
        .filter((o) => o.at >= e.at && o.at - e.at <= span);
      if (!hits.length) continue;
      purchasers++;
      revenue += hits.reduce((s, o) => s + o.amount, 0);
    }
    windows[days] = {
      matured: matured.length,
      purchasers,
      rate: matured.length ? round2((purchasers / matured.length) * 100) : null,
      revenue: round2(revenue),
      revenuePerEntrant: matured.length ? round2(revenue / matured.length) : null,
      // Stated so a null rate is never misread as "nobody converted".
      note: matured.length ? null : `no entrant is ${days} days old yet`,
    };
  }

  // Channel-agnostic, window-free: any purchase at any point after entry.
  let everPurchasers = 0;
  let everRevenue = 0;
  for (const e of dated) {
    const hits = (ordersByEmail.get(e.email) ?? []).filter((o) => o.at >= e.at);
    if (!hits.length) continue;
    everPurchasers++;
    everRevenue += hits.reduce((s, o) => s + o.amount, 0);
  }

  return {
    entrantsDated: dated.length,
    entrantsUndated: undated,
    unjoinableOrders,
    windows,
    sinceEntry: {
      entrants: dated.length,
      purchasers: everPurchasers,
      rate: dated.length ? round2((everPurchasers / dated.length) * 100) : null,
      revenue: round2(everRevenue),
      revenuePerEntrant: dated.length ? round2(everRevenue / dated.length) : null,
    },
  };
}

/**
 * What one entry is worth, which is the only honest input to a cost-per-entry
 * ceiling. Uses the widest window that has matured, falling back to lifetime.
 */
export function entryValue(cohort) {
  for (const days of [...WINDOWS].reverse()) {
    const w = cohort.windows?.[days];
    if (w?.matured) return { basis: `${days}d`, value: w.revenuePerEntrant, matured: w.matured };
  }
  return {
    basis: 'since-entry (no window matured)',
    value: cohort.sinceEntry?.revenuePerEntrant ?? null,
    matured: cohort.sinceEntry?.entrants ?? 0,
  };
}
