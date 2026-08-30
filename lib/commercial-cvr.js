/**
 * Conversion rate by LANDING-PAGE TYPE — the number the site-wide CVR cannot give.
 *
 * The site-wide rate (0.48-0.82%) counts blog sessions in its denominator, and blog
 * traffic converts near zero while earning 7% of revenue. That makes it useless for
 * "would paid traffic to a product page pay for itself", which is a question about
 * commercial pages only.
 *
 * Denominator: GA4 sessions by landing page.
 * Numerator:   Shopify orders by `landing_site` — ground truth, no modelling.
 *
 * MEASURED 2026-08-04 -> 08-29 (the first clean window after the GA4 outage):
 *
 *   blog             7,665 sessions   5 orders   0.07%
 *   giveaway lander  4,359 sessions   0 orders   0.00%
 *   product            745 sessions   4 orders   0.54%
 *   home               404 sessions   3 orders   0.74%
 *   collection         111 sessions   0 orders   0.00%
 *   COMMERCIAL         856 sessions   4 orders   0.47%
 *
 * The finding is the one nobody expected: commercial at 0.47% is indistinguishable
 * from the site-wide 0.48%. Blog contamination was NOT hiding a healthy product page.
 * At 0.47%, breakeven allowable cost-per-click is $0.12 on a $25-contribution offer
 * and $0.22 on a $47 one, against a realistic Meta CPC of $0.50-$1.50.
 *
 * Pure functions only — no I/O, so this is testable without stubbing a network.
 * The CLI that feeds it lives in scripts/commercial-page-cvr.mjs.
 */
import { pageTypeOf } from './order-attribution.js';

/**
 * The GA4 property was trashed and the hits discarded between 2026-07-27 and
 * 2026-08-03. Restoring a property does not recover them.
 *
 * This matters in ONE direction and it is the dangerous one: the hole removes
 * SESSIONS (the denominator) while Shopify orders (the numerator) are untouched,
 * so any window spanning it reports conversion HIGHER than reality. A tool whose
 * whole job is to say whether a rate clears breakeven must not fail optimistic.
 */
export const GA4_HOLE_END = '2026-08-03';

/**
 * Landing pages that must never be pooled with their page type.
 *
 * The giveaway lander took ~1,447 paid leads on a free-entry ask and 4,359 sessions
 * with zero orders. Inside the generic `page` bucket it drags an unrelated segment
 * to 0% and hides whatever else lives there. It is a different question (what does
 * a free offer convert at) wearing the same page type.
 */
export const GIVEAWAY_PATHS = new Set(['/pages/free-soap-giveaway']);

/** Page types that a paid campaign would actually point traffic at. */
export const COMMERCIAL_SEGMENTS = ['product', 'collection'];

/**
 * Reduce a GA4 landing page or a Shopify landing_site path to a comparable path.
 * Returns null for anything unusable, so callers count it rather than bucket it.
 */
export function normalizeLandingPath(p) {
  if (p === null || p === undefined) return null;
  const raw = String(p).trim();
  if (!raw || raw === '(not set)') return null;
  let s = raw.split('?')[0].split('#')[0];
  if (!s.startsWith('/')) s = '/' + s;
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s || '/';
}

/** Page type, except that a giveaway lander is broken out on its own. */
export function segmentOf(path, { giveawayPaths = GIVEAWAY_PATHS } = {}) {
  const norm = normalizeLandingPath(path);
  if (norm === null) return null;
  if (giveawayPaths.has(norm)) return 'giveaway-lander';
  return pageTypeOf(norm);
}

function emptyBucket() {
  return { sessions: 0, orders: 0, revenue: 0 };
}

