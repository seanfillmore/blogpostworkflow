/**
 * Amazon Search Query Performance ingest.
 *
 * `parseSqpReport` is pure — turns one ASIN's SQP JSON into a per-query
 * map. `mergeSqpReports` combines several per-ASIN reports (since we
 * request one report per RSC ASIN) into a single per-query view.
 *
 * `fetchSqpReportForAsin` is the live wrapper around the SP-API client.
 * Not unit-tested (live API); smoke-tested via the orchestrator's
 * --dry-run smoke run.
 */

import { normalize } from './normalize.js';

export function parseSqpReport(raw) {
  const out = {};
  for (const row of raw?.dataByAsin || []) {
    const q = row?.searchQueryData?.searchQuery;
    if (!q) continue;
    const key = normalize(q);
    if (!key) continue;
    const clicks = row.clickData?.asinClickCount ?? 0;
    const purchases = row.purchaseData?.asinPurchaseCount ?? 0;
    out[key] = {
      asin: row.asin,
      query: q,
      query_volume: row.searchQueryData?.searchQueryVolume ?? null,
      impressions: row.impressionData?.asinImpressionCount ?? 0,
      clicks,
      add_to_cart: row.cartAddData?.asinCartAddCount ?? 0,
      purchases,
      cvr: clicks > 0 ? purchases / clicks : 0,
      asin_purchase_share: row.purchaseData?.asinPurchaseShare ?? null,
    };
  }
  return out;
}

export function mergeSqpReports(perAsinMaps) {
  // Each entry in perAsinMaps is the output of parseSqpReport — keyed by query.
  // We merge by summing impressions/clicks/atc/purchases across ASINs and
  // collecting the per-ASIN breakdown.
  const merged = {};
  for (const m of perAsinMaps) {
    for (const [key, row] of Object.entries(m)) {
      if (!merged[key]) {
        merged[key] = {
          query: row.query,
          query_volume: row.query_volume,
          impressions: 0,
          clicks: 0,
          add_to_cart: 0,
          purchases: 0,
          cvr: 0,
          asins: [],
        };
      }
      merged[key].impressions += row.impressions;
      merged[key].clicks += row.clicks;
      merged[key].add_to_cart += row.add_to_cart;
      merged[key].purchases += row.purchases;
      merged[key].asins.push({ asin: row.asin, clicks: row.clicks, purchases: row.purchases });
    }
  }
  // Recompute CVR from totals
  for (const row of Object.values(merged)) {
    row.cvr = row.clicks > 0 ? row.purchases / row.clicks : 0;
  }
  return merged;
}

/**
 * Live fetcher — request, poll, download, parse one SQP report for an ASIN.
 * Window is 8 weeks ending now-3d (GA4 lag absorbed elsewhere; SQP is not
 * affected, but using consistent windows simplifies the integration).
 *
 * NOT unit tested — exercised in the orchestrator's smoke test.
 */
export async function fetchSqpReportForAsin({ client, asin, fromDate, toDate, getMarketplaceId, requestReport, pollReport, downloadReport }) {
  const reportType = 'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_ASIN_REPORT';
  const reportOptions = { asin, reportPeriod: 'WEEK' };
  const { reportId } = await requestReport(client, reportType, [getMarketplaceId()], fromDate, toDate, reportOptions);
  const { reportDocumentId } = await pollReport(client, reportId);
  const text = await downloadReport(client, reportDocumentId);
  return JSON.parse(text);
}
