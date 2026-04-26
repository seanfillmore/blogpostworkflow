/**
 * Pull Amazon Brand Analytics Search Query Performance for ALL non-Culina ASINs
 * (i.e. RSC + sub-brands). Tells us where YOUR ASINs are impressed/clicked/
 * purchased on Amazon search — including positions BELOW top-3 (which the
 * search-terms report doesn't show).
 *
 * Report type: GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT
 * Required: Brand Analytics role + Brand Registry. reportPeriod=WEEK and an
 * explicit asin list (max 200 chars, ~18 ASINs per request).
 *
 * Usage:
 *   node scripts/amazon/explore-search-query-performance-rsc.mjs
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

// Classify ASINs: anything NOT Culina is RSC (or RSC sub-brand)
const rscAsins = new Set();
const culinaAsins = new Set();
const titlesByAsin = {};
for (const item of listings.items) {
  for (const s of item.summaries || []) {
    if (!s.asin) continue;
    titlesByAsin[s.asin] = s.itemName;
    const title = (s.itemName || '').toLowerCase();
    if (title.includes('culina') || title.includes('cast iron')) {
      culinaAsins.add(s.asin);
    } else {
      rscAsins.add(s.asin);
    }
  }
}
const rscList = [...rscAsins];
console.log(`RSC ASINs: ${rscList.length} (Culina: ${culinaAsins.size} excluded)`);

// Last complete Sunday-Saturday week (matching the BA search terms run)
const now = new Date();
const day = now.getUTCDay();
const lastSaturday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - day - 1));
const lastSunday = new Date(lastSaturday);
lastSunday.setUTCDate(lastSaturday.getUTCDate() - 6);
const dataStartTime = lastSunday.toISOString().slice(0, 10);
const dataEndTime = lastSaturday.toISOString().slice(0, 10);
console.log(`Window: ${dataStartTime} to ${dataEndTime} (WEEK granularity)`);

// Chunk ASINs into space-separated batches respecting 200-char limit
function chunkAsins(asins, maxLen = 200) {
  const chunks = [];
  let current = [];
  let currentLen = 0;
  for (const asin of asins) {
    const addLen = currentLen === 0 ? asin.length : 1 + asin.length;
    if (currentLen + addLen > maxLen && current.length > 0) {
      chunks.push(current);
      current = [asin];
      currentLen = asin.length;
    } else {
      current.push(asin);
      currentLen += addLen;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

const batches = chunkAsins(rscList);
console.log(`Splitting into ${batches.length} batches of <=18 ASINs each\n`);

const client = getClient();
console.log(`Hitting ${client.env} endpoint: ${client.baseUrl}\n`);

const allRows = [];
const batchResults = [];

for (let bi = 0; bi < batches.length; bi++) {
  const batch = batches[bi];
  console.log(`=== Batch ${bi + 1}/${batches.length} (${batch.length} ASINs) ===`);
  console.log(`  ASINs: ${batch.join(' ')}`);

  try {
    const reportId = await requestReport(
      client,
      'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT',
      [getMarketplaceId()],
      dataStartTime,
      dataEndTime,
      { reportPeriod: 'WEEK', asin: batch.join(' ') },
    );
    console.log(`  Report ID: ${reportId}`);

    const reportDocumentId = await pollReport(client, reportId);
    console.log(`  Document ID: ${reportDocumentId}`);

    const data = await downloadReport(client, reportDocumentId);
    const rows = Array.isArray(data) ? data : data?.dataByAsin ?? [];
    console.log(`  Rows: ${rows.length}\n`);

    allRows.push(...rows);
    batchResults.push({ batch: bi + 1, asins: batch, reportId, rowCount: rows.length });
  } catch (err) {
    console.error(`  ERROR on batch ${bi + 1}: ${err.message}\n`);
    batchResults.push({ batch: bi + 1, asins: batch, error: err.message });
  }
}

console.log(`\n=== Total rows across all batches: ${allRows.length} ===`);

// Summarize
const perAsin = new Map();
for (const r of allRows) {
  const asin = r.asin;
  if (!asin) continue;
  if (!perAsin.has(asin)) {
    perAsin.set(asin, {
      asin,
      title: titlesByAsin[asin] || '(unknown)',
      queries: 0,
      totalImpressions: 0,
      totalClicks: 0,
      totalCartAdds: 0,
      totalPurchases: 0,
      bestQuery: null,
      bestQueryImpressions: 0,
    });
  }
  const agg = perAsin.get(asin);
  agg.queries++;
  agg.totalImpressions += r.impressionData?.asinImpressionCount ?? 0;
  agg.totalClicks += r.clickData?.asinClickCount ?? 0;
  agg.totalCartAdds += r.cartAddData?.asinCartAddCount ?? 0;
  agg.totalPurchases += r.purchaseData?.asinPurchaseCount ?? 0;
  const imp = r.impressionData?.asinImpressionCount ?? 0;
  if (imp > agg.bestQueryImpressions) {
    agg.bestQueryImpressions = imp;
    agg.bestQuery = r.searchQueryData?.searchQuery || r.searchQuery;
  }
}

const summary = [...perAsin.values()].sort((a, b) => b.totalImpressions - a.totalImpressions);

console.log('\n=== Per-ASIN summary (sorted by total impressions) ===\n');
console.log('ASIN          | Queries | Impressions | Clicks | Cart adds | Purchases | Best query');
console.log('--------------|---------|-------------|--------|-----------|-----------|------------');
for (const a of summary.slice(0, 30)) {
  const q = String(a.queries).padStart(7);
  const i = String(a.totalImpressions).padStart(11);
  const c = String(a.totalClicks).padStart(6);
  const ca = String(a.totalCartAdds).padStart(9);
  const p = String(a.totalPurchases).padStart(9);
  console.log(`${a.asin} | ${q} | ${i} | ${c} | ${ca} | ${p} | ${(a.bestQuery || '').slice(0, 40)}`);
}

// Top queries by total RSC impressions
const queryAgg = new Map();
for (const r of allRows) {
  const q = r.searchQueryData?.searchQuery || r.searchQuery;
  if (!q) continue;
  if (!queryAgg.has(q)) {
    queryAgg.set(q, {
      query: q,
      asins: new Set(),
      totalImpressions: 0,
      totalClicks: 0,
      totalPurchases: 0,
      searchQueryScore: r.searchQueryData?.searchQueryScore,
      searchQueryVolume: r.searchQueryData?.searchQueryVolume,
    });
  }
  const agg = queryAgg.get(q);
  agg.asins.add(r.asin);
  agg.totalImpressions += r.impressionData?.asinImpressionCount ?? 0;
  agg.totalClicks += r.clickData?.asinClickCount ?? 0;
  agg.totalPurchases += r.purchaseData?.asinPurchaseCount ?? 0;
}

const queries = [...queryAgg.values()].sort((a, b) => b.totalImpressions - a.totalImpressions);
console.log('\n=== Top 30 queries by your total impressions ===\n');
console.log('Query                                    | ASINs | Impressions | Clicks | Purchases | Vol');
console.log('-----------------------------------------|-------|-------------|--------|-----------|----');
for (const q of queries.slice(0, 30)) {
  const query = q.query.slice(0, 40).padEnd(40);
  const a = String(q.asins.size).padStart(5);
  const i = String(q.totalImpressions).padStart(11);
  const c = String(q.totalClicks).padStart(6);
  const p = String(q.totalPurchases).padStart(9);
  const vol = String(q.searchQueryVolume ?? '?').padStart(4);
  console.log(`${query} | ${a} | ${i} | ${c} | ${p} | ${vol}`);
}

// Dump
mkdirSync(DUMP_DIR, { recursive: true });
const outPath = `${DUMP_DIR}/${today}-search-query-performance-${client.env}.json`;
writeFileSync(
  outPath,
  JSON.stringify(
    {
      dataStartTime,
      dataEndTime,
      rscAsinsRequested: rscList,
      batchResults,
      rows: allRows,
      perAsinSummary: summary,
      topQueries: queries.slice(0, 100),
    },
    null,
    2,
  ),
);
console.log(`\nDump: ${outPath}`);

const totalImp = summary.reduce((s, a) => s + a.totalImpressions, 0);
const totalClicks = summary.reduce((s, a) => s + a.totalClicks, 0);
const totalPurch = summary.reduce((s, a) => s + a.totalPurchases, 0);
console.log(`\n=== Headline numbers ===`);
console.log(`  Total queries with any RSC impressions: ${queries.length}`);
console.log(`  RSC ASINs that received any impressions: ${summary.filter((a) => a.totalImpressions > 0).length} of ${rscList.length}`);
console.log(`  Total impressions (your ASINs): ${totalImp.toLocaleString()}`);
console.log(`  Total clicks (your ASINs): ${totalClicks.toLocaleString()}`);
console.log(`  Total purchases (your ASINs): ${totalPurch.toLocaleString()}`);
if (totalImp > 0) {
  console.log(`  Click-through rate: ${((totalClicks / totalImp) * 100).toFixed(2)}%`);
}
if (totalClicks > 0) {
  console.log(`  Click-to-purchase rate: ${((totalPurch / totalClicks) * 100).toFixed(2)}%`);
}
