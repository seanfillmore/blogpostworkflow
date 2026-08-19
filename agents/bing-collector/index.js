/**
 * Bing Collector Agent
 *
 * Pulls the Bing Webmaster Tools feed and saves a snapshot to:
 *   data/snapshots/bing/YYYY-MM-DD.json
 *
 * Usage:
 *   node agents/bing-collector/index.js
 *   node agents/bing-collector/index.js --date 2026-08-17
 *
 * WEEKLY, not daily. Bing's own data refreshes about once a week — GetQueryStats
 * returns ~26 distinct dates across a 177-day traffic window — so a daily job would
 * write six identical files a week for no new information. It is dispatched from the
 * Sunday block in scheduler.js.
 *
 * Unlike the GSC/GA4 collectors, one file is NOT one day. Bing's API has no date
 * parameter: every call returns the whole retained window, so each snapshot is a full
 * ~6-month history stamped with the day it was collected. That is the point — GA4 now
 * retains 2 months, and this is the only query-level view of the index DuckDuckGo
 * serves from, where new-customer CVR runs 2.88% against Google organic's 0.60%.
 *
 * Volume does not justify more than this: ~28 clicks/month and $0 attributed revenue
 * over 13 months. No dashboard tab, no daily cron, no writes into keyword-index.json.
 *
 * Everything that shapes the snapshot is an exported pure function so it can be tested
 * without running the agent. main() only runs on a direct invocation — importing an
 * agent in this repo otherwise executes it.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  getRankAndTrafficStats,
  getQueryStats,
  getPageStats,
  resolveCredentials,
  PER_DATE_ROW_CAP,
} from '../../lib/bing-webmaster.js';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
export const SNAPSHOTS_DIR = join(ROOT, 'data', 'snapshots', 'bing');

/** Shape version, so a consumer can tell an old file apart from a reshaped one. */
export const SNAPSHOT_VERSION = 1;

/** Today in Pacific — Bing has no data lag to back off from, the window is whole-history. */
export function todayPT(now = Date.now()) {
  return new Date(now).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

const round4 = (n) => Math.round(n * 10000) / 10000;

/** Site-wide totals over the daily traffic rows, with CTR computed (Bing returns none). */
export function summarize(daily) {
  const rows = daily || [];
  const clicks = rows.reduce((s, r) => s + (Number(r.clicks) || 0), 0);
  const impressions = rows.reduce((s, r) => s + (Number(r.impressions) || 0), 0);
  return {
    clicks,
    impressions,
    ctr: impressions > 0 ? round4(clicks / impressions) : 0,
  };
}

/** First/last date and day count of the traffic window actually returned. */
export function dateRange(daily) {
  const dates = (daily || []).map((r) => r.date).filter(Boolean).sort();
  return {
    start: dates[0] ?? null,
    end: dates.at(-1) ?? null,
    days: new Set(dates).size,
  };
}

/**
 * Query and page rows are a weekly SAMPLE while the traffic feed is daily, so their
 * totals sit well below the site totals (measured 2026-08-18: 163 vs 167 clicks,
 * 5,023 vs 13,224 impressions). Recording the coverage in the file means nobody later
 * reads that gap as data loss and goes looking for a bug that is not there.
 *
 * `truncatedDates` is the other half of that: GetQueryStats caps at 100 rows per date
 * and gives no way to page past it, so a date at the cap lost its long tail — and
 * which of the tied 1-impression rows survived is not even stable between two calls
 * a second apart. Naming those dates in the file is what stops a later reader treating
 * one snapshot's query list as the complete set of queries Bing saw that week.
 */
export function coverage(rows, labelKey) {
  const list = rows || [];
  const perDate = new Map();
  for (const r of list) perDate.set(r.date, (perDate.get(r.date) || 0) + 1);
  return {
    rows: list.length,
    dates: perDate.size,
    distinct: new Set(list.map((r) => r[labelKey])).size,
    clicks: list.reduce((s, r) => s + (Number(r.clicks) || 0), 0),
    impressions: list.reduce((s, r) => s + (Number(r.impressions) || 0), 0),
    truncatedDates: [...perDate.entries()]
      .filter(([, n]) => n >= PER_DATE_ROW_CAP)
      .map(([d]) => d)
      .sort(),
  };
}

/**
 * Assemble the snapshot. `date` is the collection date, NOT the data date — see the
 * header. Pure, so tests can assert the shape without touching the network.
 */
export function buildSnapshot({ date, site, daily, queries, pages }) {
  return {
    date,
    version: SNAPSHOT_VERSION,
    source: 'bing-webmaster',
    site,
    range: dateRange(daily),
    summary: summarize(daily),
    coverage: {
      queries: coverage(queries, 'query'),
      pages: coverage(pages, 'page'),
    },
    daily: daily || [],
    queries: queries || [],
    pages: pages || [],
  };
}

function resolveDateArg(argv = process.argv) {
  return argv.find((a) => a.startsWith('--date='))?.split('=')[1]
    ?? (argv.includes('--date') ? argv[argv.indexOf('--date') + 1] : null);
}

async function main() {
  const date = resolveDateArg() || todayPT();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error('Invalid date format. Expected YYYY-MM-DD.');
    process.exit(1);
  }

  const { siteUrl } = resolveCredentials();

  console.log('Bing Collector\n');
  console.log(`  Collected: ${date}`);
  console.log(`  Site: ${siteUrl}`);

  process.stdout.write('  Fetching daily traffic... ');
  const daily = await getRankAndTrafficStats();
  console.log(`done (${daily.length} days)`);

  process.stdout.write('  Fetching query stats... ');
  const queries = await getQueryStats();
  console.log(`done (${queries.length} rows)`);

  process.stdout.write('  Fetching page stats... ');
  const pages = await getPageStats();
  console.log(`done (${pages.length} rows)`);

  const snapshot = buildSnapshot({ date, site: siteUrl, daily, queries, pages });
  const { summary, range, coverage: cov } = snapshot;

  console.log(`  Window: ${range.start} → ${range.end} (${range.days} days)`);
  console.log(`  Totals: ${summary.clicks} clicks / ${summary.impressions} impressions, CTR ${(summary.ctr * 100).toFixed(2)}%`);
  console.log(`  Queries: ${cov.queries.distinct} distinct over ${cov.queries.dates} sampled date(s)`);
  console.log(`  Pages:   ${cov.pages.distinct} distinct over ${cov.pages.dates} sampled date(s)`);
  if (cov.queries.truncatedDates.length) {
    console.log(`  Note: ${cov.queries.truncatedDates.length} date(s) hit Bing's ${PER_DATE_ROW_CAP}-row/date cap — long tail truncated: ${cov.queries.truncatedDates.join(', ')}`);
  }

  mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  const outPath = join(SNAPSHOTS_DIR, `${date}.json`);
  writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
  console.log(`  Snapshot saved: ${outPath}`);
  return { date, summary, range };
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  main()
    .then(async ({ date, summary, range }) => {
      await notify({
        subject: 'Bing Collector completed',
        body: `Snapshot saved for ${date} — ${summary.clicks} clicks / ${summary.impressions} impressions `
          + `over ${range.start} → ${range.end} (${range.days} days).`,
        status: 'success',
      }).catch(() => {});
    })
    .catch(async (err) => {
      await notify({
        subject: 'Bing Collector failed',
        body: err.message || String(err),
        status: 'error',
      }).catch(() => {});
      console.error('Error:', err.message);
      process.exit(1);
    });
}
