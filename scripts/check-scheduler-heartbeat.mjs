#!/usr/bin/env node
/**
 * Scheduled DETECTOR for "did the daily pipeline actually finish?". Fixes
 * nothing, kills nothing, and structurally cannot.
 *
 * WHY IT EXISTS
 * ─────────────
 * On 2026-09-01 `scheduler.js` wedged inside `agents/theme-seo-auditor`'s
 * Lighthouse call and was STILL RUNNING on 2026-09-05. Nothing anywhere said
 * so. It could not:
 *
 *   - The 5 AM digest reports what agents `notify()`. A process that never
 *     exits never notifies, so a wedged run is INVISIBLE to the digest by
 *     construction — it is not a missing row, it is a row that can never exist.
 *   - `theme-seo-auditor` is the FIRST job in the monthly block, so every
 *     monthly step after it silently never ran, and no failure was recorded,
 *     because the process never exited to record one.
 *   - Its orphaned Chrome tree held ~334 MB on a 961 MB box until the OOM
 *     killer took `seo-dashboard` down 642 times instead. The operator found
 *     out from a Cloudflare 502, four days later.
 *
 * PR #786 bounded a hung STEP (`STEP_TIMEOUT_MS`). This answers the different
 * question — did the RUN as a whole finish — because a bounded hang is still a
 * hang, and because the next way this breaks will not be a Lighthouse call.
 *
 * WHY A LOG MARKER RATHER THAN A HEARTBEAT FILE
 * ─────────────────────────────────────────────
 * `scheduler.js` already logs `Content Scheduler starting` and `Scheduler
 * done.`, and both strings are unique to it — nothing else writing into
 * `scheduler.log` emits either. So the evidence already exists for every run
 * that has ever happened, which means this detector can be VALIDATED AGAINST
 * HISTORY instead of only against its own future. Measured over the 42 runs
 * since 2026-07-26: 41 completed, and exactly ONE did not — 2026-09-01, the
 * incident. One firing in six weeks, on the real event, zero false positives.
 * A new heartbeat file would have had no history to check that against.
 *
 * (Before 2026-07-26 the log carries many unmatched starts. That era spans the
 * disk-full outage and the double-logging bug fixed in `log()`, so it is not
 * comparable and is deliberately not used to calibrate anything.)
 *
 * IT CANNOT KILL THE PROCESS IT FINDS, AND THAT IS DELIBERATE
 * ───────────────────────────────────────────────────────────
 * The obvious "improvement" is to have this reap a stuck run. It must not. A
 * scheduler mid-publish is holding live Shopify writes; killing it from a timer
 * on a duration heuristic is how a half-published post happens, unattended, at
 * 4 AM. `scripts/triage-orphan-briefs.mjs --drop-non-earning` is what a
 * scheduled destructive action looks like when its input is merely plausible —
 * it ran on a fresh-but-wrong report and permanently destroyed three paid-for
 * briefs. This reports; a human kills. `killStaleRun` does not exist here and
 * a test pins that this file spawns nothing.
 *
 * WHAT EACH EXIT CODE MEANS
 * ─────────────────────────
 *   0  the most recent run started and completed. Routine.
 *   1  a run is in progress and still inside its budget. Routine — reported at
 *      `success`. At the scheduled 12:50 UTC slot this should never be seen
 *      (the 15:00 run is ~21.8h finished), but this script is also run by hand.
 *   2  STUCK: a scheduler process is alive past MAX_RUN_MINUTES. The 2026-09-01
 *      shape. Needs a human.
 *   3  DIED: the last run started, never logged completion, and no process is
 *      alive. It was killed (OOM is the likely cause on this box) or crashed
 *      without unwinding. Needs a human.
 *   4  NO RUN: nothing started within NO_RUN_HOURS. cron itself has stopped —
 *      the signature of the 2026-06 disk-full outage. Needs a human.
 *   5  ORPHANED BROWSER: the scheduler is healthy but a Chrome older than
 *      MAX_RUN_MINUTES is still resident. This is the RESOURCE half of the
 *      2026-09-01 incident and it outlives the run that spawned it, so it is
 *      worth its own code rather than a footnote.
 *
 * 2, 3, 4 and 5 render in the digest's Failures block (`status: 'error'`, which
 * on this fleet changes RENDERING ONLY — it never escalates to an email).
 * Nothing here is ever `immediate: true`.
 *
 * USAGE
 *   node scripts/check-scheduler-heartbeat.mjs
 *   node scripts/check-scheduler-heartbeat.mjs --json   (machine-readable facts)
 */

