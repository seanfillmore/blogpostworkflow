/**
 * Amazon Brand Analytics Search Terms ingest.
 *
 * The full BA report is a multi-GB single JSON object with shape:
 *
 *   {
 *     "reportSpecification": {...},
 *     "dataByDepartmentAndSearchTerm": [
 *       { departmentName, searchTerm, searchFrequencyRank,
 *         clickedAsin, clickedItemName, clickShareRank, clickShare, conversionShare },
 *       ...
 *     ]
 *   }
 *
 * Each row is ONE (searchTerm, clickedAsin) pair — three rows per
 * searchTerm cover the top-3 clicked ASINs (clickShareRank 1/2/3).
 *
 * Rows for the same searchTerm are CONTIGUOUS in the file (same
 * searchFrequencyRank). We stream-parse via stream-json's StreamArray,
 * accumulate rows by searchTerm, and emit a result whenever any of the
 * accumulated ASINs is RSC. Non-RSC accumulated ASINs become competitors.
 *
 * `parseBaReport` is the unit-tested core. `fetchBaReport` is the live
 * SP-API wrapper that downloads the JSON to disk first.
 */

import { createReadStream, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { normalize } from './normalize.js';

// stream-json v2 ships CommonJS entry points; bridge with createRequire.
const require = createRequire(import.meta.url);
const { chain } = require('stream-chain');
const { parser } = require('stream-json');
const Pick = require('stream-json/filters/pick.js');
const StreamArray = require('stream-json/streamers/stream-array.js');

/**
 * Parse the BA report file at filePath, emitting one entry per searchTerm
 * where at least one of the top-clicked ASINs is in `rscAsins`.
 * Returns a map keyed by normalized searchTerm.
 */
export async function parseBaReport({ filePath, rscAsins }) {
  if (!existsSync(filePath)) return {};
  const out = {};

  // State for the current group (rows sharing a searchTerm)
  let currentTerm = null;
  let currentFreqRank = null;
  let currentRows = []; // [{ asin, brand, clickShareRank, clickShare, conversionShare }, ...]

  function flush() {
    if (!currentTerm || currentRows.length === 0) return;
    const rscMatched = currentRows.some((r) => rscAsins.has(r.asin));
    if (!rscMatched) {
      currentRows = [];
      return;
    }
    const competitors = currentRows
      .filter((r) => !rscAsins.has(r.asin))
      .sort((a, b) => (a.clickShareRank ?? 99) - (b.clickShareRank ?? 99))
      .map((r) => ({
        asin: r.asin,
        brand: r.brand,
        click_share: r.clickShare,
        conversion_share: r.conversionShare,
      }));
    const key = normalize(currentTerm);
    if (key) {
      out[key] = {
        search_term: currentTerm,
        search_frequency_rank: currentFreqRank,
        competitors,
      };
    }
    currentRows = [];
  }

  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath, { encoding: 'utf8' });
    const arrayStream = chain([
      stream,
      parser(),
      Pick.pick({ filter: 'dataByDepartmentAndSearchTerm' }),
      StreamArray.streamArray(),
    ]);

    arrayStream.on('data', ({ value: row }) => {
      const term = row?.searchTerm;
      const rank = row?.searchFrequencyRank ?? null;
      // Group boundary: emit + reset when searchTerm changes
      if (currentTerm !== null && term !== currentTerm) flush();
      currentTerm = term;
      currentFreqRank = rank;
      if (row?.clickedAsin) {
        currentRows.push({
          asin: row.clickedAsin,
          brand: row.clickedItemName ?? null,
          clickShareRank: row.clickShareRank ?? null,
          clickShare: row.clickShare ?? null,
          conversionShare: row.conversionShare ?? null,
        });
      }
    });
    arrayStream.on('end', () => { flush(); resolve(); });
    arrayStream.on('error', (err) => reject(err));
    stream.on('error', (err) => reject(err));
  });

  return out;
}

/**
 * Backwards-compatible alias for the prior function name.
 * The "Stream" suffix was a misnomer (the file is JSON not JSONL) but
 * existing callers use this name.
 */
export const parseBaReportStream = parseBaReport;

/**
 * Live fetcher — request weekly BA report covering the window, stream it
 * to disk, return the local path. Caller passes that path to
 * parseBaReport.
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
