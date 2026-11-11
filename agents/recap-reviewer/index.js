/**
 * Recap Reviewer — fixes what the morning recap would otherwise hand Sean.
 *
 * Runs at 11:05 UTC, before the 13:00 recap (agents/daily-summary). It reads the
 * SAME inputs the recap reads (collectDigestInputs), turns every problem into a
 * review item (lib/recap-review.js) and works the routes in order:
 *
 *   Unit A  heartbeat (kill a wedged scheduler / orphaned Chrome), collector
 *           re-runs, job re-runs (allowlist only, 20 min each, verified by a
 *           later success row from the same reporter)
 *   Unit B  refresh demoted flops, close out needs_decision items (decisions.js),
 *           remediate blocked drafts (once, then archive), remove LOW_DEMAND posts
 *           behind a 301 (removal.js)
 *   Unit C  at most one autonomous fix session (fix.js)
 *   Unit D  growth recommendations, after Unit C's child has exited, so only one
 *           Claude process is alive at a time on this 961 MB box
 *
 * Nothing new starts at or after 14:30 UTC; unstarted work reads "deferred to
 * tomorrow". Output: data/reports/recap-reviewer/latest.json, its dated copy and
 * done.json on an --apply run; a dry run writes dry-run.json and nothing else,
 * so it can never replace the morning's real report. Anything not verified as fixed is reported as
 * unresolved or only-you; nothing is dropped.
 *
 * Usage:
 *   node agents/recap-reviewer/index.js           # dry run: decide, change nothing
 *   node agents/recap-reviewer/index.js --apply   # what cron runs
 *   node agents/recap-reviewer/index.js --now 2026-11-11T11:05:00Z   # dry run as of that time
 */
import { buildReviewItems, itemKey } from '../../lib/recap-review.js';
import { parseCrontab, isRerunnable, collectorFor } from '../../lib/recap-jobs.js';
import { dropRecoveredFailures } from '../../lib/digest-recovery.js';
import { MAX_FIX_ATTEMPTS } from '../../lib/recap-reviewer-state.js';
import { isDirectRun } from '../../lib/is-direct-run.js';
import { MAX_RUN_MINUTES } from '../../scripts/check-scheduler-heartbeat.mjs';
import { planDecision, executeDecision } from './decisions.js';
import { runRemovals } from './removal.js';
import { runFixUnit } from './fix.js';

export const CUTOFF_UTC = '14:30';
const CUTOFF_MIN = 14 * 60 + 30;
export const RERUN_TIMEOUT_MS = 20 * 60_000;
const STUCK_LOG_AGE_MS = 2 * 3600_000;
// The heartbeat's own ceiling: a scheduler or Chrome younger than this may belong to a live run.
const MAX_RUN_SEC = MAX_RUN_MINUTES * 60;
export const MAX_REFRESHES = 5;
const FIX_SESSION_MAX_MS = 45 * 60_000;
const FIX_SESSION_MIN_MS = 15 * 60_000;
const HEARTBEAT_SOURCE = 'scripts/check-scheduler-heartbeat.mjs';
const DEFERRED = 'deferred to tomorrow';
const WAITS = 'waits for next scheduled run';

/**
 * `crontab` command text -> argv. Strips only shell redirects (`2>&1`, `>> log`,
 * `> log`) and quotes; an ordinary argument such as `--limit 5` is never touched.
 */