import { execFileSync } from 'node:child_process';
import { openSync, readSync, fstatSync, closeSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isDirectRun } from '../lib/is-direct-run.js';
import { notify } from '../lib/notify.js';

const ROOT = process.env.SEO_CLAUDE_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEDULER_LOG = join(ROOT, 'data', 'reports', 'scheduler', 'scheduler.log');

/**
 * How long a run may legitimately take before "still running" means "stuck".
 *
 * MEASURED, NOT PICKED. Across the 41 completed runs since 2026-07-26 the
 * median is 38.7 min, p90 is 150.1 min and the LONGEST is 365.7 min (6.1h) —
 * publishing days are genuinely long. 480 min is 1.3x that longest completed
 * run. Note the scheduled slot gives enormous extra margin on top: the run
 * starts at 15:00 UTC and this fires at 12:50 UTC, ~21.8h later, by which time
 * even a 6.1h run has been finished for fifteen hours. The threshold only
 * really matters when a human runs this by hand mid-pipeline.
 */
export const MAX_RUN_MINUTES = 480;

/**
 * No run started within this many hours → cron itself has stopped. The cadence
 * is daily at 15:00 UTC and this fires at 12:50 UTC (~21.8h into the cycle), so
 * 26h is that plus a ~4h grace — enough that one late start is not an alert,
 * short enough that a genuinely skipped day is.
 */
export const NO_RUN_HOURS = 26;

/** Tail of the log to scan. Markers are sparse; this covers dozens of runs. */
const LOG_TAIL_BYTES = 4 * 1024 * 1024;

const START_MARKER = 'Content Scheduler starting';
const DONE_MARKER = 'Scheduler done.';

/**
 * Read the last N bytes of a file as UTF-8. The scheduler log is ~19 MB and
 * grows; reading it whole every morning on a 961 MB box is exactly the kind of
 * thoughtless allocation this incident was about.
 *
 * @param {string} path
 * @param {number} maxBytes
 * @returns {string|null} null when the file does not exist
 */
export function readTail(path, maxBytes = LOG_TAIL_BYTES) {
  if (!existsSync(path)) return null;
  const fd = openSync(path, 'r');
  try {
    const { size } = fstatSync(fd);
    const length = Math.min(size, maxBytes);
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, size - length);
    return buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * Find the last scheduler start and the last completion in a slice of log.
 *
 * Both markers are unique to `scheduler.js`; the collectors that share this log
 * emit neither. Timestamps are the ISO prefix `log()` writes.
 *
 * @param {string|null} text
 * @returns {{lastStart:number|null, lastDone:number|null, lastStepLine:string|null}}
 */
export function parseSchedulerMarkers(text) {
  if (!text) return { lastStart: null, lastDone: null, lastStepLine: null };
  let lastStart = null;
  let lastDone = null;
  let lastStepLine = null;

  for (const line of text.split('\n')) {
    const m = /^\[([^\]]+)\]\s*(.*)$/.exec(line);
    if (!m) continue;
    const t = Date.parse(m[1]);
    if (!Number.isFinite(t)) continue;
    const body = m[2];

    if (body.includes(START_MARKER)) {
      lastStart = t;
      lastStepLine = null; // a new run resets what "the last thing it did" means
    } else if (body.includes(DONE_MARKER)) {
      lastDone = t;
    } else if (lastStart !== null && body.trim()) {
      // Remember the most recent timestamped line of the current run so a stuck
      // report can name WHERE it wedged. On 2026-09-01 this would have read
      // `agents/theme-seo-auditor/index.js` and pointed straight at it.
      lastStepLine = body.trim();
    }
  }
  return { lastStart, lastDone, lastStepLine };
}

/**
 * Parse `ps` elapsed time. Linux `etimes` gives plain seconds; macOS has no
 * `etimes`, so `etime` (`[[DD-]HH:]MM:SS`) is parsed as a fallback purely so
 * this file is runnable and testable on a laptop.
 *
 * @param {string} raw
 * @returns {number|null} seconds
 */
export function parseElapsedSeconds(raw) {
  const s = String(raw).trim();
  if (/^\d+$/.test(s)) return Number(s);
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(s);
  if (!m) return null;
  const [, d, h, min, sec] = m;
  return (Number(d || 0) * 86400) + (Number(h || 0) * 3600) + (Number(min) * 60) + Number(sec);
}

