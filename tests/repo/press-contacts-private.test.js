/**
 * The PR contact book must never be committed.
 *
 * This repository is PUBLIC. data/press/contacts.json holds named journalists'
 * and creators' addresses, several of them personal Gmail accounts, so a single
 * `git add .` would publish a scraped contact list of real people permanently.
 * Untracking afterwards does not help — the history keeps it.
 *
 * Both halves are pinned: the path is IGNORED (so `git add .` cannot pick it up)
 * and nothing under it is TRACKED (so a force-add is caught too).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' });

test('data/press/contacts.json is gitignored', () => {
  const out = git('check-ignore', '-v', '--no-index', 'data/press/contacts.json');
  assert.match(out, /data\/press/, 'data/press/ must be matched by a .gitignore rule');
});

test('data/press/backups is gitignored too', () => {
  const out = git('check-ignore', '--no-index', 'data/press/backups/contacts-2026-01-01.json');
  assert.match(out, /data\/press\/backups/);
});

test('nothing under data/press/ is tracked', () => {
  const tracked = git('ls-files', 'data/press').trim();
  assert.equal(tracked, '', `tracked files under data/press/: ${tracked}`);
});
