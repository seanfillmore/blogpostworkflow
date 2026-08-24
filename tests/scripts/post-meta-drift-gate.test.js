// tests/scripts/post-meta-drift-gate.test.js
//
// scripts/reconcile-post-metas.mjs is the deploy-time semantic merge for
// data/posts/*/meta.json. It is dry by default and exits 0/1/2/3. This pins the
// DETECTOR that puts it on a timer:
//
//   * it may never fix anything unattended — a reconcile that applied on a
//     timer would resolve conflicts nobody reviewed, and the run that
//     permanently destroyed three paid-for briefs on 2026-08-19 is what a
//     scheduled write looks like when it is wrong;
//   * it must speak through the 5 AM digest, deferred, never `immediate: true`;
//   * exit 2 (a field changed on both sides with no owner) and exit 3 (a file
//     on the box already does not parse) are the two cases a human needs to
//     see, so they render in the digest's Failures block. Exit 1 is the
//     ordinary steady state of a box whose cron writes these files all day and
//     must not cry wolf.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyGateExit, GATE_ARGS } from '../../scripts/check-post-meta-drift.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = readFileSync(join(ROOT, 'scripts', 'check-post-meta-drift.mjs'), 'utf8');
const CRON = readFileSync(join(ROOT, 'scripts', 'setup-cron.sh'), 'utf8');

/**
 * Source with comments removed. The docstring explains at length why nothing
 * here is `immediate: true`, so a naive scan for that string reads the
 * explanation as the offence.
 */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ── exit-code classification ─────────────────────────────────────────────────

test('exit 0 — in sync, routine', () => {
  const c = classifyGateExit(0);
  assert.equal(c.status, 'success');
  assert.equal(c.needsHuman, false);
});

test('exit 1 — diverged, and that is the EXPECTED state of a live box', () => {
  const c = classifyGateExit(1);
  assert.equal(c.status, 'success', 'routine divergence must not render as a failure every single day');
  assert.equal(c.needsHuman, false);
});

test('exit 2 — unclassified field, the case a human genuinely needs to see', () => {
  const c = classifyGateExit(2);
  assert.equal(c.status, 'error', 'must land in the digest Failures block');
  assert.equal(c.needsHuman, true);
  assert.match(c.headline, /FIELD_OWNERS|unclassified/i);
  assert.match(c.headline, /lib\/post-meta-reconcile\.js/, 'say where to fix it');
});

test('exit 3 — a meta.json on the box will not parse', () => {
  const c = classifyGateExit(3);
  assert.equal(c.status, 'error');
  assert.equal(c.needsHuman, true);
  assert.match(c.headline, /parse|conflict/i);
});

test('an exit code nobody has seen before is escalated, not swallowed', () => {
  const c = classifyGateExit(97);
  assert.equal(c.status, 'error');
  assert.equal(c.needsHuman, true);
  assert.match(c.headline, /97/);
});

test('no classification ever asks for an immediate email', () => {
  for (const code of [0, 1, 2, 3, 97]) {
    assert.notEqual(classifyGateExit(code).immediate, true);
  }
});

// ── it cannot fix anything ───────────────────────────────────────────────────

test('the arguments handed to the reconcile script are fixed and contain no write flag', () => {
  assert.deepEqual(GATE_ARGS, ['--ref', 'origin/main', '--no-run-record']);
  for (const forbidden of ['--apply', '--snapshot', '--against']) {
    assert.ok(!GATE_ARGS.includes(forbidden), `${forbidden} must never be in the scheduled invocation`);
  }
});

test('the detector refuses --apply even if somebody types it', () => {
  assert.match(SRC, /--apply/, 'the refusal must name the flag it refuses');
  assert.match(SRC, /REFUS|refus/i);
});

test('the detector notifies deferred — no immediate: true in the CODE', () => {
  assert.match(CODE, /from '\.\.\/lib\/notify\.js'/);
  assert.doesNotMatch(CODE, /immediate:\s*true/);
  assert.match(CODE, /await notify\(/, 'the notification must be awaited, or a cron exit can race it');
});

test('the classification itself never carries immediate: true', () => {
  for (const code of [0, 1, 2, 3, 97]) {
    assert.equal(classifyGateExit(code).immediate, false);
  }
});

test('it uses the one isDirectRun predicate, so importing it here runs nothing', () => {
  assert.match(SRC, /isDirectRun/);
});

// ── the schedule, and the mirror ─────────────────────────────────────────────

test('setup-cron.sh defines the job AND installs it', () => {
  assert.match(CRON, /^DAILY_POST_META_GATE=/m, 'job variable must be defined');
  assert.match(CRON, /^\$DAILY_POST_META_GATE$/m, 'a variable never referenced in NEW_CRONTAB installs nothing');
});

test('the job runs at 12:40 UTC daily — before the 13:00 UTC digest reads the JSONL', () => {
  const line = CRON.match(/^DAILY_POST_META_GATE="(.*)"$/m);
  assert.ok(line, 'expected DAILY_POST_META_GATE');
  assert.match(line[1], /^40 12 \* \* \* /, 'schedule must be 40 12 * * * (UTC)');
  assert.match(line[1], /scripts\/check-post-meta-drift\.mjs/);
  assert.ok(!/--apply/.test(line[1]), 'the cron line must never carry --apply');
});

test('no cron line on this host carries a TZ= prefix', () => {
  // `cron 3.0pl1` here supports neither CRON_TZ nor a TZ crontab variable, and
  // an inline `TZ=x cd ... && node` is a shell assignment scoped to `cd`. All
  // five such prefixes were inert twice over and were stripped on 2026-08-23.
  // Re-adding one does not move a job; it only misleads the next reader.
  for (const m of CRON.matchAll(/^[A-Z0-9_]+="([^"]*)"$/gm)) {
    assert.ok(!/\bTZ=/.test(m[1]), `a TZ= prefix schedules nothing on this host: ${m[1].slice(0, 80)}`);
  }
});
