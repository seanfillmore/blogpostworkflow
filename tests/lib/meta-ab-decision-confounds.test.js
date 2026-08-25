import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideOutcome,
  DEFAULT_REGRESS_THRESHOLD,
  DEFAULT_POSITION_TOLERANCE,
} from '../../lib/meta-ab-decision.js';

// These pin the three things the checker could not see before: a symmetric
// noise floor, a position confound, and a sample too thin to read.

// ── symmetric dead-band ──────────────────────────────────────────────────────

test('a positive delta INSIDE the dead-band is flat, not improved', () => {
  // The real 2026-06-22 "coconut oil soap benefits" test: +0.25pp raw on 10 → 11
  // clicks, concluded `improved` and kept. One click is not a result.
  const d = decideOutcome({ baselineCtr: 0.0040, currentCtr: 0.0065 });
  assert.equal(d.outcome, 'flat');
  assert.equal(d.winner, 'A');
  assert.equal(d.shouldRevert, false);
});

test('every historical "improved" verdict falls inside the dead-band', () => {
  // The four 2026-03-09 tests concluded `improved`, as (baseline, current) CTR.
  const historical = [
    [0.01504, 0.01884], // tom's of maine toothpaste alternative
    [0.00050, 0.00179], // coconut oil for stretch marks
    [0.00148, 0.00243], // dr bronner alternative
    [0.00446, 0.00633], // coconut oil soap benefits
  ];
  for (const [baselineCtr, currentCtr] of historical) {
    const d = decideOutcome({ baselineCtr, currentCtr });
    assert.equal(d.outcome, 'flat', `${baselineCtr} → ${currentCtr} should be flat`);
  }
});

test('a positive delta at or beyond the threshold is still improved', () => {
  const d = decideOutcome({ baselineCtr: 0.020, currentCtr: 0.020 + DEFAULT_REGRESS_THRESHOLD });
  assert.equal(d.outcome, 'improved');
  assert.equal(d.winner, 'B');
});

// ── corpus drift control ─────────────────────────────────────────────────────

test('a rise matched by the corpus is not credited to the title', () => {
  // Blog CTR tripled between 2026-03 and 2026-08 with nobody touching most pages.
  const d = decideOutcome({ baselineCtr: 0.004, currentCtr: 0.011, controlDrift: 0.007 });
  assert.equal(d.outcome, 'flat');
  assert.ok(Math.abs(d.rawDelta - 0.007) < 1e-12);
  assert.ok(Math.abs(d.delta) < 1e-12, 'drift-adjusted delta is zero');
});

test('a rise BEYOND the corpus drift still wins', () => {
  const d = decideOutcome({ baselineCtr: 0.004, currentCtr: 0.016, controlDrift: 0.005 });
  assert.equal(d.outcome, 'improved');
  assert.ok(Math.abs(d.delta - 0.007) < 1e-12);
});

test('a fall matched by a corpus-wide headwind is not a regression', () => {
  const d = decideOutcome({ baselineCtr: 0.020, currentCtr: 0.008, controlDrift: -0.012 });
  assert.equal(d.outcome, 'flat');
  assert.equal(d.shouldRevert, false);
});

test('a non-finite controlDrift is ignored rather than poisoning the delta', () => {
  const d = decideOutcome({ baselineCtr: 0.020, currentCtr: 0.009, controlDrift: NaN });
  assert.equal(d.outcome, 'regressed');
  assert.ok(Number.isFinite(d.delta));
});

// ── position confound ────────────────────────────────────────────────────────

test('the real 2026-07-27 revert is refused as confounded, not concluded', () => {
  // sls free toothpaste: CTR 0.46% → 0.17% while average position went 13.2 →
  // 27.6 and impressions fell 9,934 → 3,462. The old checker read a 14-place
  // ranking collapse as a bad headline and threw the headline away.
  const d = decideOutcome({
    baselineCtr: 0.0046,
    currentCtr: 0.0017,
    baselinePosition: 13.2,
    currentPosition: 27.6,
  });
  assert.equal(d.outcome, 'confounded');
  assert.equal(d.shouldRevert, false);
  assert.equal(d.concluded, false, 'a confounded test stays open for re-measurement');
  assert.equal(d.winner, null);
  assert.ok(d.positionDelta > 14 - 1e-9);
});

