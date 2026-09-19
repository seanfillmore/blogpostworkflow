import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isInfraError,
  countDeliveredSubmissions,
  countRetryBudgetSubmissions,
  lastDeliveredSubmissionAt,
  retryCooldown,
  isStaleAuthBlock,
  isCooldownArtifactBlock,
  RETRY_COOLDOWN_DAYS,
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

// ── the retry cooldown ────────────────────────────────────────────────────────
//
// THE MEASUREMENT, as read off production on 2026-09-19, and the arithmetic that
// picks 30 out of it. Held here as data rather than as a comment so the constant
// is recomputed on every run: if the corpus ever says something else, this fails
// instead of quietly ageing.

// 43 posts carried delivered indexing_api submissions; 76 submissions between
// them; 33 consecutive gaps. Gap in days → how many gaps were that long.
const RETRY_GAP_DAYS = [
  ...new Array(28).fill(1),
  ...new Array(4).fill(2),
  117,
];
const POSTS_WITH_SUBMISSIONS = 43;
const TOTAL_SUBMISSIONS = 76;

// Days from a post's last submission to Google's next crawl of it, for the 38
// of those 43 posts that were recrawled at all. The other 5 have never been
// recrawled since their last submission — and they are precisely the 5 Google
// still reports as 404.
const RECRAWL_LATENCY_DAYS = [
  0, 17, 28, 28, 31, 33, 35, 35, 38, 40, 41, 41, 42, 53, 58, 59, 59, 59,
  60, 64, 66, 66, 73, 80, 80, 81, 82, 85, 85, 86, 87, 106, 106, 111, 116,
  125, 145, 158,
];

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const recallAt = (days) => RECRAWL_LATENCY_DAYS.filter((d) => d <= days).length / RECRAWL_LATENCY_DAYS.length;
const quantile = (xs, q) => [...xs].sort((a, b) => a - b)[Math.floor(q * (xs.length - 1))];

test('the measured corpus is internally consistent', () => {
  // A post with n submissions contributes n−1 consecutive gaps, so the gap count
  // is forced by the other two numbers. If this ever fails, one of the three
  // figures quoted in lib/indexing-escalation.js was transcribed wrong and the
  // whole derivation below is standing on it.
  assert.equal(RETRY_GAP_DAYS.length, TOTAL_SUBMISSIONS - POSTS_WITH_SUBMISSIONS);
  assert.equal(RETRY_GAP_DAYS.length, 33);
  assert.equal(RECRAWL_LATENCY_DAYS.length, 38);
  assert.equal(median(RECRAWL_LATENCY_DAYS), 62);
});

test('the OLD rule spent the whole budget before Google had acted, measurably', () => {
  // 32 of 33 retries were fired within 3 days of the previous one...
  const within3 = RETRY_GAP_DAYS.filter((d) => d <= 3).length;
  assert.equal(within3, 32);
  assert.ok(within3 / RETRY_GAP_DAYS.length > 0.96);

  // ...and at 3 days exactly ONE of 38 recrawls had landed.
  assert.equal(RECRAWL_LATENCY_DAYS.filter((d) => d <= 3).length, 1);
  // That one is +0 days — the same day as the submission, so it cannot have been
  // caused by it. The honest recall of a 3-day retry is zero.
  assert.equal(RECRAWL_LATENCY_DAYS.filter((d) => d > 0 && d <= 3).length, 0);
});

test('RETRY_COOLDOWN_DAYS is recomputed from that distribution, not asserted', () => {
  // The rule: the shortest round (10-day) cooldown at which at least a tenth of
  // measured recrawls have landed — i.e. the point where a retry stops being
  // provably pointless.
  let derived = 10;
  while (derived < 365 && recallAt(derived) < 0.10) derived += 10;
  assert.equal(RETRY_COOLDOWN_DAYS, derived);

  // Bounded on BOTH sides, because each bound is a different failure.
  // Too short and it changes nothing: it has to clear the interval the fleet was
  // actually retrying at (p97 of the observed gaps).
  assert.ok(RETRY_COOLDOWN_DAYS > quantile(RETRY_GAP_DAYS, 0.97));
  // Too long and the escalation can never fire at all — giving up eventually is
  // a thing this agent is supposed to be able to do. Under the median recrawl.
  assert.ok(RETRY_COOLDOWN_DAYS < median(RECRAWL_LATENCY_DAYS));
  // And it must be a real improvement on the status quo, not a rounding of it.
  assert.ok(recallAt(RETRY_COOLDOWN_DAYS) >= 3 * recallAt(3));
});

// ── countRetryBudgetSubmissions ───────────────────────────────────────────────

const sub = (day, extra = {}) => ({ method: 'indexing_api', result: 'ok', submitted_at: `${day}T03:31:00Z`, ...extra });

test('countRetryBudgetSubmissions: bunched submissions collapse to ONE attempt', () => {
  // The production shape of all five posts that got permanently blocked: three
  // consecutive mornings. Under the raw tally that is 3 and the post is
  // condemned twice over; it is one attempt.
  const subs = [sub('2026-08-28'), sub('2026-08-29'), sub('2026-08-30')];
  assert.equal(countDeliveredSubmissions(subs, 'indexing_api'), 3);
  assert.equal(countRetryBudgetSubmissions(subs, 'indexing_api'), 1);
});