export function splitCommand(command) {
  const text = ` ${String(command || '')}`
    .replace(/\s\d*>&\d+/g, ' ')
    .replace(/\s\d*>>?\s*\S+/g, ' ');
  return text.trim().split(/\s+/).filter(Boolean).map((p) => p.replace(/^["']|["']$/g, ''));
}

const minutesUTC = (d) => d.getUTCHours() * 60 + d.getUTCMinutes();
const clip = (s, n = 1500) => { const t = String(s ?? '').trim(); return t.length > n ? `…${t.slice(-n)}` : t; };
const outputTail = (r) => clip(`${r?.stderr || ''}\n${r?.stdout || ''}`, 600);

export async function runReview(deps, { apply = false, now = () => new Date() } = {}) {
  const clock = typeof now === 'function' ? now : () => now;
  const started = clock();
  const today = started.toISOString().slice(0, 10);
  const report = {
    generated_at: started.toISOString(), date: today, apply,
    resolved: [], unresolved: [], onlyYou: [], counts: {}, growth: null, fixSession: null, skipped: [],
  };
  try {
    await review(deps, { apply, clock, today, report });
  } catch (e) {
    report.crashed = true;
    report.error = clip(e?.stack || e, 2000);
    if (apply) {
      try {
        await deps.notify({ subject: 'Recap reviewer crashed', body: report.error, status: 'error', category: 'ops', immediate: true });
      } catch { /* the report still gets written */ }
    }
  }
  report.counts = {
    ...report.counts,
    resolved: report.resolved.length, unresolved: report.unresolved.length,
    onlyYou: report.onlyYou.length, skipped: report.skipped.length,
  };
  report.finished_at = clock().toISOString();
  // A dry run must never replace the morning's real report: it writes its own file.
  if (apply) await deps.writeReport(report);
  else await deps.writeDryRun(report);
  if (apply) {
    await deps.writeDone({ date: today, generated_at: report.finished_at, crashed: !!report.crashed });
    if (!report.crashed) {
      try { await deps.notify({ subject: `Recap reviewer: ${summaryLine(report)}`, body: digestBody(report), status: 'success', category: 'ops' }); } catch { /* best effort */ }
    }
  }
  return report;
}

async function review(deps, { apply, clock, today, report }) {
  const state = deps.loadState();
  const inputs = await deps.collectInputs();
  const errorRows = (inputs.entries || []).filter((e) => e?.status === 'error');
  const flops = inputs.postPerformance?.action_required || [];
  const items = buildReviewItems({
    errorRows, healthIssues: inputs.healthIssues || [], needsDecision: inputs.needsDecision || [],
    flops, blockedDrafts: inputs.blockedPosts || [],
  });
  for (const it of items) if (!state.firstSeen[it.key]) state.firstSeen[it.key] = today;
  const rowCount = new Map();
  for (const r of errorRows) rowCount.set(itemKey(r), (rowCount.get(itemKey(r)) || 0) + 1);

  const outcome = (it, action, result, evidence = '') => ({
    key: it.key, kind: it.kind, subject: it.subject, action, result, evidence: clip(evidence),
    ...(state.firstSeen[it.key] ? { since: state.firstSeen[it.key] } : {}),
  });
  const put = (bucket) => (it, action, result, evidence) => { const o = outcome(it, action, result, evidence); report[bucket].push(o); return o; };
  const resolved = put('resolved');
  const unresolved = put('unresolved');
  const onlyYou = put('onlyYou');
  const pastCutoff = () => minutesUTC(clock()) >= CUTOFF_MIN;
  const msToCutoff = () => {
    const d = clock();
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 14, 30) - d.getTime();
  };
  const checkpoint = () => { if (apply) deps.saveState(state); };
  const dry = (it, action, what) => unresolved(it, action, `dry run: would ${what}`);
  const isHb = (it) => it.source === HEARTBEAT_SOURCE;
  const byRoute = (route) => items.filter((i) => i.route === route && !isHb(i));

  // Routes with no work to do.
  for (const it of byRoute('only-you')) onlyYou(it, 'none', 'only you can do this', it.detail);
  for (const it of byRoute('stash-residual')) unresolved(it, 'none', 'left for a human: stashes are never popped automatically', it.detail);
  report.counts.automated = byRoute('count-only').length;

  let crontabText = '';
  try { crontabText = (await deps.readCrontab()) || ''; } catch { crontabText = ''; }
  const jobs = parseCrontab(crontabText);
  const commandFor = (source) => jobs.get(source)?.command || (isRerunnable(source) ? `node ${source}` : null);

  // ── Unit A ────────────────────────────────────────────────────────────────
  await heartbeatStep({ deps, apply, clock, pastCutoff, items: items.filter(isHb), report, resolved, unresolved });

  const reruns = new Map(); // command -> { res, later }
  for (const it of [...byRoute('collector-rerun'), ...byRoute('rerun')]) {
    const collector = it.route === 'collector-rerun';
    const action = collector ? 're-run collector' : 're-run';
    const source = collector ? collectorFor(it.subject) : it.source;
    if (!source) { unresolved(it, action, collector ? 'no known producer for this health row' : 'cannot re-run: the row names no source script', it.detail); continue; }
    if (!isRerunnable(source)) { unresolved(it, action, WAITS, `${source} is not on the re-run allowlist`); continue; }
    if (pastCutoff()) { unresolved(it, action, DEFERRED); continue; }
    const command = commandFor(source);
    if (!apply) { dry(it, action, `re-run \`${command}\``); continue; }
    let run = reruns.get(command);
    if (!run) {
      const startedAt = clock().toISOString();
      const [cmd, ...args] = splitCommand(command);
      const res = await deps.exec(cmd, args, { timeout: RERUN_TIMEOUT_MS });
      const later = await deps.readRowsSince(startedAt).catch(() => []);
      run = { res, later };
      reruns.set(command, run);
    }
    if (run.res.code !== 0) {
      unresolved(it, action, run.res.timedOut ? 're-run timed out after 20 minutes' : `re-run exited ${run.res.code}`, outputTail(run.res));
      continue;
    }
    if (collector) {
      const titles = await deps.healthTitles().catch(() => null);
      if (Array.isArray(titles) && !titles.includes(it.subject)) resolved(it, action, `re-ran ${source}; the feed is fresh again`, command);
      else unresolved(it, action, `re-ran ${source}, but the health check still flags it`, command);
    } else {
      const { recovered } = dropRecoveredFailures([it.row], run.later);
      if (recovered.length) resolved(it, action, `re-ran ${source} (recovered)`, command);
      else unresolved(it, action, `re-ran ${source} (exit 0), but it wrote no success row`, command);
    }
  }

  checkpoint();

  // ── Unit B ────────────────────────────────────────────────────────────────
  let refreshes = 0;
  for (const it of byRoute('refresh')) {
    const slug = it.row?.slug;
    if (!slug) { unresolved(it, 'refresh', 'cannot refresh: the row names no post', ''); continue; }
    if (pastCutoff() || refreshes >= MAX_REFRESHES) { unresolved(it, 'refresh', DEFERRED); continue; }
    refreshes += 1;
    if (!apply) { dry(it, 'refresh', `refresh ${slug}`); continue; }
    const r = await deps.exec('node', ['agents/refresh-runner/index.js', slug], { timeout: RERUN_TIMEOUT_MS });
    if (r.code === 0) resolved(it, 'refresh', `refreshed ${slug}`);
    else unresolved(it, 'refresh', r.timedOut ? 'refresh timed out' : `refresh-runner exited ${r.code}`, outputTail(r));
  }

  for (const it of byRoute('regenerate')) {
    const closed = state.closed[it.key];
    const closedOn = closed && typeof closed === 'object' ? closed.on : closed;
    const plan = planDecision(it.row, { today, retriedOn: state.regenerated[it.key], closedOn });
    if (plan.action === 'only-you') { onlyYou(it, 'none', plan.reason, it.detail); continue; }
    if (plan.action === 'already-closed') {
      report.counts.closedEarlier = (report.counts.closedEarlier || 0) + 1;
      resolved(it, 'closed earlier', `closed out on ${closedOn}: ${closed?.reason || '(reason not recorded)'}`);
      continue;
    }
    if (plan.action === 'wait') { unresolved(it, 'regenerate', plan.reason); continue; }
    const action = plan.action === 'retry' ? 'regenerate' : 'close-out';
    if (pastCutoff()) { unresolved(it, action, DEFERRED); continue; }
    if (!apply) { dry(it, action, plan.reason); continue; }
    // The one retry is spent when it is attempted, so a retry that fails is not
    // tried again every morning: tomorrow the item is closed out instead.
    if (plan.action === 'retry') state.regenerated[it.key] = today;
    try {
      const ev = await executeDecision(plan, it.row, deps, { now: clock().toISOString() });
      if (plan.action === 'retry') {
        unresolved(it, action, `retried once (${plan.reason}); checked again tomorrow`, ev);
      } else {
        state.closed[it.key] = { on: today, reason: plan.reason };
        resolved(it, action, `closed out: ${plan.reason}`, ev);
      }
    } catch (e) {
      unresolved(it, action, `${action} failed`, e.message);
    }
  }

  for (const it of byRoute('remediate-draft')) {
    const slug = it.row?.slug;
    const prior = state.remediated[it.key];
    if (!slug) { unresolved(it, 'remediate', 'cannot remediate: the row names no post'); continue; }
    if (pastCutoff()) { unresolved(it, prior ? 'archive' : 'remediate', DEFERRED); continue; }
    if (!prior) {
      if (!apply) { dry(it, 'remediate', `run content-remediator on ${slug}`); continue; }
      const r = await deps.exec('node', ['agents/content-remediator/index.js', '--slug', slug], { timeout: RERUN_TIMEOUT_MS });
      state.remediated[it.key] = today;
      const still = await deps.isBlocked(slug).catch(() => true);
      if (r.code === 0 && !still) resolved(it, 'remediate', `remediated draft ${slug}; no longer blocked`);
      else unresolved(it, 'remediate', 'remediated once; archived tomorrow if still blocked', r.code === 0 ? '' : outputTail(r));
    } else if (prior < today) {
      if (!apply) { dry(it, 'archive', `archive draft ${slug} (move, not delete)`); continue; }
      try {
        const res = await deps.archiveDraft(slug, 'hard-blocked draft still blocked after one content-remediator pass');
        resolved(it, 'archive', `archived blocked draft ${slug} (moved, not deleted)`, JSON.stringify(res));
      } catch (e) { unresolved(it, 'archive', 'archive failed', e.message); }
    } else {
      unresolved(it, 'remediate', 'remediated today; checked again tomorrow');
    }
  }

  const removeItems = byRoute('remove');
  const removal = await runRemovals({ rows: removeItems.map((i) => i.row), deps, apply, pastCutoff, today });
  report.skipped.push(...removal.skipped);
  if (removal.linkRepair) report.linkRepair = removal.linkRepair;
  for (const o of removal.outcomes) {
    const it = removeItems.find((i) => i.row === o.row);
    (o.bucket === 'resolved' ? resolved : unresolved)(it, 'remove', o.result, o.evidence);
  }

  checkpoint();

  // ── Unit C ────────────────────────────────────────────────────────────────
  const fixItems = byRoute('fix-session');
  const eligible = [];
  for (const it of fixItems) {
    if ((state.fixAttempts[it.key] || 0) >= MAX_FIX_ATTEMPTS) unresolved(it, 'fix session', `automatic fix tried ${MAX_FIX_ATTEMPTS} times; waits for a code change`, it.detail);
    else eligible.push(it);
  }
  eligible.sort((a, b) => (rowCount.get(b.key) || 0) - (rowCount.get(a.key) || 0));
  const [pick, ...rest] = eligible;
  for (const it of rest) unresolved(it, 'fix session', 'queued: one fix session per morning', it.detail);
  if (pick) {
    // The session must end by 14:30 UTC, and one with under 15 minutes is not worth starting.
    if (pastCutoff() || msToCutoff() < FIX_SESSION_MIN_MS) report.fixSession = unresolved(pick, 'fix session', DEFERRED);
    else if (!apply) report.fixSession = dry(pick, 'fix session', `start a fix session for ${pick.source || pick.subject}`);
    else {
      state.fixAttempts[pick.key] = (state.fixAttempts[pick.key] || 0) + 1;
      deps.saveState(state); // an attempt counts even if this process dies mid-session
      const command = pick.source ? commandFor(pick.source) : null;
      const timeoutMs = Math.min(FIX_SESSION_MAX_MS, msToCutoff());
      const o = await runFixUnit({ item: pick, command, splitCommand, deps, today, timeoutMs });
      const bucket = o.bucket === 'resolved' ? resolved : o.bucket === 'onlyYou' ? onlyYou : unresolved;
      report.fixSession = bucket(pick, 'fix session', o.result, o.evidence);
    }
  }

  checkpoint();

  // ── Unit D (after the fix session's child has exited) ───────────────────────
  if (pastCutoff()) report.growth = { recs: [], reason: DEFERRED };
  else {
    try {
      report.growth = await deps.generateGrowthRecs(await deps.gatherGrowthInputs());
    } catch (e) {
      report.growth = { recs: [], reason: `growth step failed: ${e.message}` };
    }
  }

  if (apply) deps.saveState(state);
}

async function heartbeatStep({ deps, apply, clock, pastCutoff, items, report, resolved, unresolved }) {
  if (pastCutoff()) { for (const it of items) unresolved(it, 'heartbeat', DEFERRED); return; }
  let hb;
  try { hb = await deps.heartbeat(); } catch (e) {
    report.heartbeat = { error: e.message };
    for (const it of items) unresolved(it, 'heartbeat', 'heartbeat check unreadable', e.message);
    return;
  }
  const state = hb?.verdict?.state || 'unknown';
  const actions = [];
  report.heartbeat = { state, actions };
  const subject = items.length ? null : { key: 'heartbeat', kind: 'health', subject: `Scheduler heartbeat: ${state}`, detail: hb?.verdict?.headline || '' };
  const targets = subject ? [subject] : items;
  const record = (fn, action, result, evidence) => { for (const it of targets) fn(it, action, result, evidence); };

  if (state === 'healthy' || state === 'in-progress') {
    if (items.length) record(resolved, 'heartbeat', `scheduler heartbeat is ${state} now`, '');
    return;
  }
  if (state === 'died' || state === 'no-run') {
    record(unresolved, 'heartbeat', `${WAITS} (scheduler ${state}; nothing to kill)`, hb?.verdict?.headline || '');
    return;
  }

  let killedScheduler = false;
  const killPids = [];
  if (state === 'stuck') {
    const last = await deps.lastSchedulerLogAt().catch(() => null);
    const age = Number.isFinite(last) ? clock().getTime() - last : null;
    if (age === null || age <= STUCK_LOG_AGE_MS) {
      record(unresolved, 'heartbeat', 'stuck scheduler left running: its last log line is under 2 h old (may be mid-publish)',
        age === null ? 'last log line time unknown' : `last log line ${(age / 60000).toFixed(0)} min ago`);
      return;
    }
    for (const p of hb.schedulerProcs || []) if (p.ageSec > MAX_RUN_SEC) killPids.push(['scheduler', p.pid, 'SIGTERM']);
    killedScheduler = killPids.length > 0;
  }
  if (state === 'orphaned-browser' || killedScheduler) {
    // Only Chrome past the run ceiling: a young one may belong to a run in progress.
    for (const p of hb.browserProcs || []) if (p.ageSec > MAX_RUN_SEC) killPids.push(['chrome', p.pid, 'SIGKILL']);
  }
  if (!killPids.length) { record(unresolved, 'heartbeat', `scheduler ${state}: no process to act on`, hb?.verdict?.headline || ''); return; }
  if (!apply) { record(unresolved, 'heartbeat', `dry run: would kill ${killPids.map(([w, p]) => `${w} pid ${p}`).join(', ')}`, ''); return; }

  for (const [what, pid, sig] of killPids) {
    try { await deps.kill(pid, sig); actions.push(`killed ${what} pid ${pid}`); } catch (e) { actions.push(`kill ${what} pid ${pid} failed: ${e.message}`); }
  }
  const after = await deps.heartbeat().catch(() => null);
  const s2 = after?.verdict?.state || 'unknown';
  if (!['stuck', 'orphaned-browser', 'unknown'].includes(s2)) {
    record(resolved, 'heartbeat', `${actions.join('; ')}; heartbeat now ${s2}${s2 === 'died' ? ' (the 15:00 run starts fresh)' : ''}`, '');
  } else {
    record(unresolved, 'heartbeat', `${actions.join('; ')}; heartbeat still ${s2}`, '');
  }
}

export function summaryLine(r) {
  return `${r.resolved.length} fixed, ${r.unresolved.length} still being worked on, ${r.onlyYou.length} only you can do, ${r.skipped.length} skipped`;
}

export function digestBody(r) {
  const L = [summaryLine(r), ''];
  const sect = (title, list) => {
    if (!list.length) return;
    L.push(`${title}:`);
    for (const o of list) L.push(`  - ${o.subject}: ${o.action}: ${o.result}`);
    L.push('');
  };
  sect('Fixed', r.resolved);
  sect('Still being worked on', r.unresolved);
  sect('Only you', r.onlyYou);
  if (r.skipped.length) { L.push('Removal skipped:'); for (const s of r.skipped) L.push(`  - ${s.slug}: ${s.reason}`); L.push(''); }
  if (r.growth) L.push(`Growth recommendations: ${r.growth.recs?.length || 0}${r.growth.reason ? ` (${r.growth.reason})` : ''}`);
  return L.join('\n');
}

async function main() {
  const apply = process.argv.includes('--apply');
  const { realDeps } = await import('./real-deps.js');
  const deps = await realDeps();
  console.log(`\nRecap Reviewer — ${apply ? 'APPLY' : 'DRY RUN'}\n`);
  // `--now <iso>` (dry runs only) evaluates the routes as if it were that time,
  // so a dry run after 14:30 UTC still shows what the morning run would do.
  const at = process.argv.indexOf('--now');
  const fixed = at !== -1 && !apply ? new Date(process.argv[at + 1]) : null;
  if (fixed && Number.isNaN(fixed.getTime())) throw new Error('--now needs an ISO timestamp');
  const report = await runReview(deps, { apply, ...(fixed ? { now: () => fixed } : {}) });
  console.log(digestBody(report));
  console.log(`\nReport: ${deps.reportPath(apply)}`);
  if (report.crashed) process.exitCode = 1;
}

if (isDirectRun(import.meta.url)) {
  main().catch(async (e) => {
    console.error(e);
    // runReview writes its own crashed report; this covers a crash before it
    // ran (e.g. wiring failed), so the recap never reads yesterday's file.
    try {
      const { writeFileSync, mkdirSync } = await import('node:fs');
      const { REVIEWER_DIR } = await import('../../lib/recap-reviewer-state.js');
      mkdirSync(REVIEWER_DIR, { recursive: true });
      const now = new Date().toISOString();
      // A dry run never touches latest.json, even when it crashes.
      const file = process.argv.includes('--apply') ? 'latest.json' : 'dry-run.json';
      writeFileSync(`${REVIEWER_DIR}/${file}`, `${JSON.stringify({
        generated_at: now, date: now.slice(0, 10), apply: process.argv.includes('--apply'), crashed: true,
        error: String(e?.stack || e).slice(0, 2000), resolved: [], unresolved: [], onlyYou: [], counts: {}, growth: null, fixSession: null, skipped: [],
      }, null, 2)}\n`);
    } catch { /* nothing writable */ }
    if (process.argv.includes('--apply')) {
      try {
        const { notify } = await import('../../lib/notify.js');
        await notify({ subject: 'Recap reviewer crashed', body: String(e?.stack || e), status: 'error', category: 'ops', immediate: true });
      } catch { /* nothing left to tell */ }
    }
    process.exitCode = 1;
  });
}
