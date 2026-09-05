// tests/scripts/scheduler-heartbeat.test.js
//
// THE DETECTOR FOR "DID THE DAILY PIPELINE ACTUALLY FINISH?".
//
// A wedged `scheduler.js` is invisible to the 5 AM digest BY CONSTRUCTION: the
// digest reports what agents `notify()`, and a process that never exits never
// notifies. That is why the 2026-09-01 hang ran for four days and was found
// from a Cloudflare 502 rather than from any report this fleet produces.
//
// The classifier is pure — no clock, no filesystem, no `ps` — so every state
// below is a case constructed here rather than a claim in a comment.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classifySchedulerHealth,
  parseSchedulerMarkers,
  parseElapsedSeconds,
  isSchedulerProcess,
  isFleetBrowser,
  MAX_RUN_MINUTES,
  NO_RUN_HOURS,
} from '../../scripts/check-scheduler-heartbeat.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOUR = 3600_000;
const NOW = Date.parse('2026-09-05T12:50:00.000Z');

/** A healthy baseline: yesterday's 15:00 run started and completed. */
const healthy = (over = {}) => ({
  now: NOW,
  lastStart: Date.parse('2026-09-04T15:00:00.000Z'),
  lastDone: Date.parse('2026-09-04T15:40:00.000Z'),
  lastStepLine: null,
  schedulerProcs: [],
  browserProcs: [],
  processInfo: true,
  ...over,
});

test('healthy: a run that started and completed is routine', () => {
  const v = classifySchedulerHealth(healthy());
  assert.equal(v.code, 0);
  assert.equal(v.state, 'healthy');
  assert.equal(v.status, 'success');
  assert.equal(v.needsHuman, false);
});

test('THE 2026-09-01 INCIDENT: a scheduler alive for 4 days is STUCK and names where it wedged', () => {
  // Exactly the production shape: started Sep 1 15:00, never completed, process
  // still alive on Sep 5, last log line naming the agent it was inside.
  const v = classifySchedulerHealth(healthy({
    lastStart: Date.parse('2026-09-01T15:00:02.389Z'),
    lastDone: Date.parse('2026-08-31T15:38:00.000Z'), // the PREVIOUS day's completion
    lastStepLine: '"/usr/bin/node" agents/theme-seo-auditor/index.js',
    schedulerProcs: [{ pid: 279142, ageSec: 4 * 24 * 3600 }],
    browserProcs: [{ pid: 283490, ageSec: 4 * 24 * 3600 }],
  }));

  assert.equal(v.code, 2);
  assert.equal(v.state, 'stuck');
  assert.equal(v.status, 'error');
  assert.equal(v.needsHuman, true);
  assert.match(v.headline, /pid 279142/);
  // The whole point of carrying lastStepLine: it points straight at the agent.
  assert.match(v.headline, /theme-seo-auditor/);
});

test('DAYS 2-5 OF THE INCIDENT: a later healthy run does not hide a still-wedged old one', () => {
  // This is the case that makes the `ps` check load-bearing rather than a
  // nice-to-have, and it is the shape production was actually in on the
  // mornings of Sep 2, 3, 4 and 5.
  //
  // The Sep 1 run hung, but the Sep 2/3/4/5 runs each started at 15:00 and
  // completed normally — so LOG EVIDENCE ALONE reads perfectly healthy: the
  // most recent start has a matching "Scheduler done." after it. Meanwhile the
  // Sep 1 process was still alive the whole time, holding ~334 MB and OOM-ing
  // the dashboard. A log-only detector would have gone silent after one day and
  // missed four of the five.
  const v = classifySchedulerHealth(healthy({
    lastStart: Date.parse('2026-09-04T15:00:00.000Z'),   // yesterday's run
    lastDone: Date.parse('2026-09-04T15:38:00.000Z'),    // ...which completed fine
    schedulerProcs: [{ pid: 279142, ageSec: 4 * 24 * 3600 }], // the Sep 1 zombie
  }));
  assert.equal(v.state, 'stuck', 'a healthy latest run must not mask an older process that never died');
  assert.equal(v.status, 'error');
  assert.match(v.headline, /pid 279142/);
});

