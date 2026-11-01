/**
 * The CVR ranges a paid proposal must fall inside — MEASURED, never benchmarked.
 *
 * WHAT THIS REPLACED. Until 2026-09-16 agents/campaign-analyzer carried a
 * hardcoded PAGE_TYPE_CVR table of industry benchmarks — product 3-7%, collection
 * 2-5%, homepage 1-3%, blog 0.5-2%, dedicated landing page 4-10% — and ENFORCED it
 * twice: the prompt told the model its projection "MUST fall within the range",
 * and the reviewer rejected anything outside it. Measured clean US shoppable CVR
 * for 2026-08-20 -> 09-15 (lib/commercial-cvr.js, PR #888):
 *
 *   blog        1726 sessions  7 orders  0.41%
 *   product      441           4         0.91%
 *   home         313           3         0.96%
 *   collection   126           0         0.00%
 *   page          58           0         0.00%
 *   commercial (product+collection) 567 / 4 = 0.71%
 *
 * The benchmarks sat 4-9x above that. So the reviewer REJECTED a proposal that
 * projected a realistic product-page CVR, and everything that survived overstated
 * revenue by the same factor — which the ROAS filter then read as profitable. That
 * is not hypothetical: the 2026-03-20 lotion proposal projected 3% CVR -> 0.89x
 * ROAS, went ACTIVE, and delivered 0.23% CVR / 0.19x ROAS.
 *
 * HOW THE RANGES ARE BUILT. Sessions from GA4 by landing page, orders from Shopify
 * `landing_site`, aggregated through lib/commercial-cvr.js's `aggregateCvr` — the
 * exclusion ladder is REUSED, not re-implemented here. Each segment's range is a
 * 95% Wilson interval (`wilsonInterval`), because single-digit order counts do not
 * support a point estimate. A segment with fewer than MIN_SEGMENT_ORDERS has no
 * usable evidence of its own and borrows a pool:
 *
 *   product, collection, landing  -> the pooled COMMERCIAL interval
 *   homepage, blog                -> the pooled clean-site interval
 *
 * Homepage and blog are NOT pooled with commercial: blog converts below the
 * commercial pages, so borrowing their range would let a blog-landing proposal
 * project a commercial rate. The clean-site pool is the evidence that includes
 * them. (On the measured window both have >= 3 orders of their own anyway.)
 *
 * NEVER THE OLD BENCHMARKS. "No evidence this page type converts better than our
 * commercial pages" is the honest default, and a dedicated landing page is not
 * assumed to convert better because an industry benchmark says landing pages do —
 * the landing range is CAPPED at the commercial pool's upper bound even when a
 * landing segment has evidence of its own.
 *
 * FAIL CLOSED. `measureCvr` throws CvrMeasurementError on a fetch error, truncated
 * orders, zero orders, a malformed orders envelope, an unusable window, or no
 * commercial denominator. The agent then writes NO proposals and NO barrier.
 * Proposals spend money; an agent that falls back to fantasy numbers when it
 * cannot measure is exactly the defect this module exists to remove.
 */
import { aggregateCvr, assertGa4WindowClean, wilsonInterval, GA4_HOLE_END } from '../../../lib/commercial-cvr.js';
import { attributionRows } from '../../../lib/order-attribution.js';

/** Trailing window measured, ending yesterday. Clamped to after the GA4 hole. */
export const MEASUREMENT_WINDOW_DAYS = 90;

/** Below this many orders a segment's own interval is not used. */
export const MIN_SEGMENT_ORDERS = 3;

/** The analyzer's page types (classifyPageType) -> lib/commercial-cvr.js segments. */
export const PAGE_TYPE_SEGMENT = Object.freeze({
  homepage: 'home',
  product: 'product',
  collection: 'collection',
  blog: 'blog',
  landing: 'page',
});

/** Which pool a page type borrows when its own sample is too thin. */
const PAGE_TYPE_POOL = Object.freeze({
  homepage: 'site',
  product: 'commercial',
  collection: 'commercial',
  blog: 'site',
  landing: 'commercial',
});

export const PAGE_TYPE_LABELS = Object.freeze({
  homepage: 'homepage',
  product: 'product page',
  collection: 'collection page',
  blog: 'blog post',
  landing: 'dedicated landing page (/pages/)',
});

export class CvrMeasurementError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CvrMeasurementError';
  }
}

