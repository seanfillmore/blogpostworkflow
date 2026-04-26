import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyOutcome, decideAction, computeDeltas, THRESHOLDS } from '../../lib/change-log/verdict.js';

test('classifyOutcome is "improved" when target_query CTR ≥ +20% and no negatives crossed', () => {
  const deltas = {
    page: { ctr: 0.10, clicks: 0.05, impressions: 0.05, position: 0, page_revenue: 0.10, sessions: 0.10, conversions: 0.05 },
    target_queries: { 'coconut lotion': { ctr: 0.25, clicks: 0.10, position: -1, impressions: 0.05 } },
  };
  assert.equal(classifyOutcome(deltas), 'improved');
});

test('classifyOutcome is "regressed" when CTR drops 25%', () => {
  const deltas = {
    page: { ctr: -0.25, clicks: -0.10, impressions: -0.05, position: 0, page_revenue: -0.05, sessions: -0.05, conversions: 0 },
    target_queries: { 'coconut lotion': { ctr: -0.30, clicks: -0.20, position: 1, impressions: -0.05 } },
  };
  assert.equal(classifyOutcome(deltas), 'regressed');
});

test('classifyOutcome is "regressed" when revenue drops 30%', () => {
  const deltas = {
    page: { ctr: 0, clicks: 0, impressions: 0, position: 0, page_revenue: -0.30, sessions: 0, conversions: -0.30 },
    target_queries: {},
  };
  assert.equal(classifyOutcome(deltas), 'regressed');
});

test('classifyOutcome is "no_change" when all deltas are within ±5%', () => {
  const deltas = {
    page: { ctr: 0.02, clicks: 0.03, impressions: -0.01, position: 0.5, page_revenue: 0.04, sessions: 0.01, conversions: 0 },
    target_queries: { 'coconut lotion': { ctr: 0.04, clicks: 0.03, position: 0.5, impressions: 0 } },
  };
  assert.equal(classifyOutcome(deltas), 'no_change');
});

test('classifyOutcome is "inconclusive" when deltas are between thresholds', () => {
  const deltas = {
    page: { ctr: 0.10, clicks: 0.10, impressions: 0.05, position: -1, page_revenue: 0.10, sessions: 0.10, conversions: 0.05 },
    target_queries: { 'coconut lotion': { ctr: 0.10, clicks: 0.15, position: -1, impressions: 0.05 } },
  };
  // +10% CTR is between ±5% (no_change) and +20% (improved). Hence inconclusive.
  assert.equal(classifyOutcome(deltas), 'inconclusive');
});

test('decideAction returns "kept" for improved or no_change or inconclusive', () => {
  const window = { changes: ['ch-1'] };
  const events = [{ id: 'ch-1', change_type: 'title' }];
  assert.equal(decideAction({ outcome: 'improved', window, events }).action, 'kept');
  assert.equal(decideAction({ outcome: 'no_change', window, events }).action, 'kept');
  assert.equal(decideAction({ outcome: 'inconclusive', window, events }).action, 'kept');
});

test('decideAction returns "reverted" for regressed when bundle is fully revertable', () => {
  const window = { changes: ['ch-1', 'ch-2'] };
  const events = [
    { id: 'ch-1', change_type: 'title' },
    { id: 'ch-2', change_type: 'meta_description' },
  ];
  assert.equal(decideAction({ outcome: 'regressed', window, events }).action, 'reverted');
});

test('decideAction returns "surfaced_for_review" for regressed when bundle includes content_body', () => {
  const window = { changes: ['ch-1', 'ch-2'] };
  const events = [
    { id: 'ch-1', change_type: 'title' },
    { id: 'ch-2', change_type: 'content_body' },
  ];
  assert.equal(decideAction({ outcome: 'regressed', window, events }).action, 'surfaced_for_review');
});

test('decideAction returns "surfaced_for_review" for regressed when bundle includes image', () => {
  const window = { changes: ['ch-1'] };
  const events = [{ id: 'ch-1', change_type: 'image' }];
  assert.equal(decideAction({ outcome: 'regressed', window, events }).action, 'surfaced_for_review');
});

test('THRESHOLDS exposed for tuning', () => {
  assert.ok(THRESHOLDS.ctr_positive);
  assert.ok(THRESHOLDS.ctr_negative);
  assert.ok(THRESHOLDS.position_positive);
  assert.ok(THRESHOLDS.position_negative);
  assert.ok(THRESHOLDS.revenue_positive);
  assert.ok(THRESHOLDS.revenue_negative);
});
