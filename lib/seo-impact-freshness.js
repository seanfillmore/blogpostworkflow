// lib/seo-impact-freshness.js
//
// ONE staleness policy for `data/reports/seo-impact/latest.json`.
//
// That single file is read by nine consumers, four of which BLOCK or DELETE
// work on what it says. Before this module they each answered "is it still
// current?" differently, or not at all:
//
//   pipeline-prioritizer  3 days      priority-tuner        35 days
//   daily-summary         9 days      calendar-runner       no check
//   content-strategist    no check    brief-triage          no check
//   ad-brief              no check    dashboard             no check
//
// Nothing chose those numbers together, and the ones with no check were the
// dangerous ones: a months-old report still blocked drafting, still silently
// dropped an LLM's proposals, and still `unlinkSync`'d paid-for briefs — on a
// measurement nobody had looked at since June.
//
// ────────────────────────────────────────────────────────────────────────────
// THE THRESHOLD, AND WHY IT IS 4 DAYS
//
// `agents/seo-impact` runs DAILY from `scheduler.js` (step 5z.1), so a healthy
// report is 0-1 days old and never older. The grace has to cover exactly two
// legitimate things:
//
//   1. Structural lag. seo-impact runs at step 5z.1, but `calendar-runner` and
//      `queue-autoapply` run at steps 1 and 3 of the SAME 8 AM pipeline, and
//      `daily-summary` runs at 5 AM PT — three hours before that day's report
//      exists. All of them legitimately read YESTERDAY's report. Age 1 is the
//      normal case for most consumers, not a warning sign.
//   2. One or two missed cron days. A transient API failure or a single skipped
//      run is not a reason to stop the fleet drafting.
//
// Age > 4 therefore means the producer has missed at least THREE consecutive
// daily runs. That has happened once, and it was not transient: the 2026-06
// disk-full incident took every cron job out for four days. It is the signature
// of a broken box, and the shape of the rule matches what `daily-summary`
// already applies to the raw feeds — expected lag + ~2 days grace.
//
// Verified against production on 2026-08-23: `latest.json` carried
// `generated_at: 2026-08-22T15:16:44Z` (age 1), with an unbroken daily run of
// dated report files behind it. 4 days is not a tight fit.
//
// DO NOT loosen this to silence a noisy digest row. A stale seo-impact report
// IS the outage; the row is how you find out.
//
// ────────────────────────────────────────────────────────────────────────────
// WHY THE ALERT THRESHOLD IS THE SAME NUMBER
//
// `agents/daily-summary`'s `checkSystemHealth` is the only channel a stale
// report speaks through — these agents run unattended at 3 and 8 AM and nobody
// reads their stdout. It used to alert at 9 days while `pipeline-prioritizer`
// silently dropped the revenue signal at 3, so ages 4-9 were a window in which
// the fleet degraded and the digest said everything was fine. The alert must
// never fire LATER than the strictest gate degrades, so both read this constant.
//
// ────────────────────────────────────────────────────────────────────────────
// WHAT A STALE REPORT MEANS, PER CONSUMER
//
// Two behaviours, and they are not interchangeable:
//
//   FAIL SAFE (blocks or deletes) — `lib/cluster-hold.js` treats a stale report
//   exactly like an absent one: `available: false`, nothing classified, nothing
//   held. Every cluster reads `unproven`, so `calendar-runner` blocks nothing,
//   `content-strategist` drops nothing, `queue-autoapply` dismisses nothing and
//   `scripts/triage-orphan-briefs.mjs --drop-non-earning` refuses to run at all.
//   This composes with the fail-open behaviour PR #624 already built into
//   `classifyClusters` (no `totals` → nothing may be a dud) rather than adding
//   a second mechanism beside it.
//
//   DEGRADE (ranks or displays) — `pipeline-prioritizer` skips the revenue-
//   cluster boost, `ad-brief` scores `commercial` neutral, the dashboard shows
//   the report with a staleness note. None of these destroy anything, so
//   refusing to run would cost more than running without the signal.
//
// The freshness arithmetic itself is NOT re-implemented here: it delegates to
// `lib/snapshot-health.js`'s `checkFreshness`, which is the fleet's one answer
// to "how old is too old" and already handles clock skew and missing data.

