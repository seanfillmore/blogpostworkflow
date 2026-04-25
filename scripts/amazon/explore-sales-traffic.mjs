/**
 * Fetch Sales and Traffic report by ASIN (last 30 days).
 *
 * Usage:
 *   node scripts/amazon/explore-sales-traffic.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import {
  getClient,
  getMarketplaceId,
  requestReport,
  pollReport,
  downloadReport,
} from '../../lib/amazon/sp-api-client.js';

const client = getClient();
console.log(`Hitting ${client.env} endpoint: ${client.baseUrl}`);

const dataEndTime = new Date().toISOString();
const dataStartTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

console.log(`Requesting GET_SALES_AND_TRAFFIC_REPORT`);
console.log(`  start: ${dataStartTime}`);
console.log(`  end:   ${dataEndTime}`);

const reportId = await requestReport(
  client,
  'GET_SALES_AND_TRAFFIC_REPORT',
  [getMarketplaceId()],
  dataStartTime,
  dataEndTime,
  { asinGranularity: 'CHILD', dateGranularity: 'DAY' },
);
console.log(`Report ID: ${reportId}`);

const reportDocumentId = await pollReport(client, reportId);
console.log(`Report document ID: ${reportDocumentId}`);

const data = await downloadReport(client, reportDocumentId);

const asinRows = data?.salesAndTrafficByAsin ?? [];
const dateRows = data?.salesAndTrafficByDate ?? [];
console.log(`\nASIN rows: ${asinRows.length}`);
console.log(`Date rows: ${dateRows.length}`);

if (asinRows.length > 0) {
  console.log('\nFirst 3 ASIN rows:');
  console.log(JSON.stringify(asinRows.slice(0, 3), null, 2));
}

const outDir = 'data/amazon-explore';
mkdirSync(outDir, { recursive: true });
const today = new Date().toISOString().slice(0, 10);
const outPath = `${outDir}/${today}-sales-traffic-${client.env}.json`;
writeFileSync(
  outPath,
  JSON.stringify({ dataStartTime, dataEndTime, reportId, data }, null, 2),
);
console.log(`\nDump: ${outPath}`);