const DAY_MS = 86400000;
const shiftDay = (ymd, days) => new Date(Date.parse(`${ymd}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/**
 * The window to measure, in PACIFIC calendar days: the last
 * MEASUREMENT_WINDOW_DAYS days ending YESTERDAY PT (a partial day never lands in
 * the denominator), never starting on or before GA4_HOLE_END — sessions are
 * missing there while orders are not, which reads CVR too HIGH, the one direction
 * this measurement must never fail in.
 *
 * WHY PACIFIC, AND WHY IT MATTERS HERE. The GA4 property's timeZone is
 * America/Los_Angeles, so GA4 buckets sessions by Pacific day; orders have to be
 * bounded on the same days or the sessions ÷ orders join does not line up. (The
 * Shopify shop runs America/Denver — NOT the zone to use.) The cron fires at 06:00
 * UTC, which is 23:00 PT the previous evening, so a UTC "yesterday" would be the
 * Pacific TODAY — a partial day in the denominator.
 *
 * `dayOf` is agents/shopify-collector's DST-correct `ptDayOf`, INJECTED rather than
 * imported: that module imports lib/shopify.js, which throws at import without
 * OAuth credentials, and this file must stay importable so a missing credential is
 * a measurement failure the agent can report, not a module that never loads.
 *
 * @param {Date} now
 * @param {{dayOf: (instant: Date) => string}} tz
 */
export function measurementWindow(now, { dayOf }) {
  if (typeof dayOf !== 'function') throw new CvrMeasurementError('measurementWindow: a Pacific dayOf is required');
  const end = dayOf(new Date(now.getTime() - DAY_MS));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(end))) throw new CvrMeasurementError(`measurementWindow: unusable end day ${end}`);
  let start = shiftDay(end, -(MEASUREMENT_WINDOW_DAYS - 1));
  const firstClean = shiftDay(GA4_HOLE_END, 1);
  if (start <= GA4_HOLE_END) start = firstClean;
  if (start > end) {
    throw new CvrMeasurementError(`measurement window unusable: first clean day ${firstClean} is after yesterday ${end}`);
  }
  try {
    assertGa4WindowClean(start);
  } catch (e) {
    throw new CvrMeasurementError(e.message);
  }
  return { start, end };
}

/**
 * Turn an `aggregateCvr` result into per-page-type ranges.
 *
 * @param {{segments:Array<{segment:string,sessions:number,orders:number}>, commercial:{sessions:number,orders:number}, totals:{sessions:number,orders:number}}} agg
 * @returns {{commercial: object|null, site: object|null, byPageType: Record<string, object|null>}}
 */
export function buildCvrRanges(agg) {
  const commercial = wilsonInterval(agg?.commercial?.orders ?? 0, agg?.commercial?.sessions ?? 0);
  const site = wilsonInterval(agg?.totals?.orders ?? 0, agg?.totals?.sessions ?? 0);
  const pools = { commercial, site };
  const bySegment = new Map((agg?.segments || []).map((s) => [s.segment, s]));

  const byPageType = {};
  for (const [pageType, segment] of Object.entries(PAGE_TYPE_SEGMENT)) {
    const seg = bySegment.get(segment) || { sessions: 0, orders: 0 };
    const own = wilsonInterval(seg.orders, seg.sessions);
    let range;
    if (own && seg.orders >= MIN_SEGMENT_ORDERS) {
      range = { source: 'segment', ...own, min: own.lower, max: own.upper };
    } else {
      const poolName = PAGE_TYPE_POOL[pageType];
      const pool = pools[poolName];
      range = pool
        ? {
          source: `pooled-${poolName}`, ...pool, min: pool.lower, max: pool.upper,
          segmentOrders: seg.orders, segmentSessions: seg.sessions,
        }
        : null;
    }
    // A dedicated landing page is never assumed to beat the commercial pages.
    if (range && pageType === 'landing') {
      if (!commercial) {
        range = null;
      } else {
        range.max = Math.min(range.max, commercial.upper);
        range.min = Math.min(range.min, range.max);
      }
    }
    byPageType[pageType] = range;
  }
  return { commercial, site, byPageType };
}

/**
 * Measure clean US shoppable CVR for the window, through the existing pipeline.
 * Dependencies are injected: lib/shopify.js throws at import without OAuth
 * credentials, so the caller imports it inside its own failure boundary.
 *
 * @param {object} deps
 * @param {(start:string, end:string) => Promise<Array>} deps.fetchSegments  lib/ga4.js fetchLandingPageSegments
 * @param {(start:string, end:string) => Promise<{orders:object[], truncated:boolean}>} deps.fetchOrders  lib/shopify.js getAllOrders
 * @param {(instant: Date) => string} deps.dayOf  agents/shopify-collector ptDayOf
 * @param {(ymd: string) => {dayStart:string, dayEnd:string}} deps.dayBounds  agents/shopify-collector ptDayBounds
 * @param {Date} [deps.now]
 * @throws {CvrMeasurementError}
 */
export async function measureCvr({ fetchSegments, fetchOrders, dayOf, dayBounds, now = new Date() }) {
  if (typeof dayBounds !== 'function') throw new CvrMeasurementError('measureCvr: Pacific dayBounds is required');
  const window = measurementWindow(now, { dayOf });
  let ga4Rows;
  let ordersRes;
  try {
    // GA4 takes bare dates: the property is already on Pacific time.
    ga4Rows = await fetchSegments(window.start, window.end);
    // Shopify does NOT: getAllOrders interpolates straight into created_at_min/max,
    // and a bare end date is read as MIDNIGHT — the whole final day is dropped
    // (verified live: getAllOrders('2026-09-12', '2026-09-12') returned 0 orders
    // while #2352, created that morning, was there). Same bounds agents/seo-impact
    // uses.
    ordersRes = await fetchOrders(dayBounds(window.start).dayStart, dayBounds(window.end).dayEnd);
  } catch (e) {
    throw new CvrMeasurementError(`fetch failed for ${window.start}..${window.end}: ${e?.message || e}`);
  }
  // getAllOrders returns {orders, pages, truncated} — NOT an array — and
  // attributionRows returns [] for a non-array rather than throwing, so a wrong
  // shape would read as a clean "zero orders". Checked explicitly, as
  // scripts/commercial-page-cvr.mjs does.
  if (!ordersRes || !Array.isArray(ordersRes.orders)) {
    throw new CvrMeasurementError('Shopify orders envelope is not {orders: [...]} — refusing to read it as zero orders');
  }
  if (ordersRes.truncated) {
    throw new CvrMeasurementError('Shopify pagination truncated — orders are missing, CVR would read too LOW');
  }
  if (!Array.isArray(ga4Rows)) {
    throw new CvrMeasurementError('GA4 landing-page segments are not an array');
  }
  const orderRows = attributionRows(ordersRes.orders);
  if (!orderRows.some((r) => r.countsAsRevenue)) {
    throw new CvrMeasurementError(
      `zero orders in ${window.start}..${window.end}. This store averages ~0.5/day; treat as a fetch failure, not a finding`
    );
  }
  const aggregate = aggregateCvr({ ga4Rows, orderRows });
  const ranges = buildCvrRanges(aggregate);
  if (!ranges.commercial) {
    throw new CvrMeasurementError(
      `no commercial (product+collection) sessions in ${window.start}..${window.end} — nothing to measure a paid landing page against`
    );
  }
  return { window, aggregate, ranges };
}

const round2 = (n) => Math.round(n * 100) / 100;
export const pct = (n) => `${(n * 100).toFixed(2)}%`;

/**
 * Maximum CPC that still clears `minRoas` at the measured commercial CVR —
 * point estimate and both Wilson bounds.
 */
export function breakEvenCpcAtMeasured(aov, minRoas, commercial) {
  const cpa = aov / minRoas;
  return {
    atPoint: round2(cpa * commercial.point),
    atLower: round2(cpa * commercial.lower),
    atUpper: round2(cpa * commercial.upper),
  };
}

function sampleText(orders, sessions) {
  return `${orders} ${orders === 1 ? 'order' : 'orders'} / ${sessions} sessions`;
}

/** The prompt section. Every range carries the sample behind it. */
export function renderMeasuredCvrSection(measurement) {
  const { window, ranges } = measurement;
  const c = ranges.commercial;
  const lines = [
    '## MEASURED conversion rate by landing-page type (use these — NOT industry benchmarks)',
    `Measured on CLEAN US shoppable traffic, ${window.start} → ${window.end}: GA4 sessions by landing page, Shopify orders by landing_site; bot, non-US, sweepstakes and giveaway traffic excluded.`,
    'The samples are SMALL — a handful of orders per page type — so each range is a 95% Wilson interval, not a point estimate. The upper bound is what the sample cannot rule out, not an expectation: project near the measured rate unless you have page-specific evidence.',
    'Your projections.cvr MUST fall inside the range for the landing page type you select. A proposal outside it is rejected.',
    `Commercial pool (product + collection): ${pct(c.point)} measured (${sampleText(c.orders, c.sessions)}); range ${pct(c.lower)}–${pct(c.upper)}.`,
  ];
  for (const [pageType, r] of Object.entries(ranges.byPageType)) {
    const label = PAGE_TYPE_LABELS[pageType];
    if (!r) {
      lines.push(`- ${label}: NO measured range — do not propose this page type.`);
      continue;
    }
    if (r.source === 'segment') {
      lines.push(`- ${label}: ${pct(r.point)} measured (${sampleText(r.orders, r.sessions)}); allowed range ${pct(r.min)}–${pct(r.max)}.`);
    } else {
      const poolName = r.source === 'pooled-commercial' ? 'pooled commercial' : 'pooled clean-site';
      lines.push(
        `- ${label}: no usable evidence of its own (${sampleText(r.segmentOrders, r.segmentSessions)}, fewer than ${MIN_SEGMENT_ORDERS} orders) — ` +
        `using the ${poolName} range (${sampleText(r.orders, r.sessions)}): ${pct(r.min)}–${pct(r.max)}.`
      );
    }
  }
  lines.push('There is NO evidence that a dedicated landing page converts better than our commercial pages; its range is capped at the commercial pool. Do not assume it does.');
  return lines.join('\n');
}
