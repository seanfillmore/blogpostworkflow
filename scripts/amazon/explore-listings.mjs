/**
 * Fetch active catalog listings for the seller.
 *
 * Usage:
 *   node scripts/amazon/explore-listings.mjs
 */

import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { getClient, request, getMarketplaceId } from '../../lib/amazon/sp-api-client.js';

const sellerId = process.env.AMAZON_SPAPI_SELLER_ID;
if (!sellerId) {
  throw new Error(
    'AMAZON_SPAPI_SELLER_ID not set. Get your Merchant Token from Seller Central → Settings → Account Info → Your Merchant Token.',
  );
}

const client = getClient();
console.log(`Hitting ${client.env} endpoint: ${client.baseUrl}`);
console.log(`Seller ID: ${sellerId}`);

const marketplaceId = getMarketplaceId();
console.log(`Calling GET /listings/2021-08-01/items/${sellerId}...`);

let allItems = [];
let pageToken = null;
do {
  const params = {
    marketplaceIds: marketplaceId,
    includedData: 'summaries,attributes',
    pageSize: 20,
  };
  if (pageToken) params.pageToken = pageToken;

  const data = await request(
    client,
    'GET',
    `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}`,
    params,
  );
  const items = data?.items ?? [];
  allItems = allItems.concat(items);
  pageToken = data?.pagination?.nextToken ?? null;
  console.log(`  fetched ${items.length} (total: ${allItems.length})`);
} while (pageToken);

console.log(`\nListings: ${allItems.length}`);

const outDir = 'data/amazon-explore';
mkdirSync(outDir, { recursive: true });
const today = new Date().toISOString().slice(0, 10);
const outPath = `${outDir}/${today}-listings-${client.env}.json`;
writeFileSync(outPath, JSON.stringify({ sellerId, marketplaceId, items: allItems }, null, 2));
console.log(`\nDump: ${outPath}`);
