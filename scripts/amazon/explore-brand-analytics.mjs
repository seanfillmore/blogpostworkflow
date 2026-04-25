/**
 * Fetch Brand Analytics search terms report (weekly).
 * Requires Brand Registry + Amazon Business Analytics role.
 *
 * Usage:
 *   node scripts/amazon/explore-brand-analytics.mjs
 */

import { createReadStream, mkdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import {
  getClient,
  getMarketplaceId,
  requestReport,
  pollReport,
  streamReportToFile,
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

const outDir = 'data/amazon-explore';
mkdirSync(outDir, { recursive: true });
const today = new Date().toISOString().slice(0, 10);
const outPath = `${outDir}/${today}-brand-analytics-${client.env}.tsv`;

console.log(`Streaming to ${outPath}...`);
const { byteCount, contentType } = await streamReportToFile(client, reportDocumentId, outPath);
const mb = (byteCount / 1024 / 1024).toFixed(1);
console.log(`Wrote ${byteCount} bytes (${mb} MB), content-type: ${contentType}`);

// Read first 50 lines as a sample.
const sample = [];
const stream = createReadStream(outPath, { encoding: 'utf-8' });
const rl = createInterface({ input: stream, crlfDelay: Infinity });
for await (const line of rl) {
  sample.push(line);
  if (sample.length >= 51) break; // headers + 50 data rows
}
rl.close();
stream.close();

if (sample.length === 0) {
  console.log('\nFile is empty.');
} else {
  const headers = sample[0].split('\t');
  console.log(`\nColumns (${headers.length}): ${headers.join(' | ')}`);
  console.log(`\nFirst 5 data rows:`);
  for (const line of sample.slice(1, 6)) {
    const fields = line.split('\t');
    const row = Object.fromEntries(headers.map((h, i) => [h, fields[i]]));
    console.log(JSON.stringify(row, null, 2));
  }
  console.log(`\n(Showing first 5 of ${sample.length - 1} sampled rows; full file at ${outPath})`);
}

console.log(`\nFile size: ${statSync(outPath).size} bytes`);
