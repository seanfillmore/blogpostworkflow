// The scheduled mirror reconcile is the ONE job in this fleet allowed to
// overwrite data/posts/<slug>/content.html unattended. Everything here exists to
// pin the reason that is safe: the scope. Widen it and the job becomes the
// nightly resync that scripts/check-content-mirror-drift.mjs was built to refuse
// — the one that eventually lands inside a refresh-runner window and destroys a
// paid LLM rewrite.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SCOPE_ARGS, classifyReconcileExit, parseCounts,
} from '../../scripts/reconcile-content-mirrors-nightly.mjs';
import { inOutageScope, inDefaultScope } from '../../lib/content-reconcile.js';
import { DIFFERENT_ARTICLE_MAX, DIVERGENT_WARN_MAX } from '../../lib/content-mirror.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// ── The scope is the whole safety argument ──────────────────────────────────

test('the scheduled scope is different-article ONLY and is frozen', () => {
  assert.deepEqual(SCOPE_ARGS, ['--only-different-article']);
  assert.ok(Object.isFrozen(SCOPE_ARGS), 'a mutable scope is a scope that widens');
});

test('inOutageScope takes the different-article tier and nothing else', () => {
  assert.equal(inOutageScope({ tier: 'different-article', blockSimilarity: 0.2 }), true);
  // The warn band is IN the default (hand-run) scope and OUT of the scheduled one.
  // That difference is the entire reason this job may apply.
  const warn = { tier: 'divergent', blockSimilarity: 0.5 };
  assert.equal(inDefaultScope(warn), true, 'the warn band is still a hand-run concern');
  assert.equal(inOutageScope(warn), false, 'the warn band must never be swept on a timer');
  assert.equal(inOutageScope({ tier: 'divergent', blockSimilarity: 0.9 }), false);
  assert.equal(inOutageScope({ tier: 'cosmetic', blockSimilarity: 1 }), false);
  assert.equal(inOutageScope(null), false);
});

test('the excluded band is where a real refresh lives — 3x margin, measured', () => {
  // The deepest legitimate content-refresher rewrite on record scored 0.775
  // block similarity against the file it was generated from. If a change ever
  // moves these constants such that a real refresh could be classified as a
  // different article, this job starts overwriting paid LLM rewrites.
  const DEEPEST_REAL_REFRESH = 0.775;
  assert.ok(DEEPEST_REAL_REFRESH > DIVERGENT_WARN_MAX,
    'a real refresh sits above the warn band, which is why the band is excluded rather than the tier');
  assert.ok(DIFFERENT_ARTICLE_MAX * 3 <= DEEPEST_REAL_REFRESH,
    'the outage tier must stay at least 3x below a measured real refresh');
  assert.equal(inOutageScope({ tier: 'divergent', blockSimilarity: DEEPEST_REAL_REFRESH }), false);
});

// ── The job cannot be talked out of its scope ───────────────────────────────

