/**
 * Fetch last 30 days of orders. Summarize count + revenue + top SKUs.
 *
 * Usage:
 *   node scripts/amazon/explore-orders.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { getClient, request, getMarketplaceId } from '../../lib/amazon/sp-api-client.js';

const client = getClient();
console.log(`Hitting ${client.env} endpoint: ${client.baseUrl}`);

const createdAfter = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
const marketplaceId = getMarketplaceId();

console.log(`Calling GET /orders/v0/orders (CreatedAfter=${createdAfter})...`);

let allOrders = [];
let nextToken = null;
do {
  const params = nextToken
    ? { NextToken: nextToken, MarketplaceIds: marketplaceId }
    : { CreatedAfter: createdAfter, MarketplaceIds: marketplaceId };
  const data = await request(client, 'GET', '/orders/v0/orders', params);
  const orders = data?.payload?.Orders ?? [];
  allOrders = allOrders.concat(orders);
  nextToken = data?.payload?.NextToken ?? null;
  console.log(`  fetched ${orders.length} (total: ${allOrders.length})`);
} while (nextToken);

let totalRevenue = 0;
for (const order of allOrders) {
  const amount = parseFloat(order.OrderTotal?.Amount ?? '0');
  if (!Number.isNaN(amount)) totalRevenue += amount;
}

console.log(`\nOrders: ${allOrders.length}`);
console.log(`Revenue (orders total): ${totalRevenue.toFixed(2)} USD`);
console.log('(SKU-level top-N would require a second call to /orders/v0/orders/{orderId}/orderItems - deferred)');

const outDir = 'data/amazon-explore';
mkdirSync(outDir, { recursive: true });
const today = new Date().toISOString().slice(0, 10);
const outPath = `${outDir}/${today}-orders-${client.env}.json`;
writeFileSync(outPath, JSON.stringify({ createdAfter, marketplaceId, orders: allOrders }, null, 2));
console.log(`\nDump: ${outPath}`);
