import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  jobsDir, jobPath, isValidJobId, writeJob, readJob, updateJob, appendEvent,
  listJobs, findActiveJob, rendersToday, pruneJobs,
} from '../../lib/ad-studio-job.js';

function freshRoot() {
  return mkdtempSync(join(tmpdir(), 'ad-studio-job-'));
}

test('job ids may not contain a path separator', () => {
  assert.equal(isValidJobId('coconut-lotion-1786000000000'), true);
  assert.equal(isValidJobId('a.b-c_d'), true);
  assert.equal(isValidJobId('../../../etc/passwd'), false);
  assert.equal(isValidJobId('a/b'), false);
  assert.equal(isValidJobId('a\\b'), false);
  assert.equal(isValidJobId(''), false);
  assert.equal(isValidJobId('..'), false);
});

test('write then read round-trips, creating the directory', () => {
  const root = freshRoot();
  writeJob(root, { jobId: 'j1', status: 'pending' });
  assert.equal(existsSync(jobsDir(root)), true);
  assert.equal(readJob(root, 'j1').status, 'pending');
});

test('reading a job that does not exist is null, not a throw', () => {
  assert.equal(readJob(freshRoot(), 'nope'), null);
});

test('reading a corrupt job file is null, not a throw', () => {
  const root = freshRoot();
  mkdirSync(jobsDir(root), { recursive: true });
  writeFileSync(jobPath(root, 'bad'), '{ not json');
  assert.equal(readJob(root, 'bad'), null);
});

// The dashboard polls this file while the agent writes it. A partial read of a
// half-written file would show the operator a broken run; writing to a temp file and
// renaming makes every read see one whole version or the previous one.
test('a write leaves no partial file behind', () => {
  const root = freshRoot();
  writeJob(root, { jobId: 'j1', status: 'running' });
  updateJob(root, 'j1', { status: 'complete' });
  const files = readdirSync(jobsDir(root));
  assert.deepEqual(files, ['j1.json']);
  assert.equal(JSON.parse(readFileSync(jobPath(root, 'j1'), 'utf8')).status, 'complete');
});

test('writeJob refuses a job with no id', () => {
  assert.throws(() => writeJob(freshRoot(), { status: 'pending' }), /jobId/);
});

test('update merges shallowly and leaves untouched keys alone', () => {
  const root = freshRoot();
  writeJob(root, { jobId: 'j1', status: 'pending', args: { product: 'coconut-lotion' } });
  const merged = updateJob(root, 'j1', { status: 'running', pid: 4242 });
  assert.equal(merged.status, 'running');
  assert.equal(merged.pid, 4242);
  assert.equal(merged.args.product, 'coconut-lotion');
});

test('update on a missing job throws rather than creating a headless one', () => {
  assert.throws(() => updateJob(freshRoot(), 'ghost', { status: 'running' }), /ghost/);
});

test('events append in order and each carries a timestamp', () => {
  const root = freshRoot();
  writeJob(root, { jobId: 'j1', status: 'running' });
  appendEvent(root, 'j1', { stage: 'copy', concept: 'manifesto' });
  const after = appendEvent(root, 'j1', { stage: 'render', artifact: 'plate-1x1.png', state: 'accepted' });
  assert.equal(after.events.length, 2);
  assert.equal(after.events[0].stage, 'copy');
  assert.equal(after.events[1].artifact, 'plate-1x1.png');
  assert.ok(Date.parse(after.events[1].at));
});

test('listJobs returns newest first', () => {
  const root = freshRoot();
  writeJob(root, { jobId: 'j1', createdAt: '2026-08-16T10:00:00.000Z' });
  writeJob(root, { jobId: 'j2', createdAt: '2026-08-16T12:00:00.000Z' });
  assert.deepEqual(listJobs(root).map(j => j.jobId), ['j2', 'j1']);
});

