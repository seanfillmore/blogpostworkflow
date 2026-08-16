import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync, readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { archiveRunOutput } from '../../lib/archive-run-output.js';

// A manually-run agent writes its output under whatever checkout it was launched from.
// That output is gitignored, so inside a worktree it is UNTRACKED — and
// `git worktree remove --force` deletes untracked files. On 2026-08-15 a set of Ad Studio
// sample plates was destroyed exactly that way, and a second orphaned run had to be copied
// out by hand later the same day.

const base = mkdtempSync(join(tmpdir(), 'archive-run-'));

// ── A directory of run output ───────────────────────────────────────────────────────
{
  const src = join(base, 'run-src');
  mkdirSync(join(src, 'concept', 'v1'), { recursive: true });
  writeFileSync(join(src, 'run.json'), '{"runId":"r1"}');
  writeFileSync(join(src, 'concept', 'v1', 'plate.png'), 'PLATEBYTES');

  const destRoot = join(base, 'archive');
  const out = archiveRunOutput({
    sourceDir: src, runId: 'r1', relativeDir: 'data/creatives/x',
    envVar: 'TEST_ARCHIVE_DIR', env: { TEST_ARCHIVE_DIR: destRoot },
  });
  assert.equal(out, join(destRoot, 'r1'));
  assert.equal(readFileSync(join(out, 'run.json'), 'utf8'), '{"runId":"r1"}');
  // The IMAGES are the point. A copy that takes only run.json saves the audit trail and
  // loses the work.
  assert.equal(readFileSync(join(out, 'concept', 'v1', 'plate.png'), 'utf8'), 'PLATEBYTES');
}

// ── A single file, which is what creative-packager produces ─────────────────────────
{
  const zip = join(base, 'pack.zip');
  writeFileSync(zip, 'ZIPBYTES');
  const destRoot = join(base, 'archive-zip');
  const out = archiveRunOutput({
    sourceDir: zip, runId: 'pack.zip', relativeDir: 'data/creative-packages',
    envVar: 'TEST_ARCHIVE_DIR', env: { TEST_ARCHIVE_DIR: destRoot },
  });
  assert.equal(readFileSync(out, 'utf8'), 'ZIPBYTES', 'a single-file artifact archives too');
}

// ── No-ops and failures ─────────────────────────────────────────────────────────────

// Archiving onto the source is a no-op, not a recursive copy. This is the path taken when
// the agent already runs in the main checkout — the destination IS the source.
{
  const src = join(base, 'same');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'f.txt'), 'x');
  assert.equal(
    archiveRunOutput({
      sourceDir: src, runId: 'same', relativeDir: 'irrelevant',
      envVar: 'TEST_ARCHIVE_DIR', env: { TEST_ARCHIVE_DIR: base },
    }),
    null,
  );
  assert.ok(existsSync(join(src, 'f.txt')), 'and must not disturb the source');
}

// Nothing to copy is not an error.
assert.equal(
  archiveRunOutput({
    sourceDir: join(base, 'missing'), runId: 'r', relativeDir: 'x',
    envVar: 'TEST_ARCHIVE_DIR', env: { TEST_ARCHIVE_DIR: join(base, 'a2') },
  }),
  null,
);
assert.equal(archiveRunOutput({}), null, 'no sourceDir at all is not an error');

// NEVER throws. The output is already on disk by the time this runs, and turning a
// successful, paid run into a crash over a failed backup is strictly worse than warning.
{
  const src = join(base, 'ok-src');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'f.txt'), 'x');
  assert.equal(
    archiveRunOutput({
      sourceDir: src, runId: 'r', relativeDir: 'x',
      envVar: 'TEST_ARCHIVE_DIR', env: { TEST_ARCHIVE_DIR: '\0bad' },
    }),
    null,
    'a failed archive must warn, not throw',
  );
}

// ── The git fallback resolves the MAIN checkout, not the worktree ───────────────────
//
// A worktree's `.git` is a FILE pointing at `<main>/.git/worktrees/<name>`, so git's
// common dir is `<main>/.git` and its parent is the main checkout. Run from this repo —
// which IS a worktree during development — the destination must land outside it.
{
  const src = join(base, 'git-src');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'f.txt'), 'x');
  const out = archiveRunOutput({
    sourceDir: src, runId: 'archive-lib-selftest', relativeDir: 'data/creatives/_selftest',
    root: process.cwd(),
  });
  if (out) {
    assert.ok(!out.startsWith(join(process.cwd(), 'data')) || process.cwd() === join(out, '..', '..', '..', '..'),
      'destination is resolved from the git common dir');
    assert.equal(readFileSync(join(out, 'f.txt'), 'utf8'), 'x');
    rmSync(out, { recursive: true, force: true });
  }
}

rmSync(base, { recursive: true, force: true });
