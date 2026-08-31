#!/usr/bin/env node
/**
 * Conversion rate by landing-page type — read-only.
 *
 *   npm run commercial-cvr
 *   npm run commercial-cvr -- --start 2026-08-04 --end 2026-08-29
 *   npm run commercial-cvr -- --json
 *
 * Answers the question the site-wide CVR cannot: would paid traffic to a
 * commercial page pay for itself? See lib/commercial-cvr.js for the measured
 * baseline and why the GA4 window is guarded.
 *
 * Exit codes:
 *   0  measured
 *   1  a fetch or argument error
 *   2  window starts inside the GA4 data hole (would report CVR too high)
 *   3  Shopify pagination truncated — orders are missing, CVR would read too low
 *   4  zero orders in window — a fetch failure, not a finding
 */
import { fetchLandingPagesByChannel } from '../lib/ga4.js';
import { getAllOrders } from '../lib/shopify.js';
import { attributionRows } from '../lib/order-attribution.js';
import {
  aggregateCvr, assertGa4WindowClean, breakevenCostPerSession, requiredCvr,
  heroOffers, GA4_HOLE_END,
} from '../lib/commercial-cvr.js';
import { FALLBACK_PACKAGE_COSTS } from '../lib/shipping-costs.js';
import { BUNDLES, evaluate } from './bundle-economics.mjs';

// Contribution is DERIVED from the same rows `npm run bundle-economics` prints,
// never transcribed. Both numbers here had gone stale — the Reset was carried at
// "$119 / $47" against a real $121 / $78.56 — and a break-even CPC computed from
// a contribution 40% too low says paid traffic is unaffordable when it is not.
const OFFERS = heroOffers(BUNDLES.map((b) => evaluate(b, FALLBACK_PACKAGE_COSTS)));
const REFERENCE_CPCS = [0.5, 1.0, 1.5];

function parseArgs(argv) {
  const args = { json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--start') args.start = argv[++i];
    else if (a === '--end') args.end = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

function defaultWindow() {
  // Yesterday, so a partial day never lands in the denominator.
  const end = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const startDate = new Date(Date.now() - 27 * 86400000);
  let start = startDate.toISOString().slice(0, 10);
  // Never default into the hole; clamp forward to the first clean day.
  const firstClean = new Date(Date.parse(GA4_HOLE_END) + 86400000).toISOString().slice(0, 10);
  if (start <= GA4_HOLE_END) start = firstClean;
  return { start, end };
}

const money = (n) => '$' + Number(n).toFixed(2);
const pct = (n) => (n === null ? 'n/a' : (n * 100).toFixed(2) + '%');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: npm run commercial-cvr -- [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--json]');
    return 0;
  }

  const win = defaultWindow();
  const start = args.start || win.start;
  const end = args.end || win.end;

  try {
    assertGa4WindowClean(start);
  } catch (e) {
    console.error(e.message);
    return 2;
  }

  const [ga4Rows, ordersRes] = await Promise.all([
    fetchLandingPagesByChannel(start, end),
    getAllOrders(start, end),
  ]);

  // getAllOrders returns {orders, pages, truncated} — NOT an array. attributionRows
  // returns [] for a non-array instead of throwing, so handing it the envelope reads
  // as a clean "zero orders" rather than failing. Both are checked explicitly.
  if (ordersRes.truncated) {
    console.error('REFUSING: Shopify pagination truncated — orders are missing, CVR would read too low.');
    return 3;
  }
  const orderRows = attributionRows(ordersRes.orders);
  if (orderRows.length === 0) {
    console.error(`REFUSING: zero orders in ${start}..${end}. This store averages ~0.5/day; treat as a fetch failure.`);
    return 4;
  }

  const result = aggregateCvr({ ga4Rows, orderRows });

  if (args.json) {
    console.log(JSON.stringify({ window: { start, end }, ...result }, null, 2));
    return 0;
  }

  console.log(`Commercial-page CVR   window ${start} → ${end}   (GA4 hole ends ${GA4_HOLE_END})`);
  console.log(`${ordersRes.orders.length} raw orders fetched, ${orderRows.filter((r) => r.countsAsRevenue).length} count as revenue\n`);

  console.log('segment            sessions   orders       CVR      revenue    rev/session');
  console.log('─'.repeat(76));
  for (const s of result.segments) {
    console.log(
      s.segment.padEnd(18) +
      String(s.sessions).padStart(8) +
      String(s.orders).padStart(9) +
      pct(s.cvr).padStart(10) +
      money(s.revenue).padStart(13) +
      (s.revenuePerSession === null ? 'n/a'.padStart(15) : money(s.revenuePerSession).padStart(15))
    );
  }
  console.log('─'.repeat(76));
  console.log(
    'TOTAL'.padEnd(18) +
    String(result.totals.sessions).padStart(8) +
    String(result.totals.orders).padStart(9) +
    pct(result.totals.cvr).padStart(10) +
    money(result.totals.revenue).padStart(13)
  );

  const { commercial, blog } = result;
  console.log('\nCOMMERCIAL (product + collection) — what a paid campaign would target');
  console.log(`  ${commercial.sessions} sessions → ${commercial.orders} orders = ${pct(commercial.cvr)}   ${money(commercial.revenue)}`);
  console.log(`  blog for contrast: ${blog.sessions} sessions → ${blog.orders} orders = ${pct(blog.cvr)}`);
  if (commercial.cvr && blog.cvr) {
    console.log(`  commercial converts ${(commercial.cvr / blog.cvr).toFixed(1)}× the blog rate`);
  }
  console.log(`\n  orders with no landing page (subscription / app channel): ${result.noLandingPage.orders}, ${money(result.noLandingPage.revenue)}`);
  console.log(`  GA4 sessions with an unusable landing page: ${result.unmappedSessions}`);

  if (commercial.orders > 0 && commercial.orders < 30) {
    console.log(`\n  ⚠ ${commercial.orders} commercial orders — directional only, not a point estimate.`);
  }

  console.log('\nPAID BREAKEVEN at the measured commercial rate');
  // Column width follows the longest offer NAME. It used to be a fixed 22, which
  // silently ran the headings together the moment the names came from the roster
  // instead of being hand-shortened here.
  const names = OFFERS.map((o) => o.label.split(' (')[0]);
  const labelW = Math.max(...OFFERS.map((o) => o.label.length)) + 2;
  const colW = Math.max(...names.map((n) => n.length)) + 3;
  for (const o of OFFERS) {
    const maxCps = breakevenCostPerSession(commercial.cvr, o.contribution);
    console.log(`  ${o.label.padEnd(labelW)} max ${maxCps === null ? 'n/a' : money(maxCps)}/click`);
  }
  console.log('\n  CVR each offer would need at a real CPC:');
  console.log('  CPC'.padEnd(10) + names.map((n) => n.padStart(colW)).join(''));
  for (const cpc of REFERENCE_CPCS) {
    console.log(
      ('  ' + money(cpc)).padEnd(10) +
      OFFERS.map((o) => pct(requiredCvr(cpc, o.contribution)).padStart(colW)).join('')
    );
  }
  console.log('\n  Read it as: the offer with the LOWER required CVR is the cheaper one to');
  console.log('  make paid work on. Contribution margin is a lever, not a constant.');

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