// ── findActiveJob: liveness is checked, never assumed ────────────────────────────────
//
// The dashboard restarts on every deploy and an agent can be OOM-killed. A lock file
// left behind by either would block every future launch with nothing saying why, so
// "is a run active" is answered by asking the OS about the pid, not by a lock.

test('a running job with a live pid is active', () => {
  const root = freshRoot();
  writeJob(root, { jobId: 'j1', status: 'running', pid: 999, createdAt: new Date().toISOString() });
  assert.equal(findActiveJob(root, { isAlive: () => true }).jobId, 'j1');
});

test('a running job whose process is gone is NOT active', () => {
  const root = freshRoot();
  writeJob(root, { jobId: 'j1', status: 'running', pid: 999, createdAt: new Date().toISOString() });
  assert.equal(findActiveJob(root, { isAlive: () => false }), null);
});

test('a complete job is never active, however alive its pid looks', () => {
  const root = freshRoot();
  writeJob(root, { jobId: 'j1', status: 'complete', pid: 999, createdAt: new Date().toISOString() });
  assert.equal(findActiveJob(root, { isAlive: () => true }), null);
});

// A job is 'pending' for the moment between the route writing it and the child booting
// up to claim it. Without a grace window a double-click launches two paid runs.
test('a just-created pending job with no pid is active during the grace window', () => {
  const root = freshRoot();
  const now = Date.parse('2026-08-16T12:00:00.000Z');
  writeJob(root, { jobId: 'j1', status: 'pending', createdAt: '2026-08-16T11:59:50.000Z' });
  assert.equal(findActiveJob(root, { now, isAlive: () => false }).jobId, 'j1');
});

test('a pending job that never claimed a pid goes stale and stops blocking', () => {
  const root = freshRoot();
  const now = Date.parse('2026-08-16T12:00:00.000Z');
  writeJob(root, { jobId: 'j1', status: 'pending', createdAt: '2026-08-16T11:50:00.000Z' });
  assert.equal(findActiveJob(root, { now, isAlive: () => false }), null);
});

// Gemini's project quota is a hard 250 renders/day. The form shows what today has
// already spent so the operator is not told about it by a 429 nineteen hours long.
test('rendersToday sums todays jobs only', () => {
  const root = freshRoot();
  const now = Date.parse('2026-08-16T12:00:00.000Z');
  writeJob(root, { jobId: 'j1', createdAt: '2026-08-16T01:00:00.000Z', totals: { renders: 6 } });
  writeJob(root, { jobId: 'j2', createdAt: '2026-08-16T09:00:00.000Z', totals: { renders: 12 } });
  writeJob(root, { jobId: 'j3', createdAt: '2026-08-15T23:00:00.000Z', totals: { renders: 90 } });
  assert.equal(rendersToday(root, { now }), 18);
});

test('rendersToday tolerates a job with no totals yet', () => {
  const root = freshRoot();
  const now = Date.parse('2026-08-16T12:00:00.000Z');
  writeJob(root, { jobId: 'j1', createdAt: '2026-08-16T01:00:00.000Z' });
  assert.equal(rendersToday(root, { now }), 0);
});

// Job files are a few KB and the run's own run.json is the permanent record. This
// project has already lost four days of cron to a full disk; nothing on that box
// accumulates without a sweep.
test('prune removes job files older than the window and keeps the rest', () => {
  const root = freshRoot();
  const now = Date.parse('2026-08-16T12:00:00.000Z');
  writeJob(root, { jobId: 'old', createdAt: '2026-08-10T12:00:00.000Z' });
  writeJob(root, { jobId: 'new', createdAt: '2026-08-16T11:00:00.000Z' });
  assert.deepEqual(pruneJobs(root, { now }), ['old']);
  assert.equal(readJob(root, 'old'), null);
  assert.equal(readJob(root, 'new').jobId, 'new');
});

test('prune on a directory that does not exist is a no-op', () => {
  assert.deepEqual(pruneJobs(freshRoot(), {}), []);
});
