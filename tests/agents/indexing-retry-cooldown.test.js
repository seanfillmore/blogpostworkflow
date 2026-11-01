import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../../lib/posts.js';
import { buildRunNotification, cooldownArtifactSlugs } from '../../agents/indexing-fixer/index.js';
import { RETRY_COOLDOWN_DAYS } from '../../lib/indexing-escalation.js';
import { previewBody } from '../../agents/daily-summary/index.js';

// agents/indexing-fixer gave up on a post after 2 delivered Indexing API
// submissions, with no notion of WHEN those submissions happened. Measured on
// production 2026-09-19: 97% of all retries were fired within 3 days of the
// previous one, against a recrawl latency whose median is 62 days and of which
// exactly 1 of 38 instances had landed inside 3 days — that one being +0 days,
// same-day, which cannot be causal. So the second submission was fired blind in
// essentially every case, and the budget was one attempt counted twice.
//
// Five live posts reached the permanent flag that way. All five return HTTP 200,
// sit in the sitemap with a fresh lastmod, carry a clean self-referential
// canonical and no noindex, and one has 14 inbound internal links. They are not
// broken pages.
//
// The rule itself lives in lib/indexing-escalation.js and is tested there. What
// is pinned here is the agent: that it stops SUBMITTING inside the cooldown,
// that it releases the blocks the old rule wrote, and that neither of those
// reaches the digest as a failure.

const nowIso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString();
const sub = (daysAgo, extra = {}) => ({ method: 'indexing_api', result: 'ok', submitted_at: nowIso(daysAgo), ...extra });
const COUNT_REASON = '2 prior Indexing API submissions failed to get the post indexed. Current state: discovered_not_crawled. Manual investigation required.';

// The 7 posts carrying indexing_blocked on production, as measured. Six were
// written by the submission-count escalation; the seventh was not.
const PRODUCTION_BLOCKED = {
  // Submissions 1-2 days apart — one attempt, counted twice.
  'body-butter': { reason: COUNT_REASON, subs: [sub(21), sub(20)] },
  'body-moisturizer': { reason: COUNT_REASON, subs: [sub(21), sub(20)] },
  'charcoal-toothpaste-does-it-work-is-it-safe': { reason: COUNT_REASON, subs: [sub(22), sub(20)] },
  'healthiest-toothpaste': { reason: COUNT_REASON, subs: [sub(21), sub(20)] },
  'sustainable-deodorant': { reason: COUNT_REASON, subs: [sub(21), sub(20)] },
  // 2026-04-09 and 2026-08-04 — 117 days apart. Two genuine attempts.
  'best-natural-deodorant-for-men': { reason: COUNT_REASON, subs: [sub(163), sub(46)] },
  // A verdict about the PAGE, reached by a different path entirely.
  'why-use-natural-deodorant': {
    reason: 'Google crawled but chose not to index — signals a content quality issue',
    subs: [sub(21), sub(20)],
  },
};

// The agent hands this the whole corpus (listAllSlugs()), not the checker's
// results — so the unblocked majority is in here too.
const productionSlugs = () => [
  ...Object.keys(PRODUCTION_BLOCKED),
  'best-soap-for-tattoos',
  'toothpaste-without-sls',
];

const productionMeta = (slug) => {
  const p = PRODUCTION_BLOCKED[slug];
  if (!p) return null;
  return { indexing_blocked: true, indexing_blocked_reason: p.reason, indexing_submissions: p.subs };
};

// ── the blast radius, reproduced ─────────────────────────────────────────────

test('the production sweep releases 5, keeps 1 and never touches the 7th', () => {
  const released = cooldownArtifactSlugs(productionSlugs(), productionMeta);

  assert.deepEqual(released.sort(), [
    'body-butter',
    'body-moisturizer',
    'charcoal-toothpaste-does-it-work-is-it-safe',
    'healthiest-toothpaste',
    'sustainable-deodorant',
  ]);

  // Its submissions are 117 days apart: two independent attempts, and the
  // verdict stands. PR #914 made it visible in the 5 AM digest, which is the
  // right remedy for it — do not bend the rule to force it through.
  assert.ok(!released.includes('best-natural-deodorant-for-men'));

  // Different reason, different path, no business of this rule's.
  assert.ok(!released.includes('why-use-natural-deodorant'),
    'a content-quality block released here means the reason gate is missing');
});

