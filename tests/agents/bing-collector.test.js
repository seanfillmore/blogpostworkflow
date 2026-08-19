// tests/agents/bing-collector.test.js
//
// The snapshot builder is pure, so none of this touches the network or the filesystem.
// Importing the agent is itself part of the test: in this repo importing agents/*/index.js
// normally RUNS the agent, and this file would hit the live Bing API and write a
// snapshot if the main guard were ever removed.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  buildSnapshot,
  summarize,
  dateRange,
  coverage,
  todayPT,
  SNAPSHOTS_DIR,
  SNAPSHOT_VERSION,
} from '../../agents/bing-collector/index.js';
import { PER_DATE_ROW_CAP } from '../../lib/bing-webmaster.js';

const daily = [
  { date: '2026-02-17', clicks: 0, impressions: 61, ctr: 0 },
  { date: '2026-02-18', clicks: 2, impressions: 62, ctr: 0.0323 },
  { date: '2026-02-19', clicks: 1, impressions: 77, ctr: 0.013 },
];

const queries = [
  { query: 'real skincare', date: '2026-02-20', clicks: 1, impressions: 2, ctr: 0.5, impressionPosition: 3, clickPosition: null },
  { query: 'real skincare', date: '2026-02-27', clicks: 2, impressions: 9, ctr: 0.2222, impressionPosition: 2, clickPosition: null },
  { query: 'cinnamon toothpaste', date: '2026-02-27', clicks: 0, impressions: 36, ctr: 0, impressionPosition: 4, clickPosition: null },
];

const pages = [
  { page: 'https://www.realskincare.com/', date: '2026-02-20', clicks: 1, impressions: 1, ctr: 1, impressionPosition: 1, clickPosition: null },
  { page: 'https://www.realskincare.com/', date: '2026-02-27', clicks: 0, impressions: 14, ctr: 0, impressionPosition: 2, clickPosition: null },
];

test('summarize computes the CTR Bing does not return, from the daily totals', () => {
  assert.deepEqual(summarize(daily), { clicks: 3, impressions: 200, ctr: 0.015 });
  // No rows must not become NaN — an empty window is a legitimate response shape.
  assert.deepEqual(summarize([]), { clicks: 0, impressions: 0, ctr: 0 });
  assert.deepEqual(summarize(undefined), { clicks: 0, impressions: 0, ctr: 0 });
});

test('dateRange reports the window the API actually returned', () => {
  assert.deepEqual(dateRange(daily), { start: '2026-02-17', end: '2026-02-19', days: 3 });
  assert.deepEqual(dateRange([]), { start: null, end: null, days: 0 });
});

test('coverage records the query/page sampling so the totals gap reads as expected', () => {
  // Bing samples query and page stats weekly while the traffic feed is daily, so query
  // clicks always land below site clicks. Without this block on the file, a later
  // reader sees 163 vs 167 and goes hunting for a collector bug that is not there.
  assert.deepEqual(coverage(queries, 'query'), {
    rows: 3, dates: 2, distinct: 2, clicks: 3, impressions: 47, truncatedDates: [],
  });
  assert.deepEqual(coverage(pages, 'page'), {
    rows: 2, dates: 2, distinct: 1, clicks: 1, impressions: 15, truncatedDates: [],
  });
});

test('coverage names the dates Bing truncated at its 100-row cap', () => {
  // GetQueryStats caps at 100 rows per date with no way to page past it, and the rows
  // at the boundary are not even stable between calls — two calls a second apart
  // returned identical totals but 1,719 vs 1,722 distinct queries. A date at the cap
  // is a truncated top-100, and the file has to say so or someone reads it as the
  // complete set of queries Bing saw that week.
  assert.equal(PER_DATE_ROW_CAP, 100);
  const atCap = [
    ...Array.from({ length: PER_DATE_ROW_CAP }, (_, i) => ({ query: `q${i}`, date: '2026-04-24', clicks: 0, impressions: 1 })),
    ...Array.from({ length: 99 }, (_, i) => ({ query: `r${i}`, date: '2026-05-01', clicks: 0, impressions: 1 })),
  ];
  const cov = coverage(atCap, 'query');
  assert.deepEqual(cov.truncatedDates, ['2026-04-24']);
  assert.equal(cov.rows, 199);
  assert.equal(cov.dates, 2);
});