test('countRetryBudgetSubmissions: the gap is measured against the last COUNTED one', () => {
  // The trap: chaining off the previous RAW submission lets a daily drip walk
  // forward one day at a time and every submission counts again. 29 daily
  // submissions span 28 days, which is still one attempt.
  const subs = [];
  for (let d = 1; d <= 29; d += 1) subs.push(sub(`2026-08-${String(d).padStart(2, '0')}`));
  assert.equal(countDeliveredSubmissions(subs, 'indexing_api'), 29);
  assert.equal(countRetryBudgetSubmissions(subs, 'indexing_api'), 1);
});

test('countRetryBudgetSubmissions: genuinely spaced submissions BOTH count', () => {
  // best-natural-deodorant-for-men on production: 2026-04-09 and 2026-08-04,
  // 117 days apart. Two real attempts, and its escalation is correct.
  const subs = [sub('2026-04-09'), sub('2026-08-04')];
  assert.equal(countRetryBudgetSubmissions(subs, 'indexing_api'), 2);
});

test('countRetryBudgetSubmissions: the boundary is inclusive at exactly the cooldown', () => {
  assert.equal(countRetryBudgetSubmissions([sub('2026-08-01'), sub('2026-08-31')], 'indexing_api'), 2); // +30d
  assert.equal(countRetryBudgetSubmissions([sub('2026-08-01'), sub('2026-08-30')], 'indexing_api'), 1); // +29d
});

test('countRetryBudgetSubmissions: out-of-order records are walked in time order', () => {
  // The history is appended chronologically today, but a count whose answer
  // depends on array order is a count waiting to be wrong.
  const subs = [sub('2026-08-04'), sub('2026-04-09'), sub('2026-08-05')];
  assert.equal(countRetryBudgetSubmissions(subs, 'indexing_api'), 2);
});

test('countRetryBudgetSubmissions: errored submissions still do not count', () => {
  // Both clauses of the rule apply, and they fail in the same direction.
  const subs = [
    sub('2026-04-09'),
    sub('2026-06-01', { result: 'error', error: 'permission denied' }),
    sub('2026-08-04'),
    sub('2026-08-05', { result: 'error', error: 'permission denied' }),
  ];
  assert.equal(countRetryBudgetSubmissions(subs, 'indexing_api'), 2);
});

test('countRetryBudgetSubmissions: an undatable record is dropped, never counted', () => {
  // This number only ever BLOCKS, so it under-counts rather than guesses: a
  // record we cannot place in time cannot prove a cooldown elapsed.
  const subs = [
    { method: 'indexing_api', result: 'ok' },
    { method: 'indexing_api', result: 'ok', submitted_at: 'not a date' },
  ];
  assert.equal(countDeliveredSubmissions(subs, 'indexing_api'), 2);
  assert.equal(countRetryBudgetSubmissions(subs, 'indexing_api'), 0);
});

test('countRetryBudgetSubmissions: other methods and empty history', () => {
  assert.equal(countRetryBudgetSubmissions([sub('2026-01-01'), { method: 'sitemap_resubmit', result: 'ok', submitted_at: '2026-06-01T00:00:00Z' }], 'indexing_api'), 1);
  assert.equal(countRetryBudgetSubmissions([], 'indexing_api'), 0);
  assert.equal(countRetryBudgetSubmissions(undefined, 'indexing_api'), 0);
});

// ── retryCooldown — the SUBMIT side ───────────────────────────────────────────
// Stopping the escalation without stopping the submission would leave the fleet
// re-submitting daily forever; it would just no longer be punished for it.

const NOW = Date.parse('2026-09-19T12:00:00Z');

test('retryCooldown: a submission yesterday means wait', () => {
  const c = retryCooldown([sub('2026-09-18')], 'indexing_api', { now: NOW });
  assert.equal(c.inCooldown, true);
  assert.equal(c.daysSince, 1);
  assert.equal(c.daysRemaining, RETRY_COOLDOWN_DAYS - 1);
});

test('retryCooldown: past the cooldown it submits again', () => {
  const c = retryCooldown([sub('2026-04-09')], 'indexing_api', { now: NOW });
  assert.equal(c.inCooldown, false);
  assert.equal(c.daysRemaining, 0);
});

test('retryCooldown: no prior delivered submission is never a wait', () => {
  // A post nobody has submitted must go out today. The cooldown paces retries;
  // it is not a queue.
  assert.equal(retryCooldown([], 'indexing_api', { now: NOW }).inCooldown, false);
  assert.equal(retryCooldown(undefined, 'indexing_api', { now: NOW }).inCooldown, false);
  assert.equal(retryCooldown([sub('2026-09-18', { result: 'error', error: 'permission denied' })], 'indexing_api', { now: NOW }).inCooldown, false,
    'an errored submission never reached Google, so it is no reason to make a page wait');
});

