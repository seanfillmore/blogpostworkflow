/**
 * PageSpeed Monitor Agent
 *
 * Measures mobile + desktop PageSpeed (Lighthouse, via the PSI API) for the
 * commercial pages listed in config/pagespeed.json, snapshots the results, and
 * flags score regressions/improvements vs. the previous snapshot.
 *
 * Writes:
 *   data/snapshots/pagespeed/YYYY-MM-DD.json   (full daily snapshot)
 *   data/reports/pagespeed/latest.json         (snapshot + diff, for the dashboard)
 *   data/reports/pagespeed/YYYY-MM-DD.md        (human-readable summary)
 *
 * Notifies via the daily digest (regressions bump status to error so they surface).
 *
 * Usage:
 *   node agents/pagespeed-monitor/index.js
 *   node agents/pagespeed-monitor/index.js --date 2026-07-24   # label backfill
 *   node agents/pagespeed-monitor/index.js --url https://www.realskincare.com/   # ad-hoc single page
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  fetchPageSpeed, parsePsiResult, buildSnapshot, diffSnapshots, summarizeMarkdown, PSI_API_KEY,
} from '../../lib/pagespeed.js';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SNAPSHOTS_DIR = join(ROOT, 'data', 'snapshots', 'pagespeed');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'pagespeed');
const CONFIG_PATH = join(ROOT, 'config', 'pagespeed.json');

const arg = name => {
  const i = process.argv.indexOf(`--${name}`);
  const inline = process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1];
  return inline ?? (i !== -1 ? process.argv[i + 1] : undefined);
};

const date = arg('date') || new Date().toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error('Invalid date format. Expected YYYY-MM-DD.');
  process.exit(1);
}

function loadConfig() {
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  const urlOverride = arg('url');
  const pages = urlOverride ? [{ label: urlOverride, url: urlOverride }] : cfg.pages;
  return {
    strategies: cfg.strategies?.length ? cfg.strategies : ['mobile', 'desktop'],
    deadBand: cfg.deadBand ?? 3,
    pages: pages.filter(p => p?.url),
  };
}

function findPreviousSnapshot() {
  if (!existsSync(SNAPSHOTS_DIR)) return null;
  const prior = readdirSync(SNAPSHOTS_DIR)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f < `${date}.json`)
    .sort();
  const latest = prior[prior.length - 1];
  if (!latest) return null;
  try { return JSON.parse(readFileSync(join(SNAPSHOTS_DIR, latest), 'utf8')); }
  catch { return null; }
}

async function main() {
  console.log('PageSpeed Monitor\n');
  if (!PSI_API_KEY) {
    throw new Error('PAGESPEEDINSIGHTS_API_KEY missing from .env — cannot query the PSI API.');
  }
  const { strategies, deadBand, pages } = loadConfig();
  console.log(`  Date: ${date}`);
  console.log(`  Pages: ${pages.length} × strategies: ${strategies.join(', ')}\n`);

  const records = [];
  const failures = [];
  for (const page of pages) {
    for (const strategy of strategies) {
      process.stdout.write(`  ${strategy.padEnd(7)} ${page.url} ... `);
      try {
        const raw = await fetchPageSpeed(page.url, strategy);
        const rec = parsePsiResult(raw, { url: page.url, strategy });
        rec.label = page.label;
        records.push(rec);
        console.log(`score ${rec.score}`);
      } catch (err) {
        failures.push({ url: page.url, strategy, error: err.message });
        console.log(`FAILED (${err.message})`);
      }
    }
  }

  if (!records.length) throw new Error(`All PSI requests failed (${failures.length} failures).`);

  const snapshot = buildSnapshot(records, date, { generatedAt: date });
  const previous = findPreviousSnapshot();
  const diff = diffSnapshots(snapshot, previous, { deadBand });

  mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  mkdirSync(REPORTS_DIR, { recursive: true });
  const snapPath = join(SNAPSHOTS_DIR, `${date}.json`);
  writeFileSync(snapPath, JSON.stringify(snapshot, null, 2));
  writeFileSync(join(REPORTS_DIR, 'latest.json'), JSON.stringify({ snapshot, diff, failures }, null, 2));
  const md = summarizeMarkdown(snapshot, diff);
  writeFileSync(join(REPORTS_DIR, `${date}.md`), md);

  console.log(`\n  Snapshot saved: ${snapPath}`);
  console.log(`  Regressions: ${diff.regressions.length} | Improvements: ${diff.improvements.length} | New: ${diff.newPages.length}`);

  return { snapshot, diff, failures };
}

main()
  .then(async ({ snapshot, diff, failures }) => {
    const worst = Math.min(...snapshot.pages.map(p => p.score));
    const status = diff.regressions.length ? 'error' : 'success';
    const parts = [
      `Measured ${snapshot.pages.length} page/strategy results (worst score ${worst}).`,
      diff.regressions.length ? `\n🔴 Regressions:\n${diff.regressions.map(r => `- ${r.url} (${r.strategy}): ${r.from}→${r.to}`).join('\n')}` : '',
      diff.improvements.length ? `\n🟢 Improvements:\n${diff.improvements.map(i => `- ${i.url} (${i.strategy}): ${i.from}→${i.to}`).join('\n')}` : '',
      failures.length ? `\n⚠️ ${failures.length} fetch failure(s).` : '',
    ].filter(Boolean);
    await notify({
      subject: `PageSpeed Monitor: worst score ${worst}${diff.regressions.length ? ` (${diff.regressions.length} regressions)` : ''}`,
      body: parts.join('\n'),
      status,
      category: 'collector',
    }).catch(() => {});
  })
  .catch(async err => {
    await notify({ subject: 'PageSpeed Monitor failed', body: err.message || String(err), status: 'error' }).catch(() => {});
    console.error('Error:', err.message);
    process.exit(1);
  });
