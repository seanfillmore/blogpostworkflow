#!/usr/bin/env node
/**
 * Paid vs organic conversion rate, per ASIN. READ ONLY.
 *
 *   node scripts/amazon-ads-paid-vs-organic.mjs [--days 90]
 *
 * WHY THIS IS THE FIRST QUESTION, not a footnote. The listing, the price and the reviews
 * are identical whichever way a shopper arrived; the only thing that differs is the path.
 * So if paid converts far worse than organic, the fault is in targeting or ad promise. If
 * BOTH convert badly, the listing is failing every visitor and bid work buys nothing. This
 * is the diagnostic the marketing-amazon-ppc-management skill ranks first, and running a
 * negation pass before answering it is how a whole optimisation cycle gets spent on the
 * wrong surface.
 *
 * It needs two sources that do not share a vocabulary:
 *   ADS  — spAdvertisedProduct report: clicks and purchases attributed to advertising.
 *   SP-API — GET_SALES_AND_TRAFFIC_REPORT: total sessions and total units for the SAME
 *            ASIN over the SAME window, across every traffic source.
 *
 * ORGANIC IS DERIVED BY SUBTRACTION AND THAT IS AN APPROXIMATION, stated here rather than
 * buried: Amazon reports sessions, not "organic sessions", so organic sessions are
 * (sessions − ad clicks) and organic units are (units − ad units). Two known distortions,
 * neither of which this script pretends away — an ad click and a session are not the same
 * unit of measurement (one visitor clicking two ads is two clicks, one session), and ad
 * attribution is a 14-day window while sessions are same-day. So treat the comparison as
 * DIRECTIONAL — a 2× gap is a finding, a 15% gap is noise.
 */

import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { isDirectRun } from '../lib/is-direct-run.js';
import { getClient, listProfiles, runReport, isoDay } from '../lib/amazon/ads-api-client.js';
import {
  getClient as getSpClient, getMarketplaceId,
  requestReport, pollReport, downloadReport,
} from '../lib/amazon/sp-api-client.js';
import { classifyBrand } from './amazon-ads-audit.mjs';

const pct = (n) => (n === null || !Number.isFinite(n) ? '—' : `${(n * 100).toFixed(2)}%`);
const money = (n) => `$${(n ?? 0).toFixed(2)}`;

/**
 * @returns {{asin, adClicks, adOrders, adSpend, adSales, sessions, units,
 *            paidCvr, organicSessions, organicUnits, organicCvr, ratio}}
 */
export function joinPaidOrganic(adRows, trafficRows) {
  const ads = new Map();
  for (const r of adRows) {
    const asin = r.advertisedAsin ?? r.asin;
    if (!asin) continue;
    const cur = ads.get(asin) ?? { clicks: 0, orders: 0, spend: 0, sales: 0 };
    cur.clicks += r.clicks ?? 0;
    cur.orders += r.purchases30d ?? 0;
    cur.spend += r.cost ?? 0;
    cur.sales += r.sales30d ?? 0;
    ads.set(asin, cur);
  }

  const traffic = new Map();
  for (const r of trafficRows) {
    const asin = r.parentAsin ?? r.childAsin;
    if (!asin) continue;
    const cur = traffic.get(asin) ?? { sessions: 0, units: 0, sales: 0 };
    cur.sessions += r.trafficByAsin?.sessions ?? 0;
    cur.units += r.salesByAsin?.unitsOrdered ?? 0;
    cur.sales += r.salesByAsin?.orderedProductSales?.amount ?? 0;
    traffic.set(asin, cur);
  }

  const out = [];
  for (const asin of new Set([...ads.keys(), ...traffic.keys()])) {
    const a = ads.get(asin) ?? { clicks: 0, orders: 0, spend: 0, sales: 0 };
    const t = traffic.get(asin) ?? { sessions: 0, units: 0, sales: 0 };
    const organicSessions = Math.max(t.sessions - a.clicks, 0);
    const organicUnits = Math.max(t.units - a.orders, 0);
    const paidCvr = a.clicks > 0 ? a.orders / a.clicks : null;
    const organicCvr = organicSessions > 0 ? organicUnits / organicSessions : null;
    out.push({
      asin, brand: classifyBrand(asin),
      adClicks: a.clicks, adOrders: a.orders, adSpend: a.spend, adSales: a.sales,
      sessions: t.sessions, units: t.units, totalSales: t.sales,
      paidCvr, organicSessions, organicUnits, organicCvr,
      ratio: paidCvr !== null && organicCvr ? paidCvr / organicCvr : null,
      adShareOfUnits: t.units > 0 ? a.orders / t.units : null,
    });
  }
  return out.sort((x, y) => y.adSpend - x.adSpend);
}

