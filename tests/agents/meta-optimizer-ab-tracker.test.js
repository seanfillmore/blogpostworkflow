import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upsertTrackerEntry, buildTrackerEntry } from '../../agents/meta-optimizer/lib/ab-tracker.js';
import { pickBaselineCtr, decideOutcome } from '../../lib/meta-ab-decision.js';

const RESULT = {
  keyword: 'best soap for tattoos',
  pageUrl: 'https://example.com/blogs/news/best-soap-for-tattoos-what-to-use-for-safe-healing-2',
  currentTitle: 'Old title',
  proposedTitle: 'New title',
  currentMeta: 'Old meta',
  proposedMeta: 'New meta',
  ctr: 0.0056,
  impressions: 2337,
  position: 12.68,
  validation_source: null,
};

test('upsertTrackerEntry replaces the existing entry for a page', () => {
  const before = [
    { pageUrl: 'https://example.com/a', testedAt: '2026-01-01' },
    { pageUrl: RESULT.pageUrl, testedAt: '2026-01-01' },
  ];
  const after = upsertTrackerEntry(before, buildTrackerEntry(RESULT, '2026-08-23'));
  assert.equal(after.length, 2);
  assert.equal(after.filter((e) => e.pageUrl === RESULT.pageUrl).length, 1);
  assert.equal(after.at(-1).testedAt, '2026-08-23');
});

test('upsertTrackerEntry tolerates a missing or non-array tracker', () => {
  assert.equal(upsertTrackerEntry(undefined, buildTrackerEntry(RESULT, '2026-08-23')).length, 1);
  assert.equal(upsertTrackerEntry(null, buildTrackerEntry(RESULT, '2026-08-23')).length, 1);
});

test('buildTrackerEntry records the page-level baseline the checker measures against', () => {
  const e = buildTrackerEntry(RESULT, '2026-08-23', { pageCtr: 0.0062, locked: true });
  assert.equal(e.baselinePageCtr, 0.0062);
  assert.equal(e.baselineCtr, 0.0056, 'keyword baseline is kept for continuity');
  assert.equal(e.legacyLocked, true, 'a change on a protected page must be auditable');
});

test('buildTrackerEntry leaves baselinePageCtr null when the lookup failed', () => {
  const e = buildTrackerEntry(RESULT, '2026-08-23', {});
  assert.equal(e.baselinePageCtr, null);
  assert.equal(e.legacyLocked, false);
});

// ── pickBaselineCtr ──────────────────────────────────────────────────────────

test('pickBaselineCtr prefers the page-level baseline', () => {
  const p = pickBaselineCtr({ baselineCtr: 0.0056, baselinePageCtr: 0.0062 });
  assert.deepEqual(p, { ctr: 0.0062, basis: 'page-28d' });
});

test('pickBaselineCtr falls back to the keyword baseline on legacy entries', () => {
  const p = pickBaselineCtr({ baselineCtr: 0.0056 });
  assert.deepEqual(p, { ctr: 0.0056, basis: 'keyword-90d' });
});

test('pickBaselineCtr treats a zero page baseline as a real measurement, not missing', () => {
  // 0 is a legitimate page CTR. `||` would have silently fallen back here.
  assert.deepEqual(pickBaselineCtr({ baselineCtr: 0.02, baselinePageCtr: 0 }), { ctr: 0, basis: 'page-28d' });
});

test('the mixed-basis comparison this replaces really does flip the verdict', () => {
  // The live tattoo winner: keyword CTR 0.56% vs page CTR 0.62%. Measuring the
  // page against the keyword baseline reads "improved" before the new title has
  // done anything at all — the auto-revert safety net scoring its own noise.
  const entry = { baselineCtr: 0.0056, baselinePageCtr: 0.0062 };
  const currentCtr = 0.0062; // nothing changed

  const mixed = decideOutcome({ baselineCtr: entry.baselineCtr, currentCtr });
  assert.equal(mixed.outcome, 'improved');

  const likeForLike = decideOutcome({ baselineCtr: pickBaselineCtr(entry).ctr, currentCtr });
  assert.equal(likeForLike.outcome, 'flat');
});
