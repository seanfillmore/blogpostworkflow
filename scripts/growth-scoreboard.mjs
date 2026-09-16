#!/usr/bin/env node
// Salvaged from feature/growth-plan-1m before that branch was deleted (2026-08-21).
// The rest of that branch was superseded (dead Klaviyo flow ID XEMgA7, a PDF
// pipeline main has since replaced, a $99 price point that shipped at $121);
// this diagnostic had no equivalent on main and was lifted on its own.
/**
 * Growth KPI scoreboard — the store's purchase conversion rate, on a denominator
 * that can actually buy, reconciled against Shopify orders. Read-only.
 *
 *   node scripts/growth-scoreboard.mjs            28 days ending yesterday (PT)
 *   node scripts/growth-scoreboard.mjs 14         14 days ending yesterday
 *   node scripts/growth-scoreboard.mjs 28 --json  machine output
 *
 * REBUILT 2026-09-16, BECAUSE EVERY NUMBER THE PREVIOUS VERSION PRINTED WAS WRONG,
 * in four independent ways — any one alone would have been enough:
 *
 *  1. IT PRINTED NaN. It summed `conversions` and `revenue` off GA4 rows fetched by
 *     fetchLandingPagesByChannel, which returns {page, channel, source, sessions}
 *     and nothing else. Its test passed because the fixtures carried fields the
 *     real fetch never produces — the test pinned a shape that did not exist.
 *  2. ITS NUMERATOR WAS WRONG. getOrders() is one page with a hard 250 cap, and it
 *     counted cancelled, TEST-discount, $0 and admin-preview orders, plus
 *     subscription renewals that never had a web session to convert.
 *  3. ITS DENOMINATOR WAS 85% JUNK. Measured 2026-08-20 → 09-15 through the ladder
 *     in lib/commercial-cvr.js: 18,201 sessions, of which non-US 2,744, `(not set)`
 *     source 2,857 (2.5% engagement — bots), sweepstakes referrers 2,580, giveaway
 *     funnel 7,319 → 2,701 CLEAN US SHOPPABLE sessions, 14 orders. Its "TRUE CVR"
 *     read ~0.08% where the clean rate is ~0.52% — a 6.5x understatement feeding
 *     every Phase gate in the $1M plan.
 *  4. ITS WINDOW ENDED TODAY, so a partial day's sessions sat in the denominator.
 *
 * WHY THE OLD "GA4 OVERCOUNTS ~4x" HEADLINE IS GONE. That ratio compared GA4
 * `conversions` to Shopify orders, and around 2026-08-01 GA4's conversion definition
 * changed meaning: before, it counted key events such as add-to-cart (~$4-9 of
 * revenue per "conversion"); after, it counts purchases. The "~4x overcount as of
 * 2026-07-22" was true of the old definition and is meaningless now. The cross-check
 * here uses GA4's `ecommercePurchases` explicitly, so it cannot silently change
 * meaning again: ~1.0 means GA4 tracking agrees with the store; well below 1.0 means
 * purchase events are being lost; well above means duplicates.
 *
 * Nothing here re-implements the pipeline. Sessions and the exclusion ladder come
 * from lib/commercial-cvr.js (aggregateCvr), orders from lib/order-attribution.js
 * (attributionRows) — the same pieces scripts/commercial-page-cvr.mjs uses, so the
 * two reports cannot disagree about what a clean session or a real order is.
 *
 * Exit codes (same vocabulary as scripts/commercial-page-cvr.mjs):
 *   0  measured
 *   1  a fetch or argument error
 *   2  window starts inside the GA4 data hole (would report CVR too high)
 *   3  Shopify pagination truncated — orders are missing, CVR would read too low
 *   4  zero orders in window — a fetch failure, not a finding
 *
 * Pure: computeScoreboard({ ga4Rows, orderRows }), scoreboardWindow(...) — tested.
 */
import {
  aggregateCvr, assertGa4WindowClean, orderExclusion, segmentOf, sessionExclusion,
  GA4_HOLE_END,
} from '../lib/commercial-cvr.js';
import { isDirectRun } from '../lib/is-direct-run.js';