/** Four quadrants, per the skill: each combination has a different cheapest fix. */
export function quadrant(row, { paidFloor, organicFloor }) {
  if (row.paidCvr === null || row.organicCvr === null) return 'insufficient data';
  const p = row.paidCvr >= paidFloor;
  const o = row.organicCvr >= organicFloor;
  if (!p && !o) return 'BAD paid / BAD organic — fix the LISTING first, bids buy nothing';
  if (p && !o) return 'good paid / BAD organic — listing throttles a working ad';
  if (!p && o) return 'BAD paid / good organic — foundation is sound, targeting is wrong';
  return 'good paid / good organic — iterate';
}

async function main() {
  const argv = process.argv.slice(2);
  const days = Number(argv[argv.indexOf('--days') + 1]) || 90;
  const endDate = isoDay(Date.now() - 864e5);
  const startDate = isoDay(Date.now() - days * 864e5);

  console.log(`Paid vs organic CVR — ${startDate} → ${endDate} (${days}d)\n`);

  console.log('Ads: advertised-product report…');
  const ads = getClient();
  await listProfiles(ads);
  const adRows = await runReport(ads, {
    name: 'paid-vs-organic', startDate, endDate,
    onProgress: (m) => console.log(`  ${m}`),
    configuration: {
      adProduct: 'SPONSORED_PRODUCTS', timeUnit: 'SUMMARY', format: 'GZIP_JSON',
      groupBy: ['advertiser'], reportTypeId: 'spAdvertisedProduct',
      columns: ['advertisedAsin', 'advertisedSku', 'impressions', 'clicks', 'cost', 'purchases30d', 'sales30d'],
    },
  });
  console.log(`  ad rows: ${adRows.length}`);

  console.log('\nSP-API: sales & traffic report…');
  const sp = getSpClient();
  const reportId = await requestReport(
    sp, 'GET_SALES_AND_TRAFFIC_REPORT', [getMarketplaceId()],
    `${startDate}T00:00:00Z`, `${endDate}T23:59:59Z`,
    { asinGranularity: 'PARENT', dateGranularity: 'RANGE' }
  );
  const docId = await pollReport(sp, reportId);
  const doc = await downloadReport(sp, docId);
  const trafficRows = (typeof doc === 'string' ? JSON.parse(doc) : doc)?.salesAndTrafficByAsin ?? [];
  console.log(`  traffic rows: ${trafficRows.length}`);

  const joined = joinPaidOrganic(adRows, trafficRows);

  // Benchmarks come from THIS account, not an imported "good CVR" number — what counts as
  // good varies enormously by category, which is the whole reason the skill sends you to
  // Brand Analytics rather than to a blog post.
  const withBoth = joined.filter((r) => r.paidCvr !== null && r.organicCvr !== null);
  const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] ?? 0; };
  const paidFloor = median(withBoth.map((r) => r.paidCvr));
  const organicFloor = median(withBoth.map((r) => r.organicCvr));

  console.log(`\n${'='.repeat(116)}`);
  console.log('PAID vs ORGANIC CONVERSION — organic is DERIVED BY SUBTRACTION, so read gaps, not decimals');
  console.log(`account median paid CVR ${pct(paidFloor)} · median organic CVR ${pct(organicFloor)} (used as the quadrant floors)`);
  console.log('='.repeat(116));
  console.log(
    '  ASIN'.padEnd(14) + 'BRAND'.padEnd(9) + 'AD SPEND'.padStart(10) + 'CLICKS'.padStart(8) +
    'PAID CVR'.padStart(10) + 'ORG CVR'.padStart(10) + 'P/O'.padStart(7) + 'SESS'.padStart(8) +
    'UNITS'.padStart(7) + '  AD SHARE'
  );
  for (const r of joined.filter((x) => x.adSpend > 0 || x.sessions > 0).slice(0, 30)) {
    console.log(
      '  ' + r.asin.padEnd(12) + r.brand.padEnd(9) +
      money(r.adSpend).padStart(10) + String(r.adClicks).padStart(8) +
      pct(r.paidCvr).padStart(10) + pct(r.organicCvr).padStart(10) +
      (r.ratio ? r.ratio.toFixed(2) + 'x' : '—').padStart(7) +
      String(r.sessions).padStart(8) + String(r.units).padStart(7) +
      '  ' + pct(r.adShareOfUnits)
    );
  }

  console.log('\nQUADRANT (spend ≥ $50):');
  for (const r of joined.filter((x) => x.adSpend >= 50)) {
    console.log(`  ${r.asin}  ${r.brand.padEnd(8)} ${money(r.adSpend).padStart(9)}  ${quadrant(r, { paidFloor, organicFloor })}`);
  }

  mkdirSync('data/reports/amazon-ads-audit', { recursive: true });
  writeFileSync('data/reports/amazon-ads-audit/paid-vs-organic.json',
    JSON.stringify({ generated_at: new Date().toISOString(), window: { startDate, endDate, days },
      read_only: true, benchmarks: { paidFloor, organicFloor }, rows: joined }, null, 2));
  console.log('\n✓ data/reports/amazon-ads-audit/paid-vs-organic.json');
}

if (isDirectRun(import.meta.url)) {
  main().catch((e) => { console.error(`\n✗ ${e.message}\n`); process.exit(1); });
}
