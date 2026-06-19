import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyBlockedReport } from '../../agents/dashboard/lib/data-loader.js';

const NEEDS_WORK = '## OVERALL QUALITY\nVERDICT: Needs Work\n\n## BLOCKERS\n1. Ingredient accuracy: claims beeswax; spec says plant wax.\n';
const PASSING   = '## OVERALL QUALITY\nVERDICT: Good\n\n## BLOCKERS\nNone.\n';
const now = Date.parse('2026-06-19T12:00:00Z');
const pastPublish = '2025-06-13T10:00:04-06:00'; // live (publish in the past)

// THE REGRESSION: a refresh of an already-live post failed the gate. It has no
// explicit shopify_status and a past publish date. The old over-filter
// (publish_at <= now → skip) hid it entirely. It must now surface as live.
test('live post (past publish, no status) with fresh Needs Work → surfaces as live', () => {
  const r = classifyBlockedReport({ report: NEEDS_WORK, meta: { shopify_publish_at: pastPublish }, reportAgeDays: 3.6, now });
  assert.ok(r, 'should be blocked');
  assert.equal(r.live, true);
  assert.match(r.blockerText, /beeswax/);
});

test('pre-publish post (no publish date) with Needs Work → surfaces as not-live', () => {
  const r = classifyBlockedReport({ report: NEEDS_WORK, meta: {}, reportAgeDays: 1, now });
  assert.ok(r);
  assert.equal(r.live, false);
});

test('explicitly published/scheduled post is never blocked', () => {
  assert.equal(classifyBlockedReport({ report: NEEDS_WORK, meta: { shopify_status: 'published', shopify_publish_at: pastPublish }, reportAgeDays: 1, now }), null);
  assert.equal(classifyBlockedReport({ report: NEEDS_WORK, meta: { shopify_status: 'scheduled' }, reportAgeDays: 1, now }), null);
});

test('OVERALL QUALITY = Good overrides a sub-section Needs Work', () => {
  const subSectionOnly = '## SOURCE VERIFICATION\nVERDICT: Needs Work\n\n## OVERALL QUALITY\nVERDICT: Good\n';
  assert.equal(classifyBlockedReport({ report: subSectionOnly, meta: {}, reportAgeDays: 1, now }), null);
});

test('BLOCKERS = None → not blocked', () => {
  assert.equal(classifyBlockedReport({ report: PASSING, meta: {}, reportAgeDays: 1, now }), null);
});

test('live post with a STALE (>30d) Needs Work report is suppressed (no flood)', () => {
  const r = classifyBlockedReport({ report: NEEDS_WORK, meta: { shopify_publish_at: pastPublish }, reportAgeDays: 45, now });
  assert.equal(r, null);
});

test('a NOT-yet-live post surfaces even with an old report (freshness applies to live only)', () => {
  const r = classifyBlockedReport({ report: NEEDS_WORK, meta: {}, reportAgeDays: 200, now });
  assert.ok(r);
  assert.equal(r.live, false);
});

test('report without a Needs Work verdict → not blocked', () => {
  assert.equal(classifyBlockedReport({ report: '## OVERALL QUALITY\nVERDICT: Excellent\n', meta: {}, now }), null);
});
