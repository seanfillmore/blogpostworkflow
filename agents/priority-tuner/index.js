#!/usr/bin/env node
/**
 * Priority Tuner (closed-loop weight tuner)
 *
 * Monthly. Joins the prioritizer's attribution ledger (signal→post) against
 * seo-impact action_wins (post→revenue) to measure which signal types actually drive
 * revenue, then applies BOUNDED nudges to the per-signal weight knobs in
 * config/pipeline-priority.json. Auto-applied (each step clamped + ≤maxStepPct, every
 * change logged to tuning-history.jsonl for manual revert). No-ops until enough
 * measured outcomes accrue (~6-8 weeks after Phase 1 goes live).
 *
 * The decision logic lives in lib/priority-tuning.js (pure, unit-tested).
 *
 * Usage:
 *   node agents/priority-tuner/index.js            # apply
 *   node agents/priority-tuner/index.js --dry-run  # print, write nothing
 *
 * See docs/superpowers/specs/2026-06-14-pipeline-prioritizer-phase2-design.md
 */

import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAttribution } from '../../lib/attribution-log.js';
import { aggregatePerformance, proposeWeightChanges, applyWeightChanges } from '../../lib/priority-tuning.js';
import { newestReportDate } from '../../lib/snapshot-health.js';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const CONFIG_PATH = join(ROOT, 'config', 'pipeline-priority.json');
const ATTRIBUTION_PATH = join(ROOT, 'data', 'reports', 'pipeline-prioritizer', 'attribution.jsonl');
const SEO_IMPACT_PATH = join(ROOT, 'data', 'reports', 'seo-impact', 'latest.json');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'priority-tuner');
const HISTORY_PATH = join(REPORTS_DIR, 'tuning-history.jsonl');
const DRY_RUN = process.argv.includes('--dry-run');

const ymd = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
function readJson(p) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } }

async function main() {
  console.log('\nPriority Tuner' + (DRY_RUN ? ' (dry-run)' : '') + '\n');
  const today = ymd(Date.now());
  const cfg = readJson(CONFIG_PATH);
  if (!cfg?.tuning) { console.error('No tuning config; aborting.'); process.exit(1); }

  // seo-impact freshness — don't tune on stale outcome data (allow 35d: monthly cadence)
  const impactDate = newestReportDate(SEO_IMPACT_PATH);
  const impactAge = impactDate ? Math.floor((Date.parse(today) - Date.parse(impactDate)) / 86400000) : Infinity;
  if (impactAge > 35) {
    console.log(`  seo-impact stale (${impactDate || 'missing'}); skipping tune.`);
    writeReport({ today, status: 'skipped', reason: `seo-impact stale (${impactDate || 'missing'})`, perf: {}, changes: [] });
    return;
  }

  const ledger = readAttribution(ATTRIBUTION_PATH);
  const actionWins = (readJson(SEO_IMPACT_PATH)?.action_wins) || [];
  const perf = aggregatePerformance(ledger, actionWins, { today, measureLagDays: cfg.tuning.measureLagDays });
  const changes = proposeWeightChanges(perf, cfg);

  console.log(`  Ledger records: ${ledger.length} | signal types measured: ${Object.keys(perf).length}`);
  for (const [t, p] of Object.entries(perf)) console.log(`    ${t}: measured ${p.measured}, wins ${p.wins}, $${p.revenue}, score ${p.score}`);
  console.log(`  Proposed changes: ${changes.length}`);
  for (const c of changes) console.log(`    ${c.param}: ${c.from} → ${c.to} (${c.reason})`);

  if (DRY_RUN) { console.log('\nDry-run: no changes written.'); return; }

  if (!changes.length) {
    writeReport({ today, status: 'no-op', reason: 'insufficient data or no qualifying signals', perf, changes: [] });
    console.log('\n  No-op (insufficient data). Report written, config unchanged.');
    return;
  }

  const newCfg = applyWeightChanges(cfg, changes);
  writeFileSync(CONFIG_PATH, JSON.stringify(newCfg, null, 2) + '\n');

  mkdirSync(REPORTS_DIR, { recursive: true });
  appendFileSync(HISTORY_PATH, JSON.stringify({ ts: new Date().toISOString(), date: today, changes }) + '\n');
  writeReport({ today, status: 'applied', reason: '', perf, changes });

  await notify({
    subject: `Priority tuner: adjusted ${changes.length} signal weight(s)`,
    body: changes.map((c) => `- ${c.param}: ${c.from} → ${c.to} (${c.reason})`).join('\n'),
    status: 'info', category: 'content',
  }).catch(() => {});
  console.log(`\n  Applied ${changes.length} change(s). config + history updated.`);
}

function writeReport({ today, status, reason, perf, changes }) {
  mkdirSync(REPORTS_DIR, { recursive: true });
  const payload = { generated_at: new Date().toISOString(), status, reason, performance: perf, changes };
  writeFileSync(join(REPORTS_DIR, 'latest.json'), JSON.stringify(payload, null, 2));
  const L = ['# Priority Tuner Report', '', `**Status:** ${status}${reason ? ` — ${reason}` : ''}`, ''];
  if (Object.keys(perf).length) {
    L.push('## Per-signal performance (measured posts)', '');
    for (const [t, p] of Object.entries(perf)) L.push(`- **${t}**: measured ${p.measured}, wins ${p.wins}, $${p.revenue}, score ${p.score}`);
    L.push('');
  }
  if (changes.length) { L.push('## Weight changes', ''); for (const c of changes) L.push(`- \`${c.param}\`: ${c.from} → ${c.to} (${c.reason})`); }
  writeFileSync(join(REPORTS_DIR, `${today}.md`), L.join('\n'));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => { console.error('Priority tuner failed:', err); process.exit(1); });
}