/** Below this many clean orders a CVR is directional, not a point estimate. */
export const SMALL_SAMPLE_ORDERS = 30;

export const DEFAULT_DAYS = 28;

const DAY_MS = 86400000;
const round2 = (n) => Math.round(n * 100) / 100;
const addDays = (ymd, n) => new Date(Date.parse(ymd) + n * DAY_MS).toISOString().slice(0, 10);

/** Median of a list of numbers, or null for an empty list. */
export function median(values) {
  const xs = (values || []).filter(Number.isFinite).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : round2((xs[mid - 1] + xs[mid]) / 2);
}

/**
 * The measurement window: `days` calendar days ending YESTERDAY, inclusive.
 *
 * Only the DEFAULT is clamped forward out of the GA4 hole, exactly as
 * scripts/commercial-page-cvr.mjs does. An explicit `days` is returned as asked and
 * the CLI refuses it — silently shortening a window somebody typed would print a
 * 17-day rate labelled as the 60 days they asked for.
 */
export function scoreboardWindow({ days, yesterday }) {
  const explicit = days !== undefined && days !== null;
  const requestedDays = explicit ? days : DEFAULT_DAYS;
  const end = yesterday;
  let start = addDays(end, -(requestedDays - 1));
  let clamped = false;
  if (!explicit && start <= GA4_HOLE_END) {
    start = addDays(GA4_HOLE_END, 1);
    clamped = true;
  }
  const actual = Math.round((Date.parse(end) - Date.parse(start)) / DAY_MS) + 1;
  return { start, end, days: actual, requestedDays, clamped };
}

// ── channels ─────────────────────────────────────────────────────────────────
//
// GA4's `sessionDefaultChannelGroup` and lib/order-attribution.js's `channel` are
// TWO DIFFERENT CLASSIFIERS reading different evidence — GA4 reads its own session
// attribution, Shopify's reads the order's landing_site and referring_site — and
// they do not name the same things. GA4 splits Organic Search from Organic Shopping
// (a Merchant Center free listing), which Shopify files as organic-search; Shopify's
// `paid-search` is really "any paid click" (gclid, or utm_medium=cpc/paid) where GA4
// has five paid groups; GA4's `AI Assistant` group and Shopify's `ai-assistant`
// channel are built from different host lists, so some AI traffic still lands in
// GA4's Referral; and a GA4 `Unassigned` session is often a Shopify `direct` order.
//
// So a per-channel CVR can only be computed over COARSE FAMILIES both sides can be
// mapped onto, and even then it is approximate: the numerator and denominator of one
// row were classified by different code. The output says so. Unknown names on either
// side fall to `other`, which is the honest bucket for "cannot be joined".

const GA4_FAMILY = new Map([
  ['Organic Search', 'organic-search'], ['Organic Shopping', 'organic-search'],
  ['Paid Search', 'paid'], ['Paid Shopping', 'paid'], ['Cross-network', 'paid'],
  ['Paid Social', 'paid'], ['Paid Video', 'paid'], ['Paid Other', 'paid'], ['Display', 'paid'],
  ['Direct', 'direct'],
  ['Email', 'email'],
  ['Referral', 'referral'], ['Organic Social', 'referral'], ['Organic Video', 'referral'],
  ['Affiliates', 'referral'], ['SMS', 'referral'], ['Mobile Push Notifications', 'referral'],
  // Present in the live property as of 2026-09-16 (35 clean sessions on the first
  // run). The first crosswalk did not know it and filed it under `other` while the
  // matching Shopify orders went to `referral` — one channel split across two rows.
  ['AI Assistant', 'ai-assistant'],
]);

const SHOPIFY_FAMILY = new Map([
  ['organic-search', 'organic-search'],
  ['paid-search', 'paid'],
  ['direct', 'direct'],
  ['email', 'email'],
  ['referral', 'referral'],
  ['ai-assistant', 'ai-assistant'],
]);

export const CHANNEL_FAMILIES = Object.freeze([
  'organic-search', 'paid', 'direct', 'email', 'referral', 'ai-assistant', 'other',
]);

