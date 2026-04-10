/**
 * GA4 Content Analyzer Agent
 *
 * Reads GA4 snapshot files, aggregates per-page traffic and conversion data,
 * classifies pages (CRO candidate vs expansion candidate vs balanced),
 * maps pages to topical clusters, and outputs actionable feedback.
 *
 * Usage:
 *   node agents/ga4-content-analyzer/index.js
 *   node agents/ga4-content-analyzer/index.js --days 14
 *
 * Output:
 *   data/reports/ga4-content-feedback/latest.json
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { notify, notifyLatestReport } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SNAPSHOTS_DIR = join(ROOT, 'data', 'snapshots', 'ga4');
const REPORT_DIR = join(ROOT, 'data', 'reports', 'ga4-content-feedback');
const TOPICAL_MAP_PATH = join(ROOT, 'data', 'topical-map.json');

const config = JSON.parse(readFileSync(join(ROOT, 'config', 'site.json'), 'utf8'));

// ── CLI args ─────────────────────────────────────────────────────────────────

const daysArg = process.argv.find(a => a.startsWith('--days='))?.split('=')[1]
  ?? (process.argv.includes('--days') ? process.argv[process.argv.indexOf('--days') + 1] : null);
const PERIOD_DAYS = parseInt(daysArg || '30', 10);

// ── Classification helpers ───────────────────────────────────────────────────

function classifyPage(sessions, conversions) {
  if (sessions >= 100 && conversions === 0) return 'high-traffic-low-conversion';
  if (sessions < 50 && conversions >= 1) return 'low-traffic-high-conversion';
  return 'balanced';
}

function aggregateSnapshots(snapshots) {
  const byPage = new Map();
  for (const snap of snapshots) {
    for (const lp of (snap.topLandingPages || [])) {
      const existing = byPage.get(lp.page) || { sessions: 0, conversions: 0, revenue: 0 };
      existing.sessions += lp.sessions || 0;
      existing.conversions += lp.conversions || 0;
      existing.revenue += lp.revenue || 0;
      byPage.set(lp.page, existing);
    }
  }
  return byPage;
}

function classifyCluster(pages) {
  const croCandidates = pages.filter(p => p.classification === 'high-traffic-low-conversion');
  const expansionCandidates = pages.filter(p => p.classification === 'low-traffic-high-conversion');
  return {
    cro_signal: croCandidates.length > expansionCandidates.length,
    expansion_signal: expansionCandidates.length > 0 && expansionCandidates.length >= croCandidates.length,
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('GA4 Content Analyzer\n');
  console.log(`  Period: last ${PERIOD_DAYS} days`);
  console.log(`  Site:   ${config.url}\n`);

  // 1. Read snapshot files within the date window
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - PERIOD_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  let snapshotFiles;
  try {
    snapshotFiles = readdirSync(SNAPSHOTS_DIR)
      .filter(f => f.endsWith('.json'))
      .filter(f => f.replace('.json', '') >= cutoffStr)
      .sort();
  } catch (err) {
    console.error(`  No snapshots directory found at ${SNAPSHOTS_DIR}`);
    console.error('  Run ga4-collector first to populate snapshot data.');
    process.exit(1);
  }

  if (snapshotFiles.length === 0) {
    console.log('  No snapshot files found in the date range. Nothing to analyze.');
    return;
  }

  console.log(`  Found ${snapshotFiles.length} snapshot files`);

  const snapshots = snapshotFiles.map(f =>
    JSON.parse(readFileSync(join(SNAPSHOTS_DIR, f), 'utf8'))
  );

  // 2. Aggregate per-page totals
  const byPage = aggregateSnapshots(snapshots);
  console.log(`  Aggregated data for ${byPage.size} unique pages`);

  // 3. Classify each page
  const pages = [];
  for (const [url, stats] of byPage) {
    pages.push({
      url,
      sessions: stats.sessions,
      conversions: stats.conversions,
      revenue: stats.revenue,
      classification: classifyPage(stats.sessions, stats.conversions),
      cluster: null,
    });
  }

  // 4. Load topical map and assign clusters
  let topicalMap = { clusters: [] };
  try {
    topicalMap = JSON.parse(readFileSync(TOPICAL_MAP_PATH, 'utf8'));
  } catch {
    console.log('  Warning: topical-map.json not found, skipping cluster mapping');
  }

  const siteUrl = config.url.replace(/\/$/, '');
  for (const page of pages) {
    for (const cluster of topicalMap.clusters) {
      const match = cluster.articles?.some(a => {
        const articlePath = a.url.replace(siteUrl, '');
        return articlePath === page.url;
      });
      if (match) {
        page.cluster = cluster.tag;
        break;
      }
    }
  }

  // 5. Compute per-cluster stats
  const clusterMap = new Map();
  for (const page of pages) {
    if (!page.cluster) continue;
    if (!clusterMap.has(page.cluster)) {
      clusterMap.set(page.cluster, []);
    }
    clusterMap.get(page.cluster).push(page);
  }

  const clusters = [];
  for (const [tag, clusterPages] of clusterMap) {
    const totalSessions = clusterPages.reduce((s, p) => s + p.sessions, 0);
    const totalConversions = clusterPages.reduce((s, p) => s + p.conversions, 0);
    const signals = classifyCluster(clusterPages);
    clusters.push({
      cluster: tag,
      total_sessions: totalSessions,
      total_conversions: totalConversions,
      conversion_rate: totalSessions > 0 ? totalConversions / totalSessions : 0,
      cro_signal: signals.cro_signal,
      expansion_signal: signals.expansion_signal,
    });
  }

  // 6. Extract candidate slugs
  const blogPrefix = '/blogs/news/';
  const extractSlug = (url) => {
    if (!url.startsWith(blogPrefix)) return null;
    return url.slice(blogPrefix.length);
  };

  const croCandidates = pages
    .filter(p => p.classification === 'high-traffic-low-conversion')
    .map(p => extractSlug(p.url))
    .filter(Boolean);

  const expansionCandidates = pages
    .filter(p => p.classification === 'low-traffic-high-conversion')
    .map(p => extractSlug(p.url))
    .filter(Boolean);

  // 7. Write report
  const report = {
    generated_at: new Date().toISOString(),
    period_days: PERIOD_DAYS,
    pages,
    clusters,
    cro_candidates: croCandidates,
    expansion_candidates: expansionCandidates,
  };

  mkdirSync(REPORT_DIR, { recursive: true });
  const outPath = join(REPORT_DIR, 'latest.json');
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\n  Report written to ${outPath}`);

  // 8. Summary
  console.log(`\n  Summary:`);
  console.log(`    Pages analyzed:        ${pages.length}`);
  console.log(`    CRO candidates:        ${croCandidates.length}`);
  console.log(`    Expansion candidates:  ${expansionCandidates.length}`);
  console.log(`    Clusters with data:    ${clusters.length}`);

  // 9. Notify
  await notify('ga4-content-analyzer', [
    `Analyzed ${pages.length} pages over ${PERIOD_DAYS} days`,
    `CRO candidates: ${croCandidates.length}`,
    `Expansion candidates: ${expansionCandidates.length}`,
  ].join('\n'));

  await notifyLatestReport('ga4-content-analyzer', outPath);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
