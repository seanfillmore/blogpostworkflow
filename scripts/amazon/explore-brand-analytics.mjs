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

import { mkdirSync, statSync, unlinkSync, renameSync } from 'node:fs';
import { listDumps, planPrune, requiredFreeBytes, freeBytes, readTail, isCompleteTail, PARTIAL_SUFFIX } from '../../lib/amazon/ba-retention.js';
import { notify } from '../../lib/notify.js';
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

const outDir = 'data/amazon-explore';
mkdirSync(outDir, { recursive: true });
const GB = (b) => (b / 1024 ** 3).toFixed(2);

// Disk policy (lib/amazon/ba-retention.js): before downloading, keep only the newest
// COMPLETE dump (a truncated or leftover .partial one is deleted), then make sure the
// new ~3.4 GB file fits with room to spare. 2026-11-08: pruning only after the write
// filled the 24 GB disk mid-download and took the day's pipeline down with it.
{
  const before = listDumps(outDir, client.env);
  const { keep, remove } = planPrune(before);
  for (const f of remove) { unlinkSync(`${outDir}/${f}`); console.log(`Pruned before download: ${f}`); }
  const free = freeBytes(outDir);
  const need = requiredFreeBytes(before);
  console.log(`Kept ${keep.join(', ') || '(no complete dump)'}; ${GB(free)} GB free, need ${GB(need)} GB.`);
  if (free < need) {
    const msg = `Brand Analytics download skipped: ${GB(free)} GB free on the server, the dump needs ${GB(need)} GB. Writing it would fill the disk and stop cron. Free space (df -h /, du -xh --max-depth=1 /root/seo-claude/data) and re-run scripts/amazon/explore-brand-analytics.mjs.`;
    console.error(msg);
    await notify({ subject: 'Brand Analytics dump skipped: not enough disk space', body: msg, status: 'error', category: 'amazon', immediate: true });
    process.exit(1);
  }
}

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

const today = new Date().toISOString().slice(0, 10);
const outPath = `${outDir}/${today}-brand-analytics-${client.env}.json`;

// Stream to .partial and rename only when complete: the keyword index reads the newest
// *.json by mtime, so a half-written dump under the final name would be read mid-write.
const partialPath = outPath + PARTIAL_SUFFIX;
console.log(`\nStreaming to ${partialPath}...`);
let byteCount;
try {
  ({ byteCount } = await streamReportToFile(client, reportDocumentId, partialPath));
} catch (err) {
  try { unlinkSync(partialPath); } catch { /* nothing written */ }
  await notify({ subject: 'Brand Analytics dump failed mid-download', body: `${err.message}\nThe partial file was deleted; the previous complete dump is still in place.`, status: 'error', category: 'amazon', immediate: err.code === 'ENOSPC' });
  throw err;
}
if (!isCompleteTail(readTail(partialPath))) {
  unlinkSync(partialPath);
  const msg = `Brand Analytics dump was incomplete (${byteCount.toLocaleString()} bytes, does not end with "]}"); deleted. The previous complete dump is still in place.`;
  console.error(msg);
  await notify({ subject: 'Brand Analytics dump incomplete, discarded', body: msg, status: 'error', category: 'amazon' });
  process.exit(1);
}
renameSync(partialPath, outPath);
const mb = (byteCount / 1024 / 1024).toFixed(1);
const gb = (byteCount / 1024 / 1024 / 1024).toFixed(2);
console.log(`Wrote ${byteCount.toLocaleString()} bytes (${mb} MB / ${gb} GB)`);
console.log(`File size on disk: ${statSync(outPath).size.toLocaleString()} bytes`);

// After a complete write, keep just this dump (the only one ever read).
for (const f of planPrune(listDumps(outDir, client.env)).remove) {
  unlinkSync(`${outDir}/${f}`);
  console.log(`Pruned old BA dump: ${f}`);
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
