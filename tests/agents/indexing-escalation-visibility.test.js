import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../../lib/posts.js';
import { buildRunNotification } from '../../agents/indexing-fixer/index.js';
import { escalationDecisions, DECISION_LABELS } from '../../lib/indexing-escalation.js';
import { previewBody } from '../../agents/daily-summary/index.js';

// agents/indexing-fixer has TWO things it calls "Tier 3" and until 2026-09-19 it
// reported only one of them.
//
//   (a) `critical` — noindex / robots / canonical / fetch failure. Always in the
//       notify() subject ("N flagged for manual fix") and body ("[critical] …").
//   (b) the submission-count escalation — >= 2 prior DELIVERED Indexing API
//       submissions and still not indexed. It printed a line, stamped
//       indexing_blocked: true on the post, and `continue`d. It was never added
//       to `critical` or to any other collection, so it reached no subject, no
//       body and no digest.
//
// Measured on production: five posts (best-natural-deodorant-for-men,
// body-moisturizer, charcoal-toothpaste-does-it-work-is-it-safe,
// healthiest-toothpaste, sustainable-deodorant) were re-stamped every single
// morning and had never once appeared in the 5 AM digest. That day's real
// subject was "Indexing Fixer: Sitemap pinged (14 URLs), 13 content-quality
// refresh triggered" — no mention of the five.

const escalatedFixture = (slug, prior = 2, state = 'crawled_not_indexed') => ({
  slug, state, prior_indexing_submissions: prior, url: `https://example.com/${slug}`, age_days: 90,
});

const PRODUCTION_FIVE = [
  'best-natural-deodorant-for-men',
  'body-moisturizer',
  'charcoal-toothpaste-does-it-work-is-it-safe',
  'healthiest-toothpaste',
  'sustainable-deodorant',
].map((s) => escalatedFixture(s));

test('an escalated post appears in the notify SUBJECT', () => {
  const { subject } = buildRunNotification({ escalated: PRODUCTION_FIVE });
  assert.match(subject, /5 escalated/);
  // And it survives beside the run that actually hid it: the real 2026-09-19
  // subject carried a sitemap ping and 13 refreshes and nothing else.
  const real = buildRunNotification({
    tierOne: new Array(14).fill(null).map((_, i) => ({ slug: `t${i}`, age_days: 30, state: 'discovered' })),
    contentQuality: new Array(13).fill(null).map((_, i) => ({ slug: `c${i}` })),
    escalated: PRODUCTION_FIVE,
  });
  assert.match(real.subject, /Sitemap pinged \(14 URLs\)/);
  assert.match(real.subject, /13 content-quality refresh triggered/);
  assert.match(real.subject, /5 escalated \(repeat submissions, still not indexed\)/);
});

test('escalated is worded so it cannot be read as the critical count', () => {
  const { subject } = buildRunNotification({
    escalated: [escalatedFixture('a')],
    critical: [{ slug: 'b', verdict: { action: 'fix_noindex_tag' } }],
  });
  // Two findings, two remedies, two distinct phrasings in one subject line.
  assert.match(subject, /1 escalated \(repeat submissions, still not indexed\)/);
  assert.match(subject, /1 flagged for manual fix/);
});

test('an escalated post appears in the notify BODY, one line each', () => {
  const { body } = buildRunNotification({ escalated: PRODUCTION_FIVE });
  for (const slug of PRODUCTION_FIVE.map((e) => e.slug)) {
    assert.match(body, new RegExp(`^\\[escalated\\] ${slug}: `, 'm'), `${slug} missing from the digest body`);
  }
  assert.match(body, /^\[escalated\] healthiest-toothpaste: 2 prior Indexing API submissions, still not indexed \(state: crawled_not_indexed\)$/m);
  assert.equal(body.split('\n').filter((l) => l.startsWith('[escalated]')).length, 5);
});

test('escalations ALONE do not flip status to error', () => {
  // CLAUDE.md: `status: 'error'` means the AGENT BROKE, never "the agent found
  // something bad" — it is what puts a row in the digest's Failures block, and
  // five agents have already had to be demoted out of it. A page Google declines
  // to index is a finding a human should read.
  const { status } = buildRunNotification({ escalated: PRODUCTION_FIVE });
  assert.equal(status, 'info');

  // Not even a large batch of them.
  const many = buildRunNotification({
    escalated: new Array(50).fill(null).map((_, i) => escalatedFixture(`post-${i}`)),
  });
  assert.equal(many.status, 'info');
});

