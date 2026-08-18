/**
 * Shopify Collector Agent
 *
 * Fetches today's Shopify CRO data (orders, abandoned checkouts, top products)
 * and saves a snapshot to:
 *   data/snapshots/shopify/YYYY-MM-DD.json
 *
 * Usage:
 *   node agents/shopify-collector/index.js
 *   node agents/shopify-collector/index.js --date 2026-03-17
 *
 * The snapshot carries an `attribution` block: one PII-free record per order saying
 * which page earned it and which channel sent it (see lib/order-attribution.js).
 * Shopify stamps every order with `landing_site` and `referring_site`; this collector
 * used to receive both on `rawOrders` and throw them away, which left the fleet
 * inferring organic revenue from GA4 instead of reading it off the orders.
 *
 * `data/snapshots/` is backed up offsite, so attribution records must stay PII-free:
 * never add email, ip, customer or address. tests/lib/order-attribution.test.js
 * asserts that, and tests/agents/shopify-collector.test.js asserts it again on the
 * assembled snapshot.
 *
 * Everything that shapes the snapshot is an exported pure function so it can be
 * tested without running the agent. main() only runs on a direct invocation.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getOrders, getAbandonedCheckouts } from '../../lib/shopify.js';
import { notify } from '../../lib/notify.js';
import { attributionRows, channelRollup } from '../../lib/order-attribution.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
export const SNAPSHOTS_DIR = join(ROOT, 'data', 'snapshots', 'shopify');

/** Shape version for the attribution block, so consumers can tell old files apart. */
export const ATTRIBUTION_VERSION = 1;

const PT_TZ = 'America/Los_Angeles';

/** The offset actually in force at an instant, as an ISO offset string. */
function ptOffsetAt(instant) {
  const s = instant.toLocaleString('en-US', { timeZone: PT_TZ, timeZoneName: 'short' });
  return s.includes('PDT') ? '-07:00' : '-08:00';
}

/**
 * Pacific UTC offset in effect mid-day on a calendar date (PDT = -07:00, PST = -08:00).
 * Probed at 20:00 UTC, which is mid-day in PT on either side of a DST switch.
 */
export function ptOffsetFor(date) {
  return ptOffsetAt(new Date(`${date}T20:00:00Z`));
}

/**
 * The offset in force at a given PT wall-clock time on a date. Each candidate offset is
 * round-tripped: interpret the wall time with it, then ask what offset that instant is
 * really in. Only the true one agrees with itself.
 *
 * This matters because the two boundaries of a DST-transition day sit in DIFFERENT
 * offsets. Using one mid-day offset for both — which is what this agent did until now —
 * shifts the whole window by an hour twice a year: on 2026-11-01 it started at 01:00 PT
 * and missed the first hour of orders, and on 2026-03-08 it started at 23:00 PT on the
 * 7th and double-counted that hour.
 */
function ptOffsetForWall(date, wall) {
  for (const off of ['-07:00', '-08:00']) {
    const instant = new Date(`${date}T${wall}${off}`);
    if (!Number.isNaN(instant.getTime()) && ptOffsetAt(instant) === off) return off;
  }
  // A wall time that does not exist (spring-forward gap): fall back to mid-day.
  return ptOffsetFor(date);
}

/** ISO bounds of one PT calendar day, for Shopify's created_at_min/max. */
export function ptDayBounds(date) {
  const startOffset = ptOffsetForWall(date, '00:00:00');
  const endOffset = ptOffsetForWall(date, '23:59:59.999');
  return {
    startOffset,
    endOffset,
    dayStart: `${date}T00:00:00${startOffset}`,
    dayEnd: `${date}T23:59:59.999${endOffset}`,
  };
}

/**
 * The PT calendar day (YYYY-MM-DD) an instant falls in. Same tz database as
 * ptOffsetFor, so bucketing and query bounds can never disagree across a DST switch.
 */
export function ptDayOf(instant) {
  if (instant === null || instant === undefined || instant === '') return null;
  const d = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-CA', { timeZone: PT_TZ });
}