/**
 * Processes matching a pattern, with their age in seconds.
 *
 * Returns [] on any failure rather than throwing: an unreadable process table
 * must degrade this detector to "log evidence only", never take it down. The
 * caller is told the difference via `processInfo`.
 *
 * @param {(args:string)=>boolean} match
 * @returns {{ok:boolean, procs:Array<{pid:number, ageSec:number, args:string}>}}
 */
export function listProcesses(match) {
  let out;
  try {
    out = execFileSync('ps', ['-eo', 'pid=,etimes=,args='], { encoding: 'utf8', timeout: 15_000 });
  } catch {
    try {
      out = execFileSync('ps', ['-eo', 'pid=,etime=,args='], { encoding: 'utf8', timeout: 15_000 });
    } catch {
      return { ok: false, procs: [] };
    }
  }
  const procs = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const [, pid, elapsed, args] = m;
    if (!match(args)) continue;
    const ageSec = parseElapsedSeconds(elapsed);
    if (ageSec === null) continue;
    procs.push({ pid: Number(pid), ageSec, args: args.slice(0, 160) });
  }
  return { ok: true, procs };
}

/** A scheduler.js process — not this detector, and not an editor's grep. */
export const isSchedulerProcess = (args) => /\bnode\b[^|]*\bscheduler\.js(\s|$)/.test(args);

/**
 * A headless Chrome launched by the fleet's puppeteer. Keyed on the puppeteer
 * cache path so an operator's own desktop browser can never match.
 */
export const isFleetBrowser = (args) => args.includes('.cache/puppeteer/chrome');

/**
 * THE WHOLE DECISION, pure and testable — no clock, no filesystem, no `ps`.
 *
 * @param {object} facts
 * @param {number} facts.now epoch ms
 * @param {number|null} facts.lastStart
 * @param {number|null} facts.lastDone
 * @param {string|null} facts.lastStepLine
 * @param {Array<{pid:number, ageSec:number}>} facts.schedulerProcs
 * @param {Array<{pid:number, ageSec:number}>} facts.browserProcs
 * @param {boolean} facts.processInfo whether `ps` could be read at all
 * @returns {{code:number, state:string, status:'success'|'error', needsHuman:boolean, headline:string, detail:string[]}}
 */
