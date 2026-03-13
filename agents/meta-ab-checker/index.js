/**
 * Meta A/B Test Checker Agent
 *
 * Reads the baseline saved by meta-optimizer (data/reports/meta-ab-tracker.json)
 * and fetches current GSC CTR for each tested page to measure whether the new
 * title/meta description improved click-through rate.
 *
 * Only evaluates entries that are at least 28 days old (one full GSC cycle).
 * Entries showing improvement are archived; entries that didn't improve are
 * flagged for another optimization pass.
 *
 * Usage:
 *   node agents/meta-ab-checker/index.js                # check all entries ≥28 days old
 *   node agents/meta-ab-checker/index.js --min-days 14  # check entries ≥14 days old
 *   node agents/meta-ab-checker/index.js --all          # check all entries regardless of age
 *
 * Output: data/reports/meta-ab-report.md
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as gsc from '../../lib/gsc.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'meta-ab');

const config = JSON.parse(readFileSync(join(ROOT, 'config', 'site.json'), 'utf8'));

// ── args ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(flag) {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : null;
}

const minDays = parseInt(getArg('--min-days') ?? '28', 10);
const checkAll = args.includes('--all');

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nMeta A/B Checker — ${config.name}`);
  console.log(`Minimum test age: ${checkAll ? 'all entries' : `${minDays} days`}\n`);

  const trackerPath = join(REPORTS_DIR, 'meta-ab-tracker.json');

  if (!existsSync(trackerPath)) {
    console.log('  No A/B tracker found. Run meta-optimizer with --apply first.');
    console.log('  Expected: data/reports/meta-ab-tracker.json');
    process.exit(0);
  }

  let tracker = [];
  try {
    tracker = JSON.parse(readFileSync(trackerPath, 'utf8'));
  } catch (e) {
    console.error(`  Failed to read tracker: ${e.message}`);
    process.exit(1);
  }

  if (tracker.length === 0) {
    console.log('  Tracker is empty. Run meta-optimizer with --apply first.');
    process.exit(0);
  }

  const today = new Date();
  const due = tracker.filter((entry) => {
    if (checkAll) return true;
    const tested = new Date(entry.testedAt);
    const ageInDays = (today - tested) / 86400000;
    return ageInDays >= minDays;
  });

  console.log(`  Tracker entries: ${tracker.length} total, ${due.length} ready to evaluate`);

  if (due.length === 0) {
    console.log(`  No entries are ${minDays}+ days old yet. Check back later.`);
    process.exit(0);
  }

  console.log('');

  const results = [];

  for (const entry of due) {
    process.stdout.write(`  Checking "${entry.keyword}" (${entry.testedAt})... `);

    try {
      // Fetch current GSC performance for the page (last 28 days = post-test window)
      const perf = await gsc.getPagePerformance(entry.pageUrl, 28);

      const currentCtr = perf.ctr ?? 0;
      const currentImpressions = perf.impressions ?? 0;
      const currentPosition = perf.position ?? entry.baselinePosition;

      const ctrDelta = currentCtr - entry.baselineCtr;
      const ctrDeltaPct = entry.baselineCtr > 0
        ? ((ctrDelta / entry.baselineCtr) * 100).toFixed(1)
        : 'N/A';

      const improved = ctrDelta > 0;
      const flag = improved ? '✅' : (ctrDelta < -0.005 ? '⚠️ Regressed' : '→ Flat');

      console.log(`${improved ? '✅ +' : (ctrDelta >= 0 ? '→ +' : '❌ ')}${(ctrDelta * 100).toFixed(2)}% CTR`);

      results.push({
        ...entry,
        currentCtr,
        currentImpressions,
        currentPosition,
        ctrDelta,
        ctrDeltaPct,
        improved,
        flag,
      });
    } catch (e) {
      console.error(`failed: ${e.message}`);
    }
  }

  if (results.length === 0) {
    console.log('  No results to report.');
    process.exit(0);
  }

  // ── Build report ────────────────────────────────────────────────────────────

  const improved = results.filter((r) => r.improved);
  const regressed = results.filter((r) => r.ctrDelta < -0.005);
  const flat = results.filter((r) => !r.improved && r.ctrDelta >= -0.005);

  const now = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const lines = [];

  lines.push(`# Meta A/B Test Results — ${config.name}`);
  lines.push(`**Run date:** ${now}`);
  lines.push(`**Test window:** ${minDays} days`);
  lines.push(`**Entries evaluated:** ${results.length}`);
  lines.push('');
  lines.push('## Summary');
  lines.push(`| Result | Count |`);
  lines.push(`|---|---|`);
  lines.push(`| ✅ Improved CTR | ${improved.length} |`);
  lines.push(`| → Flat (±0.5%) | ${flat.length} |`);
  lines.push(`| ⚠️ Regressed    | ${regressed.length} |`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const r of results.sort((a, b) => b.ctrDelta - a.ctrDelta)) {
    const sign = r.ctrDelta >= 0 ? '+' : '';
    lines.push(`## ${r.flag} — "${r.keyword}"`);
    lines.push(`**URL:** [${r.pageUrl}](${r.pageUrl})`);
    lines.push(`**Tested:** ${r.testedAt} (${Math.round((today - new Date(r.testedAt)) / 86400000)} days ago)`);
    lines.push('');
    lines.push(`| Metric | Before | After | Change |`);
    lines.push(`|---|---|---|---|`);
    lines.push(`| CTR | ${(r.baselineCtr * 100).toFixed(2)}% | ${(r.currentCtr * 100).toFixed(2)}% | **${sign}${(r.ctrDelta * 100).toFixed(2)}%** (${sign}${r.ctrDeltaPct}%) |`);
    lines.push(`| Impressions | ${r.baselineImpressions.toLocaleString()} | ${r.currentImpressions.toLocaleString()} | — |`);
    lines.push(`| Position | #${Math.round(r.baselinePosition)} | #${Math.round(r.currentPosition)} | — |`);
    lines.push('');
    lines.push(`| | Before | After |`);
    lines.push(`|---|---|---|`);
    lines.push(`| **Title** | ${r.originalTitle} | ${r.proposedTitle} |`);
    lines.push(`| **Meta** | ${r.originalMeta || '*(none)*'} | ${r.proposedMeta} |`);
    lines.push('');
    if (!r.improved) {
      lines.push(`> **Action:** Re-run meta-optimizer for this page to try a different variant.`);
      lines.push(`> \`node agents/meta-optimizer/index.js --apply\` (it will re-optimize low-CTR pages)`);
    }
    lines.push('---');
    lines.push('');
  }

  mkdirSync(REPORTS_DIR, { recursive: true });
  const reportPath = join(REPORTS_DIR, 'meta-ab-report.md');
  writeFileSync(reportPath, lines.join('\n'));

  console.log(`\n  Report: ${reportPath}`);
  console.log(`  ✅ Improved: ${improved.length}  → Flat: ${flat.length}  ⚠️ Regressed: ${regressed.length}`);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
