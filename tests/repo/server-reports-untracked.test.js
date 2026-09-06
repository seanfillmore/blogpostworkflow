// Agent `latest.json` run reports must not be tracked in git.
//
// This is the sibling of no-text-merge-machine-data.test.js and asks a DIFFERENT
// question. That file asks "if git touches this tracked file, can it corrupt it?"
// and answers with `-merge` in .gitattributes. This one asks "should git be
// carrying this file at all?" — because `-merge` protects the CONTENT of a file
// during a merge, and does nothing about the separate hazard that a deploy can
// REVERT a machine-written file to whatever was last committed.
//
// WHAT HAPPENED (2026-09-06)
//
// Thirteen `data/reports/*/latest.json` were tracked while cron rewrote them on
// the production box. A `git stash push` during a deploy was never popped, and
// data/reports/quick-wins/latest.json sat at its 2026-04-14 committed value —
// `candidate_count: 1` — for 145 days. agents/quick-win-targeter ran cleanly
// every Monday and wrote a dated .md beside it the whole time, so nothing looked
// broken. Seven agents read that file (internal-linker, collection-linker,
// performance-engine, internal-link-auditor, refresh-runner, the dashboard and
// daily-summary), which means the biggest CTR opportunity on the site — the
// tattoo-soap winner at 43,827 impressions and 0.5% CTR — was invisible to the
// quick-win pool for five months.
//
// gsc-opportunity/latest.json had the same disease and hid it better: its cron
// runs at 13:30 UTC and rewrote the file every afternoon, so it only read as
// April between the revert and 13:30 — a window that happens to contain
// daily-summary at 13:00. The digest reported April data every single morning
// while the file on disk that evening was correct.
//
// WHY A TEST RATHER THAN JUST A .gitignore ENTRY
//
// A .gitignore entry does not untrack a file that is already in the index, and
// nothing stops a future `git add -f` or a new agent from committing its first
// latest.json. The hazard is silent in both directions — a reverted report reads
// as real data to every consumer, and every consumer here `catch {}`s a bad read
// and carries on as though the file were empty.
//
// WHAT IS DELIBERATELY NOT COVERED
//
// Being untracked is NOT the right answer for every machine-written data file.
// Two tracked files stay tracked on purpose and must never be swept in here:
//   - data/rejected-keywords.json records HUMAN decisions and cannot be
//     regenerated; it is reconciled by union (scripts/reconcile-rejected-keywords.mjs).
//   - data/briefs/_dropped/ is an archive whose entire point is that an
//     untracked copy is what made the 2026-08-19 brief loss unrecoverable.
// The test below is scoped to `data/reports/*/latest.json` for exactly that
// reason: regenerable agent output, and nothing else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function tracked(pathspec) {
  return execFileSync('git', ['ls-files', '--', pathspec], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(Boolean);
}

function ignored(path) {
  // `git check-ignore` exits 1 when the path is NOT ignored, which execFileSync
  // throws on — so a throw is the "not ignored" answer, not a broken test.
  try {
    execFileSync('git', ['check-ignore', '-q', '--', path], { cwd: ROOT });
    return true;
  } catch {
    return false;
  }
}

test('no agent latest.json report is tracked in git', () => {
  const stillTracked = tracked('data/reports/*/latest.json');

  assert.deepEqual(stillTracked, [],
    'These machine-written reports are tracked in git. A deploy can revert them to\n'
    + 'the committed value and every consumer will read that as current data — which\n'
    + 'is how quick-wins served April data for 145 days. Untrack them:\n'
    + '  git rm --cached ' + stillTracked.join(' \\\n                  ') + '\n'
    + 'and add each path to .gitignore.');
});

test('the thirteen untracked on 2026-09-06 are each actually ignored', () => {
  // Untracking without a .gitignore entry leaves the file showing as untracked
  // for someone`s `git add .` to re-commit — which is the same bug returning by
  // a different door. Each path is named explicitly so that deleting one from
  // .gitignore fails here rather than silently re-opening the hazard.
  const paths = [
    'data/reports/bing-keyword-gap/latest.json',
    'data/reports/claim-audit/latest.json',
    'data/reports/competitor-watcher/latest.json',
    'data/reports/device-weights/latest.json',
    'data/reports/dropship-copy-remediation/latest.json',
    'data/reports/gsc-opportunity/latest.json',
    'data/reports/hero-product/latest.json',
    'data/reports/indexing/latest.json',
    'data/reports/post-performance/latest.json',
    'data/reports/quick-wins/latest.json',
    'data/reports/return-policy-statement/latest.json',
    'data/reports/shopping-test-monitor/latest.json',
    'data/reports/voice-of-customer/latest.json',
  ];

  const notIgnored = paths.filter((p) => !ignored(p));
  assert.deepEqual(notIgnored, [],
    'these were untracked on 2026-09-06 but are no longer gitignored, so a\n'
    + '`git add .` will re-commit them and re-open the revert hazard:\n  '
    + notIgnored.join('\n  '));
});

test('files that must STAY tracked are still tracked', () => {
  // The counter-check. A future sweep that "tidies up" data/ by ignoring
  // everything machine-written would destroy the two files whose whole safety
  // argument is that git holds a copy.
  assert.deepEqual(tracked('data/rejected-keywords.json'), ['data/rejected-keywords.json'],
    'data/rejected-keywords.json records human decisions and cannot be regenerated —\n'
    + 'it must stay tracked and be reconciled by union, never gitignored.');

  assert.ok(tracked('data/briefs/_dropped/*').length > 0,
    'data/briefs/_dropped/ must stay tracked — an untracked archive is exactly what\n'
    + 'made the 2026-08-19 loss of three paid-for briefs unrecoverable.');
});
