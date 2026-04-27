/**
 * Keyword Index Builder
 *
 * Biweekly rebuild of data/keyword-index.json + data/category-competitors.json
 * by joining Amazon BA/SQP, GSC, GA4 (and DataForSEO market enrichment).
 *
 * Self-paces: scheduler.js calls this daily; the agent skips early
 * if the existing index is < 14 days old. --force bypasses.
 *
 * Usage:
 *   node agents/keyword-index-builder/index.js
 *   node agents/keyword-index-builder/index.js --dry-run
 *   node agents/keyword-index-builder/index.js --force
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { aggregateGscWindow } from '../../lib/keyword-index/gsc-aggregator.js';
import { aggregateGa4Window } from '../../lib/keyword-index/ga4-aggregator.js';
import { parseBaReportStream } from '../../lib/keyword-index/amazon-ba.js';
import { findLatestListingsDump, listRscAsinsFromDump } from '../../lib/keyword-index/rsc-asins.js';
import { findLatestSqpDump, findLatestBaDump, parseSqpDump } from '../../lib/keyword-index/dump-readers.js';
import { mergeSources, loadClustersFromPriorIndex } from '../../lib/keyword-index/merge.js';
import { rollUpCompetitorsByCluster } from '../../lib/keyword-index/competitors.js';
import { enrichWithMarketData } from '../../lib/keyword-index/dataforseo-enricher.js';

import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const SNAPSHOTS_GSC = join(ROOT, 'data', 'snapshots', 'gsc');
const SNAPSHOTS_GA4 = join(ROOT, 'data', 'snapshots', 'ga4');
const INDEX_PATH = join(ROOT, 'data', 'keyword-index.json');
const COMPETITORS_PATH = join(ROOT, 'data', 'category-competitors.json');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'keyword-index');
const REBUILD_DAYS = 14;
const WINDOW_DAYS = 56;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');

function isoDate(d) { return d.toISOString().slice(0, 10); }

function shouldSkip(now = new Date()) {
  if (force) return false;
  if (!existsSync(INDEX_PATH)) return false;
  try {
    const prior = JSON.parse(readFileSync(INDEX_PATH, 'utf8'));
    if (!prior.built_at) return false;
    const ageDays = (now.getTime() - new Date(prior.built_at).getTime()) / 86400000;
    return ageDays < REBUILD_DAYS;
  } catch { return false; }
}

function loadPriorIndex() {
  if (!existsSync(INDEX_PATH)) return null;
  try { return JSON.parse(readFileSync(INDEX_PATH, 'utf8')); } catch { return null; }
}

function atomicWriteJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  renameSync(tmp, path);
}

function listRscAsins() {
  // Read the latest dump from `scripts/amazon/explore-listings.mjs`
  // (writes data/amazon-explore/<date>-listings-<env>.json) and return
  // the RSC-classified ASINs only. Culina is filtered out at this layer
  // so subsequent SQP/BA stages never see it.
  const dumpPath = findLatestListingsDump(ROOT);
  if (!dumpPath) {
    console.warn('  No listings dump under data/amazon-explore/. Run `node scripts/amazon/explore-listings.mjs` to seed it.');
    return [];
  }
  return listRscAsinsFromDump(dumpPath);
}

async function runStage(name, fn, stageReport) {
  const start = Date.now();
  try {
    const result = await fn();
    stageReport[name] = { ok: true, ms: Date.now() - start };
    return result;
  } catch (err) {
    stageReport[name] = { ok: false, ms: Date.now() - start, error: err.message };
    return null;
  }
}

async function main() {
  const nowIso = new Date().toISOString();
  console.log(`\nKeyword Index Builder — mode: ${dryRun ? 'DRY RUN' : 'APPLY'}${force ? ' (--force)' : ''}`);

  if (shouldSkip()) {
    console.log(`  Skipping — last build < ${REBUILD_DAYS} days ago. Use --force to override.`);
    return;
  }

  mkdirSync(REPORTS_DIR, { recursive: true });

  const fromDate = isoDate(new Date(Date.now() - WINDOW_DAYS * 86400000));
  const toDate = isoDate(new Date(Date.now() - 3 * 86400000)); // 3-day GA4 lag buffer
  console.log(`  Window: ${fromDate} → ${toDate} (${WINDOW_DAYS} days)`);

  const priorIndex = loadPriorIndex();
  const clusters = loadClustersFromPriorIndex(priorIndex);

  const stageReport = {};

  // Stage 1: Amazon ingest from explore-script dumps.
  // The orchestrator does NOT call SP-API live — that's the explore scripts'
  // job (scripts/amazon/explore-search-query-performance-rsc.mjs and
  // explore-brand-analytics.mjs run on weekly cron). Reading dumps avoids
  // the per-ASIN rate-limit problem entirely.
  let amazonMap = {};
  let baCompetitors = {};
  await runStage('amazon', async () => {
    const sqpDumpPath = findLatestSqpDump(ROOT);
    if (!sqpDumpPath) {
      throw new Error('No SQP dump under data/amazon-explore/. Run scripts/amazon/explore-search-query-performance-rsc.mjs first.');
    }
    const sqpDump = JSON.parse(readFileSync(sqpDumpPath, 'utf8'));
    amazonMap = parseSqpDump(sqpDump);
    console.log(`    SQP dump: ${sqpDumpPath} → ${Object.keys(amazonMap).length} queries`);

    const baDumpPath = findLatestBaDump(ROOT);
    if (baDumpPath) {
      const rscAsins = new Set(listRscAsins());
      try {
        baCompetitors = await parseBaReportStream({ filePath: baDumpPath, rscAsins });
        console.log(`    BA dump: ${baDumpPath} → ${Object.keys(baCompetitors).length} queries with competitor data`);
      } catch (err) {
        console.warn(`    BA parse failed: ${err.message}`);
      }
    } else {
      console.warn('    No BA dump under data/amazon-explore/. Competitor data unavailable. Run explore-brand-analytics.mjs to seed.');
    }

    // Merge BA's competitor list into amazonMap entries by query
    for (const [key, ba] of Object.entries(baCompetitors)) {
      if (amazonMap[key]) {
        amazonMap[key].search_frequency_rank = ba.search_frequency_rank;
        amazonMap[key].competitors = ba.competitors;
      }
    }
  }, stageReport);

  // Stage 2: GSC ingest
  const gscMap = await runStage('gsc',
    () => aggregateGscWindow({ snapshotsDir: SNAPSHOTS_GSC, fromDate, toDate }),
    stageReport,
  ) || {};

  if (!stageReport.gsc?.ok) {
    console.error('  GSC ingest failed — aborting build (no fallback for missing GSC).');
    if (!dryRun) await notify({ subject: 'Keyword Index Builder failed', body: `GSC stage failed: ${stageReport.gsc?.error}`, status: 'error' });
    process.exit(1);
  }

  // Stage 3: GA4 join
  const ga4Map = await runStage('ga4',
    () => aggregateGa4Window({ snapshotsDir: SNAPSHOTS_GA4, fromDate, toDate }),
    stageReport,
  ) || {};

  // Stage 4: Merge
  const entries = mergeSources({ amazon: amazonMap, gsc: gscMap, ga4Map, clusters });
  console.log(`  Merge: ${Object.keys(entries).length} entries qualified`);

  // Stage 5: DataForSEO enrich
  await runStage('dataforseo',
    () => enrichWithMarketData({ entries }),
    stageReport,
  );

  // Stage 6: Competitor roll-up
  const clusterCompetitors = rollUpCompetitorsByCluster(entries);

  // Final assembly
  const bySource = { amazon: 0, gsc_ga4: 0 };
  for (const e of Object.values(entries)) bySource[e.validation_source] = (bySource[e.validation_source] || 0) + 1;

  const output = {
    built_at: nowIso,
    window_days: WINDOW_DAYS,
    total_keywords: Object.keys(entries).length,
    by_validation_source: bySource,
    cluster_count: new Set(Object.values(entries).map((e) => e.cluster)).size,
    keywords: entries,
  };
  const competitorsOutput = {
    built_at: nowIso,
    window_days: WINDOW_DAYS,
    clusters: clusterCompetitors,
  };

  // Build report
  const reportPath = join(REPORTS_DIR, `${nowIso.slice(0, 10)}.md`);
  const reportLines = [
    `# Keyword Index Build — ${nowIso.slice(0, 10)}`,
    ``,
    `**Window:** ${fromDate} → ${toDate} (${WINDOW_DAYS} days)`,
    `**Mode:** ${dryRun ? 'DRY RUN' : 'APPLY'}`,
    ``,
    `## Stage outcomes`,
    ``,
    ...Object.entries(stageReport).map(([s, r]) =>
      `- **${s}**: ${r.ok ? '✅' : '❌'} (${r.ms} ms)${r.error ? ` — ${r.error}` : ''}`),
    ``,
    `## Counts`,
    ``,
    `- Total keywords: ${output.total_keywords}`,
    `- Amazon-validated: ${bySource.amazon}`,
    `- GSC+GA4-validated: ${bySource.gsc_ga4}`,
    `- Clusters: ${output.cluster_count}`,
  ];
  const degraded = !stageReport.amazon?.ok;
  if (degraded) reportLines.unshift('> ⚠ DEGRADED: Amazon stage failed; build is GSC-only.', '');

  if (dryRun) {
    console.log('\n  Dry-run: not writing outputs.');
    console.log(reportLines.join('\n'));
    return;
  }

  atomicWriteJson(INDEX_PATH, output);
  atomicWriteJson(COMPETITORS_PATH, competitorsOutput);
  writeFileSync(reportPath, reportLines.join('\n') + '\n');

  // Notify
  const notifyStatus = degraded ? 'error' : 'info';
  await notify({
    subject: degraded ? 'Keyword Index Builder ran (degraded)' : 'Keyword Index Builder ran',
    body: `Built keyword-index with ${output.total_keywords} keywords (${bySource.amazon} amazon, ${bySource.gsc_ga4} gsc_ga4). See ${reportPath}.`,
    status: notifyStatus,
  });
  console.log(`\n  Wrote ${INDEX_PATH}, ${COMPETITORS_PATH}, ${reportPath}`);
}

main().catch(async (err) => {
  console.error('Error:', err.message);
  await notify({ subject: 'Keyword Index Builder crashed', body: err.message || String(err), status: 'error' });
  process.exit(1);
});
