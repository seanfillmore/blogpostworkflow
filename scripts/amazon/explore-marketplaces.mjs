/**
 * SP-API smoke test: list marketplace participations.
 *
 * Runs GET /sellers/v1/marketplaceParticipations and dumps the full response.
 * This is the wiring test - if this works, the client is good.
 *
 * Usage:
 *   node scripts/amazon/explore-marketplaces.mjs
 *   AMAZON_SPAPI_ENV=sandbox node scripts/amazon/explore-marketplaces.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { getClient, request } from '../../lib/amazon/sp-api-client.js';

const client = getClient();
console.log(`Hitting ${client.env} endpoint: ${client.baseUrl}`);
console.log('Calling GET /sellers/v1/marketplaceParticipations...');

const data = await request(client, 'GET', '/sellers/v1/marketplaceParticipations');
const rows = data?.payload || [];

console.log(`\nMarketplaces returned: ${rows.length}`);
for (const m of rows) {
  const name = m.marketplace?.name ?? '(unknown)';
  const id = m.marketplace?.id ?? '(unknown)';
  const participating = m.participation?.isParticipating ? 'active' : 'inactive';
  console.log(`  - ${name} (${id}) - ${participating}`);
}

const outDir = 'data/amazon-explore';
mkdirSync(outDir, { recursive: true });
const today = new Date().toISOString().slice(0, 10);
const outPath = `${outDir}/${today}-marketplaces-${client.env}.json`;
writeFileSync(outPath, JSON.stringify(data, null, 2));
console.log(`\nDump: ${outPath}`);
