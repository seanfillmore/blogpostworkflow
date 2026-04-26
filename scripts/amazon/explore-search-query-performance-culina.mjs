/**
 * Pull Amazon Brand Analytics Search Query Performance for the Culina ASINs.
 *
 * NOTE: Culina is awaiting Brand Registry approval. Until that lands, this
 * script will return 0 rows because SQP requires Brand Registry. Re-run after
 * approval to populate per-ASIN impression / click / cart-add / purchase data.
 *
 * Report type: GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT
 * Required: Brand Analytics role + Brand Registry. reportPeriod=WEEK and an
 * explicit asin list (max 200 chars, ~18 ASINs per request).
 *
 * Usage:
 *   node scripts/amazon/explore-search-query-performance-culina.mjs
 */

import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import {
  getClient,
  getMarketplaceId,
  requestReport,
  pollReport,
  downloadReport,
} from '../../lib/amazon/sp-api-client.js';

const DUMP_DIR = 'data/amazon-explore';
const today = new Date().toISOString().slice(0, 10);

function findLatest(prefix) {
  const candidates = readdirSync(DUMP_DIR)
    .filter((f) => f.includes(prefix))
    .sort();
  if (candidates.length === 0) {
    throw new Error(`No file matching "${prefix}" in ${DUMP_DIR}`);
  }
  return `${DUMP_DIR}/${candidates[candidates.length - 1]}`;
}

const listingsPath = findLatest('listings-production');
console.log(`Listings: ${listingsPath}`);
const listings = JSON.parse(readFileSync(listingsPath, 'utf-8'));

const culinaAsins = new Set();
const titlesByAsin = {};
for (const item of listings.items) {
  for (const s of item.summaries || []) {
    if (!s.asin) continue;
    titlesByAsin[s.asin] = s.itemName;
    const title = (s.itemName || '').toLowerCase();
    if (title.includes('culina') || title.includes('cast iron')) {
      culinaAsins.add(s.asin);
    }
  }
}
const asinList = [...culinaAsins];
console.log(`Culina ASINs: ${asinList.length}`);

if (asinList.length === 0) {
  throw new Error('No Culina ASINs found in listings dump.');
}

const joined = asinList.join(' ');
if (joined.length > 200) {
  throw new Error(
    `Culina ASIN list exceeds 200-char SP-API limit (${joined.length}). Split into batches before requesting.`,
  );
}

// Last complete Sunday-Saturday week
const now = new Date();
const day = now.getUTCDay();
const lastSaturday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - day - 1));
const lastSunday = new Date(lastSaturday);
lastSunday.setUTCDate(lastSaturday.getUTCDate() - 6);
const dataStartTime = lastSunday.toISOString().slice(0, 10);
const dataEndTime = lastSaturday.toISOString().slice(0, 10);
console.log(`Window: ${dataStartTime} to ${dataEndTime} (WEEK granularity)\n`);

const client = getClient();
console.log(`Hitting ${client.env} endpoint: ${client.baseUrl}\n`);

const reportId = await requestReport(
  client,
  'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT',
  [getMarketplaceId()],
  dataStartTime,
  dataEndTime,
  { reportPeriod: 'WEEK', asin: joined },
);
console.log(`Report ID: ${reportId}`);

const reportDocumentId = await pollReport(client, reportId);
console.log(`Document ID: ${reportDocumentId}`);

const data = await downloadReport(client, reportDocumentId);
const rows = Array.isArray(data) ? data : data?.dataByAsin ?? [];
console.log(`Rows returned: ${rows.length}\n`);

mkdirSync(DUMP_DIR, { recursive: true });
const outPath = `${DUMP_DIR}/${today}-search-query-performance-culina-${client.env}.json`;
writeFileSync(
  outPath,
  JSON.stringify({ dataStartTime, dataEndTime, asins: asinList, rows }, null, 2),
);
console.log(`Dump: ${outPath}`);

if (rows.length === 0) {
  console.log(
    '\nReport returned 0 rows. Most likely cause: Brand Registry not yet approved for Culina.',
  );
  console.log(
    'Search Query Performance requires Brand Registry. Re-run after approval lands.',
  );
  process.exit(0);
}

