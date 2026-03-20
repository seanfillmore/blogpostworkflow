import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCTRDelta } from '../../agents/meta-ab-tracker/index.js';

test('computes positive delta when test CTR is higher', () => {
  const delta = computeCTRDelta(0.05, 0.04);
  assert.ok(delta > 0);
  assert.ok(Math.abs(delta - 0.01) < 0.0001);
});

test('computes negative delta when test CTR is lower', () => {
  const delta = computeCTRDelta(0.03, 0.05);
  assert.ok(delta < 0);
  assert.ok(Math.abs(delta - (-0.02)) < 0.0001);
});

test('returns null when either value is null', () => {
  assert.equal(computeCTRDelta(null, 0.04), null);
  assert.equal(computeCTRDelta(0.04, null), null);
  assert.equal(computeCTRDelta(null, null), null);
});
