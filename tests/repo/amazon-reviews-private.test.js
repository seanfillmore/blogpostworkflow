/**
 * Amazon review pulls must never be committed.
 *
 * This repository is PUBLIC. data/amazon-reviews/ holds reviewers' display names
 * and their full review text, pulled from Seller Central. Both halves are pinned:
 * the directory is IGNORED (so `git add .` cannot pick it up) and nothing under
 * it is TRACKED (so a force-add is caught too).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' });

test('data/amazon-reviews/ is gitignored', () => {
  for (const f of ['culina-2026-11-24.csv', 'culina-2026-11-24.md']) {
    const out = git('check-ignore', '--no-index', `data/amazon-reviews/${f}`);
    assert.match(out, /data\/amazon-reviews/);
  }
});

test('nothing under data/amazon-reviews/ is tracked', () => {
  assert.equal(git('ls-files', 'data/amazon-reviews').trim(), '');
});
