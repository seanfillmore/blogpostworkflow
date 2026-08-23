import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectBlockedPosts, planPost, metaAfterSuccess, metaAfterExhaustion,
  renderResolverSummary,
} from '../../agents/blocked-post-resolver/index.js';
import { reportFingerprint } from '../../lib/blocked-posts.js';

const NEEDS_WORK = '## OVERALL QUALITY\nVERDICT: Needs Work\n\n## BLOCKERS\n1. Factual concerns: an uncited statistic.\n';
const PASSING = '## OVERALL QUALITY\nVERDICT: Good\n\n## BLOCKERS\nNone.\n';
const now = Date.parse('2026-08-22T12:00:00Z');
const AT = '2026-08-22T12:00:00.000Z';
const live = (extra = {}) => ({ shopify_blog_id: 48998449187, shopify_article_id: 562334302378, shopify_publish_at: '2025-06-25T11:00:07-06:00', ...extra });

// ── selection ────────────────────────────────────────────────────────────────

test('a live post with a fresh Needs Work report is selected — the live page is the thing to fix', () => {
  const picked = selectBlockedPosts([{ slug: 'a', meta: live(), report: NEEDS_WORK, reportAgeDays: 2 }], { now });
  assert.equal(picked.length, 1);
  assert.equal(picked[0].slug, 'a');
  assert.equal(picked[0].live, true);
});

test('a passing post is never selected', () => {
  assert.deepEqual(selectBlockedPosts([{ slug: 'a', meta: live(), report: PASSING, reportAgeDays: 1 }], { now }), []);
});

test('a post already exhausted against THIS report is not re-attempted', () => {
  const meta = live({ blocked_resolution: { outcome: 'exhausted', report_fingerprint: reportFingerprint(NEEDS_WORK) } });
  assert.deepEqual(selectBlockedPosts([{ slug: 'a', meta, report: NEEDS_WORK, reportAgeDays: 1 }], { now }), []);
});

test('a post with a stale (>30d) report is not selected — no daily churn on ancient reports', () => {
  assert.deepEqual(selectBlockedPosts([{ slug: 'a', meta: live(), report: NEEDS_WORK, reportAgeDays: 400 }], { now }), []);
});

test('--limit and --slug narrow the batch without changing the rules', () => {
  const entries = [
    { slug: 'a', meta: live(), report: NEEDS_WORK, reportAgeDays: 1 },
    { slug: 'b', meta: live(), report: NEEDS_WORK, reportAgeDays: 1 },
  ];
  assert.equal(selectBlockedPosts(entries, { now, limit: 1 }).length, 1);
  assert.deepEqual(selectBlockedPosts(entries, { now, slug: 'b' }).map((p) => p.slug), ['b']);
});

// ── planning ─────────────────────────────────────────────────────────────────

test('a post on Shopify is planned for remediation', () => {
  const plan = planPost({ slug: 'a', meta: live(), live: true });
  assert.equal(plan.action, 'remediate');
});

test('a post with NO Shopify article is left to the publish pipeline, not remediated', () => {
  // remediate-live-post.js pulls the LIVE body; with no article id there is
  // nothing to pull and it exits 1. That is calendar-runner's job, not ours.
  const plan = planPost({ slug: 'a', meta: { title: 'draft' }, live: false });
  assert.equal(plan.action, 'skip');
  assert.match(plan.reason, /not on shopify/i);
});

// ── meta transitions ─────────────────────────────────────────────────────────

test('success clears needs_rebuild and any prior exhaustion record', () => {
  const before = live({ needs_rebuild: { flagged_at: '2026-08-16T00:00:00Z', reasons: ['factual'] }, blocked_resolution: { outcome: 'exhausted' } });
  const after = metaAfterSuccess(before, { at: AT });
  assert.equal(after.needs_rebuild, undefined);
  assert.equal(after.blocked_resolution, undefined);
  assert.equal(after.blocked_resolved_at, AT);
  assert.equal(after.shopify_article_id, before.shopify_article_id, 'nothing else is touched');
});

// SEAN'S EXPLICIT DECISION: on exhaustion we soften, never delete. These are
// indexed pages that earn traffic. Nothing here may unpublish or kill a post.
test('exhaustion clears the flag, keeps the post live, and records why', () => {
  const before = live({ needs_rebuild: { flagged_at: '2026-08-16T00:00:00Z', reasons: ['factual concerns'] } });
  const after = metaAfterExhaustion(before, { at: AT, report: NEEDS_WORK, reasons: ['factual concerns'] });

  assert.equal(after.needs_rebuild, undefined, 'the flag is cleared so the post stops resurfacing');
  assert.equal(after.blocked_resolution.outcome, 'exhausted');
  assert.equal(after.blocked_resolution.attempted_at, AT);
  assert.deepEqual(after.blocked_resolution.reasons, ['factual concerns']);
  assert.equal(after.blocked_resolution.report_fingerprint, reportFingerprint(NEEDS_WORK));
  // The page stays exactly as published as it was.
  assert.equal(after.shopify_article_id, before.shopify_article_id);
  assert.equal(after.shopify_publish_at, before.shopify_publish_at);
  assert.equal('shopify_status' in after ? after.shopify_status : undefined, before.shopify_status);
});

test('a fresh editor verdict re-opens an exhausted post (fingerprint changes)', () => {
  const after = metaAfterExhaustion(live(), { at: AT, report: NEEDS_WORK, reasons: [] });
  assert.notEqual(after.blocked_resolution.report_fingerprint, reportFingerprint('a different report'));
});

// ── the digest line ──────────────────────────────────────────────────────────

test('renderResolverSummary names every post and what happened to it', () => {
  const body = renderResolverSummary({
    resolved: [{ slug: 'best-toothpaste-without-sls-2025' }],
    exhausted: [{ slug: 'coconut-oil-for-skin', reasons: ['factual concerns'] }],
    skipped: [{ slug: 'unpublished-draft', reason: 'not on Shopify' }],
    failed: [{ slug: 'boom', reason: 'editor crashed' }],
    dryRun: false,
  });
  assert.match(body, /best-toothpaste-without-sls-2025/);
  assert.match(body, /coconut-oil-for-skin/);
  assert.match(body, /factual concerns/);
  assert.match(body, /unpublished-draft/);
  assert.match(body, /boom/);
  assert.match(body, /editor crashed/);
  assert.match(body, /still live/i, 'says plainly that an exhausted page stays live');
});

test('renderResolverSummary says so when there was nothing to do', () => {
  const body = renderResolverSummary({ resolved: [], exhausted: [], skipped: [], failed: [], dryRun: false });
  assert.match(body, /no blocked posts/i);
});

test('renderResolverSummary labels a dry run as a dry run', () => {
  const body = renderResolverSummary({ resolved: [], exhausted: [], skipped: [], failed: [], dryRun: true, candidates: [{ slug: 'a' }] });
  assert.match(body, /dry run/i);
  assert.match(body, /\ba\b/);
});