/** Default to yesterday PT so the early-morning cron captures a full previous day. */
export function getYesterdayPT(now = Date.now()) {
  return ptDayOf(new Date((now instanceof Date ? now.getTime() : now) - 86_400_000));
}

export function buildTopProducts(rawOrders) {
  const map = new Map();
  for (const order of (rawOrders || [])) {
    for (const item of (order.line_items || [])) {
      const title = item.title;
      const rev = parseFloat(item.price || 0) * (item.quantity || 1);
      if (!map.has(title)) map.set(title, { title, revenue: 0, orders: 0 });
      const entry = map.get(title);
      entry.revenue += rev;
      entry.orders += 1;
    }
  }
  return [...map.values()]
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5)
    .map(p => ({ title: p.title, revenue: Math.round(p.revenue * 100) / 100, orders: p.orders }));
}

/**
 * The `attribution` block: per-order PII-free records plus a channel rollup.
 * Pure — the backfill script builds the identical block for historical snapshots.
 */
export function buildAttribution(rawOrders) {
  const orders = attributionRows(rawOrders);
  return {
    version: ATTRIBUTION_VERSION,
    channels: channelRollup(orders),
    orders,
  };
}

/**
 * Assemble the snapshot. Every pre-existing field keeps its exact shape — dashboards
 * and other agents read them — and `attribution` is purely additive.
 */
export function buildSnapshot({ date, count, revenue, aov, abandonedCount, rawOrders }) {
  const orderCount = count ?? 0;
  const abandoned = abandonedCount ?? 0;
  const cartAbandonmentRate = abandoned + orderCount > 0
    ? Math.round((abandoned / (abandoned + orderCount)) * 100) / 100
    : 0;

  return {
    date,
    orders: { count: orderCount, revenue, aov },
    abandonedCheckouts: { count: abandoned },
    cartAbandonmentRate,
    topProducts: buildTopProducts(rawOrders),
    attribution: buildAttribution(rawOrders),
  };
}

function resolveDateArg(argv = process.argv) {
  return argv.find(a => a.startsWith('--date='))?.split('=')[1]
    ?? (argv.includes('--date') ? argv[argv.indexOf('--date') + 1] : null);
}

async function main() {
  const date = resolveDateArg() || getYesterdayPT();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error('Invalid date format. Expected YYYY-MM-DD.');
    process.exit(1);
  }

  console.log('Shopify Collector\n');
  console.log(`  Date: ${date}`);

  const { dayStart, dayEnd } = ptDayBounds(date);

  process.stdout.write('  Fetching orders... ');
  const { count, revenue, aov, rawOrders } = await getOrders(dayStart, dayEnd);
  console.log(`done (${count} orders, $${revenue} revenue)`);

  process.stdout.write('  Fetching abandoned checkouts... ');
  const { count: abandonedCount } = await getAbandonedCheckouts(dayStart, dayEnd);
  console.log(`done (${abandonedCount} abandoned)`);

  const snapshot = buildSnapshot({ date, count, revenue, aov, abandonedCount, rawOrders });

  for (const c of snapshot.attribution.channels) {
    console.log(`  ${c.channel}: ${c.orders} order(s), $${c.revenue}`);
  }

  mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  const outPath = join(SNAPSHOTS_DIR, `${date}.json`);
  writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
  console.log(`  Snapshot saved: ${outPath}`);
  return date;
}

// Only run when invoked directly. Without this guard, any import of this module
// (the tests, and scripts/backfill-order-attribution.mjs) executes the whole agent —
// hitting the live Shopify API, writing a snapshot, and calling process.exit.
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  main()
    .then(async (date) => {
      await notify({ subject: 'Shopify Collector completed', body: `Snapshot saved for ${date}`, status: 'success' }).catch(() => {});
    })
    .catch(async err => {
      await notify({ subject: 'Shopify Collector failed', body: err.message || String(err), status: 'error' }).catch(() => {});
      console.error('Error:', err.message);
      process.exit(1);
    });
}
