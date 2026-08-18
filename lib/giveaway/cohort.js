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
 * ── THREE DENOMINATOR TRAPS ────────────────────────────────────────────────
 *
 * 1. COHORT MATURITY. Dividing purchasers by ALL entrants counts someone who
 *    entered yesterday as a failed 30-day conversion. Early in a campaign almost
 *    every entrant is immature, so that denominator drives the rate toward zero
 *    and reads as "the giveaway does not convert" precisely when the data cannot
 *    say anything yet. Each window counts only entrants whose window elapsed.
 *
 * 2. EXISTING CUSTOMERS. A meaningful share of entrants will be people who have
 *    already bought — a giveaway advertised to a warm audience always pulls
 *    them in. They repurchase at this brand's ~18-22.5% baseline whether or not
 *    they ever saw the ad, so blending them into one rate inflates it and makes
 *    the giveaway look like it converts far better than it acquires. Worse, it
 *    corrupts CAC directly: paying to "acquire" an existing customer is not
 *    acquisition. Every figure is therefore also reported split by whether the
 *    entrant had ANY prior paid order before entering. `newCustomer` is the
 *    segment a CAC ceiling must be set from; `existingCustomer` is a retention
 *    read and its conversions are NOT incremental without a holdout.
 *
 * 3. JUNK ORDERS. `getOrders`/`getAllOrders` return raw Shopify orders including
 *    admin previews, TEST-discount orders, cancellations and $0 orders. Counting
 *    those as conversions inflates both the rate and the revenue. Orders are run
 *    through `classifyOrder` and only `countsAsRevenue` rows survive — the same
 *    rule `lib/order-attribution.js` states is mandatory for any revenue figure.
 */
import { normalizeEmail } from './entries.js';
import { classifyOrder } from '../order-attribution.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const WINDOWS = [30, 60, 90];

/**
 * How far back a prior order still marks someone an existing customer. Two years
 * is a judgement, not a fact: someone who last bought 25 months ago is counted as
 * new. It is stated in the output so the boundary is never invisible.
 */
export const PRIOR_LOOKBACK_DAYS = 730;

const round2 = (n) => Math.round(n * 100) / 100;

function emptyBucket(days) {
  return {
    matured: 0, purchasers: 0, rate: null, revenue: 0, revenuePerEntrant: null,
    note: `no entrant is ${days} days old yet`,
  };
}

/** Windowed + lifetime figures for one set of entrants. */
function measure(entrants, ordersByEmail, nowMs) {
  const windows = {};
  for (const days of WINDOWS) {
    const span = days * DAY_MS;
    const matured = entrants.filter((e) => nowMs - e.at >= span);
    if (!matured.length) { windows[days] = emptyBucket(days); continue; }

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
      rate: round2((purchasers / matured.length) * 100),
      revenue: round2(revenue),
      revenuePerEntrant: round2(revenue / matured.length),
      note: null,
    };
  }

  let everPurchasers = 0;
  let everRevenue = 0;
  for (const e of entrants) {
    const hits = (ordersByEmail.get(e.email) ?? []).filter((o) => o.at >= e.at);
    if (!hits.length) continue;
    everPurchasers++;
    everRevenue += hits.reduce((s, o) => s + o.amount, 0);
  }

  return {
    entrants: entrants.length,
    windows,
    sinceEntry: {
      entrants: entrants.length,
      purchasers: everPurchasers,
      rate: entrants.length ? round2((everPurchasers / entrants.length) * 100) : null,
      revenue: round2(everRevenue),
      revenuePerEntrant: entrants.length ? round2(everRevenue / entrants.length) : null,
    },
  };
}

/**
 * @param {Array<{email: string, properties?: object}>} profiles entrants
 * @param {Array<object>} orders RAW Shopify orders; classified here, junk dropped
 * @param {{now?: Date}} [opts]
 */
export function computeEntryPurchaseCohort(profiles = [], orders = [], { now = new Date() } = {}) {
  const nowMs = now.getTime();

  const ordersByEmail = new Map();
  let unjoinableOrders = 0;
  let excludedJunkOrders = 0;

  for (const o of orders) {
    const c = classifyOrder(o);
    // Admin previews, TEST-discount orders, cancellations and $0 orders are not
    // conversions. Counted, not silently dropped, so the exclusion is visible.
    if (!c || !c.countsAsRevenue) { excludedJunkOrders++; continue; }

    const rawEmail = o?.email || o?.contact_email || o?.customer?.email;
    if (!rawEmail) { unjoinableOrders++; continue; }
    let email;
    try { email = normalizeEmail(rawEmail); } catch { unjoinableOrders++; continue; }
    const at = Date.parse(c.created_at);
    if (!Number.isFinite(at)) { unjoinableOrders++; continue; }

    if (!ordersByEmail.has(email)) ordersByEmail.set(email, []);
    ordersByEmail.get(email).push({ at, amount: c.total });
  }
  for (const list of ordersByEmail.values()) list.sort((a, b) => a.at - b.at);

  const dated = [];
  let undated = 0;
  for (const p of profiles) {
    if (!p?.email) { undated++; continue; }
    const raw = p.properties?.gv_entered_at;
    const at = raw ? Date.parse(raw) : NaN;
    if (!Number.isFinite(at)) { undated++; continue; }
    let email;
    try { email = normalizeEmail(p.email); } catch { undated++; continue; }

    // Existing customer = at least one real order strictly BEFORE entering.
    const priorCutoff = at - PRIOR_LOOKBACK_DAYS * DAY_MS;
    const hadPrior = (ordersByEmail.get(email) ?? [])
      .some((o) => o.at < at && o.at >= priorCutoff);
    dated.push({ email, at, existing: hadPrior });
  }

  const newCustomers = dated.filter((e) => !e.existing);
  const existingCustomers = dated.filter((e) => e.existing);
  const blended = measure(dated, ordersByEmail, nowMs);

  return {
    entrantsDated: dated.length,
    entrantsUndated: undated,
    unjoinableOrders,
    excludedJunkOrders,
    priorLookbackDays: PRIOR_LOOKBACK_DAYS,
    // Blended stays first for continuity, but it is the least useful of the three:
    // it mixes acquisition with retention. Set a CAC ceiling from segments.new.
    windows: blended.windows,
    sinceEntry: blended.sinceEntry,
    segments: {
      new: measure(newCustomers, ordersByEmail, nowMs),
      existing: measure(existingCustomers, ordersByEmail, nowMs),
    },
  };
}

/**
 * What one entry is worth. Uses the widest window that has matured, falling back
 * to lifetime.
 *
 * `segment` defaults to 'new' because this feeds the CAC ceiling and paying to
 * reacquire an existing customer is not acquisition. Pass 'blended' only for a
 * headline figure, never for a spend decision.
 */
export function entryValue(cohort, { segment = 'new' } = {}) {
  const src = segment === 'blended' ? cohort : cohort?.segments?.[segment];
  if (!src) return { segment, basis: 'unavailable', value: null, matured: 0 };

  for (const days of [...WINDOWS].reverse()) {
    const w = src.windows?.[days];
    if (w?.matured) return { segment, basis: `${days}d`, value: w.revenuePerEntrant, matured: w.matured };
  }
  return {
    segment,
    basis: 'since-entry (no window matured)',
    value: src.sinceEntry?.revenuePerEntrant ?? null,
    matured: src.sinceEntry?.entrants ?? 0,
  };
}