test('a stale completion from a PREVIOUS run cannot mark the current run complete', () => {
  // The subtle bug this guards: `lastDone` is the last completion anywhere in
  // the log. If a run starts and hangs, the previous day's "Scheduler done."
  // is still the most recent completion — and reading that as "completed"
  // would have made this detector silent on the exact incident it exists for.
  const v = classifySchedulerHealth(healthy({
    lastStart: Date.parse('2026-09-04T15:00:00.000Z'),
    lastDone: Date.parse('2026-09-03T15:38:00.000Z'), // BEFORE the last start
    schedulerProcs: [],
  }));
  assert.notEqual(v.code, 0, 'a completion older than the last start must not count as completing it');
  assert.equal(v.state, 'died');
});

test('died: started, never completed, nothing alive → needs a human', () => {
  const v = classifySchedulerHealth(healthy({ lastDone: null, schedulerProcs: [] }));
  assert.equal(v.code, 3);
  assert.equal(v.state, 'died');
  assert.equal(v.status, 'error');
  // On this box an unexplained disappearance is nearly always the OOM killer.
  assert.match(v.headline, /oom-kill|OOM/i);
});

test('in-progress within budget is routine, not a failure row', () => {
  const v = classifySchedulerHealth(healthy({
    lastDone: null,
    schedulerProcs: [{ pid: 999, ageSec: 20 * 60 }],
  }));
  assert.equal(v.code, 1);
  assert.equal(v.status, 'success');
  assert.equal(v.needsHuman, false);
});

test('the in-progress/stuck boundary is MAX_RUN_MINUTES', () => {
  const under = classifySchedulerHealth(healthy({
    lastDone: null,
    schedulerProcs: [{ pid: 1, ageSec: MAX_RUN_MINUTES * 60 - 1 }],
  }));
  const over = classifySchedulerHealth(healthy({
    lastDone: null,
    schedulerProcs: [{ pid: 1, ageSec: MAX_RUN_MINUTES * 60 + 1 }],
  }));
  assert.equal(under.state, 'in-progress');
  assert.equal(over.state, 'stuck');
});

test('MAX_RUN_MINUTES clears the longest run ever observed to complete', () => {
  // Measured over the 41 completed runs since 2026-07-26: median 38.7 min,
  // p90 150.1 min, longest 365.7 min. A ceiling at or under that would call a
  // normal heavy publishing day "stuck" and train the reader to ignore the row.
  const LONGEST_COMPLETED_RUN_MIN = 365.7;
  assert.ok(
    MAX_RUN_MINUTES > LONGEST_COMPLETED_RUN_MIN,
    `MAX_RUN_MINUTES ${MAX_RUN_MINUTES} is at or below the longest run observed to complete normally `
      + `(${LONGEST_COMPLETED_RUN_MIN} min). Re-measure from scheduler.log before lowering it.`,
  );
});

test('no-run: nothing at all in the log', () => {
  const v = classifySchedulerHealth(healthy({ lastStart: null, lastDone: null }));
  assert.equal(v.code, 4);
  assert.equal(v.state, 'no-run');
  assert.match(v.headline, /df -h|crontab/);
});

test('no-run: last completed run is older than NO_RUN_HOURS', () => {
  const start = NOW - (NO_RUN_HOURS + 2) * HOUR;
  const v = classifySchedulerHealth(healthy({ lastStart: start, lastDone: start + HOUR }));
  assert.equal(v.code, 4);
  assert.equal(v.state, 'no-run');
});

