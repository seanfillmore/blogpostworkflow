/**
 * Fetch recent financial events (settlements, refunds, fees) - last 30 days.
 *
 * Usage:
 *   node scripts/amazon/explore-finance.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { getClient, request } from '../../lib/amazon/sp-api-client.js';

const client = getClient();
console.log(`Hitting ${client.env} endpoint: ${client.baseUrl}`);

const postedAfter = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

console.log(`Calling GET /finances/v0/financialEvents (PostedAfter=${postedAfter})...`);

let allEvents = { ShipmentEventList: [], RefundEventList: [], ServiceFeeEventList: [] };
let nextToken = null;

do {
  const params = nextToken ? { NextToken: nextToken } : { PostedAfter: postedAfter };
  const data = await request(client, 'GET', '/finances/v0/financialEvents', params);
  const events = data?.payload?.FinancialEvents ?? {};
  for (const key of Object.keys(events)) {
    if (Array.isArray(events[key])) {
      allEvents[key] = (allEvents[key] ?? []).concat(events[key]);
    } else {
      allEvents[key] = events[key];
    }
  }
  nextToken = data?.payload?.NextToken ?? null;
  console.log(`  page fetched; NextToken=${nextToken ? 'yes' : 'no'}`);
} while (nextToken);

console.log(`\nShipment events: ${allEvents.ShipmentEventList?.length ?? 0}`);
console.log(`Refund events: ${allEvents.RefundEventList?.length ?? 0}`);
console.log(`Service fee events: ${allEvents.ServiceFeeEventList?.length ?? 0}`);

const outDir = 'data/amazon-explore';
mkdirSync(outDir, { recursive: true });
const today = new Date().toISOString().slice(0, 10);
const outPath = `${outDir}/${today}-finance-${client.env}.json`;
writeFileSync(outPath, JSON.stringify({ postedAfter, events: allEvents }, null, 2));
console.log(`\nDump: ${outPath}`);
