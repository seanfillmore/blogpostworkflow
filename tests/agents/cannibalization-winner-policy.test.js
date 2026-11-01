// The SLS toothpaste page (locked winner, #5) was LLM-merged into twice in a
// week and fell to #10. Operator decision 2026-10-03: never merge into a locked
// winner, redirect the loser instead; and touch nothing on a winner that is
// frozen or still inside the measurement window of its last change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decideWinnerAction } from '../../agents/cannibalization-resolver/winner-policy.js';
import { decideEdit } from '../../lib/post-edit-gate.js';

const NOW = '2026-10-03T12:00:00.000Z';

test('a locked winner is never merged into: CONSOLIDATE becomes REDIRECT', () => {
  const d = decideWinnerAction('CONSOLIDATE', { now: NOW, locked: true }, decideEdit);
  assert.equal(d.action, 'REDIRECT');
  assert.match(d.reason, /locked winner/);
});

test('an unlocked, open winner keeps the model\'s call', () => {
  assert.equal(decideWinnerAction('CONSOLIDATE', { now: NOW }, decideEdit).action, 'CONSOLIDATE');
  assert.equal(decideWinnerAction('REDIRECT', { now: NOW, locked: true }, decideEdit).action, 'REDIRECT');
});

test('a frozen or cooling winner holds the whole pair, redirect included', () => {
  const frozen = { now: NOW, locked: true, freeze: { until: '2026-11-14T00:00:00.000Z', reason: 'recovering' } };
  assert.equal(decideWinnerAction('CONSOLIDATE', frozen, decideEdit).action, 'HOLD');
  assert.equal(decideWinnerAction('REDIRECT', frozen, decideEdit).action, 'HOLD');
  const cooling = { now: NOW, lastMaterialAt: '2026-09-21T15:00:00.000Z' };
  const d = decideWinnerAction('REDIRECT', cooling, decideEdit);
  assert.equal(d.action, 'HOLD');
  assert.match(d.until, /^2026-10-19/);
});

test('an unreadable winner state holds rather than guessing', () => {
  assert.equal(decideWinnerAction('CONSOLIDATE', { now: NOW, unreadable: true }, decideEdit).action, 'HOLD');
});

test('the resolver asks the policy before any merge, and redirects into a winner start its clock', () => {
  const src = readFileSync(new URL('../../agents/cannibalization-resolver/index.js', import.meta.url), 'utf8');
  const policyAt = src.indexOf('decideWinnerAction(loser.action');
  const mergeAt = src.indexOf('await consolidateContent(');
  assert.ok(policyAt > 0 && policyAt < mergeAt, 'policy is decided before the paid merge call');
  assert.match(src, /recordMaterialEdit\(winnerHandle, 'rewrite', `cannibalization-resolver \(/);
});

test('winner facts are read once per run, so several losers fold into one winner together', () => {
  const src = readFileSync(new URL('../../agents/cannibalization-resolver/index.js', import.meta.url), 'utf8');
  assert.match(src, /winnerFactsThisRun\.set\(winnerHandle, readEditFacts\(winnerHandle\)\)/);
  assert.ok(src.indexOf('const winnerFactsThisRun = new Map()') < src.indexOf('for (const decision of capped)'));
});