/** orders ÷ sessions, or null when there is no denominator to divide by. */
function rateOf(bucket) {
  if (bucket.sessions <= 0) return null;
  return bucket.orders / bucket.sessions;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Join GA4 sessions to Shopify orders by landing-page segment.
 *
 * @param {object} opts
 * @param {Array<{page:string, sessions:number}>} opts.ga4Rows
 * @param {Array<{landingPath:string|null, total:number, countsAsRevenue:boolean}>} opts.orderRows
 *        Records from lib/order-attribution.js attributionRows().
 * @param {Set<string>} [opts.giveawayPaths]
 * @returns {{
 *   segments: Array<{segment:string, sessions:number, orders:number, revenue:number, cvr:number|null, revenuePerSession:number|null}>,
 *   totals: object, commercial: object, blog: object,
 *   noLandingPage: {orders:number, revenue:number},
 *   unmappedSessions: number,
 * }}
 */
export function aggregateCvr({ ga4Rows = [], orderRows = [], giveawayPaths = GIVEAWAY_PATHS } = {}) {
  const buckets = new Map();
  const bucket = (seg) => {
    if (!buckets.has(seg)) buckets.set(seg, emptyBucket());
    return buckets.get(seg);
  };

  let unmappedSessions = 0;
  for (const row of ga4Rows) {
    const seg = segmentOf(row?.page, { giveawayPaths });
    const sessions = Number(row?.sessions) || 0;
    if (seg === null) { unmappedSessions += sessions; continue; }
    bucket(seg).sessions += sessions;
  }

  // Orders with no landing_site are subscription renewals and app-channel orders.
  // They had no web session, so giving them a segment would invent a rate with an
  // empty denominator. They are reported separately so revenue still reconciles.
  const noLandingPage = { orders: 0, revenue: 0 };
  for (const row of orderRows) {
    if (!row?.countsAsRevenue) continue;
    const total = Number(row?.total) || 0;
    const seg = segmentOf(row?.landingPath, { giveawayPaths });
    if (seg === null) {
      noLandingPage.orders += 1;
      noLandingPage.revenue = round2(noLandingPage.revenue + total);
      continue;
    }
    const b = bucket(seg);
    b.orders += 1;
    b.revenue = round2(b.revenue + total);
  }

  const segments = [...buckets.entries()]
    .map(([segment, b]) => ({
      segment,
      sessions: b.sessions,
      orders: b.orders,
      revenue: b.revenue,
      cvr: rateOf(b),
      revenuePerSession: b.sessions > 0 ? b.revenue / b.sessions : null,
    }))
    .sort((a, b) => b.sessions - a.sessions || b.orders - a.orders);

  const rollup = (names) => {
    const acc = emptyBucket();
    for (const n of names) {
      const b = buckets.get(n);
      if (!b) continue;
      acc.sessions += b.sessions;
      acc.orders += b.orders;
      acc.revenue = round2(acc.revenue + b.revenue);
    }
    return { ...acc, cvr: rateOf(acc) };
  };

  return {
    segments,
    totals: rollup([...buckets.keys()]),
    commercial: rollup(COMMERCIAL_SEGMENTS),
    blog: rollup(['blog']),
    noLandingPage,
    unmappedSessions,
  };
}

/**
 * Throw unless the window starts strictly after the GA4 outage.
 * Fails loud rather than quietly reporting an inflated rate.
 */
export function assertGa4WindowClean(startDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(startDate || ''))) {
    throw new Error(`commercial-cvr: start date must be YYYY-MM-DD, got: ${startDate}`);
  }
  if (startDate <= GA4_HOLE_END) {
    throw new Error(
      `commercial-cvr: window starts ${startDate}, on or before the GA4 data hole ending ${GA4_HOLE_END}. ` +
      `Sessions are missing there but orders are not, so CVR would read too HIGH. Start after ${GA4_HOLE_END}.`
    );
  }
}

/**
 * Maximum you can pay per session (≈ per click) and still break even, given a
 * conversion rate and the offer's contribution margin.
 *
 * This is the whole paid-media question in one line: compare it to a real CPC.
 */
export function breakevenCostPerSession(cvr, contributionMargin) {
  if (cvr === null || !Number.isFinite(cvr) || cvr <= 0) return null;
  if (!Number.isFinite(contributionMargin) || contributionMargin <= 0) return null;
  return cvr * contributionMargin;
}

/** The conversion rate an offer needs to break even at a given cost per click. */
export function requiredCvr(costPerSession, contributionMargin) {
  if (!Number.isFinite(costPerSession) || costPerSession <= 0) return null;
  if (!Number.isFinite(contributionMargin) || contributionMargin <= 0) return null;
  return costPerSession / contributionMargin;
}
