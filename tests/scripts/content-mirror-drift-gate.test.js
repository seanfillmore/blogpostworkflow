// tests/scripts/content-mirror-drift-gate.test.js
//
// `scripts/check-content-mirrors.mjs` is the read-only mirror check, exiting
// 0/1/2/3. This pins the DETECTOR that puts it on a timer:
//
//   * it may never resync anything unattended. `scripts/reconcile-content-mirrors.mjs`
//     exists and is --apply-gated, so this cron line is one careless edit away
//     from a nightly overwrite of content.html — which would eventually fire
//     inside the minutes when agents/refresh-runner legitimately has a paid LLM
//     rewrite sitting in that file;
//   * it must speak through the 5 AM digest, deferred, never `immediate: true`;
//   * exit 2 (a local file is a DIFFERENT ARTICLE) and exit 3 (a post could not
//     be read) are the two cases a human needs. Exit 1 is the 0.25-0.75 band,
//     which the operator decided on 2026-08-24 to leave ADVISORY rather than
//     promote to a refusal — so it must not render as a daily failure.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyMirrorGateExit, GATE_ARGS } from '../../scripts/check-content-mirror-drift.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = readFileSync(join(ROOT, 'scripts', 'check-content-mirror-drift.mjs'), 'utf8');
const CRON = readFileSync(join(ROOT, 'scripts', 'setup-cron.sh'), 'utf8');

/**
 * Source with comments removed. The docstring explains at length why nothing
 * here is `immediate: true` and why it never resyncs, so a naive scan reads the
 * explanation as the offence.
 */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ── exit-code classification ─────────────────────────────────────────────────

test('exit 0 — every mirror matches live. Routine.', () => {
  const c = classifyMirrorGateExit(0);
  assert.equal(c.status, 'success');
  assert.equal(c.needsHuman, false);
});

test('exit 1 — the warn band is ADVISORY and must not render as a daily failure', () => {
  const c = classifyMirrorGateExit(1);
  assert.equal(c.status, 'success', 'a band we deliberately do not block on must not cry wolf every morning');
  assert.equal(c.needsHuman, false);
  assert.match(c.headline, /advisory/i, 'say why it is quiet, or the next reader will "fix" it');
  assert.match(c.headline, /reconcile-content-mirrors/, 'name the way out');
});

test('exit 2 — a different article, the case a human genuinely needs to see', () => {
  const c = classifyMirrorGateExit(2);
  assert.equal(c.status, 'error', 'must land in the digest Failures block');
  assert.equal(c.needsHuman, true);
  assert.match(c.headline, /DIFFERENT ARTICLE/);
  assert.match(c.headline, /REFUSES/, 'say that the live page is already protected, or this reads as an outage');
  assert.match(c.headline, /reconcile-content-mirrors/, 'say where to fix it');
});

test('exit 3 — a post on the box could not be read', () => {
  const c = classifyMirrorGateExit(3);
  assert.equal(c.status, 'error');
  assert.equal(c.needsHuman, true);
  assert.match(c.headline, /read|parse/i);
});

test('exit 64 — the check refused the invocation, which means the frozen args no longer fit', () => {
  const c = classifyMirrorGateExit(64);
  assert.equal(c.status, 'error');
  assert.equal(c.needsHuman, true);
  assert.match(c.headline, /GATE_ARGS/);
});

test('an exit code nobody has seen before is escalated, not swallowed', () => {
  const c = classifyMirrorGateExit(97);
  assert.equal(c.status, 'error');
  assert.equal(c.needsHuman, true);
  assert.match(c.headline, /97/);
});

test('no classification ever asks for an immediate email', () => {
  for (const code of [0, 1, 2, 3, 64, 97]) {
    assert.equal(classifyMirrorGateExit(code).immediate, false);
  }
});

// ── it cannot resync ─────────────────────────────────────────────────────────

