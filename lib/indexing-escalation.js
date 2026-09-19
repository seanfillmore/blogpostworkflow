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
 * The escalation, stated as the DECISION it leaves for a human.
 *
 * Same vocabulary and same shape as `DECISION_LABELS` in lib/queue-autoapply.js
 * (PR #911), because it is the same class of finding: a skip no automated run
 * will ever clear. Once a post crosses `>= 2` delivered submissions the fixer
 * stamps it and `continue`s — it never submits that URL again, so nothing in
 * this pipeline can change the verdict. That is what separates it from Tier 1
 * and Tier 2, which clear themselves on the next run.
 *
 * Measured on production 2026-09-19: five posts, re-stamped every morning since
 * 2026-08-30 and named in no digest, ever. All five return HTTP 200, sit in the
 * sitemap with a fresh lastmod, carry a clean self-referential canonical and no
 * noindex, and are well linked internally (one has 14 inbound links). They are
 * not broken pages. They are invisible ones, which is exactly the kind of thing
 * a human has to decide about and a robot cannot.
 */
export const DECISION_LABELS = Object.freeze({
  'indexing-api-exhausted':
    'Google has ignored repeated Indexing API submissions — investigate the page, or accept it stays unindexed',
});

/**
 * The escalation records, as `needs_decision[]` rows for the 5 AM digest.
 *
 * Field names deliberately match lib/queue-autoapply.js's rows so
 * agents/daily-summary renders both through ONE renderer rather than growing a
 * parallel one.
 *
 * `created_at` is the FIRST delivered submission, never `indexing_blocked_at`:
 * the fixer re-stamps that field on every run, so an item stuck since August
 * would report "stuck 0 days" every morning — which is the same invisibility
 * this whole change exists to remove, wearing a date.
 */
export function escalationDecisions(escalated = [], getMeta = () => null) {
  return escalated.map((e) => {
    const subs = getMeta(e.slug)?.indexing_submissions;
    const delivered = Array.isArray(subs)
      ? subs.filter((s) => s && s.method === 'indexing_api' && s.result !== 'error')
      : [];
    const first = delivered
      .map((s) => s.submitted_at)
      .filter(Boolean)
      .sort()[0] || null;
    return {
      slug: e.slug,
      title: e.title || e.slug,
      trigger: e.state ? `indexing: ${e.state}` : 'indexing',
      created_at: first,
      decision: 'indexing-api-exhausted',
      reason: `${e.prior_indexing_submissions} prior Indexing API submissions, still not indexed`,
      label: DECISION_LABELS['indexing-api-exhausted'],
      last_gate_reason: `${e.prior_indexing_submissions} Indexing API submissions were delivered to Google and the page is still not indexed. `
        + 'Nothing in this pipeline will submit it again.',
      url: e.url || null,
    };
  });
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
