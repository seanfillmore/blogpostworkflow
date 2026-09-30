#!/usr/bin/env node
/**
 * Pull the three Sponsored Products reports `culina-ppc-audit.mjs` needs, straight from
 * the Ads API. READ ONLY — GETs plus POSTs to /reporting/reports, which creates a report
 * and cannot mutate a campaign.
 *
 *   node scripts/amazon/pull-ads-reports.mjs [--days 30]
 *   node scripts/amazon/culina-ppc-audit.mjs
 *
 * WHY A CSV BRIDGE RATHER THAN A REWRITE. That audit's header says its inputs are
 * "five Amazon Ads console exports … export them by hand until Ads API access is
 * approved". Access is now approved, so this replaces the hand export and nothing else:
 * it writes the same filenames, with the same column headers the console emits, into the
 * same directory. Every tested behaviour in that script — break-even ACoS, the
 * negate/bid-down split, self-competition, the auto-target-group exclusion — keeps
 * running against the same shapes. Rewriting the audit to consume API JSON would have
 * re-litigated four measurement decisions that already have tests.
 *
 * ATTRIBUTION IS 7-DAY, DELIBERATELY. Sponsored Products console reports are 7-day, the
 * audit reads `7 Day Total Sales` and `7 Day Total Orders (#)`, and its header warns that
 * spend is comparable across ad types while sales are not. Requesting the 30-day columns
 * would silently inflate every sales figure against a spend figure that did not move,
 * making every ACoS look better than it is. The column NAMES are what the audit keys on,
 * so a mismatch here would not error — it would just be wrong.
 *
 * THE WINDOW MUST MATCH THE FINANCE PULL. `culina-ppc-audit.mjs` joins this ad spend to a
 * 30-day SP-API finance window, so the default is 30 days. Widening it here alone makes
 * the P&L compare 90 days of ad cost against 30 days of revenue.
 */

import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectRun } from '../../lib/is-direct-run.js';
import { getClient, listProfiles, runReport, isoDay } from '../../lib/amazon/ads-api-client.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'data', 'amazon-explore', 'ads-reports');

/** RFC4180: quote when the value carries a comma, quote or newline; double inner quotes. */
export function toCsv(rows, headers) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(','), ...rows.map((r) => headers.map((h) => esc(r[h])).join(','))].join('\n') + '\n';
}

const BASE = { adProduct: 'SPONSORED_PRODUCTS', timeUnit: 'SUMMARY', format: 'GZIP_JSON' };

async function main() {
  const argv = process.argv.slice(2);
  const days = Number(argv[argv.indexOf('--days') + 1]) || 30;
  const endDate = isoDay(Date.now() - 864e5);
  const startDate = isoDay(Date.now() - days * 864e5);

  const client = getClient();
  await listProfiles(client);
  console.log(`Ads reports ${startDate} → ${endDate} (${days}d, 7-day attribution)\n`);
  const log = (m) => console.log(`  ${m}`);

  mkdirSync(OUT, { recursive: true });

  // 1. Advertised product — carries SKU→ASIN, which is the brand key (RSC- prefix).
  const ap = await runReport(client, {
    name: 'ap', startDate, endDate, onProgress: log,
    configuration: {
      ...BASE, groupBy: ['advertiser'], reportTypeId: 'spAdvertisedProduct',
      columns: ['campaignName', 'advertisedSku', 'advertisedAsin', 'cost', 'sales7d', 'purchases7d', 'clicks', 'impressions'],
    },
  });
  writeFileSync(
    join(OUT, 'Sponsored_Products_Advertised_product_report.csv'),
    toCsv(
      ap.map((r) => ({
        'Campaign Name': r.campaignName, 'Advertised SKU': r.advertisedSku, 'Advertised ASIN': r.advertisedAsin,
        Impressions: r.impressions, Clicks: r.clicks, Spend: r.cost,
        '7 Day Total Sales': r.sales7d, '7 Day Total Orders (#)': r.purchases7d,
        'Start Date': startDate, 'End Date': endDate,
      })),
      ['Campaign Name', 'Advertised SKU', 'Advertised ASIN', 'Impressions', 'Clicks', 'Spend',
       '7 Day Total Sales', '7 Day Total Orders (#)', 'Start Date', 'End Date']
    )
  );
  console.log(`  advertised product: ${ap.length} rows`);

  // 2. Search term — §2 wasted spend.
  const st = await runReport(client, {
    name: 'st', startDate, endDate, onProgress: log,
    configuration: {
      ...BASE, groupBy: ['searchTerm'], reportTypeId: 'spSearchTerm',
      columns: ['campaignName', 'adGroupName', 'keyword', 'matchType', 'searchTerm', 'cost', 'clicks', 'impressions', 'sales7d', 'purchases7d'],
    },
  });
  writeFileSync(
    join(OUT, 'Sponsored_Products_Search_term_report.csv'),
    toCsv(
      st.map((r) => ({
        'Campaign Name': r.campaignName, 'Ad Group Name': r.adGroupName,
        Targeting: r.keyword, 'Match Type': r.matchType, 'Customer Search Term': r.searchTerm,
        Impressions: r.impressions, Clicks: r.clicks, Spend: r.cost,
        '7 Day Total Sales': r.sales7d, '7 Day Total Orders (#)': r.purchases7d,
        'Start Date': startDate, 'End Date': endDate,
      })),
      ['Campaign Name', 'Ad Group Name', 'Targeting', 'Match Type', 'Customer Search Term',
       'Impressions', 'Clicks', 'Spend', '7 Day Total Sales', '7 Day Total Orders (#)', 'Start Date', 'End Date']
    )
  );
  console.log(`  search term: ${st.length} rows`);

  // 3. Targeting — §3 self-competition.
  const tg = await runReport(client, {
    name: 'tg', startDate, endDate, onProgress: log,
    configuration: {
      ...BASE, groupBy: ['targeting'], reportTypeId: 'spTargeting',
      columns: ['campaignName', 'adGroupName', 'keyword', 'matchType', 'cost', 'clicks', 'impressions', 'sales7d', 'purchases7d'],
    },
  });
  writeFileSync(
    join(OUT, 'Sponsored_Products_Targeting_report.csv'),
    toCsv(
      tg.map((r) => ({
        'Campaign Name': r.campaignName, 'Ad Group Name': r.adGroupName,
        Targeting: r.keyword, 'Match Type': r.matchType,
        Impressions: r.impressions, Clicks: r.clicks, Spend: r.cost,
        '7 Day Total Sales': r.sales7d, '7 Day Total Orders (#)': r.purchases7d,
        'Start Date': startDate, 'End Date': endDate,
      })),
      ['Campaign Name', 'Ad Group Name', 'Targeting', 'Match Type',
       'Impressions', 'Clicks', 'Spend', '7 Day Total Sales', '7 Day Total Orders (#)', 'Start Date', 'End Date']
    )
  );
  console.log(`  targeting: ${tg.length} rows`);

  console.log(`\n✓ ${OUT}`);
  console.log('  Now run: node scripts/amazon/culina-ppc-audit.mjs');
}

if (isDirectRun(import.meta.url)) {
  main().catch((e) => { console.error(`\n✗ ${e.message}\n`); process.exit(1); });
}
