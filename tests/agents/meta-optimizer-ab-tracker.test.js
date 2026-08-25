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

test('the symmetric dead-band now absorbs a SMALL mixed-basis gap on its own', () => {
  // The live tattoo winner: keyword CTR 0.56% vs page CTR 0.62%. This case used
  // to read "improved" before the new title had done anything — the auto-revert
  // safety net scoring its own noise. It no longer does, because `delta > 0` is
  // no longer a win: the dead-band became symmetric on 2026-08-24 when replaying
  // the tracker showed that ALL FIVE verdicts ever recorded as improved sat
  // inside it. Both bases now agree, which is the point.
  const entry = { baselineCtr: 0.0056, baselinePageCtr: 0.0062 };
  const currentCtr = 0.0062; // nothing changed

  assert.equal(decideOutcome({ baselineCtr: entry.baselineCtr, currentCtr }).outcome, 'flat');
  assert.equal(decideOutcome({ baselineCtr: pickBaselineCtr(entry).ctr, currentCtr }).outcome, 'flat');
});

test('a LARGE mixed-basis gap still flips the verdict, so pickBaselineCtr stays load-bearing', () => {
  // The dead-band is a noise floor, not a basis correction, and it must not be
  // mistaken for one. A page whose tested query is a small slice of its traffic
  // can differ from the page baseline by far more than 0.5pp — the flagship
  // earns 37,531 impressions across 666 queries, its biggest worth 6.1% of them
  // — and at that size the wrong denominator still manufactures a win.
  const entry = { baselineCtr: 0.0056, baselinePageCtr: 0.0120 };
  const currentCtr = 0.0120; // nothing changed

  assert.equal(decideOutcome({ baselineCtr: entry.baselineCtr, currentCtr }).outcome, 'improved');
  assert.equal(decideOutcome({ baselineCtr: pickBaselineCtr(entry).ctr, currentCtr }).outcome, 'flat');
});
