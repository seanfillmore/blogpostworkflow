/**
 * Backlink Monitor Agent
 *
 * Fetches the domain's backlink profile live from DataForSEO, saves a dated
 * JSON snapshot, and diffs it against the previous snapshot to surface changes
 * in referring domains, total backlinks, and domain rank over time.
 *
 * Requires the DataForSEO Backlinks API subscription. When that subscription is
 * inactive the agent degrades gracefully (reports "subscription required" and
 * exits 0) rather than failing.
 *
 * Usage:
 *   node agents/backlink-monitor/index.js                 # snapshot, diff, report
 *   node agents/backlink-monitor/index.js --summary-only  # print summary, no report file
 *
 * Output: data/reports/backlinks/backlink-monitor-report.md
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { notify, notifyLatestReport } from '../../lib/notify.js';
import { getBacklinksSummary } from '../../lib/dataforseo.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const BACKLINKS_DIR = join(ROOT, 'data', 'backlinks');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'backlinks');
const SNAPSHOTS_DIR = join(BACKLINKS_DIR, 'snapshots');

const config = JSON.parse(readFileSync(join(ROOT, 'config', 'site.json'), 'utf8'));

const args = process.argv.slice(2);
const summaryOnly = args.includes('--summary-only');

// ── snapshot management ───────────────────────────────────────────────────────

function loadPreviousSummary(todayFile) {
  if (!existsSync(SNAPSHOTS_DIR)) return null;
  const prevFile = readdirSync(SNAPSHOTS_DIR)
    .filter((f) => f.endsWith('.json') && f !== todayFile)
    .sort()
    .reverse()[0];
  if (!prevFile) return null;
  try {
    return JSON.parse(readFileSync(join(SNAPSHOTS_DIR, prevFile), 'utf8'));
  } catch {
    return null;
  }
}

// ── report ────────────────────────────────────────────────────────────────────

function buildReport(summary, prev) {
  const now = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const lines = [
    `# Backlink Monitor Report — ${config.name}`,
    `**Run date:** ${now}`,
    `**Data source:** DataForSEO Backlinks API`,
    '',
    '## Domain Summary',
    `| Metric | Value |`,
    `|---|---|`,
    `| Domain Rank | ${summary.rank} |`,
    `| Total Backlinks | ${summary.backlinks.toLocaleString()} |`,
    `| Referring Domains | ${summary.referringDomains.toLocaleString()} |`,
    `| Dofollow | ${summary.dofollow.toLocaleString()} |`,
    `| Nofollow | ${summary.nofollow.toLocaleString()} |`,
    `| Broken Backlinks | ${summary.brokenBacklinks.toLocaleString()} |`,
    `| Referring IPs | ${summary.referringIps.toLocaleString()} |`,
  ];

  if (prev) {
    lines.push('');
    lines.push(`## Changes since ${prev.date}`);
    lines.push(`| Metric | Previous | Current | Change |`);
    lines.push(`|---|---|---|---|`);
    const row = (label, p, c) => lines.push(`| ${label} | ${p} | ${c} | ${c - p >= 0 ? '+' : ''}${c - p} |`);
    row('Referring Domains', prev.referringDomains, summary.referringDomains);
    row('Total Backlinks', prev.backlinks, summary.backlinks);
    row('Domain Rank', prev.rank, summary.rank);
  }

  lines.push('');
  return lines.join('\n');
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nBacklink Monitor — ${config.name}\n`);

  mkdirSync(BACKLINKS_DIR, { recursive: true });
  mkdirSync(REPORTS_DIR, { recursive: true });

  const domain = config.url.replace(/^https?:\/\//, '').replace(/\/$/, '');
  console.log(`  Fetching backlink data from DataForSEO for ${domain}...`);
  const summary = await getBacklinksSummary(domain);

  if (!summary) {
    // Backlinks API requires a separate DataForSEO subscription.
    console.log('  ⚠️ DataForSEO Backlinks API subscription is inactive — no backlink data available.');
    console.log('  Activate it at https://app.dataforseo.com/backlinks-subscription to enable this agent.');
    notify({
      subject: 'Backlink Monitor skipped — Backlinks subscription inactive',
      body: 'getBacklinksSummary returned no data (DataForSEO Backlinks API subscription required). Activate the subscription to resume backlink monitoring.',
      status: 'info',
    });
    return;
  }

  console.log(`  DataForSEO: ${summary.referringDomains} referring domains, rank ${summary.rank}`);

  const today = new Date().toISOString().slice(0, 10);
  const todayFile = `${today}.json`;
  const prev = loadPreviousSummary(todayFile);

  mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  writeFileSync(join(SNAPSHOTS_DIR, todayFile), JSON.stringify({ ...summary, date: today }, null, 2));
  console.log(`  Snapshot saved: ${join(SNAPSHOTS_DIR, todayFile)}`);

  if (prev) {
    const drDelta = summary.referringDomains - prev.referringDomains;
    console.log(`  Referring domains since ${prev.date}: ${drDelta >= 0 ? '+' : ''}${drDelta}`);
  } else {
    console.log('  No previous snapshot found — this is the baseline.');
  }

  if (summaryOnly) return;

  const report = buildReport(summary, prev);
  const reportPath = join(REPORTS_DIR, 'backlink-monitor-report.md');
  writeFileSync(reportPath, report);
  console.log(`  Report saved: ${reportPath}`);
}

main()
  .then(() => notifyLatestReport('Backlink Monitor completed', join(ROOT, 'data', 'reports', 'backlinks')))
  .catch((err) => {
    notify({ subject: 'Backlink Monitor failed', body: err.message || String(err), status: 'error' });
    console.error('Error:', err.message);
  });
