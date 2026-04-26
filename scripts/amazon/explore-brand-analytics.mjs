/**
 * Fetch Brand Analytics search terms report (weekly).
 * Requires Brand Registry + Amazon Business Analytics role.
 *
 * The full US weekly search-terms report is several GB of JSON
 * (every department × every search term). It's too large to load
 * into memory or parse inline. This script streams the file to disk
 * and prints jq commands the user can run to inspect samples.
 *
 * Usage:
 *   node scripts/amazon/explore-brand-analytics.mjs
 */

import { mkdirSync, statSync } from 'node:fs';
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
const outPath = `${outDir}/${today}-brand-analytics-${client.env}.json`;

console.log(`\nStreaming to ${outPath}...`);
const { byteCount } = await streamReportToFile(client, reportDocumentId, outPath);
const mb = (byteCount / 1024 / 1024).toFixed(1);
const gb = (byteCount / 1024 / 1024 / 1024).toFixed(2);
console.log(`Wrote ${byteCount.toLocaleString()} bytes (${mb} MB / ${gb} GB)`);
console.log(`File size on disk: ${statSync(outPath).size.toLocaleString()} bytes`);

console.log(`\n--- Inspecting the data ---`);
console.log(`The file is JSON with shape: { "dataByDepartmentAndSearchTerm": [ {...}, {...}, ... ] }`);
console.log(`Each row has fields like: searchTerm, searchFrequencyRank, clickedAsin, clickShareRank, etc.`);
console.log(`\nSample commands (run from the project root):`);
console.log(`  # Peek at the structure (first 500 chars)`);
console.log(`  head -c 500 ${outPath}`);
console.log(`  # Count total rows`);
console.log(`  jq '.dataByDepartmentAndSearchTerm | length' ${outPath}`);
console.log(`  # First 5 rows`);
console.log(`  jq '.dataByDepartmentAndSearchTerm[:5]' ${outPath}`);
console.log(`  # Top 20 highest-frequency search terms (by rank)`);
console.log(`  jq '.dataByDepartmentAndSearchTerm | sort_by(.searchFrequencyRank // 999999) | .[:20] | .[] | {searchTerm, searchFrequencyRank}' ${outPath}`);
console.log(`  # Filter to your brand's clicked ASINs only (replace with your ASINs)`);
console.log(`  jq '.dataByDepartmentAndSearchTerm | map(select(.clickedAsin == "B0B686R9FZ"))' ${outPath}`);