test('the sweep asks the CORPUS, not the checker report', () => {
  // The sibling sweep (staleBlockedSlugs) needs a verdict, so it can only ever
  // see posts in today's report. This question is answered by the post's own
  // submission history, and a block that outlived the rule that wrote it must
  // not survive because the checker skipped that post this morning —
  // agents/legacy-triage buckets a blocked post as broken, and
  // agents/legacy-rebuilder then skips it forever.
  const src = readFileSync(join(ROOT, 'agents/indexing-fixer/index.js'), 'utf8');
  assert.match(src, /cooldownArtifactSlugs\(listAllSlugs\(\), loadPostMeta\)/);
  assert.doesNotMatch(src, /cooldownArtifactSlugs\(allResults/);
});

test('the sweep tolerates a missing or unreadable post meta', () => {
  assert.deepEqual(cooldownArtifactSlugs(productionSlugs(), () => null), []);
  assert.deepEqual(cooldownArtifactSlugs(undefined, productionMeta), []);
  assert.deepEqual(cooldownArtifactSlugs(['', null, 'no-such-post'], productionMeta), []);
});

// ── the submit side ──────────────────────────────────────────────────────────

test('the agent SKIPS inside the cooldown and COUNTS the skip', () => {
  // Fixing the escalation alone would leave the fleet re-submitting daily
  // forever; it would just no longer be punished for it. The source is scanned
  // because the loop lives inside processNormalRun, which reads a report off
  // disk and talks to the live Indexing API.
  const src = readFileSync(join(ROOT, 'agents/indexing-fixer/index.js'), 'utf8');

  assert.match(src, /const cooldownSkipped = \[\];/, 'the skip must be collected');
  const loop = src.slice(src.indexOf('for (const r of tierTwo)'), src.indexOf('// The counts the summary block'));
  assert.match(loop, /retryCooldown\(subs, 'indexing_api'\)/);
  assert.match(loop, /if \(cooldown\.inCooldown\) \{/);
  assert.match(loop, /cooldownSkipped\.push\(\{/, 'skipped AND counted, never silently dropped');

  // The cooldown check must sit AFTER the escalation check: a post that has
  // already spent its budget is escalated whatever its cooldown says, and
  // shuffling the two would turn a give-up verdict into a silent daily wait.
  assert.ok(loop.indexOf('if (priorIndexing >= 2)') < loop.indexOf('if (cooldown.inCooldown)'));
  // And BEFORE the submission, or it gates nothing at all.
  assert.ok(loop.indexOf('if (cooldown.inCooldown)') < loop.indexOf('submitUrlForIndexing'));
});

test('a hand-typed --approve is not cooldown gated', () => {
  // Same carve-out every gate in this fleet makes for a single-slug CLI
  // invocation: the cooldown paces UNATTENDED spend.
  const src = readFileSync(join(ROOT, 'agents/indexing-fixer/index.js'), 'utf8');
  const approval = src.slice(src.indexOf('async function processApproval'));
  assert.doesNotMatch(approval, /retryCooldown|inCooldown/);
});

// ── what the 5 AM digest says ────────────────────────────────────────────────

const cooldownRow = (slug, since) => ({
  slug, state: 'crawled_not_indexed', age_days: 90,
  days_since_last_submission: since, days_remaining: RETRY_COOLDOWN_DAYS - since,
});

test('a cooldown skip and a release are named in the SUBJECT', () => {
  const { subject } = buildRunNotification({
    cooldownSkipped: [cooldownRow('a', 1), cooldownRow('b', 4)],
    released: ['body-butter', 'healthiest-toothpaste'],
  });
  assert.match(subject, /2 waiting out the retry cooldown/);
  assert.match(subject, /2 released \(block was bunched submissions\)/);
});

test('neither can be read as the escalated count beside it', () => {
  const { subject } = buildRunNotification({
    escalated: [{ slug: 'x', state: 'crawled_not_indexed', prior_indexing_submissions: 2 }],
    cooldownSkipped: [cooldownRow('a', 1)],
    released: ['b'],
  });
  assert.match(subject, /1 escalated \(repeat submissions, still not indexed\)/);
  assert.match(subject, /1 waiting out the retry cooldown/);
  assert.match(subject, /1 released \(block was bunched submissions\)/);
});

test('each is one body line, saying how long', () => {
  const { body } = buildRunNotification({
    cooldownSkipped: [cooldownRow('healthiest-toothpaste', 4)],
    released: ['body-butter'],
  });
  assert.match(body, new RegExp(`^\\[cooldown\\] healthiest-toothpaste: last submitted 4d ago, ${RETRY_COOLDOWN_DAYS - 4}d to go$`, 'm'));
  assert.match(body, /^\[released\] body-butter: prior submissions were under 30d apart — one attempt counted twice; indexing_blocked cleared$/m);
});

test('NEITHER flips status to error — this is the policy working', () => {
  // CLAUDE.md: `status: 'error'` means the AGENT BROKE. A page waiting out a
  // cooldown it will leave on its own, and a block correctly released, are both
  // routine housekeeping. Five agents have already had to be demoted out of the
  // Failures block for less.
  assert.equal(buildRunNotification({ cooldownSkipped: [cooldownRow('a', 1)] }).status, 'info');
  assert.equal(buildRunNotification({ released: ['a', 'b', 'c', 'd', 'e'] }).status, 'info');
  const many = buildRunNotification({
    cooldownSkipped: new Array(40).fill(null).map((_, i) => cooldownRow(`p${i}`, 1)),
    released: new Array(5).fill(null).map((_, i) => `r${i}`),
  });
  assert.equal(many.status, 'info');
});

test('a run whose only news is a cooldown still reports it', () => {
  // `parts` empty is what gates the notify(). A morning where every candidate is
  // waiting must not look like a run that did nothing — that is how a hold
  // nobody can see becomes a mystery outage six weeks later.
  assert.equal(buildRunNotification({ cooldownSkipped: [cooldownRow('a', 1)] }).parts.length, 1);
  assert.deepEqual(buildRunNotification().parts, []);
});

test('ORDERING — a release is visible in the preview; a cooldown never buries one', () => {
  // agents/daily-summary cuts an entry body at EIGHT lines. A release is a state
  // change on a post silently condemned for weeks, so it sits with the findings.
  // A cooldown skip is the most routine thing this agent does and will be the
  // BULK of an ordinary morning, so it goes last — ahead of it and it would fill
  // all eight lines by itself, which is exactly how PR #914's escalations were
  // truncated out of the digest for a month.
  const { body } = buildRunNotification({
    tierOne: new Array(14).fill(null).map((_, i) => ({ slug: `t${i}`, age_days: 30, state: 'discovered' })),
    contentQuality: new Array(13).fill(null).map((_, i) => ({ slug: `c${i}` })),
    cooldownSkipped: new Array(12).fill(null).map((_, i) => cooldownRow(`cd${i}`, 2)),
    released: ['body-butter'],
    escalated: [{ slug: 'best-natural-deodorant-for-men', state: 'crawled_not_indexed', prior_indexing_submissions: 2 }],
  });
  const lines = body.split('\n');
  const at = (prefix) => lines.findIndex((l) => l.startsWith(prefix));

  assert.ok(at('[escalated]') < at('[released]'), 'a give-up verdict outranks a release');
  assert.ok(at('[released]') < at('[tier1]'), 'a release outranks routine work');
  assert.ok(at('[cooldown]') > at('[refresh]'), 'the bulk routine skip goes last');

  const shown = previewBody(body);
  assert.ok(shown.includes('best-natural-deodorant-for-men'));
  assert.ok(shown.includes('body-butter'), 'the release was truncated out of the digest preview');
});

// ── the run report ───────────────────────────────────────────────────────────

test('the report counts both, and neither becomes a needs_decision row', () => {
  const src = readFileSync(join(ROOT, 'agents/indexing-fixer/index.js'), 'utf8');
  assert.match(src, /cooldown_skipped: cooldownSkipped\.length/);
  assert.match(src, /released_from_cooldown_artifact: released\.length/);
  // needs_decision is "a skip no automated run will ever clear" (PR #911). Both
  // of these clear themselves, so putting them there would dilute the one block
  // a human is asked to act on.
  assert.match(src, /needs_decision: needsDecision/);
  assert.match(src, /escalationDecisions\(escalated, loadPostMeta\)/);
  assert.doesNotMatch(src, /escalationDecisions\((cooldownSkipped|released)/);
});

test('the release writes an audit field and never touches anything else', () => {
  const src = readFileSync(join(ROOT, 'agents/indexing-fixer/index.js'), 'utf8');
  const sweep = src.slice(src.indexOf('const releasedSet = new Set(resolved)'), src.indexOf('const actionable ='));
  assert.match(sweep, /indexing_blocked: false/);
  assert.match(sweep, /indexing_unblocked_by:/, 'a release must say which rule made it');
  assert.match(sweep, /if \(!DRY_RUN\)/, '--dry-run must not write');
  // A hold/release is never a publish state change. Nothing on this path may
  // unpublish, redirect, deindex or delete.
  assert.doesNotMatch(sweep, /post-kill|unpublish|createRedirect|deleteArticle/i);
});
