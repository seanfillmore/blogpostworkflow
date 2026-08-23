import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { isDirectRun } from '../../lib/is-direct-run.js';

// A real file that certainly exists, so realpathSync has something to resolve.
const SELF = new URL(import.meta.url).pathname;
const SELF_URL = import.meta.url;

test('true when the module IS the entry point (exact path match)', () => {
  assert.equal(isDirectRun(SELF_URL, SELF), true);
});

test('false when a DIFFERENT file is the entry point (the import case)', () => {
  // This is the shape that matters: a test runner is argv[1], the agent is not.
  assert.equal(isDirectRun(pathToFileURL('/repo/agents/editor/index.js').href, '/repo/tests/editor.test.js'), false);
});

test('false when there is no entry point at all', () => {
  // null / '' mean "no entry point" and must answer false...
  assert.equal(isDirectRun(SELF_URL, null), false);
  assert.equal(isDirectRun(SELF_URL, ''), false);
});

test('an explicitly-undefined entryPath falls back to process.argv[1], it does not mean "none"', () => {
  // JS default parameters fire on `undefined`, so callers cannot express "no
  // entry point" by passing undefined — that is the documented default path.
  // Under `node --test <this file>`, argv[1] IS this file, so it reads true.
  assert.equal(isDirectRun(SELF_URL, undefined), isDirectRun(SELF_URL, process.argv[1]));
});

test('false when import.meta.url is missing', () => {
  assert.equal(isDirectRun(undefined, SELF), false);
  assert.equal(isDirectRun('', SELF), false);
});

test('false for a non-file URL rather than throwing', () => {
  assert.doesNotThrow(() => isDirectRun('https://example.com/x.js', SELF));
  assert.equal(isDirectRun('https://example.com/x.js', SELF), false);
});

test('non-existent paths that are string-equal still count as a direct run', () => {
  // realpathSync would throw on both; the exact compare must answer first, or a
  // scheduled agent silently becomes a no-op that still exits 0.
  const p = '/definitely/not/on/disk/agents/foo/index.js';
  assert.equal(isDirectRun(pathToFileURL(p).href, p), true);
});

test('non-existent and different → false, without throwing', () => {
  assert.doesNotThrow(() =>
    isDirectRun(pathToFileURL('/nope/a/index.js').href, '/nope/b/index.js'));
  assert.equal(isDirectRun(pathToFileURL('/nope/a/index.js').href, '/nope/b/index.js'), false);
});

test('matches the entry point through a symlinked path', async () => {
  const { mkdtempSync, symlinkSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'idr-'));
  try {
    const real = join(dir, 'index.js');
    const link = join(dir, 'linked.js');
    writeFileSync(real, '');
    symlinkSync(real, link);
    // module resolved via the real path, process launched via the symlink
    assert.equal(isDirectRun(pathToFileURL(real).href, link), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