test('the arguments handed to the check are frozen, empty, and carry no write flag', () => {
  assert.deepEqual(GATE_ARGS, []);
  assert.ok(Object.isFrozen(GATE_ARGS));
  for (const forbidden of ['--apply', '--snapshot-live']) {
    assert.ok(!GATE_ARGS.includes(forbidden), `${forbidden} must never be in the scheduled invocation`);
  }
});

test('the detector refuses --apply and --snapshot-live even if somebody types them', () => {
  assert.match(SRC, /--snapshot-live/, 'the refusal must name the flags it refuses');
  assert.match(SRC, /REFUS|refus/i);
});

test('the detector never spawns the reconciler — the resync script is not reachable from cron', () => {
  // The reconciler IS named in the headlines and the digest body, deliberately:
  // a human reading the row needs to be told where to go. What must not exist
  // is a code path that RUNS it. So this counts child processes rather than
  // scanning for the string.
  const spawns = [...CODE.matchAll(/\b(?:spawnSync|spawn|execFileSync|execFile|execSync|exec)\s*\(/g)];
  assert.equal(spawns.length, 1, `expected exactly one child process, found ${spawns.length}`);

  const call = CODE.slice(CODE.indexOf('spawnSync('));
  const args = call.slice(0, call.indexOf('\n  });'));
  assert.match(args, /check-content-mirrors\.mjs/, 'the one child process is the read-only check');
  assert.doesNotMatch(args, /reconcile-content-mirrors/, 'a scheduled run must never invoke the resync');
});

test('the detector notifies deferred — no immediate: true in the CODE', () => {
  assert.match(CODE, /from '\.\.\/lib\/notify\.js'/);
  assert.doesNotMatch(CODE, /immediate:\s*true/);
  assert.match(CODE, /await notify\(/, 'the notification must be awaited, or a cron exit can race it');
});

test('it uses the one isDirectRun predicate, so importing it here runs nothing', () => {
  assert.match(SRC, /isDirectRun/);
});

// ── the schedule, and the mirror ─────────────────────────────────────────────

test('setup-cron.sh defines the job AND installs it', () => {
  assert.match(CRON, /^DAILY_CONTENT_MIRROR_GATE=/m, 'job variable must be defined');
  assert.match(CRON, /^\$DAILY_CONTENT_MIRROR_GATE$/m, 'a variable never referenced in NEW_CRONTAB installs nothing');
});

test('the job runs at 12:20 UTC daily, between three UTC landmarks DST cannot move', () => {
  const line = CRON.match(/^DAILY_CONTENT_MIRROR_GATE="(.*)"$/m);
  assert.ok(line, 'expected DAILY_CONTENT_MIRROR_GATE');
  assert.match(line[1], /^20 12 \* \* \* /, 'schedule must be 20 12 * * * (UTC)');
  assert.match(line[1], /scripts\/check-content-mirror-drift\.mjs/);
  assert.ok(!/--apply/.test(line[1]), 'the cron line must never carry --apply');
  assert.ok(!/--snapshot-live/.test(line[1]), 'the cron line must never capture live bodies on a timer');
  assert.ok(!/\bTZ=/.test(line[1]), 'a TZ= prefix schedules nothing on this host');
});

test('it does not collide with the post-meta gate or the digest', () => {
  const at = (name) => {
    const m = CRON.match(new RegExp(`^${name}="(\\d+) (\\d+) `, 'm'));
    assert.ok(m, `expected ${name}`);
    return Number(m[2]) * 60 + Number(m[1]);
  };
  const mirror = at('DAILY_CONTENT_MIRROR_GATE');
  const meta = at('DAILY_POST_META_GATE');
  const digest = at('DAILY_SUMMARY');
  assert.ok(mirror < meta, 'the two cheap detectors must not share a slot');
  assert.ok(mirror < digest, 'the row has to land in the SAME morning digest, not tomorrow\'s');
  assert.ok(digest - mirror <= 60, 'and not so early that it reports a tree the pipeline has not settled');
});
