import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  minDetectableEffect,
  requiredImpressionsPerArm,
  assessPower,
  DEFAULT_TARGET_RELATIVE_LIFT,
  Z_ALPHA_TWO_SIDED_95,
  Z_BETA_80,
} from '../../lib/ctr-power.js';

// CTR is a fraction throughout (0.005 = 0.5%), matching lib/meta-ab-decision.js.

test('MDE shrinks as the sample grows', () => {
  const small = minDetectableEffect({ impressionsPerArm: 1000, baselineCtr: 0.005 });
  const big = minDetectableEffect({ impressionsPerArm: 100000, baselineCtr: 0.005 });
  assert.ok(big < small, 'more impressions must detect a smaller effect');
});

test('MDE matches the closed form it documents', () => {
  const n = 12000;
  const p = 0.005;
  const expected = (Z_ALPHA_TWO_SIDED_95 + Z_BETA_80) * Math.sqrt((2 * p * (1 - p)) / n);
  const got = minDetectableEffect({ impressionsPerArm: n, baselineCtr: p });
  assert.ok(Math.abs(got - expected) < 1e-12);
});

test('MDE on the real flagship page is far larger than the CTR itself', () => {
  // best-soap-for-tattoos-...-2: 37,531 impressions / 90d at 0.56% CTR.
  // Per 28-day arm that is ~11,676 impressions.
  const n = (37531 / 90) * 28;
  const mde = minDetectableEffect({ impressionsPerArm: n, baselineCtr: 0.0056 });
  // ~0.27 percentage points — roughly a 49% RELATIVE move before it is visible.
  assert.ok(mde > 0.002 && mde < 0.003, `flagship MDE was ${mde}`);
  assert.ok(mde / 0.0056 > 0.4, 'the smallest visible move is a large relative one');
});

test('MDE on a 133-impression test is nonsense, and says so', () => {
  // The real 2026-03-09 "tom's of maine toothpaste alternative" test: 133
  // impressions, 1.5% CTR, concluded "improved" on +0.38pp.
  const mde = minDetectableEffect({ impressionsPerArm: 133, baselineCtr: 0.015 });
  assert.ok(mde > 0.03, `MDE was ${mde}; the concluded delta was 0.0038`);
});

test('degenerate inputs return Infinity rather than NaN', () => {
  assert.equal(minDetectableEffect({ impressionsPerArm: 0, baselineCtr: 0.005 }), Infinity);
  assert.equal(minDetectableEffect({ impressionsPerArm: -5, baselineCtr: 0.005 }), Infinity);
  assert.equal(minDetectableEffect({ impressionsPerArm: NaN, baselineCtr: 0.005 }), Infinity);
});

test('a zero baseline CTR is floored, not divided by', () => {
  const mde = minDetectableEffect({ impressionsPerArm: 10000, baselineCtr: 0 });
  assert.ok(Number.isFinite(mde) && mde > 0);
});

test('requiredImpressionsPerArm inverts minDetectableEffect', () => {
  const p = 0.004;
  const n = requiredImpressionsPerArm({ baselineCtr: p, absoluteLift: 0.002 });
  const mde = minDetectableEffect({ impressionsPerArm: n, baselineCtr: p });
  assert.ok(Math.abs(mde - 0.002) < 1e-9, `round trip gave ${mde}`);
});

test('requiredImpressionsPerArm returns Infinity for a zero or negative lift', () => {
  assert.equal(requiredImpressionsPerArm({ baselineCtr: 0.004, absoluteLift: 0 }), Infinity);
  assert.equal(requiredImpressionsPerArm({ baselineCtr: 0.004, absoluteLift: -0.001 }), Infinity);
});

test('assessPower: the flagship page clears the default target by a hair', () => {
  // best-soap-for-tattoos-...-2 is one of only THREE blog pages powered at all,
  // and it clears by ~5%: MDE ≈ 0.274pp against a 0.280pp target. Pinned here
  // because "powered" on this page is a knife edge, not a comfortable margin —
  // a normal week of traffic variance takes it back under.
  const n = (37531 / 90) * 28;
  const v = assessPower({ impressionsPerArm: n, baselineCtr: 0.0056 });
  assert.equal(v.powered, true);
  assert.equal(v.shortfall, 0);
  assert.equal(v.targetRelativeLift, DEFAULT_TARGET_RELATIVE_LIFT);
  const headroom = (n - v.requiredImpressionsPerArm) / v.requiredImpressionsPerArm;
  assert.ok(headroom > 0 && headroom < 0.1, `headroom was ${headroom}`);
});

test('assessPower: the fifth-largest blog page is already not powered', () => {
  // coconut-oil-deodorant-...: 26,184 impressions/90d at 0.59% — the largest page
  // that does NOT clear the bar alone, and the top of the pooled corpus.
  const n = (26184 / 90) * 28;
  const v = assessPower({ impressionsPerArm: n, baselineCtr: 0.0059 });
  assert.equal(v.powered, false);
  assert.ok(v.shortfall > 0, 'shortfall names how many impressions are missing');
});

test('assessPower: a ten-page cohort IS powered for the default target', () => {
  // The real size-10 treatment arm off the pooled corpus: 100,817 impressions
  // /90d at 0.46%, i.e. ~31,365 per 28-day arm. Measured, not invented.
  const n = (100817 / 90) * 28;
  const v = assessPower({ impressionsPerArm: n, baselineCtr: 468 / 100817 });
  assert.equal(v.powered, true);
  assert.equal(v.shortfall, 0);
});

test('assessPower reports the relative MDE so a report can be honest', () => {
  const v = assessPower({ impressionsPerArm: 5000, baselineCtr: 0.004 });
  assert.ok(Math.abs(v.relativeMde - v.mde / 0.004) < 1e-12);
});

test('assessPower honours a custom target lift', () => {
  const n = (37531 / 90) * 28;
  const lax = assessPower({ impressionsPerArm: n, baselineCtr: 0.0056, targetRelativeLift: 1.0 });
  assert.equal(lax.powered, true, 'a doubling IS detectable on the flagship');
});

test('assessPower never throws on missing input', () => {
  const v = assessPower({});
  assert.equal(v.powered, false);
  assert.ok(Number.isFinite(v.impressionsPerArm));
});