test('buildSnapshot assembles the whole file, stamped with the collection date', () => {
  const snap = buildSnapshot({
    date: '2026-08-17',
    site: 'https://realskincare.com/',
    daily,
    queries,
    pages,
  });

  assert.equal(snap.date, '2026-08-17');
  assert.equal(snap.version, SNAPSHOT_VERSION);
  assert.equal(snap.source, 'bing-webmaster');
  // The verified property is the apex domain, not the www host GSC_SITE_URL uses.
  assert.equal(snap.site, 'https://realskincare.com/');

  // `date` is when it was COLLECTED; the data spans the whole retained window, because
  // Bing's API has no date parameter and always returns everything it holds.
  assert.deepEqual(snap.range, { start: '2026-02-17', end: '2026-02-19', days: 3 });
  assert.notEqual(snap.date, snap.range.end);

  assert.deepEqual(snap.summary, { clicks: 3, impressions: 200, ctr: 0.015 });
  assert.equal(snap.coverage.queries.distinct, 2);
  assert.equal(snap.coverage.pages.distinct, 1);
  assert.deepEqual(snap.daily, daily);
  assert.deepEqual(snap.queries, queries);
  assert.deepEqual(snap.pages, pages);
});

test('buildSnapshot is deterministic — a second run for the same date writes the same bytes', () => {
  const args = { date: '2026-08-17', site: 'https://realskincare.com/', daily, queries, pages };
  assert.equal(
    JSON.stringify(buildSnapshot(args), null, 2),
    JSON.stringify(buildSnapshot(args), null, 2),
  );
});

test('buildSnapshot survives an empty feed without inventing numbers', () => {
  const snap = buildSnapshot({ date: '2026-08-17', site: 'x', daily: [], queries: [], pages: [] });
  assert.deepEqual(snap.summary, { clicks: 0, impressions: 0, ctr: 0 });
  assert.deepEqual(snap.range, { start: null, end: null, days: 0 });
  assert.deepEqual(snap.daily, []);
});

test('todayPT resolves the Pacific calendar day, not the UTC one', () => {
  // 2026-08-18T04:00:00Z is still the 17th at -0700. A UTC read would file the
  // snapshot a day ahead of every other feed in data/snapshots/.
  assert.equal(todayPT(Date.parse('2026-08-18T04:00:00Z')), '2026-08-17');
  assert.match(todayPT(), /^\d{4}-\d{2}-\d{2}$/);
});

test('the snapshot lands in its own feed directory, not an existing one', () => {
  // This feed must never write into gsc/, ga4/ or keyword-index.json.
  assert.match(SNAPSHOTS_DIR, /data\/snapshots\/bing$/);
});

test('the agent keeps its main guard and stays weekly', () => {
  const src = readFileSync('agents/bing-collector/index.js', 'utf8');
  assert.ok(src.includes('isDirectRun'), 'main guard missing — importing this agent would run it');
  assert.ok(src.includes("from '../../lib/bing-webmaster.js'"), 'must use the shared client');
  assert.ok(src.includes('notify('), 'must notify on completion and failure');

  const sched = readFileSync('scheduler.js', 'utf8');
  assert.ok(sched.includes('agents/bing-collector/index.js'), 'not wired into the scheduler');
  // It belongs in the Sunday block: Bing refreshes weekly, so a daily dispatch writes
  // six duplicate files a week.
  const at = sched.indexOf('agents/bing-collector/index.js');
  const sundayBlock = sched.indexOf('// ── Weekly jobs (Sundays only) ─');
  assert.ok(sundayBlock !== -1 && at > sundayBlock, 'bing-collector must sit inside the Sunday weekly block');
});
