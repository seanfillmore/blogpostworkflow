/**
 * Fetch FBA inventory summary. Lists SKUs and fulfillable quantities.
 *
 * Usage:
 *   node scripts/amazon/explore-inventory.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { getClient, request, getMarketplaceId } from '../../lib/amazon/sp-api-client.js';

const client = getClient();
console.log(`Hitting ${client.env} endpoint: ${client.baseUrl}`);

const marketplaceId = getMarketplaceId();
console.log('Calling GET /fba/inventory/v1/summaries...');

let allItems = [];
let nextToken = null;
do {
  const params = {
    granularityType: 'Marketplace',
    granularityId: marketplaceId,
    marketplaceIds: marketplaceId,
    details: 'true',
  };
  if (nextToken) params.nextToken = nextToken;

  const data = await request(client, 'GET', '/fba/inventory/v1/summaries', params);
  const items = data?.payload?.inventorySummaries ?? [];
  allItems = allItems.concat(items);
  nextToken = data?.pagination?.nextToken ?? null;
  console.log(`  fetched ${items.length} (total: ${allItems.length})`);
} while (nextToken);

let totalFulfillable = 0;
for (const it of allItems) {
  totalFulfillable += it.inventoryDetails?.fulfillableQuantity ?? 0;
}

console.log(`\nSKUs in FBA: ${allItems.length}`);
console.log(`Total fulfillable units: ${totalFulfillable}`);

const outDir = 'data/amazon-explore';
mkdirSync(outDir, { recursive: true });
const today = new Date().toISOString().slice(0, 10);
const outPath = `${outDir}/${today}-inventory-${client.env}.json`;
writeFileSync(outPath, JSON.stringify({ marketplaceId, items: allItems }, null, 2));
console.log(`\nDump: ${outPath}`);
