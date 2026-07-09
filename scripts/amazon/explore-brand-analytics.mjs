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

import { mkdirSync, statSync, readdirSync, unlinkSync } from 'node:fs';
import {
  getClient,
  getMarketplaceId,
  requestReport,
  pollReport,
  streamReportToFile,
} from '../../lib/amazon/sp-api-client.js';
import { settledWeekWindow } from '../../lib/amazon/report-window.js';

const client = getClient();
console.log(`Hitting ${client.env} endpoint: ${client.baseUrl}`);

// Most recent Sun–Sat week that ended at least ~7 days ago. Brand Analytics
// weekly data isn't finalized the instant a week ends, so requesting the
// just-ended week FATAL'd / sat IN_QUEUE on every Sunday run (same bug the SQP
// explore had — see lib/amazon/report-window.js).
const SETTLE_LAG_DAYS = Number(process.env.BA_SETTLE_LAG_DAYS || 7);
const { dataStartTime: startDate, dataEndTime: endDate } = settledWeekWindow(new Date(), SETTLE_LAG_DAYS);
const dataStartTime = `${startDate}T00:00:00.000Z`;
const dataEndTime = `${endDate}T23:59:59.999Z`;

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

// Retention: each weekly BA dump is ~3.3 GB and only the newest is consumed
// (lib/keyword-index/dump-readers.js takes the latest by mtime). Without pruning
// these accumulate and eventually fill the disk — on 2026-07-05 an unpruned dump
// filled the 24 GB server to 100%, silently halting every cron job for days.
// Keep the newest BA_RETAIN dumps (default 2) for this env, delete the rest.
// Guard: only prune when THIS write looks complete (>1 GB) so a truncated/empty
// write can never delete the last good dump.
const RETAIN = Math.max(1, Number(process.env.BA_RETAIN || 2));
const MIN_COMPLETE_BYTES = 1024 * 1024 * 1024; // 1 GB
if (byteCount >= MIN_COMPLETE_BYTES) {
  const suffix = `-brand-analytics-${client.env}.json`;
  const dumps = readdirSync(outDir)
    .filter((f) => f.endsWith(suffix))
    .map((f) => ({ f, mtime: statSync(`${outDir}/${f}`).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  const stale = dumps.slice(RETAIN);
  for (const { f } of stale) {
    unlinkSync(`${outDir}/${f}`);
    console.log(`Pruned old BA dump: ${f}`);
  }
  console.log(`Retained ${Math.min(RETAIN, dumps.length)} of ${dumps.length} BA dump(s).`);
} else {
  console.log(`Skipping retention prune: write only ${mb} MB (<1 GB), keeping all dumps.`);
}

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