// Per-ASIN summary
const perAsin = new Map();
for (const r of rows) {
  const asin = r.asin;
  if (!perAsin.has(asin)) {
    perAsin.set(asin, {
      asin,
      title: titlesByAsin[asin] || '(unknown)',
      queries: 0,
      imp: 0,
      clicks: 0,
      cartAdds: 0,
      purch: 0,
      bestQuery: null,
      bestImp: 0,
    });
  }
  const a = perAsin.get(asin);
  a.queries++;
  a.imp += r.impressionData?.asinImpressionCount ?? 0;
  a.clicks += r.clickData?.asinClickCount ?? 0;
  a.cartAdds += r.cartAddData?.asinCartAddCount ?? 0;
  a.purch += r.purchaseData?.asinPurchaseCount ?? 0;
  const imp = r.impressionData?.asinImpressionCount ?? 0;
  if (imp > a.bestImp) {
    a.bestImp = imp;
    a.bestQuery = r.searchQueryData?.searchQuery || r.searchQuery;
  }
}

const sorted = [...perAsin.values()].sort((a, b) => b.imp - a.imp);
console.log('Per-ASIN (by impressions):');
console.log('ASIN          Queries  Imp     Clicks  CartAdd  Purch  Best query');
for (const a of sorted) {
  const line =
    a.asin +
    '  ' +
    String(a.queries).padStart(7) +
    '  ' +
    String(a.imp).padStart(6) +
    '  ' +
    String(a.clicks).padStart(6) +
    '  ' +
    String(a.cartAdds).padStart(7) +
    '  ' +
    String(a.purch).padStart(5) +
    '  ' +
    (a.bestQuery || '').slice(0, 40);
  console.log(line);
}

// Top queries by total Culina impressions
const queryAgg = new Map();
for (const r of rows) {
  const q = r.searchQueryData?.searchQuery || r.searchQuery;
  if (!q) continue;
  if (!queryAgg.has(q)) {
    queryAgg.set(q, {
      query: q,
      asins: new Set(),
      imp: 0,
      clicks: 0,
      cartAdds: 0,
      purch: 0,
      vol: r.searchQueryData?.searchQueryVolume,
    });
  }
  const a = queryAgg.get(q);
  a.asins.add(r.asin);
  a.imp += r.impressionData?.asinImpressionCount ?? 0;
  a.clicks += r.clickData?.asinClickCount ?? 0;
  a.cartAdds += r.cartAddData?.asinCartAddCount ?? 0;
  a.purch += r.purchaseData?.asinPurchaseCount ?? 0;
}

const queries = [...queryAgg.values()].sort((a, b) => b.imp - a.imp);
console.log('\nTop 30 queries by Culina impressions:');
for (const q of queries.slice(0, 30)) {
  const ctr = q.imp > 0 ? ((q.clicks / q.imp) * 100).toFixed(1) : '0';
  const cvr = q.clicks > 0 ? ((q.purch / q.clicks) * 100).toFixed(1) : '0';
  console.log(
    `  "${q.query.slice(0, 40)}" vol=${q.vol ?? '?'} imp=${q.imp} clicks=${q.clicks} purch=${q.purch} CTR=${ctr}% click->purch=${cvr}%`,
  );
}

const totals = sorted.reduce(
  (acc, a) => ({ imp: acc.imp + a.imp, clicks: acc.clicks + a.clicks, purch: acc.purch + a.purch }),
  { imp: 0, clicks: 0, purch: 0 },
);
console.log('\nHEADLINE:');
console.log(`  Total queries: ${queries.length}`);
console.log(`  Active ASINs (any imp): ${sorted.filter((a) => a.imp > 0).length} of ${asinList.length}`);
console.log(`  Total impressions: ${totals.imp.toLocaleString()}`);
console.log(`  Total clicks: ${totals.clicks.toLocaleString()}`);
console.log(`  Total purchases: ${totals.purch.toLocaleString()}`);
if (totals.imp > 0) {
  console.log(`  CTR: ${((totals.clicks / totals.imp) * 100).toFixed(2)}%`);
}
if (totals.clicks > 0) {
  console.log(`  Click->purchase: ${((totals.purch / totals.clicks) * 100).toFixed(2)}%`);
}
