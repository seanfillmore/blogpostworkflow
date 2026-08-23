// lib/blocked-posts.js
//
// The single pure rule for "is this post hard-blocked by the editorial gate?",
// shared by the 5 AM digest (agents/daily-summary), the dashboard's blocked-posts
// card (agents/dashboard/lib/data-loader.js) and the agent that fixes them
// (agents/blocked-post-resolver). It lived in data-loader.js, which drags in the
// whole dashboard path module — not importable from an agent — so it moved here.
//
// Two things changed when it moved, both of them the reason the digest cried
// wolf every morning:
//
//   1. Publish state now comes from lib/post-publish-state.js, so a legacy post
//      with an article id and no `shopify_status` is recognised as LIVE. The old
//      rule 2 ("skip only posts Shopify EXPLICITLY marks published/scheduled")
//      meant the 52 status-less posts could never be skipped, and three live,
//      HTTP-200 pages carrying a stale Needs Work report were reported as
//      "Action Required — hard-blocked" every day since 2026-08-16.
//   2. `includeLive` splits the two audiences that were previously conflated.
//      The email is for things a human must act on: a live page is not one, so
//      the digest passes `includeLive: false`. The dashboard and the resolver
//      pass `includeLive: true` — a live page whose refresh fails the gate is
//      real work, it just is not mail.

import { createHash } from 'node:crypto';
import { resolvePublishStatus } from './post-publish-state.js';

// How recent a LIVE post's editor report must be to count as a freshly-blocked
// refresh rather than an ancient stale report on a healthy legacy post. Days.
export const LIVE_BLOCK_FRESHNESS_DAYS = 30;

/**
 * Content address for an editor report. Used to answer "have we already tried,
 * and failed, on exactly this verdict?" — see rule 6. Deliberately content-based
 * rather than timestamp-based: file mtimes in data/posts/ are checkout/pull
 * times, not review times, and are meaningless in a fresh worktree.
 */
export function reportFingerprint(report) {
  return createHash('sha1').update(String(report ?? '')).digest('hex');
}

/**
 * Pure decision: given a post's editor report + meta, is it hard-blocked?
 *
 * Rules, in order:
 *   1. The report must contain a "VERDICT: Needs Work" — cheap pre-filter.
 *   2. A SCHEDULED post is never blocked: it goes live on its own.
 *   3. "## OVERALL QUALITY" (the editor's canonical sign-off) trumps sub-section
 *      verdicts: Pass / Good / Excellent → not blocked.
 *   4. "## BLOCKERS*" starting with "None" → not blocked.
 *   5. A LIVE post is blocked only while its failing report is FRESH, and only
 *      when the caller asked for live posts (`includeLive`). Explicitly-published
 *      and inferred-published posts get identical treatment here — the split
 *      between them is what this module exists to end.
 *   6. A post already exhausted by blocked-post-resolver against THIS EXACT
 *      report is suppressed until the editor says something new. Without this a
 *      page whose last unsourceable claim cannot be repaired re-enters the queue
 *      every day and burns paid LLM calls on text that will not change.
 *
 * @returns {{live:boolean, blockerText:string}|null} null = not blocked
 */
export function classifyBlockedReport({
  report, meta, reportAgeDays = Infinity, now = Date.now(), includeLive = true,
} = {}) {
  if (!report || !meta) return null;
  if (!/VERDICT[:*\s]*Needs Work/i.test(report)) return null;                              // rule 1

  const status = resolvePublishStatus(meta, { now });
  if (status === 'scheduled') return null;                                                 // rule 2

  const overallMatch = report.match(/##[^\n]*OVERALL QUALITY[^\n]*\n[\s\S]*?VERDICT[:*\s]+([^\n]+)/i);
  if (overallMatch && !/needs work/i.test(overallMatch[1])) return null;                   // rule 3

  const blockersMatch = report.match(/##[^\n]*BLOCKER[^\n]*\n([\s\S]*?)(?=\n##|\n---|$)/i);
  if (blockersMatch && /^\s*None\b/i.test(blockersMatch[1].trim())) return null;           // rule 4

  const live = status === 'published';
  if (live && (!includeLive || reportAgeDays > LIVE_BLOCK_FRESHNESS_DAYS)) return null;    // rule 5

  const prior = meta.blocked_resolution;
  if (prior && prior.report_fingerprint === reportFingerprint(report)) return null;        // rule 6

  const blockerText = blockersMatch ? blockersMatch[1].trim().slice(0, 600) : 'See editor report for details.';
  return { live, blockerText };
}
