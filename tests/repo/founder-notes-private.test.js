/**
 * Founder notes must never be committed: the repository is PUBLIC and the
 * notes hold Sean's private answers. Pinned both ways: ignored, and untracked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' });

test('data/founder-notes/notes.jsonl is gitignored', () => {
  assert.match(git('check-ignore', '-v', '--no-index', 'data/founder-notes/notes.jsonl'), /founder-notes/);
});

test('question sets are gitignored too', () => {
  assert.match(git('check-ignore', '--no-index', 'data/founder-notes/questions/2026-W43.json'), /founder-notes/);
});

test('nothing under data/founder-notes/ is tracked', () => {
  assert.equal(git('ls-files', 'data/founder-notes').trim(), '');
});