import { join } from 'node:path';
import { checkFreshness, newestReportDate } from './snapshot-health.js';

/** The one report every gate holds on. One path, so nobody holds on a different truth. */
export const SEO_IMPACT_RELPATH = join('data', 'reports', 'seo-impact', 'latest.json');

/** The name this feed goes by in logs, banners and the digest. */
export const SEO_IMPACT_NAME = 'seo-impact report';

/**
 * The default, derived above: a daily producer + one day of structural pipeline
 * lag + two days of grace. Every consumer uses this unless it has a documented
 * reason not to, and there is exactly one such consumer.
 */
export const SEO_IMPACT_MAX_AGE_DAYS = 4;

/**
 * `agents/priority-tuner`'s deliberately wider window — the one exception.
 *
 * The tuner does not read the report's CURRENT state. It joins its attribution
 * ledger against `action_wins`, which are revenue outcomes measured over the
 * report's own trailing 28-day window and only become measurable after
 * `tuning.measureLagDays`. A report a fortnight old still describes very nearly
 * the same 28 days of outcomes, so tuning on it is not tuning on stale data in
 * the way that BLOCKING on it would be.
 *
 * It is also the least urgent consumer in the fleet: it nudges weight knobs, and
 * skipping a run costs nothing. 35 days keeps a monthly-cadence tuner able to
 * run at all. It is looser than the alert threshold on purpose, which is safe —
 * a looser consumer can never degrade before the digest has already complained.
 */
export const PRIORITY_TUNER_MAX_AGE_DAYS = 35;

/** The report's absolute path under a checkout root. */
export function seoImpactPath(root) {
  return join(root, SEO_IMPACT_RELPATH);
}

const dateOf = (ts) => {
  if (!ts) return null;
  const d = String(ts).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
};

/** Today in Pacific time, the timezone every scheduled job's date is stamped in. */
export function todayPT() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

/**
 * Freshness of a report object ALREADY IN HAND — no second read of the file.
 *
 * `lib/cluster-hold.js` takes an injectable `readJson`, so re-reading the path
 * through `newestReportDate` would bypass the injection and make the gate
 * untestable without a fixture on disk. Same classifier, different input.
 *
 * @returns {{name, newestDate, ageDays:number|null, maxAgeDays:number, status:'ok'|'stale'|'missing'}}
 */
export function freshnessOfReport(report, { today = todayPT(), maxAgeDays = SEO_IMPACT_MAX_AGE_DAYS } = {}) {
  const [r] = checkFreshness(
    [{ name: SEO_IMPACT_NAME, newestDate: dateOf(report?.generated_at), maxAgeDays }],
    { today },
  );
  return r;
}

/** Freshness of the report on disk, for callers that do not need its contents. */
export function freshnessOfFile(path, { today = todayPT(), maxAgeDays = SEO_IMPACT_MAX_AGE_DAYS } = {}) {
  const [r] = checkFreshness(
    [{ name: SEO_IMPACT_NAME, newestDate: newestReportDate(path), maxAgeDays }],
    { today },
  );
  return r;
}

/** True only for `ok`. A missing report is not fresh — it is the other failure. */
export function isFresh(result) {
  return result?.status === 'ok';
}

/**
 * One sentence for a log line, a banner or a digest row. Empty when fresh, so a
 * caller can `if (note) ...` without re-checking the status.
 */
export function staleNote(result) {
  if (!result || result.status === 'ok') return '';
  if (result.status === 'missing') {
    return `${SEO_IMPACT_RELPATH} is missing or has no generated_at — run agents/seo-impact.`;
  }
  return `${SEO_IMPACT_RELPATH} is STALE — ${result.ageDays} days old (generated ${result.newestDate}), `
    + `expected within ${result.maxAgeDays} days; agents/seo-impact has missed several daily runs.`;
}
