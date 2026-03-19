/**
 * GSC Collector Agent
 *
 * Fetches Google Search Console data for a specific date and saves a snapshot to:
 *   data/snapshots/gsc/YYYY-MM-DD.json
 *
 * Default date is 3 days ago (Pacific time) to account for GSC's data lag.
 *
 * Usage:
 *   node agents/gsc-collector/index.js
 *   node agents/gsc-collector/index.js --date 2026-03-15
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getKeywordsForDate, getPagesForDate } from '../../lib/gsc.js';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SNAPSHOTS_DIR = join(ROOT, 'data', 'snapshots', 'gsc');

// Default: 3 days ago in Pacific time (matches GSC data lag)
function defaultDate() {
  return new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
    .toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

const dateArg = process.argv.find(a => a.startsWith('--date='))?.split('=')[1]
  ?? (process.argv.includes('--date') ? process.argv[process.argv.indexOf('--date') + 1] : null);
const date = dateArg || defaultDate();

if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error('Invalid date format. Expected YYYY-MM-DD.');
  process.exit(1);
}

async function main() {
  console.log('GSC Collector\n');
  console.log(`  Date: ${date}`);

  process.stdout.write('  Fetching top queries... ');
  const topQueries = await getKeywordsForDate(date, 10);
  console.log(`done (${topQueries.length} queries)`);

  process.stdout.write('  Fetching top pages... ');
  const topPages = await getPagesForDate(date, 10);
  console.log(`done (${topPages.length} pages)`);

  if (!topQueries.length && !topPages.length) {
    console.log('  No GSC data for this date (may still be within lag window) — skipping snapshot.');
    return false;
  }

  // Compute summary from query-level data (GSC returns weighted aggregates per query)
  const totalClicks      = topQueries.reduce((s, r) => s + r.clicks, 0);
  const totalImpressions = topQueries.reduce((s, r) => s + r.impressions, 0);
  const weightedCtr      = totalImpressions > 0 ? totalClicks / totalImpressions : 0;
  const weightedPosition = totalImpressions > 0
    ? topQueries.reduce((s, r) => s + r.position * r.impressions, 0) / totalImpressions
    : 0;

  const snapshot = {
    date,
    summary: {
      clicks:      totalClicks,
      impressions: totalImpressions,
      ctr:         Math.round(weightedCtr * 10000) / 10000,
      position:    Math.round(weightedPosition * 10) / 10,
    },
    topQueries,
    topPages,
  };

  mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  const outPath = join(SNAPSHOTS_DIR, `${date}.json`);
  writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
  console.log(`  Snapshot saved: ${outPath}`);
  return true;
}

main()
  .then(async (saved) => {
    if (saved) {
      await notify({ subject: 'GSC Collector completed', body: `Snapshot saved for ${date}`, status: 'success' }).catch(() => {});
    }
  })
  .catch(async err => {
    await notify({ subject: 'GSC Collector failed', body: err.message || String(err), status: 'error' }).catch(() => {});
    console.error('Error:', err.message);
    process.exit(1);
  });
