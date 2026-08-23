// lib/calendar-coverage.js
//
// "Is this keyword already covered?" — and, just as importantly, a record of
// every calendar item a re-plan threw away and why.
//
// WHY THIS EXISTS
// ───────────────
// `agents/content-strategist` REPLACES data/calendar/calendar.json with the
// brief queue it just extracted. Anything the planner does not re-propose, or
// that one of the filters drops, simply stops existing. On 2026-08-19 and
// 2026-08-21 that cleared 12 of the 19 items on the calendar
// (data/calendar/calendar.json.bak-2026-08-18 → the 2026-08-23 calendar), and
// the only trace was eight `[SKIP]` lines in an unattended cron log:
//
//   4  dropped by the "already covered by a published post" check
//   3  dropped by the soap cluster $0 verdict
//   4  never re-proposed, but their post is live — finished work the calendar
//      had gone on carrying
//   1  never re-proposed and no post exists: travel-size-deodorant, a real loss
//
// Two defects in the covered check made it drop items it should have kept, and
// both are reproduced by tests/lib/calendar-coverage.test.js against real
// production data:
//
// 1. THE POOL COUNTED POSTS THAT WERE NEVER PUBLISHED. The pool was every
//    `data/posts/<slug>/meta.json` with a `target_keyword`, with no check that
//    anything had been written. `agents/blog-post-writer` writes that file at
//    DRAFT time, so from the moment `calendar-runner` starts drafting an item,
//    the item's own keyword is in the "published" pool — and the next re-plan
//    drops the item as `already covered` by the post generated FROM it. Same
//    slug, same keyword. `scripts/triage-orphan-briefs.mjs` had guarded against
//    this since it was written (`!content.html && !shopify_article_id` → skip);
//    the strategist never did. Two such scaffolds were live on the server on
//    2026-08-23.
//
// 2. THE CALENDAR SELF-MATCH EXEMPTION WAS DEFEATED BY A TIE. The old rule let
//    `findSemanticDuplicate` pick one winner and then compared THAT winner to
//    the proposal. `findSemanticDuplicate` breaks ties with `>`, so the first
//    entry to score 1.0 wins. The live calendar carries "sls-free toothpaste",
//    "toothpaste sls free" and "toothpaste no sls", whose core token sets are
//    identical — Jaccard 1.0 to each other. Re-propose any one of them and it
//    matched its twin instead of itself, so an item already on the calendar was
//    reported as a duplicate and cleared. The exemption now asks the only
//    question that matters — "is this exact keyword already scheduled?" — and
//    answers before any similarity is computed.
//
// Every change here makes the check LESS aggressive, never more. A coverage
// check that over-fires silently kills planned content, which is the failure
// being fixed; widening it to catch more would be the same bug with the sign
// flipped.

import { findSemanticDuplicate } from './cannibalization-guard.js';

