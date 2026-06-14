import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideOutcome, DEFAULT_REGRESS_THRESHOLD } from '../../lib/meta-ab-decision.js';

// CTR is a fraction (0.02 = 2%). The variant "B" is the proposed rewrite that
// became live; "A" is the original we'd revert to.

test('improvement → winner B, keep (no revert)', () => {
  const d = decideOutcome({ baselineCtr: 0.020, currentCtr: 0.026 });
  assert.equal(d.outcome, 'improved');
  assert.equal(d.winner, 'B');
  assert.equal(d.shouldRevert, false);
  assert.ok(Math.abs(d.delta - 0.006) < 1e-9);
});

test('small negative within threshold → flat, winner A, no revert', () => {
  // -0.002 is within the 0.005 dead-band → flat, not worth reverting
  const d = decideOutcome({ baselineCtr: 0.020, currentCtr: 0.018 });
  assert.equal(d.outcome, 'flat');
  assert.equal(d.winner, 'A');
  assert.equal(d.shouldRevert, false);
});

test('clear regression beyond threshold → winner A, REVERT', () => {
  const d = decideOutcome({ baselineCtr: 0.020, currentCtr: 0.009 });
  assert.equal(d.outcome, 'regressed');
  assert.equal(d.winner, 'A');
  assert.equal(d.shouldRevert, true);
});

test('exactly at the threshold is flat (not a regression)', () => {
  const d = decideOutcome({ baselineCtr: 0.020, currentCtr: 0.020 - DEFAULT_REGRESS_THRESHOLD });
  assert.equal(d.outcome, 'flat');
  assert.equal(d.shouldRevert, false);
});

test('zero delta → flat, winner A', () => {
  const d = decideOutcome({ baselineCtr: 0.02, currentCtr: 0.02 });
  assert.equal(d.outcome, 'flat');
  assert.equal(d.winner, 'A');
});

test('custom threshold respected', () => {
  // -0.003 regression: flat under default 0.005, but regressed under 0.002
  const lenient = decideOutcome({ baselineCtr: 0.02, currentCtr: 0.017 });
  assert.equal(lenient.outcome, 'flat');
  const strict = decideOutcome({ baselineCtr: 0.02, currentCtr: 0.017 }, { regressThreshold: 0.002 });
  assert.equal(strict.outcome, 'regressed');
  assert.equal(strict.shouldRevert, true);
});

test('missing currentCtr treated as zero (full regression)', () => {
  const d = decideOutcome({ baselineCtr: 0.02, currentCtr: null });
  assert.equal(d.outcome, 'regressed');
  assert.equal(d.shouldRevert, true);
});
