/**
 * Fetch Brand Analytics search terms report (weekly).
 * Requires Brand Registry + Amazon Business Analytics role.
 *
 * Usage:
 *   node scripts/amazon/explore-brand-analytics.mjs
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

// Last complete Sunday-Saturday week.
const now = new Date();
const day = now.getUTCDay(); // 0 = Sunday
const lastSaturday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - day - 1));
const lastSunday = new Date(lastSaturday);
lastSunday.setUTCDate(lastSaturday.getUTCDate() - 6);

const dataStartTime = lastSunday.toISOString();
const dataEndTime = new Date(lastSaturday.getTime() + 24 * 60 * 60 * 1000 - 1).toISOString();

console.log(`Requesting GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT`);
console.log(`  start: ${dataStartTime}`);
console.log(`  end:   ${dataEndTime}`);

const reportId = await requestReport(
  client,
  'GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT',
  [getMarketplaceId()],
  dataStartTime,
  dataEndTime,
  { reportPeriod: 'WEEK' },
);
console.log(`Report ID: ${reportId}`);

const reportDocumentId = await pollReport(client, reportId);
console.log(`Report document ID: ${reportDocumentId}`);

const rows = await downloadReport(client, reportDocumentId);

const rowArray = Array.isArray(rows) ? rows : rows?.dataByDepartmentAndSearchTerm ?? [];
console.log(`\nRows: ${rowArray.length}`);
if (rowArray.length > 0) {
  console.log('First 5 rows:');
  console.log(JSON.stringify(rowArray.slice(0, 5), null, 2));
}

const outDir = 'data/amazon-explore';
mkdirSync(outDir, { recursive: true });
const today = new Date().toISOString().slice(0, 10);
const outPath = `${outDir}/${today}-brand-analytics-${client.env}.json`;
writeFileSync(
  outPath,
  JSON.stringify({ dataStartTime, dataEndTime, reportId, rows }, null, 2),
);
console.log(`\nDump: ${outPath}`);
