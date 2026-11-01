#!/usr/bin/env node
/**
 * Pull the search-term report on its own and merge it into an existing audit. READ ONLY.
 *
 *   node scripts/amazon-ads-pull-search-terms.mjs [--days 60]
 *
 * Separate from amazon-ads-audit.mjs because this is the report that fails: it is the
 * largest of the four and its download died with a bare `fetch failed` on the first run,
 * which is a transport error rather than an API rejection. Re-running the whole audit to
 * retry one report costs ~25 minutes of report generation for the other three.
 *
 * It is also the report the change list is built from — zero-order terms to negate — so
 * an audit missing it is missing its most actionable half, and silently shipping one that
 * reports "0 waste found" would be worse than shipping nothing.
 */

import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { isDirectRun } from '../lib/is-direct-run.js';
import { getClient, listProfiles, runReport, isoDay } from '../lib/amazon/ads-api-client.js';

const COLUMNS = [
  'campaignId', 'campaignName', 'adGroupId', 'adGroupName',
  'keyword', 'keywordType', 'matchType', 'searchTerm',
  'impressions', 'clicks', 'cost', 'purchases30d', 'sales30d',
];

async function main() {
  const argv = process.argv.slice(2);
  const days = Number(argv[argv.indexOf('--days') + 1]) || 60;
  const inPath = argv.includes('--in')
    ? argv[argv.indexOf('--in') + 1]
    : 'data/reports/amazon-ads-audit/latest.json';

  const endDate = isoDay(Date.now() - 864e5);
  const startDate = isoDay(Date.now() - days * 864e5);

  const client = getClient();
  await listProfiles(client);
  console.log(`Search terms ${startDate} → ${endDate} (${days}d)`);

  const rows = await runReport(client, {
    name: 'search-terms', startDate, endDate,
    onProgress: (m) => console.log(`  ${m}`),
    configuration: {
      adProduct: 'SPONSORED_PRODUCTS', timeUnit: 'SUMMARY', format: 'GZIP_JSON',
      groupBy: ['searchTerm'], reportTypeId: 'spSearchTerm', columns: COLUMNS,
    },
  });
  console.log(`  rows: ${rows.length}`);

  // Refuse to record an empty pull over a populated one — a retry that silently wrote
  // zero rows would turn a visible failure into an audit that reports no waste.
  if (!rows.length) {
    throw new Error('Search-term report returned 0 rows; refusing to overwrite the audit.');
  }

  const d = JSON.parse(readFileSync(inPath, 'utf8'));
  d.searchTerms = rows;
  d.window.searchTermStartDate = startDate;
  writeFileSync(inPath, JSON.stringify(d, null, 2));
  console.log(`✓ Merged ${rows.length} search-term rows into ${inPath}`);
}

if (isDirectRun(import.meta.url)) {
  main().catch((e) => { console.error(`✗ ${e.message}`); process.exit(1); });
}
