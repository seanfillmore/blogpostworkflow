// The recap reviewer writes server-only state (its report, its state file,
// backups of removed articles) and creates throwaway fix checkouts. None of it
// may be committed: the report and state are regenerated daily, and a removed
// article's backup holds live page content that belongs on the box only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function ignored(path) {
  try { execFileSync('git', ['check-ignore', '-q', '--', path], { cwd: ROOT }); return true; } catch { return false; }
}

test('recap reviewer output, removed-post backups and fix checkouts are gitignored', () => {
  const paths = [
    'data/reports/recap-reviewer/latest.json',
    'data/reports/recap-reviewer/state.json',
    'data/reports/recap-reviewer/done.json',
    'data/backups/removed-posts/some-post-2026-11-11.json',
    '.claude/worktrees/fix-agents-editor-2026-11-11/x.js',
  ];
  assert.deepEqual(paths.filter((p) => !ignored(p)), []);
});

test('the .gitignore names each path explicitly', async () => {
  const { readFileSync } = await import('node:fs');
  const gi = readFileSync(join(ROOT, '.gitignore'), 'utf8').split('\n').map((l) => l.trim());
  for (const p of ['data/reports/recap-reviewer/', 'data/backups/removed-posts/', '.claude/worktrees/fix-*']) {
    assert.ok(gi.includes(p), p);
  }
});
