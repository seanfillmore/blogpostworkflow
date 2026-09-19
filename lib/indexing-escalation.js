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
//
// Since 2026-09-19 there is a SECOND clause, and it is the other half of the
// same idea: a delivered submission only counts toward the budget if Google had
// a fair chance to act on the PREVIOUS one. See RETRY_COOLDOWN_DAYS below for
// the measurement — the fleet was re-submitting the next morning, which spent
// the whole budget in two days against a recrawl latency measured in months.

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
 * Submissions of a given method that were actually delivered to Google, as
 * records. A submission counts as delivered unless it was explicitly recorded as
 * an error. (Legacy records predate the `result` field; absent an error they
 * were successful, so they count.)
 *
 * One predicate, so the raw count and the cooldown count can never disagree
 * about what "delivered" means.
 */
function deliveredSubmissions(submissions, method) {
  if (!Array.isArray(submissions)) return [];
  return submissions.filter((s) => s && s.method === method && s.result !== 'error');
}

/**
 * Count submissions of a given method that were actually delivered to Google.
 *
 * This is the RAW tally — it says how many times we called the API and got a
 * 2xx, and nothing about whether those calls were independent attempts. It is
 * still the right number for reporting ("we have submitted this 5 times") and
 * it is what `isStaleAuthBlock` asks. It is NOT what decides an escalation any
 * more; `countRetryBudgetSubmissions` is.
 */
export function countDeliveredSubmissions(submissions, method) {
  return deliveredSubmissions(submissions, method).length;
}

const DAY_MS = 86400000;

/**
 * The minimum gap between two delivered Indexing API submissions for the second
 * one to count as an INDEPENDENT attempt.
 *
 * DERIVED, not picked, from the production corpus measured 2026-09-19 — 43 posts
 * carrying delivered `indexing_api` submissions, 76 submissions, 33 consecutive
 * gaps (76 − 43 = 33, one per post beyond its first):
 *
 *   RETRY INTERVAL — what we actually did.
 *     28 gaps of 1 day, 4 of 2 days, 1 of 117 days.
 *     => 32 of 33 retries (97%) were fired within 3 days of the previous one.
 *
 *   RECRAWL LATENCY — what Google actually does. 38 of the 43 posts were
 *   recrawled after their last submission. Days from that submission to the
 *   crawl, sorted:
 *     0, 17, 28, 28, 31, 33, 35, 35, 38, 40, 41, 41, 42, 53, 58, 59, 59, 59,
 *     60, 64, 66, 66, 73, 80, 80, 81, 82, 85, 85, 86, 87, 106, 106, 111, 116,
 *     125, 145, 158                                        => median 62 days.
 *
 * Read the two together and the defect is arithmetic rather than a judgement
 * call: at the 3-day interval the retries were actually fired at, exactly
 * 1 of 38 recrawls had landed (2.6%) — and that one is +0 days, the same day,
 * which cannot have been caused by the submission. So in essentially every
 * case the second submission was fired BLIND, before Google had acted on the
 * first, and a rule that gave up after two of them was counting one attempt
 * twice and then calling the page unindexable.
 *
 * 30 days is where the first real mass of recrawls has landed (4 of 38, 11%)
 * and is under half the observed median. It is deliberately NOT the median:
 * a 62-day cooldown would make a second counted attempt so rare that the
 * escalation could effectively never fire, and giving up eventually is a thing
 * this agent is supposed to be able to do. 30 is ten times the interval the
 * fleet was really retrying at, comfortably below the median, and is the rule
 * agents/indexing-fixer's own header docstring claimed from the start (a claim
 * no code ever implemented — see PR #914, which corrected the docstring to
 * match the code; this is the change that instead makes the code match the
 * design).
 *
 * What it does NOT claim: 11% is not "Google has probably acted by now". It is
 * the point at which a retry stops being provably pointless. The evidence for a
 * give-up verdict is still the >= 2 count; this constant only stops one attempt
 * being counted as two.
 */
export const RETRY_COOLDOWN_DAYS = 30;

/**
 * Count a post's INDEPENDENT delivered attempts for a method: walk the delivered
 * submissions in time order and count one only when it is at least
 * `cooldownDays` after the previously COUNTED one.
 *
 * Against the previously counted one, not the previous raw one — otherwise a
 * bunched run of daily retries would chain forward a day at a time and every
 * submission would count, which is the behaviour being fixed.
 *
 * A delivered record whose `submitted_at` will not parse is DROPPED rather than
 * counted. This number only ever blocks (it is the give-up budget), so the
 * fail-open direction is to under-count: a record we cannot place in time
 * cannot prove that a cooldown elapsed, and refusing to guess means the post
 * gets retried rather than permanently flagged on evidence nobody can read.
 */
export function countRetryBudgetSubmissions(submissions, method, { cooldownDays = RETRY_COOLDOWN_DAYS } = {}) {
  const stamps = deliveredSubmissions(submissions, method)
    .map((s) => Date.parse(s.submitted_at))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);

  const cooldownMs = cooldownDays * DAY_MS;
  let counted = 0;
  let lastCountedAt = null;
  for (const t of stamps) {
    if (lastCountedAt === null || (t - lastCountedAt) >= cooldownMs) {
      counted += 1;
      lastCountedAt = t;
    }
  }
  return counted;
}

