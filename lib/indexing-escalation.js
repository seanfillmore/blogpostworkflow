// lib/indexing-escalation.js
// Pure logic for the indexing-fixer's escalation decisions.
//
// Background: the fixer escalates a post to a permanent `indexing_blocked` flag
// after 2 prior Indexing API submissions that still didn't get it indexed. The
// original bug counted ALL submission records — including ones that errored out
// (e.g. an account-wide auth/scope 403) and never reached Google at all. A
// multi-day auth outage therefore poisoned the entire queue, permanently
// blocking dozens of perfectly indexable posts.
//
// The rule this module encodes: only submissions that were actually DELIVERED to
// Google count toward a post's give-up budget. Infrastructure failures (auth,
// scope, quota, rate-limit, network) are account-wide and transient — they are
// never evidence that a specific page won't index.

// Substrings that mark an error as infrastructure/account-wide rather than
// specific to one URL. Matched case-insensitively against the error message.
const INFRA_ERROR_PATTERNS = [
  'permission denied',
  'scope_insufficient',
  'access_token_scope',
  'owner status',
  'insufficient authentication',
  'rate limited',
  'rate_limit',
  'quota exhausted',
  'quota exceeded',
  'token refresh failed',
  'invalid_grant',
  'fetch failed',
  'econnreset',
  'etimedout',
  'enotfound',
  'socket hang up',
  'network',
];

/**
 * True when an error message indicates an account-wide / transient
 * infrastructure failure rather than a page-specific rejection. These must not
 * count toward a post's escalation budget or trigger a permanent block.
 */
export function isInfraError(message) {
  if (!message) return false;
  const m = String(message).toLowerCase();
  return INFRA_ERROR_PATTERNS.some((p) => m.includes(p));
}

/**
 * Count submissions of a given method that were actually delivered to Google.
 * A submission counts as delivered unless it was explicitly recorded as an
 * error. (Legacy records predate the `result` field; absent an error they were
 * successful, so they count.)
 */
export function countDeliveredSubmissions(submissions, method) {
  if (!Array.isArray(submissions)) return 0;
  return submissions.filter((s) => s && s.method === method && s.result !== 'error').length;
}

/**
 * True when a post's `indexing_blocked` flag is a stale artifact of the
 * submission-count escalation that fired without 2 genuinely-delivered
 * submissions — i.e. the block was caused by errored/infra submissions, not by
 * Google declining to index a page it actually received. Such blocks are safe to
 * clear so the fixer retries them.
 *
 * Blocks from technical misconfigurations (noindex, robots, canonical, fetch)
 * carry a different reason and are left intact.
 */
export function isStaleAuthBlock(meta) {
  if (!meta || !meta.indexing_blocked) return false;
  const reason = String(meta.indexing_blocked_reason || '');
  // Only the submission-count escalation produces this reason text.
  if (!/prior Indexing API submissions/i.test(reason)) return false;
  return countDeliveredSubmissions(meta.indexing_submissions, 'indexing_api') < 2;
}