test('a position move inside tolerance does not block a verdict', () => {
  const d = decideOutcome({
    baselineCtr: 0.020, currentCtr: 0.005, baselinePosition: 8.0, currentPosition: 9.5,
  });
  assert.equal(d.outcome, 'regressed');
  assert.equal(d.shouldRevert, true);
});

test('tolerance scales with position — one place at rank 3 is not one place at rank 40', () => {
  const deep = decideOutcome({
    baselineCtr: 0.020, currentCtr: 0.001, baselinePosition: 40, currentPosition: 47,
  });
  assert.equal(deep.outcome, 'regressed', '7 places at rank 40 is inside 25%');
  assert.equal(deep.positionTolerance, 10);
  const shallow = decideOutcome({
    baselineCtr: 0.020, currentCtr: 0.001, baselinePosition: 4, currentPosition: 11,
  });
  assert.equal(shallow.outcome, 'confounded', '7 places at rank 4 is not');
  assert.equal(shallow.positionTolerance, DEFAULT_POSITION_TOLERANCE);
});

test('an IMPROVEMENT on a page that also climbed is confounded too', () => {
  // The guard is symmetric on purpose: credit is as unearned as blame.
  const d = decideOutcome({
    baselineCtr: 0.004, currentCtr: 0.020, baselinePosition: 20, currentPosition: 4,
  });
  assert.equal(d.outcome, 'confounded');
  assert.equal(d.winner, null);
});

test('a missing position is not treated as position zero', () => {
  const d = decideOutcome({ baselineCtr: 0.020, currentCtr: 0.009, baselinePosition: 8.0 });
  assert.equal(d.outcome, 'regressed');
  assert.equal(d.positionDelta, null);
});

test('DEFAULT_POSITION_TOLERANCE is exported and is the floor of the scaled rule', () => {
  const d = decideOutcome({
    baselineCtr: 0.004, currentCtr: 0.001, baselinePosition: 2,
    currentPosition: 2 + DEFAULT_POSITION_TOLERANCE + 0.1,
  });
  assert.equal(d.outcome, 'confounded');
});

// ── power floor ──────────────────────────────────────────────────────────────

test('a 133-impression test is underpowered and never concludes', () => {
  // "tom's of maine toothpaste alternative", concluded `improved` for real.
  const d = decideOutcome({
    baselineCtr: 0.01504, currentCtr: 0.01884, impressionsPerArm: 133,
  });
  assert.equal(d.outcome, 'underpowered');
  assert.equal(d.concluded, false);
  assert.equal(d.shouldRevert, false);
  assert.ok(d.power && d.power.shortfall > 0);
});

test('an underpowered REGRESSION is not reverted either', () => {
  // Reverting on an unreadable measurement throws away good work as readily as
  // it undoes bad work.
  const d = decideOutcome({
    baselineCtr: 0.020, currentCtr: 0.002, impressionsPerArm: 200,
  });
  assert.equal(d.outcome, 'underpowered');
  assert.equal(d.shouldRevert, false);
});

test('a powered sample concludes normally', () => {
  const d = decideOutcome({
    baselineCtr: 0.004, currentCtr: 0.012, impressionsPerArm: 200000,
  });
  assert.equal(d.outcome, 'improved');
  assert.equal(d.concluded, true);
});

test('omitting impressionsPerArm skips the power gate entirely', () => {
  const d = decideOutcome({ baselineCtr: 0.020, currentCtr: 0.009 });
  assert.equal(d.outcome, 'regressed');
  assert.equal(d.power, null);
});

// ── precedence ───────────────────────────────────────────────────────────────

test('a confounded test reports as confounded even when also underpowered', () => {
  // Invalid beats insufficient: there is no sample size that fixes a page that
  // moved 20 places, so saying "underpowered" would send the wrong instruction.
  const d = decideOutcome({
    baselineCtr: 0.004, currentCtr: 0.001,
    baselinePosition: 8, currentPosition: 28, impressionsPerArm: 50,
  });
  assert.equal(d.outcome, 'confounded');
});

test('nothing new throws on a completely empty entry', () => {
  const d = decideOutcome({});
  assert.ok(typeof d.outcome === 'string');
  assert.equal(d.shouldRevert, false);
});