test('NO_RUN_HOURS leaves headroom for the real 15:00→12:50 gap', () => {
  // The job runs at 15:00 UTC and this detector at 12:50 UTC, so on a perfectly
  // healthy box the last start is ALWAYS ~21.83h old. A ceiling at or under
  // that would fire every single morning.
  assert.ok(NO_RUN_HOURS > 21.84, `NO_RUN_HOURS ${NO_RUN_HOURS} would fire on every healthy run`);
});

test('a stuck run outranks "no recent run" — precedence sends the human to the right place', () => {
  // A run wedged three days ago satisfies BOTH conditions. Reporting it as
  // "cron has stopped" would send somebody to check crontab when the real
  // problem is a live process holding memory.
  const v = classifySchedulerHealth(healthy({
    lastStart: NOW - 96 * HOUR,
    lastDone: null,
    schedulerProcs: [{ pid: 42, ageSec: 96 * 3600 }],
  }));
  assert.equal(v.state, 'stuck');
});

test('orphaned browser is reported even when the pipeline itself is fine', () => {
  const v = classifySchedulerHealth(healthy({
    browserProcs: [{ pid: 283490, ageSec: 30 * 3600 }],
  }));
  assert.equal(v.code, 5);
  assert.equal(v.state, 'orphaned-browser');
  assert.equal(v.status, 'error');
});

test('a browser younger than the ceiling is not an orphan', () => {
  // competitor-intelligence legitimately runs Chrome weekly; a short-lived one
  // must never produce a failure row.
  const v = classifySchedulerHealth(healthy({
    browserProcs: [{ pid: 1, ageSec: 5 * 60 }],
  }));
  assert.equal(v.code, 0);
});

test('an unreadable process table degrades to log evidence and says so', () => {
  const v = classifySchedulerHealth(healthy({ processInfo: false }));
  assert.equal(v.code, 0, 'must still reach a verdict from the log alone');
  assert.ok(
    v.detail.some((d) => /process table could not be read/i.test(d)),
    'a verdict reached without process evidence must say so rather than implying it checked',
  );
});

// ── marker parsing ───────────────────────────────────────────────────────────

test('parseSchedulerMarkers finds the last start, completion and step line', () => {
  const log = [
    '[2026-09-04T15:00:01.000Z] Content Scheduler starting',
    '[2026-09-04T15:20:00.000Z]   "/usr/bin/node" agents/seo-impact/index.js',
    '[2026-09-04T15:40:00.000Z] Scheduler done.',
    '[2026-09-05T15:00:02.000Z] Content Scheduler starting',
    '[2026-09-05T15:33:26.000Z]     "/usr/bin/node" agents/theme-seo-auditor/index.js',
  ].join('\n');
  const m = parseSchedulerMarkers(log);
  assert.equal(m.lastStart, Date.parse('2026-09-05T15:00:02.000Z'));
  assert.equal(m.lastDone, Date.parse('2026-09-04T15:40:00.000Z'));
  assert.match(m.lastStepLine, /theme-seo-auditor/);
});

test('a new start resets the remembered step line', () => {
  // Otherwise a stuck run would be reported as wedged inside whatever the
  // PREVIOUS run happened to log last.
  const log = [
    '[2026-09-04T15:00:01.000Z] Content Scheduler starting',
    '[2026-09-04T15:20:00.000Z]   agents/legacy-rebuilder/index.js',
    '[2026-09-04T15:40:00.000Z] Scheduler done.',
    '[2026-09-05T15:00:02.000Z] Content Scheduler starting',
  ].join('\n');
  assert.equal(parseSchedulerMarkers(log).lastStepLine, null);
});

test('parseSchedulerMarkers tolerates an empty or absent log', () => {
  for (const input of [null, '', 'no timestamps here']) {
    const m = parseSchedulerMarkers(input);
    assert.equal(m.lastStart, null);
    assert.equal(m.lastDone, null);
  }
});

// ── process matching ─────────────────────────────────────────────────────────

