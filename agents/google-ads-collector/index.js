/**
 * Google Ads Collector Agent
 *
 * Fetches yesterday's Google Ads performance data and saves a snapshot to:
 *   data/snapshots/google-ads/YYYY-MM-DD.json
 *
 * Defaults to yesterday (not today) due to Google Ads reporting lag.
 *
 * Usage:
 *   node agents/google-ads-collector/index.js
 *   node agents/google-ads-collector/index.js --date 2026-03-18
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { fetchDailySnapshot, yesterdayPT } from '../../lib/google-ads.js';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SNAPSHOTS_DIR = join(ROOT, 'data', 'snapshots', 'google-ads');

const dateArg = process.argv.find(a => a.startsWith('--date='))?.split('=')[1]
  ?? (process.argv.includes('--date') ? process.argv[process.argv.indexOf('--date') + 1] : null);
const date = dateArg || yesterdayPT();

if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error('Invalid date format. Expected YYYY-MM-DD.');
  process.exit(1);
}

async function main() {
  console.log('Google Ads Collector\n');
  console.log(`  Date: ${date}`);

  process.stdout.write('  Fetching snapshot... ');
  const snapshot = await fetchDailySnapshot(date);
  console.log(`done ($${snapshot.spend} spend, ${snapshot.clicks} clicks, ${snapshot.conversions} conversions)`);

  mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  const outPath = join(SNAPSHOTS_DIR, `${date}.json`);
  writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
  console.log(`  Snapshot saved: ${outPath}`);
}

main()
  .then(async () => {
    await notify({ subject: 'Google Ads Collector completed', body: `Snapshot saved for ${date}`, status: 'success' }).catch(() => {});
  })
  .catch(async err => {
    await notify({ subject: 'Google Ads Collector failed', body: err.message || String(err), status: 'error' }).catch(() => {});
    console.error('Error:', err.message);
    process.exit(1);
  });
