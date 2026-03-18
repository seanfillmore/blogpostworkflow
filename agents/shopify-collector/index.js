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
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getOrders, getAbandonedCheckouts } from '../../lib/shopify.js';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SNAPSHOTS_DIR = join(ROOT, 'data', 'snapshots', 'shopify');

const dateArg = process.argv.find(a => a.startsWith('--date='))?.split('=')[1]
  ?? (process.argv.includes('--date') ? process.argv[process.argv.indexOf('--date') + 1] : null);
const date = dateArg || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error('Invalid date format. Expected YYYY-MM-DD.');
  process.exit(1);
}

function buildTopProducts(rawOrders) {
  const map = new Map();
  for (const order of rawOrders) {
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

async function main() {
  console.log('Shopify Collector\n');
  console.log(`  Date: ${date}`);

  // Determine Pacific UTC offset dynamically (PDT = -07:00, PST = -08:00)
  const refTime = new Date(`${date}T20:00:00Z`);
  const ptStr = refTime.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', timeZoneName: 'short' });
  const ptOffset = ptStr.includes('PDT') ? '-07:00' : '-08:00';
  const dayStart = `${date}T00:00:00${ptOffset}`;
  const dayEnd   = `${date}T23:59:59.999${ptOffset}`;

  process.stdout.write('  Fetching orders... ');
  const { count, revenue, aov, rawOrders } = await getOrders(dayStart, dayEnd);
  console.log(`done (${count} orders, $${revenue} revenue)`);

  process.stdout.write('  Fetching abandoned checkouts... ');
  const { count: abandonedCount } = await getAbandonedCheckouts(dayStart, dayEnd);
  console.log(`done (${abandonedCount} abandoned)`);

  const topProducts = buildTopProducts(rawOrders);
  const cartAbandonmentRate = abandonedCount + count > 0
    ? Math.round((abandonedCount / (abandonedCount + count)) * 100) / 100
    : 0;

  const snapshot = {
    date,
    orders: { count, revenue, aov },
    abandonedCheckouts: { count: abandonedCount },
    cartAbandonmentRate,
    topProducts,
  };

  mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  const outPath = join(SNAPSHOTS_DIR, `${date}.json`);
  writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
  console.log(`  Snapshot saved: ${outPath}`);
}

main()
  .then(async () => {
    await notify({ subject: 'Shopify Collector completed', body: `Snapshot saved for ${date}`, status: 'success' }).catch(() => {});
  })
  .catch(async err => {
    await notify({ subject: 'Shopify Collector failed', body: err.message || String(err), status: 'error' }).catch(() => {});
    console.error('Error:', err.message);
    process.exit(1);
  });