test('parseElapsedSeconds handles Linux etimes and macOS etime', () => {
  assert.equal(parseElapsedSeconds('345600'), 345600);   // Linux: plain seconds
  assert.equal(parseElapsedSeconds('4-00:00:00'), 345600); // macOS: 4 days
  assert.equal(parseElapsedSeconds('01:30'), 90);
  assert.equal(parseElapsedSeconds('10:00:00'), 36000);
  assert.equal(parseElapsedSeconds('garbage'), null);
});

test('isSchedulerProcess matches the real invocations and not this detector', () => {
  assert.ok(isSchedulerProcess('/usr/bin/node scheduler.js'));
  assert.ok(isSchedulerProcess('node /root/seo-claude/scheduler.js'));
  // Must NOT match the detector itself, or it would report itself as a stuck run.
  assert.ok(!isSchedulerProcess('/usr/bin/node scripts/check-scheduler-heartbeat.mjs'));
  assert.ok(!isSchedulerProcess('vim scheduler.js'));
});

test('isFleetBrowser matches puppeteer Chrome but never a desktop browser', () => {
  assert.ok(isFleetBrowser('/root/.cache/puppeteer/chrome/linux-146.0.7680.153/chrome-linux64/chrome --no-sandbox'));
  assert.ok(!isFleetBrowser('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'));
});

// ── the guarantee ────────────────────────────────────────────────────────────

/**
 * Source with comments removed. The header of this script DESCRIBES the things
 * it must not do ("it may never kill the run it finds", "never `immediate:
 * true`"), so a scan of the raw file flags its own documentation — the same
 * trap `lib/product-category-terms.js` hit when its rule fired on the sentence
 * stating the rule. Scanning CODE is the point; the prose is evidence the
 * decision was considered, not evidence it was violated.
 */
function codeOnly(rel) {
  return readFileSync(join(ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')  // block comments, incl. the jsdoc header
    .replace(/^\s*\/\/.*$/gm, '');     // line comments
}

test('the detector spawns nothing but `ps` — it can never kill or restart a run', () => {
  // A scheduler mid-publish holds live Shopify writes. Reaping it from a timer
  // on a duration heuristic is how a half-published post happens at 4 AM.
  const src = codeOnly(join('scripts', 'check-scheduler-heartbeat.mjs'));

  for (const forbidden of ['pm2 ', 'SIGKILL', 'SIGTERM', 'process.kill', 'spawnSync(', 'execSync(']) {
    assert.ok(
      !src.includes(forbidden),
      `check-scheduler-heartbeat.mjs must not reference ${forbidden} — it is a detector, not a reaper.`,
    );
  }

  // The one child process it may create is `ps`. This is the assertion that
  // actually bounds it: an allowlist of one, not a blacklist of spellings.
  const execCalls = [...src.matchAll(/execFileSync\(\s*'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(execCalls)], ['ps'], 'the only command this may run is `ps`');
  // The lookbehind excludes a preceding `.` so RegExp.prototype.exec() — which
  // this file uses freely for parsing — is not mistaken for a child-process
  // call. Without it this assertion flags three harmless regex matches.
  assert.ok(
    !/(?<![.\w])exec[A-Za-z]*\(/.test(src.replace(/execFileSync\(/g, '')),
    'no child-process call other than execFileSync(ps) is permitted here',
  );
});

test('it never escalates to email and never sets error on a routine state', () => {
  const src = codeOnly(join('scripts', 'check-scheduler-heartbeat.mjs'));
  assert.ok(!/immediate:\s*true/.test(src), 'a heartbeat row belongs in the 5 AM digest, never in an immediate email');

  // Routine states must not render in the Failures block, or the block stops
  // being read — the failure mode CLAUDE.md documents for five other agents.
  for (const facts of [healthy(), healthy({ lastDone: null, schedulerProcs: [{ pid: 1, ageSec: 60 }] })]) {
    assert.equal(classifySchedulerHealth(facts).status, 'success');
  }
});
