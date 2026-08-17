// lib/ad-studio-job.js
//
// The progress record of one Ad Studio run, while it runs.
//
// ONE WRITER, BY DESIGN. The dashboard route creates the job file and then never
// touches it again; the spawned agent writes everything after that, including its own
// pid on startup. Two writers on one file would need locking, and every lock this
// project could reasonably use survives a crash it should not survive.
//
// That is also why cancellation is a SIGNAL and not a write: the route sends SIGTERM
// and the agent's existing handler — which already archives run output before exiting
// — records the outcome. The reader never decides what happened.
//
// Liveness is asked of the OS, never of a lock file. The dashboard restarts on every
// deploy and an agent can be OOM-killed on a 961 MB box; a stale lock would block
// every future launch with nothing on screen saying why.

import { readdirSync, readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Job files are a few KB; the run's own run.json is the permanent record. */
export const DEFAULT_MAX_AGE_MS = 3 * DAY_MS;

/**
 * How long a job may sit 'pending' before it is presumed never to have started.
 *
 * This window covers ONE thing only: the seconds between the route writing the job file
 * and the spawned agent booting far enough to claim it. The agent claims immediately
 * after parseArgs — before any network call — so a job still pending a minute later is a
 * child that never started (bad cwd, no `node` on PATH, OOM at boot), not a run in
 * progress. It must never be asked to cover a working run: it used to, back when the
 * agent claimed only after the copy stage, and a second Render click in that window
 * spawned a second paid agent.
 */
export const DEFAULT_PENDING_GRACE_MS = 60 * 1000;

/** `data/reports/ad-studio/` is already gitignored, so job files need no ignore rule. */
export function jobsDir(root) {
  return join(root, 'data', 'reports', 'ad-studio', 'jobs');
}

const JOB_ID_RE = /^[\w.-]+$/;

export function isValidJobId(id) {
  const s = String(id || '');
  if (!s || s === '.' || s === '..') return false;
  return JOB_ID_RE.test(s);
}

export function jobPath(root, jobId) {
  if (!isValidJobId(jobId)) throw new Error(`ad-studio-job: invalid job id "${jobId}"`);
  return join(jobsDir(root), `${jobId}.json`);
}

/**
 * Atomic: write a temp file, then rename over the target. The dashboard polls this
 * file while the agent writes it, and a partial read would render a broken run.
 *
 * Stamps `createdAt` with the current time when the incoming job has none, and leaves
 * an existing value untouched — an update must never reset a job's creation time. A
 * job that never got a `createdAt` is invisible to pruning, rendersToday, and
 * findActiveJob alike (Date.parse(undefined) is NaN), which is the exact "never
 * cleaned up" failure mode that has already cost this project four days of cron.
 */
export function writeJob(root, job) {
  if (!job || !job.jobId) throw new Error('ad-studio-job: writeJob requires a jobId');
  const record = { ...job, createdAt: job.createdAt || new Date().toISOString() };
  const dir = jobsDir(root);
  mkdirSync(dir, { recursive: true });
  const final = jobPath(root, record.jobId);
  const tmp = `${final}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2));
  renameSync(tmp, final);
  return record;
}

/** null — never a throw — for missing OR corrupt. A reader must not crash on either. */
export function readJob(root, jobId) {
  try {
    return JSON.parse(readFileSync(jobPath(root, jobId), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * PATCH SEMANTICS: an `undefined` value means "leave this field alone", not "clear it".
 *
 * Not a nicety. `{...current, ...patch}` with an undefined value leaves the key present
 * but undefined, and JSON.stringify then DROPS it — so an optional argument that
 * defaulted to undefined would silently erase a value the job already had, and one that
 * defaults to null would overwrite it with null (null survives stringify). That is
 * exactly how `job.start()` erased the launch route's cost plan: the browser gates its
 * "planned N renders · $X" line on `job.plan`, so the number vanished the moment the run
 * started spending. Callers that really mean "clear it" pass null explicitly.
 */
export function updateJob(root, jobId, patch) {
  const current = readJob(root, jobId);
  if (!current) throw new Error(`ad-studio-job: no such job "${jobId}"`);
  const defined = Object.fromEntries(Object.entries(patch || {}).filter(([, v]) => v !== undefined));
  return writeJob(root, { ...current, ...defined });
}

export function appendEvent(root, jobId, event) {
  const current = readJob(root, jobId);
  if (!current) throw new Error(`ad-studio-job: no such job "${jobId}"`);
  const events = Array.isArray(current.events) ? current.events : [];
  events.push({ at: new Date().toISOString(), ...event });
  return writeJob(root, { ...current, events });
}

export function listJobs(root) {
  const dir = jobsDir(root);
  if (!existsSync(dir)) return [];
  const jobs = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const job = readJob(root, f.replace(/\.json$/, ''));
    if (job) jobs.push(job);
  }
  return jobs.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

// Exported (not just used as findActiveJob's default) so the job route can report
// liveness on GET /job/<id> without re-implementing the same signal-0 probe.
export const pidAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

/**
 * The run currently in flight, or null. `isAlive` and `now` are injectable so the
 * behaviour is testable without spawning processes.
 */
export function findActiveJob(root, { now = Date.now(), isAlive = pidAlive, pendingGraceMs = DEFAULT_PENDING_GRACE_MS } = {}) {
  for (const job of listJobs(root)) {
    if (job.status === 'running') {
      if (job.pid && isAlive(job.pid)) return job;
      continue;
    }
    if (job.status === 'pending') {
      const age = now - Date.parse(job.createdAt || 0);
      if (job.pid && isAlive(job.pid)) return job;
      if (Number.isFinite(age) && age < pendingGraceMs) return job;
    }
  }
  return null;
}

/** Renders billed today. Gemini's project quota is a hard 250/day. */
export function rendersToday(root, { now = Date.now() } = {}) {
  const day = new Date(now).toISOString().slice(0, 10);
  let total = 0;
  for (const job of listJobs(root)) {
    if (String(job.createdAt || '').slice(0, 10) !== day) continue;
    total += Number(job.totals?.renders) || 0;
  }
  return total;
}

export function pruneJobs(root, { now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
  const dir = jobsDir(root);
  if (!existsSync(dir)) return [];
  const removed = [];
  for (const job of listJobs(root)) {
    const age = now - Date.parse(job.createdAt || 0);
    if (!Number.isFinite(age) || age <= maxAgeMs) continue;
    try { unlinkSync(jobPath(root, job.jobId)); removed.push(job.jobId); } catch { /* ignore */ }
  }
  return removed;
}
