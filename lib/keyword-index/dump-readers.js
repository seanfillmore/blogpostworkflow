/**
 * Read Amazon dump files written by the explore scripts.
 *
 * The keyword-index builder used to fetch SP-API reports live in Stage 1,
 * which hit per-ASIN rate limits. The fix is to decouple: explore scripts
 * (scripts/amazon/explore-*.mjs) run on their own weekly cron, dump
 * pre-aggregated data to disk, and the builder reads from disk only.
 *
 * - SQP dump: scripts/amazon/explore-search-query-performance-rsc.mjs writes
 *   `data/amazon-explore/<date>-search-query-performance-<env>.json` with
 *   shape `{ rscAsinsRequested, rows: [{asin, searchQueryData, ...}], ... }`.
 *   Uses the batched GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT
 *   (multi-ASIN per request) so it stays inside Reports API quotas.
 *
 * - BA dump: scripts/amazon/explore-brand-analytics.mjs streams the
 *   Search Terms report (multi-GB JSONL) to
 *   `data/amazon-explore/<date>-brand-analytics-<env>.json`. The existing
 *   `parseBaReportStream` reads it directly — no separate parser needed.
 */

import { readdirSync, existsSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSqpReport, mergeSqpReports } from './amazon-sqp.js';

const EXPLORE_DIR_REL = 'data/amazon-explore';

function findLatestMatching(rootDir, pattern) {
  const dir = join(rootDir, EXPLORE_DIR_REL);
  if (!existsSync(dir)) return null;
  const candidates = readdirSync(dir)
    .filter((f) => pattern.test(f))
    .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return candidates[0] ? join(dir, candidates[0].f) : null;
}

// Prefer the most recent SQP dump that actually has rows. A failed Brand
// Analytics week (all batches FATAL → rows: []) still writes a dump; without
// this guard the builder would consume that empty dump and zero out the entire
// Amazon-validated layer until the next good week.
export function findLatestSqpDump(rootDir = process.cwd()) {
  const dir = join(rootDir, EXPLORE_DIR_REL);
  if (!existsSync(dir)) return null;
  const candidates = readdirSync(dir)
    .filter((f) => /-search-query-performance-.*\.json$/.test(f))
    .map((f) => ({ path: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (candidates.length === 0) return null;
  for (const c of candidates) {
    try {
      const dump = JSON.parse(readFileSync(c.path, 'utf8'));
      if (Array.isArray(dump.rows) && dump.rows.length > 0) return c.path;
    } catch { /* unreadable — skip */ }
  }
  // None have rows — fall back to the newest so callers still get a path.
  return candidates[0].path;
}

export function findLatestBaDump(rootDir = process.cwd()) {
  return findLatestMatching(rootDir, /-brand-analytics-.*\.json$/);
}

/**
 * Parse the SQP explore dump into the same per-query map shape produced by
 * mergeSqpReports — so the orchestrator's downstream merge code stays
 * unchanged. The dump contains rows from many ASINs in a flat list; we
 * group by ASIN, parse each group, then merge.
 */
export function parseSqpDump(dump) {
  if (!dump || !Array.isArray(dump.rows)) return {};
  const byAsin = {};
  for (const row of dump.rows) {
    if (!row.asin) continue;
    if (!byAsin[row.asin]) byAsin[row.asin] = [];
    byAsin[row.asin].push(row);
  }
  const perAsinMaps = Object.entries(byAsin).map(([asin, rows]) =>
    parseSqpReport({ asin, dataByAsin: rows }),
  );
  return mergeSqpReports(perAsinMaps);
}

const UNTAPPED_REL = 'data/reports/gsc-query-miner/untapped-candidates.json';

/**
 * Read the gsc-query-miner's untapped-candidates feed.
 *
 * Age is measured from the `generated_at` field inside the file, never from
 * mtime: a git checkout rewrites mtimes, which is how a dormant agent's stale
 * output previously passed for fresh. A file past `maxAgeDays` returns no
 * candidates, so a dead miner stops injecting demand instead of injecting
 * months-old demand forever.
 *
 * Never throws. A missing or unreadable feed is an absent enhancement, not a
 * build failure — same contract as the optional BA dump.
 */
export function readUntappedCandidates(rootDir = process.cwd(), { maxAgeDays = 21, now = new Date() } = {}) {
  const none = (status, ageDays = null) => ({ candidates: [], status, ageDays });
  const path = join(rootDir, UNTAPPED_REL);
  if (!existsSync(path)) return none('missing');

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return none('malformed');
  }

  const generatedAt = parsed?.generated_at ? Date.parse(parsed.generated_at) : NaN;
  if (Number.isNaN(generatedAt)) return none('malformed');
  if (!Array.isArray(parsed.candidates)) return none('malformed');

  const ageDays = Math.floor((now.getTime() - generatedAt) / 86400000);
  if (ageDays > maxAgeDays) return none('stale', ageDays);

  const candidates = parsed.candidates.filter((c) => c && typeof c.keyword === 'string' && c.keyword.trim());
  return { candidates, status: 'ok', ageDays };
}