/**
 * When a method's most recent DELIVERED submission happened, in epoch ms, or
 * null when there is none we can place in time. Errored submissions are ignored
 * for the same reason they never counted: they did not reach Google, so they
 * are no reason to make a page wait.
 */
export function lastDeliveredSubmissionAt(submissions, method) {
  const stamps = deliveredSubmissions(submissions, method)
    .map((s) => Date.parse(s.submitted_at))
    .filter((t) => Number.isFinite(t));
  return stamps.length ? Math.max(...stamps) : null;
}

/**
 * Should this post be submitted again today, or is it still inside the window
 * where Google demonstrably has not acted on the last submission?
 *
 * Submitting inside the cooldown is what spent the budget in the first place:
 * it burns a quota slot to tell Google something it has not finished processing,
 * and (before this change) it pushed the post one step closer to a permanent
 * block on the strength of that. The caller SKIPS AND COUNTS — it never drops
 * the post silently, and a skip is self-clearing: the post comes back into
 * scope by itself the day the cooldown expires.
 *
 * A `submitted_at` in the future (clock skew, a hand-edited record) reads as
 * still in cooldown, because a gap we cannot establish is a gap we have not
 * proved — the same direction `countRetryBudgetSubmissions` takes.
 *
 * @returns {{inCooldown: boolean, daysSince: number|null, daysRemaining: number}}
 */
export function retryCooldown(submissions, method, {
  cooldownDays = RETRY_COOLDOWN_DAYS,
  now = Date.now(),
} = {}) {
  const last = lastDeliveredSubmissionAt(submissions, method);
  if (last === null) return { inCooldown: false, daysSince: null, daysRemaining: 0 };
  const daysSince = Math.floor((now - last) / DAY_MS);
  const inCooldown = daysSince < cooldownDays;
  return {
    inCooldown,
    daysSince,
    daysRemaining: inCooldown ? Math.max(0, cooldownDays - daysSince) : 0,
  };
}

/**
 * The escalation, stated as the DECISION it leaves for a human.
 *
 * Same vocabulary and same shape as `DECISION_LABELS` in lib/queue-autoapply.js
 * (PR #911), because it is the same class of finding: a skip no automated run
 * will ever clear. Once a post crosses `>= 2` INDEPENDENT delivered submissions
 * (`countRetryBudgetSubmissions`) the fixer stamps it and `continue`s — it never
 * submits that URL again, so nothing in this pipeline can change the verdict.
 * That is what separates it from Tier 1, Tier 2 and a cooldown skip, all of
 * which clear themselves on a later run.
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
      last_gate_reason: `${e.prior_indexing_submissions} Indexing API submissions were delivered to Google, at least ${RETRY_COOLDOWN_DAYS} days apart, `
        + 'and the page is still not indexed. Nothing in this pipeline will submit it again.',
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
  if (!isSubmissionCountBlock(meta)) return false;
  return countDeliveredSubmissions(meta.indexing_submissions, 'indexing_api') < 2;
}

/**
 * Does this `indexing_blocked` flag come from the SUBMISSION-COUNT escalation?
 *
 * Only that escalation writes "prior Indexing API submissions" into the reason.
 * Every block-clearing rule in this module gates on it FIRST, and the gate is
 * not decorative: measured on production 2026-09-19, of the 7 posts carrying
 * `indexing_blocked`, one — `why-use-natural-deodorant` — reads "Google crawled
 * but chose not to index — signals a content quality issue". That is a verdict
 * about the PAGE, reached by a different path, and no arithmetic about how often
 * we pressed submit has anything to say about it. A clearing rule that releases
 * it has lost its reason gate.
 */
function isSubmissionCountBlock(meta) {
  return /prior Indexing API submissions/i.test(String(meta?.indexing_blocked_reason || ''));
}

/**
 * True when a post's `indexing_blocked` flag is an artifact of the OLD raw
 * submission-count rule — the block was produced by submissions bunched inside
 * the retry cooldown, which the current rule collapses into a single attempt.
 *
 * Same shape and the same reason gate as `isStaleAuthBlock` above, and a strict
 * superset of it: a post with fewer than 2 delivered submissions also has fewer
 * than 2 independent ones. The two are kept separate anyway because they answer
 * different questions and are cited in different places — "the submissions never
 * reached Google" (an auth outage) and "the submissions reached Google too fast
 * to be two attempts" (this one).
 *
 * Clearing is safe in the direction that matters: it restores a FREE API retry
 * on a live page that is already published and already in the sitemap. It never
 * unpublishes, deindexes or deletes anything.
 *
 * Measured on production 2026-09-19 — of the 6 posts blocked by this
 * escalation, 5 release (submissions 1–2 days apart) and 1 does not
 * (`best-natural-deodorant-for-men`, submissions 2026-04-09 and 2026-08-04,
 * 117 days apart — two genuine independent attempts, and the verdict stands).
 */
export function isCooldownArtifactBlock(meta, { cooldownDays = RETRY_COOLDOWN_DAYS } = {}) {
  if (!meta || !meta.indexing_blocked) return false;
  if (!isSubmissionCountBlock(meta)) return false;
  return countRetryBudgetSubmissions(meta.indexing_submissions, 'indexing_api', { cooldownDays }) < 2;
}