test('retryCooldown: the MOST RECENT delivered submission decides', () => {
  const c = retryCooldown([sub('2026-01-01'), sub('2026-09-18'), sub('2026-03-01')], 'indexing_api', { now: NOW });
  assert.equal(c.inCooldown, true);
  assert.equal(c.daysSince, 1);
});

test('retryCooldown: a future timestamp reads as still waiting', () => {
  // Clock skew or a hand-edited record. A gap we cannot establish is a gap we
  // have not proved, and the cost of waiting is one deferred free API call.
  const c = retryCooldown([sub('2026-12-01')], 'indexing_api', { now: NOW });
  assert.equal(c.inCooldown, true);
});

test('lastDeliveredSubmissionAt: null when there is nothing datable', () => {
  assert.equal(lastDeliveredSubmissionAt([], 'indexing_api'), null);
  assert.equal(lastDeliveredSubmissionAt([{ method: 'indexing_api', result: 'ok' }], 'indexing_api'), null);
  assert.equal(lastDeliveredSubmissionAt([sub('2026-04-09')], 'indexing_api'), Date.parse('2026-04-09T03:31:00Z'));
});

// ── isCooldownArtifactBlock ───────────────────────────────────────────────────

const blockedBy = (reason, subs) => ({
  indexing_blocked: true,
  indexing_blocked_reason: reason,
  indexing_submissions: subs,
});
const COUNT_REASON = '2 prior Indexing API submissions failed to get the post indexed. Current state: discovered_not_crawled. Manual investigation required.';

test('isCooldownArtifactBlock: a block built from bunched submissions is released', () => {
  assert.equal(isCooldownArtifactBlock(blockedBy(COUNT_REASON, [sub('2026-08-29'), sub('2026-08-30')])), true);
});

test('isCooldownArtifactBlock: a block built from spaced submissions STAYS', () => {
  // The verdict on best-natural-deodorant-for-men. Do not bend the rule to
  // release it — PR #914 made it visible in the digest, which is the remedy.
  assert.equal(isCooldownArtifactBlock(blockedBy(COUNT_REASON, [sub('2026-04-09'), sub('2026-08-04')])), false);
});

test('isCooldownArtifactBlock: THE REASON GATE — a content-quality block is untouched', () => {
  // Verified on production: why-use-natural-deodorant carries this reason. It is
  // a verdict about the PAGE reached by a different path, and no arithmetic
  // about how often we pressed submit has anything to say about it. If this
  // releases, the reason gate has been lost.
  const meta = blockedBy(
    'Google crawled but chose not to index — signals a content quality issue',
    [sub('2026-08-29'), sub('2026-08-30')],
  );
  assert.equal(isCooldownArtifactBlock(meta), false);
  // And the same gate on every other block this fleet writes.
  assert.equal(isCooldownArtifactBlock(blockedBy('Page has a noindex meta tag. Remove it in the Shopify article HTML.', [])), false);
  assert.equal(isCooldownArtifactBlock(blockedBy('robots.txt blocks this URL. Check the Shopify theme robots.txt.liquid file.', [])), false);
  assert.equal(isCooldownArtifactBlock(blockedBy('Google picked a different canonical (https://other) than what the page declares.', [])), false);
});

test('isCooldownArtifactBlock: an unblocked post is never released', () => {
  assert.equal(isCooldownArtifactBlock({ indexing_blocked: false, indexing_blocked_reason: COUNT_REASON }), false);
  assert.equal(isCooldownArtifactBlock({}), false);
  assert.equal(isCooldownArtifactBlock(null), false);
});

test('isCooldownArtifactBlock: a superset of isStaleAuthBlock, never a contradiction', () => {
  // Fewer than 2 delivered implies fewer than 2 independent, so anything the
  // auth-outage rule releases this one releases too. The two are kept separate
  // because they answer different questions, not because they can disagree.
  const cases = [
    blockedBy(COUNT_REASON, [sub('2026-08-29', { result: 'error' }), sub('2026-08-30', { result: 'error' })]),
    blockedBy(COUNT_REASON, [sub('2026-08-30')]),
    blockedBy(COUNT_REASON, [sub('2026-04-09'), sub('2026-08-04')]),
    blockedBy('Page has a noindex meta tag.', []),
  ];
  for (const meta of cases) {
    if (isStaleAuthBlock(meta)) {
      assert.equal(isCooldownArtifactBlock(meta), true, `${meta.indexing_blocked_reason} should also be a cooldown artifact`);
    }
  }
});

test('the reason the agent WRITES is recognised by the rule that clears it', () => {
  // The two are a pair: agents/indexing-fixer composes this string and this
  // module greps it back. A reworded stamp that no longer matches would leave
  // every future block permanently unclearable, silently.
  for (const n of [2, 3]) {
    const written = `${n} prior Indexing API submissions, at least ${RETRY_COOLDOWN_DAYS} days apart, failed to get the post indexed. Current state: crawled_not_indexed. Manual investigation required.`;
    assert.equal(isCooldownArtifactBlock(blockedBy(written, [sub('2026-08-29'), sub('2026-08-30')])), true);
    assert.equal(isCooldownArtifactBlock(blockedBy(written, [sub('2026-04-09'), sub('2026-08-04')])), false);
  }
});
