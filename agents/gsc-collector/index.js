/**
 * GSC Collector Agent
 *
 * Fetches Google Search Console data for a specific date and saves a snapshot to:
 *   data/snapshots/gsc/YYYY-MM-DD.json
 *
 * Default date is 3 days ago (Pacific time) to account for GSC's data lag.
 * A default run ALSO retries every date in the last 10 days that has no
 * snapshot yet (lib/gsc-backfill.js): when Google's reporting runs late the lag
 * date comes back empty, and before this it was skipped forever. That is how
 * 2026-09-30 and 2026-10-01 went missing.
 *
 * Usage:
 *   node agents/gsc-collector/index.js
 *   node agents/gsc-collector/index.js --date 2026-03-15   (that date only)
 */

import { writeFileSync, mkdirSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getKeywordsForDate, getPagesForDate, getQueriesByPageForDate } from '../../lib/gsc.js';
import { notify } from '../../lib/notify.js';
import { isDirectRun } from '../../lib/is-direct-run.js';
import { datesToCollect } from '../../lib/gsc-backfill.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SNAPSHOTS_DIR = join(ROOT, 'data', 'snapshots', 'gsc');

const dateArg = process.argv.find(a => a.startsWith('--date='))?.split('=')[1]
  ?? (process.argv.includes('--date') ? process.argv[process.argv.indexOf('--date') + 1] : null);

if (dateArg && !/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) {
  console.error('Invalid date format. Expected YYYY-MM-DD.');
  process.exit(1);
}

function existingSnapshotDates() {
  if (!existsSync(SNAPSHOTS_DIR)) return [];
  return readdirSync(SNAPSHOTS_DIR)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map(f => f.slice(0, 10));
}

async function main() {
  console.log('GSC Collector\n');
  const dates = dateArg ? [dateArg] : datesToCollect({ existing: existingSnapshotDates() });
  const saved = [];
  const empty = [];
  for (const date of dates) {
    if (await collectDate(date)) saved.push(date);
    else empty.push(date);
  }
  return { saved, empty };
}

async function collectDate(date) {
  console.log(`  Date: ${date}`);

  process.stdout.write('  Fetching top queries... ');
  const topQueries = await getKeywordsForDate(date, 1000);
  console.log(`done (${topQueries.length} queries)`);

  process.stdout.write('  Fetching top pages... ');
  const topPages = await getPagesForDate(date, 1000);
  console.log(`done (${topPages.length} pages)`);

  process.stdout.write('  Fetching query×page rows... ');
  const queriesByPage = await getQueriesByPageForDate(date, 5000);
  console.log(`done (${queriesByPage.length} rows)`);

  if (!topQueries.length && !topPages.length && !queriesByPage.length) {
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
    queriesByPage,
  };

  mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  const outPath = join(SNAPSHOTS_DIR, `${date}.json`);
  writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
  console.log(`  Snapshot saved: ${outPath}`);
  return true;
}

// Guarded: importing this module must not run the agent (live writes, paid
// API calls, process.exit). See lib/is-direct-run.js.
if (isDirectRun(import.meta.url)) {
  main()
    .then(async ({ saved, empty }) => {
      if (saved.length) {
        const backfilled = saved.length > 1 ? ` (${saved.length - 1} backfilled after a GSC delay)` : '';
        const pending = empty.length ? `\nStill no GSC data, will retry: ${empty.join(', ')}` : '';
        await notify({
          subject: `GSC Collector completed${backfilled}`,
          body: `Snapshots saved for ${saved.join(', ')}${pending}`,
          status: 'success',
        }).catch(() => {});
      }
    })
    .catch(async err => {
      await notify({ subject: 'GSC Collector failed', body: err.message || String(err), status: 'error' }).catch(() => {});
      console.error('Error:', err.message);
      process.exit(1);
    });
}