/** Same normalization the strategist uses to turn a keyword into a slug. */
export function slugifyKeyword(str) {
  return String(str ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

const norm = (s) => String(s ?? '').trim().toLowerCase();

// ─────────────────────────────────────────────────────────────────────────────
// The pool
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Which posts count as coverage.
 *
 * A directory under data/posts/ is not a post. It counts only once something
 * has actually been written — `content.html` on disk, or a `shopify_article_id`
 * for the legacy corpus that was synced in without local content. This is the
 * exact rule `scripts/triage-orphan-briefs.mjs:114` already applies; it is
 * repeated here rather than invented, so the two cannot drift.
 *
 * I/O is injected so this stays pure and testable.
 *
 * @param {{slugs: string[], getMeta: (slug:string)=>object|null, hasContent: (slug:string)=>boolean}} io
 * @returns {{posts: {slug:string, keyword:string}[], unwritten: {slug:string, keyword:string}[]}}
 *   posts     — real coverage.
 *   unwritten — meta.json only. Reported, never matched against: these are the
 *               drafts-in-progress and merge leftovers that used to cover
 *               against themselves.
 */
export function coveragePool({ slugs = [], getMeta = () => null, hasContent = () => false } = {}) {
  const posts = [];
  const unwritten = [];
  for (const slug of slugs) {
    let meta = null;
    try { meta = getMeta(slug); } catch { meta = null; }
    const keyword = meta?.target_keyword;
    if (!keyword) continue;                      // nothing to match on
    let written = false;
    try { written = Boolean(hasContent(slug)); } catch { written = false; }
    const row = { slug, keyword };
    if (written || meta?.shopify_article_id) posts.push(row);
    else unwritten.push(row);
  }
  return { posts, unwritten };
}

// ─────────────────────────────────────────────────────────────────────────────
// The check
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Is `keyword` already covered? Returns the collision, or null.
 *
 * Two candidate pools, deliberately different rules:
 *   - publishedPosts ({slug, keyword} of every post that really exists): an
 *     EXACT match is the strongest possible duplicate, and a near-duplicate is
 *     cannibalization of a live page.
 *   - calendarKeywords (items already scheduled): an exact match is the item
 *     matching ITSELF on a re-plan, which is expected and must not block.
 *
 * These used to share one call with a blanket `dup !== keyword` exemption, so
 * the self-match escape hatch applied to published posts too — near-duplicates
 * were rejected while exact duplicates sailed through. That is how "natural
 * antiperspirant" and "sls sensitivity toothpaste" were scheduled on 2026-08-17
 * with live posts carrying those exact target keywords. Splitting the pools
 * fixed that; see the header for the two ways the split itself then misfired.
 *
 * @returns {{keyword:string, slug:string|null, rule:'exact'|'near', pool:'published'|'calendar'}|null}
 */
export function findCoverage(keyword, { publishedPosts = [], calendarKeywords = [] } = {}) {
  if (!keyword) return null;
  const kw = norm(keyword);

  const exact = publishedPosts.find((p) => norm(p?.keyword) === kw);
  if (exact) return { keyword: exact.keyword, slug: exact.slug ?? null, rule: 'exact', pool: 'published' };

  const publishedKeywords = publishedPosts.map((p) => p?.keyword).filter(Boolean);
  const publishedDup = findSemanticDuplicate(keyword, publishedKeywords, { threshold: 0.6 });
  if (publishedDup) {
    const hit = publishedPosts.find((p) => p.keyword === publishedDup);
    return { keyword: publishedDup, slug: hit?.slug ?? null, rule: 'near', pool: 'published' };
  }

  // SELF-MATCH. Asked before any similarity is computed, because the old
  // post-hoc `best !== keyword` test lost to a tie: three calendar items with
  // identical core token sets all score 1.0, findSemanticDuplicate keeps the
  // first, and the item was cleared as a duplicate of its own twin.
  if (calendarKeywords.some((k) => norm(k) === kw)) return null;

  const calendarDup = findSemanticDuplicate(keyword, calendarKeywords, { threshold: 0.6 });
  if (calendarDup) return { keyword: calendarDup, slug: null, rule: 'near', pool: 'calendar' };

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// The record
// ─────────────────────────────────────────────────────────────────────────────

/** Reasons in the order a reader should worry about them. */
export const CLEAR_REASONS = ['not_reproposed', 'already_covered', 'cluster_dud', 'off_scope', 'branded', 'rejected', 'completed'];

const REASON_LABEL = {
  not_reproposed: 'no reason recorded — the planner did not re-propose it and no filter fired',
  already_covered: 'already covered',
  cluster_dud: 'cluster does not earn',
  off_scope: 'off product scope',
  branded: 'branded keyword',
  rejected: 'on the rejected-keywords list',
  completed: 'already published',
};

/**
 * Reconcile the calendar before a re-plan against the calendar after it.
 *
 * Every item that disappeared gets a reason. An item the strategist explicitly
 * filtered carries that filter's record; an item that simply was not
 * re-proposed is reported as `completed` when its post is live, and as
 * `not_reproposed` — a real, unexplained loss — when it is not.
 *
 * `review` items are never counted: they are carried across by
 * `mergeReviewItems`, not by the brief queue, so their absence here would be an
 * artifact of where the caller takes its "after" snapshot.
 *
 * A skip is joined to an item three ways, in order: the proposal's own slug,
 * the proposal's keyword, and — the self-match signature — the slug of the POST
 * the proposal collided with. The 2026-08-19 run dropped a proposal called
 * "deodorant without aluminum" against post `aluminum-free-deodorant`, and the
 * calendar item it thereby cleared was `aluminum-free-deodorant`; matching on
 * the proposal alone would have filed that as "no reason recorded".
 *
 * @param {{previousItems:object[], newItems:object[], skips:object[],
 *          postState:(slug:string)=>{exists:boolean, live:boolean}}} args
 * @returns {object[]} one row per cleared item
 */
export function classifyClearedItems({ previousItems = [], newItems = [], skips = [], postState = () => ({ exists: false, live: false }) } = {}) {
  const survived = new Set((newItems || []).map((i) => i?.slug).filter(Boolean));

  const bySkip = (item) => (skips || []).find((s) => {
    if (!s) return false;
    if (slugifyKeyword(s.keyword) === item.slug) return true;
    if (norm(s.keyword) === norm(item.keyword)) return true;
    return Boolean(s.matchedSlug) && s.matchedSlug === item.slug;
  }) || null;

  const out = [];
  for (const item of previousItems || []) {
    if (!item?.slug) continue;
    if (item.status === 'review') continue;
    if (survived.has(item.slug)) continue;

    const skip = bySkip(item);
    let state = { exists: false, live: false };
    try { state = postState(item.slug) || state; } catch { /* fail open */ }

    const reason = skip?.reason ?? (state.live ? 'completed' : 'not_reproposed');
    out.push({
      slug: item.slug,
      keyword: item.keyword ?? '',
      reason,
      // The proposal that collided is NOT always the item's own keyword.
      proposal: skip?.keyword ?? null,
      matched: skip?.matched ?? null,
      matchedSlug: skip?.matchedSlug ?? null,
      rule: skip?.rule ?? null,
      pool: skip?.pool ?? null,
      detail: skip?.detail ?? null,
      postExists: Boolean(state.exists),
      postLive: Boolean(state.live),
      // The item was "covered" by the post at its own slug — i.e. by the post
      // generated from this very item. Not cannibalization by another page.
      selfMatch: reason === 'already_covered' && Boolean(skip?.matchedSlug) && skip.matchedSlug === item.slug,
    });
  }

  const rank = (r) => {
    const i = CLEAR_REASONS.indexOf(r.reason);
    return i === -1 ? CLEAR_REASONS.length : i;
  };
  return out.sort((a, b) => rank(a) - rank(b) || a.slug.localeCompare(b.slug));
}

/**
 * Human-readable lines for the console and for the digest body.
 *
 * An already-covered row must name the post it matched, by path, so the
 * verdict can be re-examined without re-running anything. That was the whole
 * failure: `[SKIP] already covered: "x" ~ existing "x"` named a keyword, not a
 * page, so nobody could tell a live competitor page from the item's own draft.
 */
export function renderClearedLines(cleared = [], { max = 20 } = {}) {
  const lines = [];
  for (const c of cleared.slice(0, max)) {
    const bits = [`  ${c.slug}  "${c.keyword}"`];
    let why = REASON_LABEL[c.reason] || c.reason;
    if (c.reason === 'already_covered') {
      why += ` by data/posts/${c.matchedSlug || '?'} ("${c.matched}", ${c.rule}-match against the ${c.pool} pool)`;
      if (c.proposal && norm(c.proposal) !== norm(c.keyword)) why += `, via proposal "${c.proposal}"`;
      if (c.selfMatch) why += ' — SELF-MATCH: that post is this item';
    } else if (c.reason === 'cluster_dud' && c.detail) {
      why = c.detail;
    } else if (c.reason === 'completed') {
      why += ` as data/posts/${c.slug} — the calendar had gone on carrying finished work`;
    }
    bits.push(`      ${why}`);
    lines.push(bits.join('\n'));
  }
  if (cleared.length > max) lines.push(`  (+${cleared.length - max} more)`);
  return lines;
}

/**
 * One DEFERRED notification per re-plan that cleared anything.
 *
 * Never `immediate: true` — CLAUDE.md's digest convention. A cleared calendar
 * is a thing to read at 5 AM, not a page. `status` is `warning` only when
 * something was lost without a reason; a run that merely tidied finished work
 * off the calendar is `info`, because that is the policy working.
 *
 * @returns {{subject:string, body:string, status:string, category:string}|null}
 */
export function clearedDigest(cleared = [], { kept = 0 } = {}) {
  if (!cleared.length) return null;

  const counts = {};
  for (const c of cleared) counts[c.reason] = (counts[c.reason] || 0) + 1;
  const unexplained = cleared.filter((c) => c.reason === 'not_reproposed');

  const body = [
    `The content calendar re-plan replaced ${cleared.length + kept} scheduled item(s): ${kept} kept, ${cleared.length} cleared.`,
    '',
    'Cleared by reason:',
    ...CLEAR_REASONS.filter((r) => counts[r]).map((r) => `  ${counts[r]} — ${REASON_LABEL[r]}`),
    '',
    'Every cleared item:',
    ...renderClearedLines(cleared, { max: 50 }),
    '',
    unexplained.length
      ? `${unexplained.length} item(s) were dropped with NO recorded reason and have no live post — the planner did not re-propose them and no filter fired. These are the ones to look at: ${unexplained.map((c) => c.slug).join(', ')}.`
      : 'Nothing was dropped without a recorded reason.',
    '',
    'The calendar is REPLACED by each re-plan, so an item that is not re-proposed disappears. Restore one by re-adding it to data/calendar/calendar.json.',
  ].join('\n');

  return {
    subject: `Content calendar: ${cleared.length} item(s) cleared on re-plan${unexplained.length ? ` (${unexplained.length} unexplained)` : ''}`,
    body,
    status: unexplained.length ? 'warning' : 'info',
    category: 'pipeline',
  };
}
