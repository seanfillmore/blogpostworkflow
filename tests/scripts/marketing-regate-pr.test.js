import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  regateBranchName,
  changedSkillFiles,
  summarizeRegateOutput,
} from '../../scripts/marketing-regate-pr.mjs';

test('branch name is dated and suffixed on a same-day rerun', () => {
  const d = new Date('2026-11-01T17:12:46Z');
  assert.equal(regateBranchName(d), 'chore/marketing-regate-2026-11-01');
  assert.equal(regateBranchName(d, 1), 'chore/marketing-regate-2026-11-01-2');
});

test('only skill files are committed, never the digest symlink or anything else', () => {
  const porcelain = [
    ' M .claude/skills/marketing-review-mining/SKILL.md',
    ' D data/reports/daily-summary/2026-03-21.jsonl',
    '?? data/reports/daily-summary',
    ' M .claude/skills/marketing-offer-construction/SKILL.md',
  ].join('\n');
  assert.deepEqual(changedSkillFiles(porcelain), [
    '.claude/skills/marketing-review-mining/SKILL.md',
    '.claude/skills/marketing-offer-construction/SKILL.md',
  ]);
  assert.deepEqual(changedSkillFiles(''), []);
});

test('summary starts at the re-gate report section', () => {
  const out = 'noise\n721 live tactics\n── UNPARK → runnable today (1) ──\n  skill-a [was scale]\n';
  assert.match(summarizeRegateOutput(out), /^── UNPARK/);
});

test('scheduler runs the PR wrapper, never --regate --apply against the live checkout', () => {
  const src = readFileSync(new URL('../../scheduler.js', import.meta.url), 'utf8');
  assert.match(src, /scripts\/marketing-regate-pr\.mjs --apply/);
  assert.doesNotMatch(src, /marketing-learner\/index\.js --regate --apply/);
});
