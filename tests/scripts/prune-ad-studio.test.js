import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { planPrune, assertSafeTarget, DAY_MS } from '../../scripts/prune-ad-studio.mjs';

const SCRIPT = fileURLToPath(new URL('../../scripts/prune-ad-studio.mjs', import.meta.url));

// All fixtures live under a fresh mkdtemp root per test, ending in
// data/creatives/ad-studio so assertSafeTarget accepts them without weakening the
// real safety check. Never touches the real data/ tree.
function makeTargetDir(t) {
  const root = mkdtempSync(join(tmpdir(), 'ad-studio-prune-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const targetDir = join(root, 'data', 'creatives', 'ad-studio');
  mkdirSync(targetDir, { recursive: true });
  return targetDir;
}

function daysAgoIso(days) {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

function setMtimeDaysAgo(path, days) {
  const t = new Date(Date.now() - days * DAY_MS);
  utimesSync(path, t, t);
}

/**
 * Write a run fixture matching what agents/ad-studio/index.js actually produces:
 * run.json (unless `aborted`) + per-concept copy.json/demand-gen-assets.json +
 * one image + proof.json per variation directory. `variations` mirrors run.json's
 * results[].variations shape: [{ n, ok }].
 *
 * An aborted run gets no run.json at all — its age is carried on the run
 * directory's own mtime instead, exactly what runAgeMs falls back to.
 */
function writeRun({ targetDir, runId, ageDays, aborted = false, conceptSlug = 'ingredient-callout', variations = [{ n: 1, ok: true }] }) {
  const runDir = join(targetDir, runId);
  mkdirSync(runDir, { recursive: true });

  if (!aborted) {
    const report = {
      runId,
      generatedAt: daysAgoIso(ageDays),
      results: [{ conceptSlug, format: conceptSlug, variations }],
    };
    writeFileSync(join(runDir, 'run.json'), JSON.stringify(report, null, 2));
  }

  const conceptDir = join(runDir, conceptSlug);
  mkdirSync(conceptDir, { recursive: true });
  writeFileSync(join(conceptDir, 'copy.json'), JSON.stringify({ zones: {}, claims: [] }));
  writeFileSync(join(conceptDir, 'demand-gen-assets.json'), JSON.stringify({}));

  for (const v of variations) {
    const vDir = join(conceptDir, `v${v.n}`);
    mkdirSync(vDir, { recursive: true });
    writeFileSync(join(vDir, 'finished-1x1.png'), Buffer.from('fake-image-bytes'));
    writeFileSync(join(vDir, 'proof.json'), JSON.stringify({ ok: v.ok }));
  }

  if (aborted) setMtimeDaysAgo(runDir, ageDays);

  return runDir;
}

function allPaths(plan) {
  return plan.runs.flatMap(r => r.files.map(f => f.path));
}

test('a JSON file is never selected for deletion, at any age', (t) => {
  const targetDir = makeTargetDir(t);
  // Deliberately push this run well past BOTH the grace period and the retention
  // window, with a mix of accepted and rejected variations — the scenario most
  // likely to sweep up a JSON file if the image/JSON distinction were ever dropped.
  writeRun({
    targetDir,
    runId: 'run-json-safety',
    ageDays: 200,
    variations: [{ n: 1, ok: true }, { n: 2, ok: false }],
  });

  const plan = planPrune({ targetDir, rejectedDays: 7, runDays: 90 });
  const paths = allPaths(plan);

  assert.ok(paths.length > 0, 'sanity check: the fixture should have selected something');
  assert.ok(
    paths.every(p => !p.toLowerCase().endsWith('.json')),
    `no JSON path should ever be selected for deletion, got: ${JSON.stringify(paths.filter(p => p.endsWith('.json')))}`
  );
});

test("an accepted variation's images survive past the rejected grace period", (t) => {
  const targetDir = makeTargetDir(t);
  // 20 days: past the 7-day rejected grace period, but well inside the 90-day
  // retention window. If accept/reject were ignored this would be wrongly pruned.
  writeRun({ targetDir, runId: 'run-accepted-survives', ageDays: 20, variations: [{ n: 1, ok: true }] });

  const plan = planPrune({ targetDir, rejectedDays: 7, runDays: 90 });

  assert.equal(plan.totals.files, 0, 'an accepted variation inside the retention window must not be pruned');
});

test('a rejected variation is selected only after the grace period', (t) => {
  const targetDir = makeTargetDir(t);
  writeRun({ targetDir, runId: 'run-fresh-rejected', ageDays: 3, variations: [{ n: 1, ok: false }] });
  writeRun({ targetDir, runId: 'run-stale-rejected', ageDays: 10, variations: [{ n: 1, ok: false }] });

  const plan = planPrune({ targetDir, rejectedDays: 7, runDays: 90 });
  const fresh = plan.runs.find(r => r.runId === 'run-fresh-rejected');
  const stale = plan.runs.find(r => r.runId === 'run-stale-rejected');

  assert.equal(fresh, undefined, 'a rejected variation still inside the grace period must not be pruned yet');
  assert.ok(stale, 'a rejected variation past the grace period must be selected');
  assert.ok(stale.files.some(f => f.path.endsWith('.png')));
});

test('everything in a run past the retention window is selected except JSON', (t) => {
  const targetDir = makeTargetDir(t);
  // 120 days: past the 90-day retention window. Include one accepted and one
  // rejected variation — the retention window applies "accepted or not".
  writeRun({
    targetDir,
    runId: 'run-past-retention',
    ageDays: 120,
    variations: [{ n: 1, ok: true }, { n: 2, ok: false }],
  });

  const plan = planPrune({ targetDir, rejectedDays: 7, runDays: 90 });
  const run = plan.runs.find(r => r.runId === 'run-past-retention');

  assert.ok(run, 'the expired run must be selected');
  assert.ok(run.files.some(f => f.path.includes(`${join('v1', 'finished-1x1.png')}`)), 'the ACCEPTED variation image must be selected too');
  assert.ok(run.files.some(f => f.path.includes(`${join('v2', 'finished-1x1.png')}`)), 'the rejected variation image must be selected');
  assert.equal(run.files.length, 2, 'one image per variation, both selected');
  assert.ok(run.files.every(f => !f.path.endsWith('.json')), 'JSON must still be excluded even past the retention window');
});

test('a run directory with no run.json has its images treated as rejected, not accepted, not skipped', (t) => {
  const targetDir = makeTargetDir(t);
  // ok:true in the fixture writer is irrelevant here — aborted:true means no
  // run.json is ever written, so there is no accepted/rejected data to read.
  writeRun({ targetDir, runId: 'run-aborted-fresh', ageDays: 3, aborted: true, variations: [{ n: 1, ok: true }] });
  writeRun({ targetDir, runId: 'run-aborted-stale', ageDays: 10, aborted: true, variations: [{ n: 1, ok: true }] });

  const plan = planPrune({ targetDir, rejectedDays: 7, runDays: 90 });
  const fresh = plan.runs.find(r => r.runId === 'run-aborted-fresh');
  const stale = plan.runs.find(r => r.runId === 'run-aborted-stale');

  assert.equal(
    fresh, undefined,
    'a very recent aborted run still gets the same grace period as a rejected variation — not pruned immediately'
  );
  assert.ok(
    stale,
    'an aborted run past the grace period must be pruned — proves its images are NOT treated as accepted (which would keep them forever) and are NOT skipped (which would also keep them forever)'
  );
  assert.equal(stale.aborted, true);
});

test('dry-run selects but deletes nothing', (t) => {
  const targetDir = makeTargetDir(t);
  const runDir = writeRun({ targetDir, runId: 'run-dry-run-check', ageDays: 120, variations: [{ n: 1, ok: true }] });
  const imagePath = join(runDir, 'ingredient-callout', 'v1', 'finished-1x1.png');
  assert.ok(existsSync(imagePath), 'sanity check: fixture image exists before running');

  const out = execFileSync('node', [SCRIPT, '--dir', targetDir], { encoding: 'utf8' });

  assert.match(out, /DRY RUN/);
  assert.ok(existsSync(imagePath), 'dry run (no --apply) must not delete anything');
});

// Bonus coverage for the other non-negotiable safety rail named in the brief: the
// script refuses to operate on anything that doesn't resolve to data/creatives/ad-studio.
test('refuses to run against a target that does not end in data/creatives/ad-studio', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ad-studio-prune-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const wrongDir = join(root, 'data', 'creatives', 'session-1234');
  mkdirSync(wrongDir, { recursive: true });

  assert.throws(() => assertSafeTarget(wrongDir), /does not end in/);
});