test('the job spawns the reconciler and nothing else', () => {
  const src = read('scripts/reconcile-content-mirrors-nightly.mjs');
  const spawns = src.match(/spawnSync\(/g) || [];
  assert.equal(spawns.length, 1, 'one child process: the reconciler');
  assert.match(src, /reconcile-content-mirrors\.mjs/);
});

test('the job refuses the two flags that would leave the outage tier', () => {
  const src = read('scripts/reconcile-content-mirrors-nightly.mjs');
  assert.match(src, /for \(const forbidden of \['--all', '--slug'\]\)/);
  assert.match(src, /return 64/);
});

test('the reconciler itself refuses to combine the scope with a wider one', () => {
  // Belt and braces: even a hand-typed command cannot ask for
  // "different-article only" AND "everything" and get a quiet answer.
  const src = read('scripts/reconcile-content-mirrors.mjs');
  assert.match(src, /outageOnly && \(sweepAll \|\| onlySlug\)/);
  assert.match(src, /process\.exit\(64\)/);
});

test('a HOLD is still reported whatever the scope', () => {
  // Scoping holds away is the single arrangement that hides the genuinely-ahead
  // post the reconciler exists to protect.
  const src = read('scripts/reconcile-content-mirrors.mjs');
  assert.match(src, /decision\.action !== 'hold'/);
});

// ── Severity: doing the work is not a failure ───────────────────────────────

test('reconciling mirrors is success, not a failure row', () => {
  const done = classifyReconcileExit(0, { reconciled: 12, held: 0 });
  assert.equal(done.status, 'success');
  assert.equal(done.needsHuman, false);
  assert.match(done.headline, /Reconciled 12/);

  const quiet = classifyReconcileExit(0, { reconciled: 0, held: 0 });
  assert.equal(quiet.status, 'success');
  assert.match(quiet.headline, /No different-article mirrors/);
});

test('a HOLD is the guards working, never a failure', () => {
  // Found by DRY-RUNNING THIS JOB AGAINST PRODUCTION, which exited 1 with two
  // `local-ahead` holds — the standing residual state — and the first version of
  // this classifier called that breakage. `local-ahead` means the local file
  // holds text live does not, usually an unpublished edit, so refusing to
  // overwrite it is the most important thing this job does. Reporting it as a
  // broken agent is precisely backwards, and is the same defect PR #850 and #851
  // fixed elsewhere in the fleet.
  const held = classifyReconcileExit(1, { reconciled: 0, held: 2 });
  assert.equal(held.status, 'success');
  assert.equal(held.needsHuman, false);
  assert.match(held.headline, /Held 2 back/);
  assert.match(held.headline, /policy working/);
});

test('an UNREADABLE post is a real failure — that split is the point', () => {
  // exit 3, not 1. A file nobody can read is silent otherwise: every reader in
  // the fleet catch{}s it and carries on as though it were empty.
  const unreadable = classifyReconcileExit(3, { reconciled: 0, held: 0 });
  assert.equal(unreadable.status, 'error');
  assert.equal(unreadable.needsHuman, true);
  assert.match(unreadable.headline, /could not be READ/);
});

test('a refused argument and an unknown exit are failures', () => {
  assert.equal(classifyReconcileExit(64, {}).status, 'error');
  assert.match(classifyReconcileExit(64, {}).headline, /SCOPE_ARGS is a frozen/);
  for (const code of [2, 70, -1]) {
    assert.equal(classifyReconcileExit(code, {}).status, 'error', `exit ${code} is unclassifiable`);
  }
});

test('the classifier matches the reconciler’s ACTUAL exit codes', () => {
  // The mapping above is only correct while the reconciler still means what it
  // meant. Pin the source line rather than trusting a comment.
  const src = read('scripts/reconcile-content-mirrors.mjs');
  assert.match(src, /process\.exitCode = unreadable\.length \? 3 : held\.length \? 1 : 0/,
    'if these codes move, classifyReconcileExit must move with them');
});

test('nothing here is ever immediate', () => {
  for (const code of [0, 1, 3, 64]) {
    assert.equal(classifyReconcileExit(code, {}).immediate, false);
  }
});

test('counts are read off the reconciler’s own summary', () => {
  assert.deepEqual(
    parseCounts('34 considered, 30 reconciled, 4 held'),
    { reconciled: 30, held: 4 },
  );
  assert.deepEqual(parseCounts(''), { reconciled: 0, held: 0 });
});

// ── The detector stays a detector ───────────────────────────────────────────

test('the 12:20 detector is untouched and still cannot apply', () => {
  // The two jobs are separate on purpose: this one does the work, that one is
  // the independent check on whether the work happened. Folding them together
  // would make the thing doing the work the thing grading it.
  const src = read('scripts/check-content-mirror-drift.mjs');
  assert.match(src, /export const GATE_ARGS = Object\.freeze\(\[\]\)/);
  assert.match(src, /for \(const forbidden of \['--apply', '--snapshot-live'\]\)/);
  // It NAMES the reconciler in its digest body on purpose — a human reading the
  // row has to be told where to go — so the check is what it SPAWNS, never
  // whether the string appears.
  const spawned = [...src.matchAll(/spawnSync\([^)]*?'scripts',\s*'([\w.-]+)'/gs)].map((m) => m[1]);
  assert.deepEqual(spawned, ['check-content-mirrors.mjs'],
    'the detector may spawn only the read-only check');
});

// ── Scheduling ──────────────────────────────────────────────────────────────

test('the reconcile is scheduled before the detector and far from the scheduler', () => {
  const cron = read('scripts/setup-cron.sh');
  const line = cron.match(/^DAILY_CONTENT_MIRROR_RECONCILE="(\d+) (\d+) /m);
  assert.ok(line, 'the job must be in the version-controlled crontab mirror');
  const [, minute, hour] = line;
  const reconcileAt = Number(hour) * 60 + Number(minute);

  const gate = cron.match(/^DAILY_CONTENT_MIRROR_GATE="(\d+) (\d+) /m);
  const gateAt = Number(gate[2]) * 60 + Number(gate[1]);
  assert.ok(reconcileAt < gateAt, 'the detector must grade the state the reconcile left behind');

  // refresh-runner moves a paid rewrite into content.html during the 15:00 UTC
  // scheduler run. Keep a wide margin from it.
  const SCHEDULER_AT = 15 * 60;
  assert.ok(SCHEDULER_AT - reconcileAt >= 120,
    'at least two hours clear of the scheduler, so no in-flight rewrite is exposed');
  // Scoped to JOB lines: the file carries a comment documenting the historical
  // TZ= bug, and that comment is the record of why this rule exists.
  const jobLines = cron.split('\n').filter((l) => /^[A-Z_]+="\d/.test(l));
  for (const line of jobLines) {
    assert.doesNotMatch(line, /TZ=/, `a TZ= prefix schedules nothing on this host: ${line.slice(0, 60)}`);
  }
  assert.ok(jobLines.length > 40, 'sanity: the job lines were actually found');
});

test('the reconcile job is actually installed by the crontab mirror', () => {
  const cron = read('scripts/setup-cron.sh');
  assert.match(cron, /^\$DAILY_CONTENT_MIRROR_RECONCILE$/m,
    'defining the variable without emitting it is a job nobody runs');
});
