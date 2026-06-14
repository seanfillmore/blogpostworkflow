import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isInfraError,
  countDeliveredSubmissions,
  isStaleAuthBlock,
} from '../../lib/indexing-escalation.js';

// ── isInfraError ──────────────────────────────────────────────────────────────
// Infra errors are transient, account-wide failures (auth/scope/quota/network).
// They are NOT evidence that a specific page won't index, so they must never
// count toward a post's give-up budget.

test('isInfraError: detects scope-insufficient auth failure', () => {
  assert.equal(isInfraError('Indexing API permission denied — verify owner status in GSC. ACCESS_TOKEN_SCOPE_INSUFFICIENT'), true);
});

test('isInfraError: detects generic permission denied', () => {
  assert.equal(isInfraError('Indexing API permission denied — verify owner status in GSC.'), true);
});

test('isInfraError: detects rate limiting', () => {
  assert.equal(isInfraError('Indexing API rate limited — quota exceeded'), true);
});

test('isInfraError: detects quota exhaustion', () => {
  assert.equal(isInfraError('Indexing submission quota exhausted (100/day self-limit)'), true);
});

test('isInfraError: detects token refresh failure', () => {
  assert.equal(isInfraError('GSC token refresh failed: HTTP 400 — invalid_grant'), true);
});

test('isInfraError: detects network failure', () => {
  assert.equal(isInfraError('fetch failed: ECONNRESET'), true);
});

test('isInfraError: a genuine per-URL rejection is NOT infra', () => {
  assert.equal(isInfraError('Indexing submission failed: HTTP 400 — URL is malformed'), false);
});

test('isInfraError: empty/missing message is not infra', () => {
  assert.equal(isInfraError(''), false);
  assert.equal(isInfraError(undefined), false);
  assert.equal(isInfraError(null), false);
});

// ── countDeliveredSubmissions ──────────────────────────────────────────────────
// Only submissions that actually reached Google ("ok") count toward escalation.
// Errored submissions never reached the index pipeline.

test('countDeliveredSubmissions: counts only ok results for the method', () => {
  const subs = [
    { method: 'indexing_api', result: 'ok' },
    { method: 'indexing_api', result: 'error', error: 'permission denied' },
    { method: 'indexing_api', result: 'ok' },
    { method: 'sitemap_resubmit', result: 'ok' },
  ];
  assert.equal(countDeliveredSubmissions(subs, 'indexing_api'), 2);
  assert.equal(countDeliveredSubmissions(subs, 'sitemap_resubmit'), 1);
});

test('countDeliveredSubmissions: errored submissions do not count', () => {
  const subs = [
    { method: 'indexing_api', result: 'error', error: 'permission denied' },
    { method: 'indexing_api', result: 'error', error: 'permission denied' },
  ];
  assert.equal(countDeliveredSubmissions(subs, 'indexing_api'), 0);
});

test('countDeliveredSubmissions: legacy records without a result field count as delivered', () => {
  // Historical "ok" submissions were recorded with result:'ok', but be lenient:
  // a record with a notification_time and no error is a delivered submission.
  const subs = [
    { method: 'indexing_api', submitted_at: '2026-01-01', notification_time: '2026-01-01' },
  ];
  assert.equal(countDeliveredSubmissions(subs, 'indexing_api'), 1);
});

test('countDeliveredSubmissions: handles empty/missing history', () => {
  assert.equal(countDeliveredSubmissions([], 'indexing_api'), 0);
  assert.equal(countDeliveredSubmissions(undefined, 'indexing_api'), 0);
});

// ── isStaleAuthBlock ───────────────────────────────────────────────────────────
// A post is a "stale auth block" (safe to clear) when it was blocked by the
// submission-count escalation but never actually delivered 2 submissions to
// Google — i.e. the block was caused by errored/infra submissions, not by
// Google genuinely refusing to index a delivered page.

test('isStaleAuthBlock: blocked with only errored submissions → stale', () => {
  const meta = {
    indexing_blocked: true,
    indexing_blocked_reason: '2 prior Indexing API submissions failed to get the post indexed. Current state: discovered_not_crawled. Manual investigation required.',
    indexing_submissions: [
      { method: 'indexing_api', result: 'error', error: 'Indexing API permission denied' },
      { method: 'indexing_api', result: 'error', error: 'Indexing API permission denied' },
    ],
  };
  assert.equal(isStaleAuthBlock(meta), true);
});

test('isStaleAuthBlock: blocked after 2 delivered submissions → NOT stale (genuine)', () => {
  const meta = {
    indexing_blocked: true,
    indexing_blocked_reason: '2 prior Indexing API submissions failed to get the post indexed. Current state: crawled_not_indexed. Manual investigation required.',
    indexing_submissions: [
      { method: 'indexing_api', result: 'ok' },
      { method: 'indexing_api', result: 'ok' },
    ],
  };
  assert.equal(isStaleAuthBlock(meta), false);
});

test('isStaleAuthBlock: blocked for a technical misconfiguration → NOT stale', () => {
  const meta = {
    indexing_blocked: true,
    indexing_blocked_reason: 'Page has a noindex meta tag. Remove it in the Shopify article HTML.',
    indexing_submissions: [],
  };
  assert.equal(isStaleAuthBlock(meta), false);
});

test('isStaleAuthBlock: not blocked at all → not stale', () => {
  assert.equal(isStaleAuthBlock({ indexing_blocked: false }), false);
  assert.equal(isStaleAuthBlock({}), false);
});
