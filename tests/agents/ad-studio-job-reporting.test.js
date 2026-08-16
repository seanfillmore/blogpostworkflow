import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs, createJobReporter } from '../../agents/ad-studio/index.js';
import { writeJob, readJob } from '../../lib/ad-studio-job.js';

const freshRoot = () => mkdtempSync(join(tmpdir(), 'ad-studio-report-'));

const baseArgv = ['--product', 'coconut-lotion', '--formats', 'manifesto'];

test('--job-id is parsed, and absent by default', () => {
  assert.equal(parseArgs(baseArgv).jobId, null);
  assert.equal(parseArgs([...baseArgv, '--job-id', 'j1']).jobId, 'j1');
});

test('a job id with a path separator is rejected at parse time', () => {
  assert.throws(() => parseArgs([...baseArgv, '--job-id', '../escape']), /job-id/);
});

// THE LOAD-BEARING PROPERTY. Every CLI run in this repo's history passes no --job-id.
// If the reporter did anything at all without one, every existing invocation would
// start writing files it never wrote before.
test('with no job id every reporter method is a silent no-op', () => {
  const root = freshRoot();
  const r = createJobReporter({ root, jobId: null });
  r.start({ pid: 1 });
  r.event({ stage: 'render' });
  r.finish({ runId: 'x' });
  r.fail(new Error('boom'));
  assert.equal(readJob(root, 'null'), null);
});

test('start claims the job: running, with the pid and the run id', () => {
  const root = freshRoot();
  writeJob(root, { jobId: 'j1', status: 'pending', createdAt: new Date().toISOString() });
  createJobReporter({ root, jobId: 'j1' }).start({ pid: 4242, runId: 'coconut-lotion-2026' });
  const job = readJob(root, 'j1');
  assert.equal(job.status, 'running');
  assert.equal(job.pid, 4242);
  assert.equal(job.runId, 'coconut-lotion-2026');
  assert.ok(job.startedAt);
});

test('events accumulate on the job', () => {
  const root = freshRoot();
  writeJob(root, { jobId: 'j1', status: 'pending', createdAt: new Date().toISOString() });
  const r = createJobReporter({ root, jobId: 'j1' });
  r.start({ pid: 1 });
  r.event({ stage: 'copy', concept: 'manifesto', state: 'ok' });
  r.event({ stage: 'render', concept: 'manifesto', variation: 1, artifact: 'plate-1x1.png', state: 'accepted', attempts: 1 });
  const job = readJob(root, 'j1');
  assert.equal(job.events.length, 2);
  assert.equal(job.events[1].artifact, 'plate-1x1.png');
});

test('finish records the totals and the terminal status', () => {
  const root = freshRoot();
  writeJob(root, { jobId: 'j1', status: 'pending', createdAt: new Date().toISOString() });
  const r = createJobReporter({ root, jobId: 'j1' });
  r.start({ pid: 1 });
  r.finish({ runId: 'r1', totals: { renders: 6, artifacts: { accepted: 3, total: 3 } } });
  const job = readJob(root, 'j1');
  assert.equal(job.status, 'complete');
  assert.equal(job.totals.renders, 6);
  assert.ok(job.finishedAt);
});

test('fail records the message, never the stack, and never the environment', () => {
  const root = freshRoot();
  writeJob(root, { jobId: 'j1', status: 'pending', createdAt: new Date().toISOString() });
  const r = createJobReporter({ root, jobId: 'j1' });
  r.start({ pid: 1 });
  r.fail(new Error('ad-studio: --formats is required'));
  const job = readJob(root, 'j1');
  assert.equal(job.status, 'error');
  assert.equal(job.error, 'ad-studio: --formats is required');
  assert.equal(job.stack, undefined);
  assert.ok(job.finishedAt);
});

// A job-file problem must never turn a successful paid run into a crash. This is the
// same posture archiveRunOutput takes: the images are on disk by then.
test('a reporter whose job file has vanished swallows the error', () => {
  const root = freshRoot();
  const r = createJobReporter({ root, jobId: 'gone' });
  assert.doesNotThrow(() => { r.start({ pid: 1 }); r.event({ stage: 'render' }); r.finish({}); });
});