export function classifySchedulerHealth(facts) {
  const {
    now, lastStart, lastDone, lastStepLine,
    schedulerProcs = [], browserProcs = [], processInfo = true,
  } = facts;

  const maxAgeSec = MAX_RUN_MINUTES * 60;
  const staleBrowsers = browserProcs.filter((p) => p.ageSec > maxAgeSec);
  const staleSchedulers = schedulerProcs.filter((p) => p.ageSec > maxAgeSec);
  const detail = [];

  const mins = (ms) => (ms / 60000).toFixed(1);
  const hrs = (sec) => (sec / 3600).toFixed(1);

  if (lastStart === null) {
    return {
      code: 4,
      state: 'no-run',
      status: 'error',
      needsHuman: true,
      headline:
        'NO RUN FOUND: no "Content Scheduler starting" anywhere in the tail of scheduler.log. Either cron has stopped '
        + 'firing the daily pipeline or the log was truncated. Check `crontab -l` on the box and `df -h /` — a full '
        + 'disk is what stopped cron for four days in 2026-06.',
      detail,
    };
  }

  const ageH = (now - lastStart) / 3600000;
  detail.push(`last start: ${new Date(lastStart).toISOString()} (${ageH.toFixed(1)}h ago)`);
  if (lastDone !== null) detail.push(`last completion: ${new Date(lastDone).toISOString()}`);
  if (staleBrowsers.length) {
    detail.push(
      `stale browsers: ${staleBrowsers.map((p) => `pid ${p.pid} (${hrs(p.ageSec)}h)`).join(', ')}`,
    );
  }
  if (!processInfo) detail.push('NOTE: the process table could not be read; this verdict is from log evidence alone.');

  const completed = lastDone !== null && lastDone >= lastStart;

  // A stuck process is the strongest signal available and outranks everything
  // else — including "no run in 26h", which a wedged run from three days ago
  // would ALSO satisfy. Reporting that as "cron stopped" would send a human to
  // fix the wrong thing, the same precedence reasoning as `confounded` before
  // `underpowered` in lib/meta-ab-decision.js.
  if (staleSchedulers.length) {
    const worst = staleSchedulers.reduce((a, b) => (a.ageSec > b.ageSec ? a : b));
    return {
      code: 2,
      state: 'stuck',
      status: 'error',
      needsHuman: true,
      headline:
        `STUCK: a scheduler.js process (pid ${worst.pid}) has been running for ${hrs(worst.ageSec)}h, past the `
        + `${MAX_RUN_MINUTES}-minute ceiling. It is holding memory and every step after the wedged one will not run. `
        + (lastStepLine ? `Its last logged line was: ${lastStepLine}` : 'It logged no step line.'),
      detail,
    };
  }

  if (!completed) {
    if (schedulerProcs.length) {
      const youngest = schedulerProcs.reduce((a, b) => (a.ageSec < b.ageSec ? a : b));
      return {
        code: 1,
        state: 'in-progress',
        status: 'success',
        needsHuman: false,
        headline:
          `A run is in progress (pid ${youngest.pid}, ${(youngest.ageSec / 60).toFixed(1)} min) and still inside its `
          + `${MAX_RUN_MINUTES}-minute budget. Routine.`,
        detail,
      };
    }
    return {
      code: 3,
      state: 'died',
      status: 'error',
      needsHuman: true,
      headline:
        `DIED: the run that started ${mins(now - lastStart)} min ago never logged "Scheduler done." and no scheduler `
        + 'process is alive. It was killed or crashed without unwinding — on this box the OOM killer is the likeliest '
        + 'cause, so check `journalctl | grep oom-kill` and `free -m`. Steps after the failure point did not run.'
        + (lastStepLine ? ` Its last logged line was: ${lastStepLine}` : ''),
      detail,
    };
  }

  if (ageH > NO_RUN_HOURS) {
    return {
      code: 4,
      state: 'no-run',
      status: 'error',
      needsHuman: true,
      headline:
        `NO RECENT RUN: the last completed run started ${ageH.toFixed(1)}h ago, past the ${NO_RUN_HOURS}h ceiling for `
        + 'a daily job. cron is not firing the pipeline. Check `crontab -l` and `df -h /`.',
      detail,
    };
  }

  if (staleBrowsers.length) {
    return {
      code: 5,
      state: 'orphaned-browser',
      status: 'error',
      needsHuman: true,
      headline:
        `ORPHANED BROWSER: the pipeline is healthy but ${staleBrowsers.length} puppeteer Chrome process(es) have `
        + `outlived it, the oldest by ${hrs(staleBrowsers.reduce((a, b) => (a.ageSec > b.ageSec ? a : b)).ageSec)}h. `
        + 'This is the resource half of the 2026-09-01 incident: six such processes held ~334 MB and drove the OOM '
        + 'killer onto seo-dashboard. Kill them by pid once you have confirmed no run owns them.',
      detail,
    };
  }

  return {
    code: 0,
    state: 'healthy',
    status: 'success',
    needsHuman: false,
    headline: `The daily pipeline completed. Last run started ${ageH.toFixed(1)}h ago and logged "Scheduler done.".`,
    detail,
  };
}

/** Gather the facts this box can see. */
export function gatherFacts(now = Date.now()) {
  const { lastStart, lastDone, lastStepLine } = parseSchedulerMarkers(readTail(SCHEDULER_LOG));
  const sched = listProcesses(isSchedulerProcess);
  const browsers = listProcesses(isFleetBrowser);
  return {
    now,
    lastStart,
    lastDone,
    lastStepLine,
    schedulerProcs: sched.procs,
    browserProcs: browsers.procs,
    processInfo: sched.ok && browsers.ok,
  };
}

async function main(argv) {
  const facts = gatherFacts();
  const verdict = classifySchedulerHealth(facts);

  if (argv.includes('--json')) {
    console.log(JSON.stringify({ ...facts, verdict }, null, 2));
    return 0;
  }

  console.log(`[scheduler heartbeat] exit ${verdict.code} (${verdict.state}) — ${verdict.headline}`);
  for (const line of verdict.detail) console.log(`  ${line}`);

  await notify({
    subject: `Scheduler heartbeat — ${verdict.state}${verdict.needsHuman ? ' (needs a human)' : ''}`,
    status: verdict.status,
    category: 'pipeline',
    body: [
      verdict.headline,
      '',
      'Detector only — nothing was killed, restarted or written. A stuck run is left alone on purpose:',
      'it may be mid-publish against live Shopify, and killing that from a timer is how a half-published',
      'post happens. Inspect and kill by hand:',
      '  ssh root@137.184.119.230 "ps -eo pid,lstart,rss,args --sort=-rss | head -12"',
      '',
      ...verdict.detail.map((d) => `  ${d}`),
    ].join('\n'),
  });

  // Always exit 0. This runs from cron, where a non-zero exit is invisible; the
  // digest row IS the report. Same contract as the other detectors in this slot.
  return 0;
}

if (isDirectRun(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
