#!/usr/bin/env node
/**
 * Digest agent diff — did any agent stop reporting?
 *
 * A wrongly-guarded agent (lib/is-direct-run.js) becomes a silent no-op that
 * still exits 0, so cron records success and the 5 AM digest shows no error. The
 * only signal is a row that used to appear and no longer does. Run this after a
 * guard rollout, or any change to how agents are dispatched.
 *
 * Reads data/reports/daily-summary/<day>.jsonl — SERVER-AUTHORITATIVE, written by
 * cron. A local checkout has little or nothing here; run it on the server.
 *
 * Usage:
 *   node scripts/digest-agent-diff.mjs 2026-08-23 2026-08-21 2026-08-20 2026-08-19
 *   node scripts/digest-agent-diff.mjs --today          # today + the 3 prior days
 *
 * Exit code is always 0 — this is a report, not a gate. Some agents are weekly or
 * monthly, so a name in the MISSING list is a prompt to check scheduler.js and
 * crontab, not proof of a no-op.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentNameOf, diffAgentSets } from '../lib/digest-agent-diff.js';
import { isDirectRun } from '../lib/is-direct-run.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'data', 'reports', 'daily-summary');

function agentsIn(day) {
  const p = join(DIR, `${day}.jsonl`);
  if (!existsSync(p)) return null;
  const set = new Set();
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }  // a malformed line is not a missing agent
    const name = agentNameOf(rec);
    if (name) set.add(name);
  }
  return set;
}

function ymd(d) { return d.toISOString().slice(0, 10); }

function resolveDays(argv) {
  if (argv[0] === '--today') {
    const now = new Date();
    const day = (n) => ymd(new Date(now.getTime() - n * 86400000));
    return { today: day(0), baselines: [day(1), day(2), day(3)] };
  }
  return { today: argv[0], baselines: argv.slice(1) };
}

function main() {
  const { today, baselines } = resolveDays(process.argv.slice(2));
  if (!today || !baselines.length) {
    console.error('usage: node scripts/digest-agent-diff.mjs <today> <baseline-day...>   (or --today)');
    process.exit(1);
  }

  const todaySet = agentsIn(today);
  if (!todaySet) {
    console.log(`NO DIGEST FILE for ${today} — the scheduler has not run yet, or did not run at all.`);
    return;
  }

  const sets = [];
  const used = [];
  for (const b of baselines) {
    const s = agentsIn(b);
    if (!s) continue;
    sets.push(s);
    used.push(`${b}(${s.size})`);
  }
  if (!sets.length) {
    console.log(`No baseline digest files found among: ${baselines.join(', ')} — cannot compare.`);
    return;
  }

  const { missing, added, baselineSize } = diffAgentSets(todaySet, sets);

  console.log(`today ${today}: ${todaySet.size} reporting agents`);
  console.log(`baseline: ${used.join(', ')} -> ${baselineSize} distinct agents\n`);

  if (missing.length === 0) {
    console.log('PASS — every agent that reported on a baseline day also reported today.');
  } else {
    console.log(`ATTENTION — ${missing.length} agent(s) reported on a baseline day but NOT today:`);
    for (const a of missing) console.log(`   ${a}`);
    console.log('\nSome agents are weekly or monthly, and some are hand-run, so absence is not');
    console.log('automatically a silent no-op. Cross-check each name against scheduler.js and');
    console.log('crontab before concluding anything.');
  }
  if (added.length) console.log(`\n(new today, informational: ${added.join(', ')})`);
}

// Guarded: importing this module must not run the report. See lib/is-direct-run.js.
if (isDirectRun(import.meta.url)) {
  main();
}
