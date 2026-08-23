import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyBlockedReport, reportFingerprint, LIVE_BLOCK_FRESHNESS_DAYS } from '../../lib/blocked-posts.js';

const NEEDS_WORK = '## OVERALL QUALITY\nVERDICT: Needs Work\n\n## BLOCKERS\n1. Ingredient accuracy: claims beeswax; spec says plant wax.\n';
const PASSING = '## OVERALL QUALITY\nVERDICT: Good\n\n## BLOCKERS\nNone.\n';
const now = Date.parse('2026-08-22T12:00:00Z');
const pastPublish = '2025-06-25T11:00:07-06:00';
const legacyLive = { shopify_article_id: 562334302378, shopify_publish_at: pastPublish };

// The digest said "Action Required — 3 posts hard-blocked" every morning for
// three pages that all return HTTP 200. They are live; the report is stale.
// includeLive:false is the email's setting — a live page is never an "action
// required" row there, because agents/blocked-post-resolver now owns fixing it
// and reports its own outcome.
test('digest mode (includeLive:false) never reports a LIVE legacy post as blocked', () => {
  assert.equal(
    classifyBlockedReport({ report: NEEDS_WORK, meta: legacyLive, reportAgeDays: 3, now, includeLive: false }),
    null,
  );
});

test('digest mode still reports a genuinely stuck pre-publish post', () => {
  const r = classifyBlockedReport({ report: NEEDS_WORK, meta: {}, reportAgeDays: 3, now, includeLive: false });
  assert.ok(r);
  assert.equal(r.live, false);
  assert.match(r.blockerText, /beeswax/);
});

// includeLive:true is the dashboard's / the resolver's setting: a live page
// serving content that fails the gate IS work, it just is not email-worthy.
test('dashboard mode surfaces a live legacy post with a FRESH failing report', () => {
  const r = classifyBlockedReport({ report: NEEDS_WORK, meta: legacyLive, reportAgeDays: 3, now, includeLive: true });
  assert.ok(r);
  assert.equal(r.live, true);
});

// THE UNIFICATION: an EXPLICITLY published post and an inferred-published one
// are now treated identically. Before, rule 2 skipped explicit 'published'
// outright while an unset status fell through to the freshness rule — the exact
// inconsistency that made 52 legacy posts behave differently from the other 41.
test('dashboard mode treats explicit and inferred published identically', () => {
  const explicit = { shopify_status: 'published', shopify_article_id: 1, shopify_publish_at: pastPublish };
  const a = classifyBlockedReport({ report: NEEDS_WORK, meta: explicit, reportAgeDays: 3, now, includeLive: true });
  const b = classifyBlockedReport({ report: NEEDS_WORK, meta: legacyLive, reportAgeDays: 3, now, includeLive: true });
  assert.deepEqual(a, b);
});

test('a SCHEDULED post is never blocked in either mode (it goes live on its own)', () => {
  const sched = { shopify_status: 'scheduled' };
  assert.equal(classifyBlockedReport({ report: NEEDS_WORK, meta: sched, reportAgeDays: 1, now, includeLive: true }), null);
  assert.equal(classifyBlockedReport({ report: NEEDS_WORK, meta: sched, reportAgeDays: 1, now, includeLive: false }), null);
});

test('a live post with a STALE report is suppressed even in dashboard mode', () => {
  const r = classifyBlockedReport({
    report: NEEDS_WORK, meta: legacyLive, reportAgeDays: LIVE_BLOCK_FRESHNESS_DAYS + 1, now, includeLive: true,
  });
  assert.equal(r, null);
});

test('OVERALL QUALITY = Good overrides a sub-section Needs Work', () => {
  const sub = '## SOURCE VERIFICATION\nVERDICT: Needs Work\n\n## OVERALL QUALITY\nVERDICT: Good\n';
  assert.equal(classifyBlockedReport({ report: sub, meta: {}, reportAgeDays: 1, now, includeLive: true }), null);
});

test('BLOCKERS = None → not blocked; no Needs Work verdict → not blocked', () => {
  assert.equal(classifyBlockedReport({ report: PASSING, meta: {}, reportAgeDays: 1, now, includeLive: true }), null);
  assert.equal(classifyBlockedReport({ report: '## OVERALL QUALITY\nVERDICT: Excellent\n', meta: {}, now, includeLive: true }), null);
});

test('missing report or meta → not blocked', () => {
  assert.equal(classifyBlockedReport({ report: '', meta: {}, now }), null);
  assert.equal(classifyBlockedReport({ report: NEEDS_WORK, meta: null, now }), null);
});

// ── the immortality fix: don't re-report a report we already failed on ────────
// blocked-post-resolver exhausts its repair loop on some posts. Softening runs,
// the flag is cleared, the page stays live and earning — but the editor report
// still says Needs Work. Without this, that post re-enters the queue tomorrow,
// and every day after, burning paid LLM calls on the same unfixable text.
test('a post whose CURRENT report was already exhausted is suppressed', () => {
  const meta = {
    ...legacyLive,
    blocked_resolution: { outcome: 'exhausted', report_fingerprint: reportFingerprint(NEEDS_WORK) },
  };
  assert.equal(classifyBlockedReport({ report: NEEDS_WORK, meta, reportAgeDays: 1, now, includeLive: true }), null);
});

test('a CHANGED report re-opens a previously exhausted post', () => {
  const meta = {
    ...legacyLive,
    blocked_resolution: { outcome: 'exhausted', report_fingerprint: reportFingerprint('some older report text') },
  };
  const r = classifyBlockedReport({ report: NEEDS_WORK, meta, reportAgeDays: 1, now, includeLive: true });
  assert.ok(r, 'a new editor verdict is new information — try again');
});

test('reportFingerprint is stable and content-addressed', () => {
  assert.equal(reportFingerprint(NEEDS_WORK), reportFingerprint(NEEDS_WORK));
  assert.notEqual(reportFingerprint(NEEDS_WORK), reportFingerprint(PASSING));
  assert.equal(reportFingerprint(''), reportFingerprint(null));
});
