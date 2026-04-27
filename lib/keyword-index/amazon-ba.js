/**
 * Amazon Brand Analytics Search Terms ingest.
 *
 * The full BA report is multi-GB JSONL. We stream-parse line-by-line
 * and emit only entries where at least one of the top-3 clicked ASINs
 * is an RSC ASIN we own. Non-RSC entries from those rows are kept as
 * `competitors`.
 *
 * `parseBaReportStream` is the unit-tested core. `fetchBaReport` is
 * the live SP-API wrapper that downloads the JSONL to disk first.
 */

import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { normalize } from './normalize.js';

const TOP_N = 3;

export async function parseBaReportStream({ filePath, rscAsins }) {
  if (!existsSync(filePath)) return {};
  const out = {};
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    // Check whether any top-N clicked ASIN is RSC
    let rscMatched = false;
    for (let i = 1; i <= TOP_N; i++) {
      if (rscAsins.has(row[`clickedAsin${i}`])) { rscMatched = true; break; }
    }
    if (!rscMatched) continue;

    const key = normalize(row.searchTerm);
    if (!key) continue;

    // Build competitors list (non-RSC top-N ASINs)
    const competitors = [];
    for (let i = 1; i <= TOP_N; i++) {
      const asin = row[`clickedAsin${i}`];
      if (!asin || rscAsins.has(asin)) continue;
      competitors.push({
        asin,
        brand: row[`productTitle${i}`] || null,
        click_share: row[`clickShare${i}`] ?? null,
        conversion_share: row[`conversionShare${i}`] ?? null,
      });
    }

    out[key] = {
      search_term: row.searchTerm,
      search_frequency_rank: row.searchFrequencyRank ?? null,
      competitors,
    };
  }
  return out;
}

/**
 * Live fetcher — request weekly BA report covering the window, stream it
 * to disk, return the local path. Caller passes that path to
 * parseBaReportStream.
 *
 * NOT unit-tested.
 */
export async function fetchBaReport({ client, fromDate, toDate, outPath, getMarketplaceId, requestReport, pollReport, streamReportToFile }) {
  const reportType = 'GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT';
  const reportOptions = { reportPeriod: 'WEEK' };
  const { reportId } = await requestReport(client, reportType, [getMarketplaceId()], fromDate, toDate, reportOptions);
  const { reportDocumentId } = await pollReport(client, reportId);
  await streamReportToFile(client, reportDocumentId, outPath);
  return outPath;
}
