// tests/scripts/giveaway-draw-guards.test.js
//
// The guard that makes the manual commit step in the runbook safe. An operator
// who forgets to commit the snapshot must get a refusal, not an unprovable draw
// that nobody notices until someone asks how the winner was chosen.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertSnapshotCommitted } from '../../scripts/giveaway/draw.mjs';

const REL = 'data/giveaway/draw-snapshot.json';

function repoWith(contents, { commit = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'draw-guard-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: dir });
  mkdirSync(join(dir, 'data', 'giveaway'), { recursive: true });
  writeFileSync(join(dir, REL), contents);
  if (commit) {
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'snapshot'], { cwd: dir });
  }
  return dir;
}

test('a committed, unmodified snapshot passes the guard', () => {
  const dir = repoWith('{"ok":true}\n');
  assert.doesNotThrow(() => assertSnapshotCommitted(dir, REL));
});

test('an UNCOMMITTED snapshot is refused', () => {
  const dir = repoWith('{"ok":true}\n', { commit: false });
  assert.throws(() => assertSnapshotCommitted(dir, REL), /not committed/i);
});

test('a snapshot MODIFIED after commit is refused', () => {
  const dir = repoWith('{"ok":true}\n');
  writeFileSync(join(dir, REL), '{"ok":false}\n');
  assert.throws(() => assertSnapshotCommitted(dir, REL), /differs from the committed/i);
});

test('a missing snapshot is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'draw-guard-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  assert.throws(() => assertSnapshotCommitted(dir, REL), /missing/i);
});

test('REGRESSION: importing draw.mjs does not conduct a drawing', () => {
  // Importing a script module RUNS it across this fleet. Reaching this line at
  // all proves the guard held — the import at the top of this file would
  // otherwise have tried to draw, refused on the missing --seed, and killed the
  // test process with exit(1).
  assert.equal(typeof assertSnapshotCommitted, 'function');
});