test('the pre-existing severity rule is untouched', () => {
  // Out of scope for this change: whatever `critical` and `tierTwoFailed` did
  // before, they still do. Only the escalated set is new.
  assert.equal(buildRunNotification({ critical: [{ slug: 'a', verdict: { action: 'fix_robots_txt' } }] }).status, 'error');
  assert.equal(buildRunNotification({ tierTwoFailed: [{ slug: 'a', error: 'boom' }] }).status, 'error');
  assert.equal(buildRunNotification({ tierOne: [{ slug: 'a', age_days: 1, state: 'discovered' }] }).status, 'info');
  // A hold is the policy working, and so is an escalation — neither escalates.
  assert.equal(buildRunNotification({ heldRefreshes: [{ slug: 'a', cluster: 'x' }], escalated: PRODUCTION_FIVE }).status, 'info');
});

test('a run with nothing to report still sends nothing', () => {
  // `parts` empty is what the caller gates the notify() on. A run that pinged
  // nothing and escalated nothing must not start mailing an empty subject.
  assert.deepEqual(buildRunNotification().parts, []);
  assert.equal(buildRunNotification({ escalated: [escalatedFixture('a')] }).parts.length, 1);
});

test('the escalation is collected, not only logged, and is deferred', () => {
  // A source scan: the stamping loop lives inside processNormalRun, which reads a
  // report off disk and talks to the Indexing API, so the collection itself
  // cannot be exercised here.
  const src = readFileSync(join(ROOT, 'agents/indexing-fixer/index.js'), 'utf8');

  assert.match(src, /const escalated = \[\];/, 'the escalated set must exist');
  assert.match(src, /escalated\.push\(\{/, 'an escalation must be collected, not only printed');
  // The bug was that the escalation branch `continue`d without recording
  // anything; the push has to sit above that continue, inside the same branch as
  // the indexing_blocked stamp.
  const branch = src.slice(src.indexOf('if (priorIndexing >= 2)'), src.indexOf('if (quota.submission.remaining === 0)'));
  assert.match(branch, /escalated\.push\(/);
  assert.match(branch, /indexing_blocked: true/);

  assert.match(src, /buildRunNotification\(\{[\s\S]{0,400}escalated,/, 'the notification must be built from it');
  // Deferred, like every other finding in this fleet.
  assert.doesNotMatch(src, /immediate: true/, 'this notification must stay deferred');
});

test('the docstring no longer claims a 30-day condition the code has never had', () => {
  const src = readFileSync(join(ROOT, 'agents/indexing-fixer/index.js'), 'utf8');
  const header = src.slice(0, src.indexOf("import {"));
  assert.doesNotMatch(header, /remain not-indexed at/, 'there is no age check anywhere in this agent');
  assert.doesNotMatch(header, /30\+ days/);
  // The real trigger, stated: the delivered-submission count alone.
  assert.match(header, /delivered/i);
  assert.match(header, /no such check has ever existed/i, 'say what was wrong, not just the right thing');
  // And the code still has no age condition: the trigger is the whole predicate.
  // (The record it pushes carries age_days for the reader; that is reporting,
  // not a gate.) Adding an age check is a behaviour change, not a doc fix.
  assert.match(src, /^\s*if \(priorIndexing >= 2\) \{$/m);
});

// ── the body alone was not enough, and this is why ──────────────────────────
//
// agents/daily-summary renders an entry body through previewBody(), which cuts
// at EIGHT lines. The production run that hid the escalations carried 14
// [tier1] lines and 13 [refresh] lines; appending the escalated set after those
// would have changed the subject and nothing else a human ever reads.

test('an escalation survives the digest preview on the real run shape', () => {
  const { body } = buildRunNotification({
    tierOne: new Array(14).fill(null).map((_, i) => ({ slug: `t${i}`, age_days: 30, state: 'discovered' })),
    contentQuality: new Array(13).fill(null).map((_, i) => ({ slug: `c${i}` })),
    escalated: PRODUCTION_FIVE,
  });
  const shown = previewBody(body);
  for (const slug of PRODUCTION_FIVE.map((e) => e.slug)) {
    assert.ok(shown.includes(slug), `${slug} was truncated out of the digest preview`);
  }
});

test('what no run will ever clear is ordered above the routine work', () => {
  const { body } = buildRunNotification({
    tierOne: [{ slug: 'routine', age_days: 5, state: 'discovered' }],
    contentQuality: [{ slug: 'refreshed' }],
    escalated: [escalatedFixture('given-up-on')],
    critical: [{ slug: 'misconfigured', verdict: { action: 'fix_noindex_tag' } }],
  });
  const lines = body.split('\n');
  const at = (prefix) => lines.findIndex((l) => l.startsWith(prefix));
  assert.ok(at('[escalated]') < at('[tier1]'), 'escalated must precede routine tier-1 work');
  assert.ok(at('[critical]') < at('[refresh]'), 'critical must precede routine refreshes');
});

// ── the report the 5 AM digest actually reads ───────────────────────────────

test('escalations become needs_decision rows in queue-autoapply\'s shape', () => {
  // PR #911 established the vocabulary, the row shape and the renderer. Matching
  // it is what keeps agents/daily-summary at ONE "Needs your decision" block
  // instead of growing a parallel one per producer.
  const [row] = escalationDecisions([escalatedFixture('healthiest-toothpaste', 3)], () => ({
    indexing_submissions: [
      { method: 'indexing_api', result: 'ok', submitted_at: '2026-08-30T03:31:00Z' },
      { method: 'indexing_api', result: 'error', submitted_at: '2026-08-29T03:31:00Z' },
      { method: 'indexing_api', result: 'ok', submitted_at: '2026-09-10T03:31:00Z' },
      { method: 'sitemap_resubmit', result: 'ok', submitted_at: '2026-08-01T03:31:00Z' },
    ],
  }));
  for (const field of ['slug', 'title', 'trigger', 'created_at', 'decision', 'reason', 'label']) {
    assert.ok(field in row, `needs_decision rows must carry ${field}`);
  }
  assert.equal(row.decision, 'indexing-api-exhausted');
  assert.equal(row.label, DECISION_LABELS['indexing-api-exhausted']);
  assert.match(row.label, /investigate the page, or accept it stays unindexed/,
    'it must state the DECISION, not restate the item');
  // The FIRST DELIVERED indexing_api submission — not the errored one that never
  // reached Google, and not the sitemap ping.
  assert.equal(row.created_at, '2026-08-30T03:31:00Z');
});

test('the age is not indexing_blocked_at, which the fixer rewrites every morning', () => {
  // stampPostMeta sets indexing_blocked_at: new Date() on EVERY run, so an item
  // stuck since August would report "stuck 0 days" forever — the same
  // invisibility this change exists to remove, wearing a date.
  const [row] = escalationDecisions([escalatedFixture('a')], () => ({
    indexing_blocked_at: new Date().toISOString(),
    indexing_submissions: [{ method: 'indexing_api', result: 'ok', submitted_at: '2026-08-30T03:31:00Z' }],
  }));
  assert.equal(row.created_at, '2026-08-30T03:31:00Z');

  // A post whose submission history cannot be read reports NO age rather than a
  // wrong one; the digest simply omits the "stuck N days" clause.
  const [unknown] = escalationDecisions([escalatedFixture('b')], () => null);
  assert.equal(unknown.created_at, null);
});

test('the fixer writes the report the digest reads, always', () => {
  const src = readFileSync(join(ROOT, 'agents/indexing-fixer/index.js'), 'utf8');
  assert.match(src, /needs_decision: needsDecision/, 'the report must carry needs_decision[]');
  assert.match(src, /escalationDecisions\(escalated, loadPostMeta\)/);
  // Written on every run including an empty one, so a staleness check can tell
  // "ran, found nothing" from "did not run" — and never gated on escalated.length.
  assert.doesNotMatch(src, /if \(escalated\.length\)[\s\S]{0,200}writeFileSync/);
  // The digest must read this report, never the post metas.
  const digest = readFileSync(join(ROOT, 'agents/daily-summary/index.js'), 'utf8');
  assert.match(digest, /'reports', 'indexing-fixer', 'latest\.json'/);
  assert.doesNotMatch(digest, /indexing_blocked/, 'the digest reads the report, not the fleet working state');
});
