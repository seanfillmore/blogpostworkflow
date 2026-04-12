/**
 * Backlink Monitor Agent
 *
 * Reads an Ahrefs "Referring Domains" CSV export and diffs it against the
 * previous month's snapshot to surface new and lost referring domains.
 *
 * Setup:
 *   1. In Ahrefs → Site Explorer → your domain → Referring Domains
 *   2. Export as CSV → save to data/backlinks/referring-domains.csv
 *   3. Run this agent — it saves a snapshot and compares to the previous one
 *
 * The agent will automatically archive the last snapshot and compare each run,
 * so you only need to drop in a fresh export and run.
 *
 * Usage:
 *   node agents/backlink-monitor/index.js                 # compare and report
 *   node agents/backlink-monitor/index.js --summary-only  # print summary, no full report
 *
 * Output: data/reports/backlink-monitor-report.md
 *
 * CSV columns expected (Ahrefs default export):
 *   Domain, Domain Rating, First seen, Last seen, Dofollow, Links to target
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, copyFileSync } from 'fs';
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

// ── CSV parsing ───────────────────────────────────────────────────────────────

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const raw = lines[0].split(',').map((h) => h.replace(/^"|"$/g, '').trim().toLowerCase());
  return lines.slice(1).map((line) => {
    const cols = [];
    let cur = '';
    let inQuote = false;
    for (const ch of line) {
      if (ch === '"') { inQuote = !inQuote; }
      else if (ch === ',' && !inQuote) { cols.push(cur); cur = ''; }
      else { cur += ch; }
    }
    cols.push(cur);
    const obj = {};
    raw.forEach((h, i) => { obj[h] = (cols[i] || '').replace(/^"|"$/g, '').trim(); });
    return obj;
  });
}

function normalizeDomain(row) {
  // Ahrefs uses "referring domain" or "domain" as the column name
  const domain = row['referring domain'] || row['domain'] || row['refdomains'] || '';
  const dr = parseFloat(row['domain rating'] || row['dr'] || '0') || 0;
  const dofollow = (row['dofollow'] || '').toLowerCase() === 'true' || (row['dofollow'] || '') === '1';
  const firstSeen = row['first seen'] || row['first_seen'] || '';
  return { domain: domain.toLowerCase(), dr, dofollow, firstSeen };
}

function loadCSV(filepath) {
  if (!existsSync(filepath)) return null;
  const rows = parseCSV(readFileSync(filepath, 'utf8'));
  return rows.map(normalizeDomain).filter((r) => r.domain);
}

async function fetchLiveBacklinks() {
  try {
    const domain = config.url.replace(/^https?:\/\//, '').replace(/\/$/, '');
    console.log(`  Fetching backlink data from DataForSEO for ${domain}...`);
    const summary = await getBacklinksSummary(domain);
    if (!summary) {
      console.log('  ⚠️ Backlinks API not available (requires subscription). Falling back to CSV.');
      return null;
    }
    console.log(`  DataForSEO: ${summary.referringDomains} referring domains, rank ${summary.rank}`);
    return summary;
  } catch (err) {
    console.log(`  ⚠️ DataForSEO backlinks fetch failed: ${err.message}. Falling back to CSV.`);
    return null;
  }
}

// ── snapshot management ───────────────────────────────────────────────────────

function getLatestSnapshot() {
  if (!existsSync(SNAPSHOTS_DIR)) return null;
  const files = readdirSync(SNAPSHOTS_DIR)
    .filter((f) => f.endsWith('.csv'))
    .sort()
    .reverse();
  return files.length > 0 ? join(SNAPSHOTS_DIR, files[0]) : null;
}

function saveSnapshot(sourcePath) {
  mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const dest = join(SNAPSHOTS_DIR, `${date}.csv`);
  copyFileSync(sourcePath, dest);
  return dest;
}

// ── diff ──────────────────────────────────────────────────────────────────────

function diffDomains(prev, curr) {
  const prevSet = new Map(prev.map((r) => [r.domain, r]));
  const currSet = new Map(curr.map((r) => [r.domain, r]));

  const gained = curr.filter((r) => !prevSet.has(r.domain));
  const lost = prev.filter((r) => !currSet.has(r.domain));
  const retained = curr.filter((r) => prevSet.has(r.domain));

  return { gained, lost, retained };
}

// ── report ────────────────────────────────────────────────────────────────────

function buildReport(curr, diff, snapshotDate) {
  const now = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const lines = [];

  lines.push(`# Backlink Monitor Report — ${config.name}`);
  lines.push(`**Run date:** ${now}`);
  lines.push(`**Compared to:** ${snapshotDate || 'N/A (first run)'}`);
  lines.push(`**Total referring domains:** ${curr.length}`);
  lines.push('');

  if (diff) {
    const gainedDR = diff.gained.filter((r) => r.dr >= 20);
    const lostDR = diff.lost.filter((r) => r.dr >= 20);

    lines.push('## Summary');
    lines.push(`| | Count | DR 20+ |`);
    lines.push(`|---|---|---|`);
    lines.push(`| ✅ Gained | ${diff.gained.length} | ${gainedDR.length} |`);
    lines.push(`| ❌ Lost   | ${diff.lost.length}   | ${lostDR.length}   |`);
    lines.push(`| Retained  | ${diff.retained.length} | — |`);
    lines.push('');

    if (diff.gained.length > 0) {
      lines.push('## New Referring Domains');
      lines.push('| Domain | DR | Dofollow | First Seen |');
      lines.push('|---|---|---|---|');
      diff.gained
        .sort((a, b) => b.dr - a.dr)
        .slice(0, 50)
        .forEach((r) => {
          lines.push(`| ${r.domain} | ${r.dr} | ${r.dofollow ? 'Yes' : 'No'} | ${r.firstSeen} |`);
        });
      if (diff.gained.length > 50) lines.push(`*…and ${diff.gained.length - 50} more*`);
      lines.push('');
    }

    if (diff.lost.length > 0) {
      lines.push('## Lost Referring Domains');
      lines.push('| Domain | DR | Dofollow |');
      lines.push('|---|---|---|');
      diff.lost
        .sort((a, b) => b.dr - a.dr)
        .slice(0, 50)
        .forEach((r) => {
          lines.push(`| ${r.domain} | ${r.dr} | ${r.dofollow ? 'Yes' : 'No'} |`);
        });
      if (diff.lost.length > 50) lines.push(`*…and ${diff.lost.length - 50} more*`);
      lines.push('');
    }
  } else {
    lines.push('## All Referring Domains (first run — no previous snapshot to compare)');
    lines.push('| Domain | DR | Dofollow |');
    lines.push('|---|---|---|');
    curr
      .sort((a, b) => b.dr - a.dr)
      .slice(0, 100)
      .forEach((r) => {
        lines.push(`| ${r.domain} | ${r.dr} | ${r.dofollow ? 'Yes' : 'No'} |`);
      });
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('## How to Update');
  lines.push('Run: `node agents/backlink-monitor/index.js`');
  lines.push('The agent fetches data from DataForSEO automatically. CSV import is used as fallback if the API is unavailable.');

  return lines.join('\n');
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nBacklink Monitor — ${config.name}\n`);

  mkdirSync(BACKLINKS_DIR, { recursive: true });
  mkdirSync(REPORTS_DIR, { recursive: true });

  // Try DataForSEO API first
  const liveSummary = await fetchLiveBacklinks();
  if (liveSummary) {
    // Save summary as JSON snapshot for future comparison
    mkdirSync(SNAPSHOTS_DIR, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const snapshotPath = join(SNAPSHOTS_DIR, `${today}.json`);

    // Load previous JSON snapshot for diff
    const prevFiles = existsSync(SNAPSHOTS_DIR) ? readdirSync(SNAPSHOTS_DIR).filter(f => f.endsWith('.json')).sort().reverse() : [];
    const prevPath = prevFiles.find(f => f !== `${today}.json`);
    let prevSummary = null;
    if (prevPath) {
      try { prevSummary = JSON.parse(readFileSync(join(SNAPSHOTS_DIR, prevPath), 'utf8')); } catch {}
    }

    writeFileSync(snapshotPath, JSON.stringify({ ...liveSummary, date: today }, null, 2));
    console.log(`  Snapshot saved: ${snapshotPath}`);

    // Build simple report
    mkdirSync(REPORTS_DIR, { recursive: true });
    const lines = [
      `# Backlink Monitor Report — ${config.name}`,
      `**Run date:** ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`,
      `**Data source:** DataForSEO Backlinks API`,
      '',
      '## Domain Summary',
      `| Metric | Value |`,
      `|---|---|`,
      `| Domain Rank | ${liveSummary.rank} |`,
      `| Total Backlinks | ${liveSummary.backlinks.toLocaleString()} |`,
      `| Referring Domains | ${liveSummary.referringDomains.toLocaleString()} |`,
      `| Dofollow | ${liveSummary.dofollow.toLocaleString()} |`,
      `| Nofollow | ${liveSummary.nofollow.toLocaleString()} |`,
      `| Broken Backlinks | ${liveSummary.brokenBacklinks.toLocaleString()} |`,
      `| Referring IPs | ${liveSummary.referringIps.toLocaleString()} |`,
    ];

    if (prevSummary) {
      const delta = (curr, prev, label) => {
        const d = curr - prev;
        return d === 0 ? '' : ` (${d > 0 ? '+' : ''}${d})`;
      };
      lines.push('');
      lines.push(`## Changes since ${prevSummary.date}`);
      lines.push(`| Metric | Previous | Current | Change |`);
      lines.push(`|---|---|---|---|`);
      lines.push(`| Referring Domains | ${prevSummary.referringDomains} | ${liveSummary.referringDomains} | ${liveSummary.referringDomains - prevSummary.referringDomains} |`);
      lines.push(`| Total Backlinks | ${prevSummary.backlinks} | ${liveSummary.backlinks} | ${liveSummary.backlinks - prevSummary.backlinks} |`);
      lines.push(`| Domain Rank | ${prevSummary.rank} | ${liveSummary.rank} | ${liveSummary.rank - prevSummary.rank} |`);
    }

    lines.push('');
    const reportPath = join(REPORTS_DIR, 'backlink-monitor-report.md');
    writeFileSync(reportPath, lines.join('\n'));
    console.log(`  Report saved: ${reportPath}`);
    return;
  }

  const inputPath = join(BACKLINKS_DIR, 'referring-domains.csv');

  if (!existsSync(inputPath)) {
    console.log('  No CSV found at data/backlinks/referring-domains.csv');
    console.log('');
    console.log('  To use this agent:');
    console.log('  1. Go to Ahrefs → Site Explorer → your domain → Referring Domains');
    console.log('  2. Export as CSV → save to data/backlinks/referring-domains.csv');
    console.log('  3. Run: node agents/backlink-monitor/index.js');
    process.exit(0);
  }

  // Load current export
  const curr = loadCSV(inputPath);
  if (!curr || curr.length === 0) {
    console.error('  CSV is empty or unreadable. Check the file format.');
    process.exit(1);
  }
  console.log(`  Current export: ${curr.length} referring domains`);

  // Load previous snapshot for comparison
  const prevSnapshotPath = getLatestSnapshot();
  let prev = null;
  let snapshotDate = null;
  if (prevSnapshotPath) {
    prev = loadCSV(prevSnapshotPath);
    snapshotDate = prevSnapshotPath.split('/').pop().replace('.csv', '');
    console.log(`  Previous snapshot: ${snapshotDate} (${prev.length} domains)`);
  } else {
    console.log('  No previous snapshot found — this will be the baseline.');
  }

  // Diff
  const diff = prev ? diffDomains(prev, curr) : null;

  if (diff) {
    console.log(`\n  Changes since ${snapshotDate}:`);
    console.log(`    ✅ Gained: ${diff.gained.length} domains (DR 20+: ${diff.gained.filter((r) => r.dr >= 20).length})`);
    console.log(`    ❌ Lost:   ${diff.lost.length} domains (DR 20+: ${diff.lost.filter((r) => r.dr >= 20).length})`);
  }

  // Save current as new snapshot
  const newSnapshotPath = saveSnapshot(inputPath);
  console.log(`\n  Snapshot saved: ${newSnapshotPath}`);

  if (summaryOnly) {
    process.exit(0);
  }

  // Write report
  const report = buildReport(curr, diff, snapshotDate);
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