export function channelFamilyOfGa4(group) {
  return GA4_FAMILY.get(String(group ?? '').trim()) || 'other';
}

export function channelFamilyOfShopify(channel) {
  return SHOPIFY_FAMILY.get(String(channel ?? '').trim()) || 'other';
}

/** GA4 purchases, or null when no row carries the metric at all (unmeasured ≠ zero). */
function ga4PurchasesOf(ga4Rows) {
  let seen = false;
  let total = 0;
  for (const r of ga4Rows) {
    if (r && Object.prototype.hasOwnProperty.call(r, 'purchases')) {
      seen = true;
      total += Number(r.purchases) || 0;
    }
  }
  return seen ? total : null;
}

/**
 * The whole scoreboard from already-fetched data. No I/O.
 *
 * @param {object} opts
 * @param {Array<{page, channel, source, country, sessions, purchases?}>} opts.ga4Rows
 *        rows from lib/ga4.js fetchLandingPageSegments
 * @param {Array<object>} opts.orderRows records from lib/order-attribution.js attributionRows
 */
export function computeScoreboard({ ga4Rows = [], orderRows = [] } = {}) {
  const agg = aggregateCvr({ ga4Rows, orderRows });

  // The ladder starts from EVERY session GA4 reported. aggregateCvr keeps sessions on
  // a landing page it cannot parse outside its own ladder; here they are the first
  // rung, so the descent from "all" to "clean" is one unbroken subtraction.
  const allSessions = agg.rawTotals.sessions + agg.unmappedSessions;
  const rungs = [
    { reason: 'unusable-landing-page', sessions: agg.unmappedSessions, orders: 0, revenue: 0 },
    ...agg.excluded.map((e) => ({ reason: e.reason, sessions: e.sessions, orders: e.orders, revenue: e.revenue })),
  ];

  const revenueRows = orderRows.filter((r) => r?.countsAsRevenue);
  const totals = revenueRows.map((r) => Number(r.total) || 0);
  const noLandingPage = agg.noLandingPage.orders;
  const sessionDriven = revenueRows.length - noLandingPage;

  // By channel, CLEAN traffic only, on both sides — the same two predicates
  // aggregateCvr applied, so these rows sum to the clean totals exactly.
  const families = new Map(CHANNEL_FAMILIES.map((f) => [f, {
    family: f, sessions: 0, orders: 0, revenue: 0, ga4Channels: new Set(), shopifyChannels: new Set(),
  }]));
  for (const r of ga4Rows) {
    if (segmentOf(r?.page) === null) continue;
    if (sessionExclusion({ country: r?.country, source: r?.source, page: r?.page })) continue;
    const f = families.get(channelFamilyOfGa4(r?.channel));
    f.sessions += Number(r?.sessions) || 0;
    if (r?.channel) f.ga4Channels.add(r.channel);
  }
  for (const r of revenueRows) {
    if (segmentOf(r.landingPath) === null) continue;
    if (orderExclusion(r)) continue;
    const f = families.get(channelFamilyOfShopify(r.channel));
    f.orders += 1;
    f.revenue = round2(f.revenue + (Number(r.total) || 0));
    if (r.channel) f.shopifyChannels.add(r.channel);
  }
  const byChannel = [...families.values()]
    .filter((f) => f.sessions > 0 || f.orders > 0)
    .map((f) => ({
      family: f.family,
      sessions: f.sessions,
      orders: f.orders,
      revenue: f.revenue,
      cvr: f.sessions > 0 ? f.orders / f.sessions : null,
      ga4Channels: [...f.ga4Channels].sort(),
      shopifyChannels: [...f.shopifyChannels].sort(),
    }))
    .sort((a, b) => b.sessions - a.sessions || b.orders - a.orders);

  const ga4Purchases = ga4PurchasesOf(ga4Rows);

  return {
    sessions: { all: allSessions, clean: agg.totals.sessions },
    ladder: { all: allSessions, rungs, clean: agg.totals.sessions },
    orders: {
      fetched: orderRows.length,
      countsAsRevenue: revenueRows.length,
      revenue: round2(totals.reduce((a, b) => a + b, 0)),
      sessionDriven,
      noLandingPage,
      noLandingPageRevenue: agg.noLandingPage.revenue,
      clean: agg.totals.orders,
      cleanRevenue: agg.totals.revenue,
    },
    // Over every order that counts as revenue, renewals included — they are real
    // revenue and real order values. Both statistics, because at ~0.6 orders/day three
    // $200+ orders moved a 28-day mean from $44 to $67 and the mean alone misleads.
    aov: {
      orders: totals.length,
      mean: totals.length ? round2(totals.reduce((a, b) => a + b, 0) / totals.length) : null,
      median: median(totals),
    },
    cvr: {
      // Session-driven orders over every GA4 session. Shown so the gap is visible;
      // never optimize on it — the denominator is mostly bots and giveaway traffic.
      raw: allSessions > 0 ? sessionDriven / allSessions : null,
      // Clean orders over clean US shoppable sessions. THIS is the rate to optimize.
      clean: agg.totals.cvr,
    },
    tracking: {
      ga4Purchases,
      shopifySessionDrivenOrders: sessionDriven,
      ratio: ga4Purchases === null || sessionDriven <= 0 ? null : ga4Purchases / sessionDriven,
    },
    byChannel,
    smallSample: agg.totals.orders < SMALL_SAMPLE_ORDERS,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { json: false, days: undefined };
  for (const a of argv) {
    if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (/^\d+$/.test(a) && Number(a) > 0) args.days = Number(a);
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

const RUNG_LABELS = {
  'unusable-landing-page': 'landing page GA4 truncated past recognition',
  'non-us': 'non-US (cannot buy — US shipping only)',
  'no-source': 'US, sessionSource (not set) — bot signature',
  'sweepstakes-referrer': 'US sweepstakes-aggregator referrers',
  'giveaway-lander': 'US giveaway funnel, other sources',
};

const money = (n) => (n === null ? 'n/a' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const pct = (n) => (n === null ? 'n/a' : (n * 100).toFixed(2) + '%');
const int = (n) => Number(n).toLocaleString('en-US');

function printScoreboard(win, s) {
  const W = 52;
  console.log(`\nGrowth scoreboard — ${win.days}d  ${win.start} → ${win.end}  (GA4 hole ends ${GA4_HOLE_END})`);
  if (win.clamped) console.log(`  default ${win.requestedDays}d window clamped forward out of the GA4 hole`);
  console.log('─'.repeat(76));

  console.log('SESSIONS — how every GA4 session becomes the clean denominator');
  console.log(`  ${'all GA4 sessions'.padEnd(W)}${int(s.ladder.all).padStart(9)}`);
  for (const r of s.ladder.rungs) {
    console.log(`  ${('− ' + (RUNG_LABELS[r.reason] || r.reason)).padEnd(W)}${int(r.sessions).padStart(9)}`);
  }
  console.log(`  ${'= CLEAN US SHOPPABLE'.padEnd(W)}${int(s.ladder.clean).padStart(9)}`);

  console.log('\nORDERS (Shopify — cancelled, TEST, $0 and admin-preview orders removed)');
  console.log(`  count as revenue            ${String(s.orders.countsAsRevenue).padStart(5)}   ${money(s.orders.revenue)}   (${s.orders.fetched} fetched)`);
  console.log(`  − no landing page           ${String(s.orders.noLandingPage).padStart(5)}   ${money(s.orders.noLandingPageRevenue)}   subscription renewals / app — no session to convert`);
  console.log(`  = session-driven            ${String(s.orders.sessionDriven).padStart(5)}`);
  console.log(`    of which CLEAN US SHOPPABLE ${String(s.orders.clean).padStart(3)}   ${money(s.orders.cleanRevenue)}`);

  console.log(`\nAOV over ${s.aov.orders} revenue orders:  mean ${money(s.aov.mean)}   median ${money(s.aov.median)}`);
  console.log('  Quote the median: a few large orders swing the mean at this volume.');

  console.log('\nCONVERSION RATE');
  console.log(`  CLEAN  ${pct(s.cvr.clean).padStart(7)}   ${s.orders.clean} orders / ${int(s.sessions.clean)} clean US shoppable sessions   <-- optimize on this`);
  console.log(`  raw    ${pct(s.cvr.raw).padStart(7)}   ${s.orders.sessionDriven} orders / ${int(s.sessions.all)} sessions of every kind   (do not optimize on this)`);
  if (s.smallSample) {
    console.log(`  ⚠ ${s.orders.clean} clean orders (< ${SMALL_SAMPLE_ORDERS}) — directional only, not a point estimate.`);
  }

  console.log('\nTRACKING SANITY — GA4 ecommercePurchases vs Shopify session-driven orders');
  const t = s.tracking;
  console.log(`  GA4 ${t.ga4Purchases === null ? 'n/a' : t.ga4Purchases} / Shopify ${t.shopifySessionDrivenOrders} = ${t.ratio === null ? 'n/a' : t.ratio.toFixed(2) + 'x'}`);
  console.log('  ~1.0x = GA4 purchase tracking agrees with the store. <1 = purchase events lost, >1 = duplicates.');
  console.log('  (This is NOT the pre-2026-08 "GA4 overcounts ~4x" figure — that counted key events.)');

  console.log('\nBY CHANNEL — clean traffic only, APPROXIMATE');
  console.log('  Sessions are classified by GA4, orders by Shopify attribution: two different');
  console.log('  classifiers, crosswalked onto coarse families. A row does not join exactly.');
  console.log(`  ${'family'.padEnd(16)}${'sessions'.padStart(9)}${'orders'.padStart(8)}${'CVR'.padStart(9)}   GA4 groups / Shopify channels`);
  for (const c of s.byChannel) {
    console.log(
      `  ${c.family.padEnd(16)}${int(c.sessions).padStart(9)}${String(c.orders).padStart(8)}${pct(c.cvr).padStart(9)}` +
      `   ${c.ga4Channels.join(', ') || '—'} / ${c.shopifyChannels.join(', ') || '—'}`,
    );
  }
  console.log('');
}

export async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(e.message);
    return 1;
  }
  if (args.help) {
    console.log('Usage: node scripts/growth-scoreboard.mjs [days] [--json]   (default 28 days ending yesterday PT)');
    return 0;
  }

  // Imported here, not at module scope: lib/shopify.js throws at import time without
  // OAuth credentials, and the pure functions above must stay importable by tests.
  const [{ fetchLandingPageSegments }, { getAllOrders }, { attributionRows }, collector] = await Promise.all([
    import('../lib/ga4.js'),
    import('../lib/shopify.js'),
    import('../lib/order-attribution.js'),
    import('../agents/shopify-collector/index.js'),
  ]);

  // Yesterday in PACIFIC time — the store's day, and the day GA4 reports in.
  const win = scoreboardWindow({ days: args.days, yesterday: collector.getYesterdayPT() });
  try {
    assertGa4WindowClean(win.start);
  } catch (e) {
    console.error(e.message);
    return 2;
  }

  // getAllOrders interpolates straight into created_at_min/max, and a bare
  // YYYY-MM-DD as created_at_max means that day's MIDNIGHT — silently dropping the
  // window's last day. Explicit PT day bounds, as agents/seo-impact passes.
  const [ga4Rows, ordersRes] = await Promise.all([
    fetchLandingPageSegments(win.start, win.end),
    getAllOrders(collector.ptDayBounds(win.start).dayStart, collector.ptDayBounds(win.end).dayEnd),
  ]);

  if (ordersRes.truncated) {
    console.error('REFUSING: Shopify pagination truncated — orders are missing, CVR would read too low.');
    return 3;
  }
  const orderRows = attributionRows(ordersRes.orders);
  if (!orderRows.some((r) => r.countsAsRevenue)) {
    console.error(`REFUSING: zero revenue orders in ${win.start}..${win.end}. This store averages ~0.5/day; treat as a fetch failure.`);
    return 4;
  }

  const s = computeScoreboard({ ga4Rows, orderRows });
  if (args.json) {
    console.log(JSON.stringify({ window: win, ...s }, null, 2));
    return 0;
  }
  printScoreboard(win, s);
  return 0;
}

if (isDirectRun(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
}

