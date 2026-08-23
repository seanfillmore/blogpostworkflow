#!/usr/bin/env node
/**
 * Collapse the eight duplicate tattoo-soap calendar items into ONE refresh action.
 *
 * WHY
 * ───
 * data/calendar/calendar.json carried nine soap items. EIGHT of them are the same
 * search intent — "which soap do I wash a new tattoo with":
 *
 *   best-tattoo-soap                         what-soap-to-use-for-tattoo
 *   best-soaps-for-tattoos                   what-soap-to-use-for-tattoos
 *   best-soap-for-new-tattoo                 what-soap-can-i-use-to-wash-my-tattoo
 *   best-soap-for-fresh-tattoo               best-antibacterial-soap-for-tattoos
 *
 * Eight, not the seven the brief for this work named. Seven were added undated by
 * agents/gsc-opportunity on 2026-08-18/19 as "unmapped" new-topic candidates; the
 * eighth, best-antibacterial-soap-for-tattoos, came from content-strategist on
 * 2026-08-14 and is the only one carrying a publish_date. It is folded in on the
 * same evidence as the rest, not on the grounds that it is dated: "best
 * antibacterial soap for tattoos" draws 617 impressions at average position 11.8,
 * and 372 of those impressions are ALREADY served by the winner page below. There
 * is no antibacterial-specific page to build — the site sells one bar soap, and
 * unscented-antibacterial-soap and antibacterial-body-soap are already published.
 *
 * They are not unmapped. GSC (90 days to 2026-08-20, data/snapshots/gsc/) shows
 * ONE page is already the top-ranked internal result for every one of them:
 *
 *   /blogs/news/best-soap-for-tattoos-what-to-use-for-safe-healing-2
 *     16,553 impressions / 102 clicks across all tattoo queries
 *
 * gsc-opportunity called them unmapped only because loadCoveredKeywords() reads a
 * single `target_keyword` per post, and that page's is "best soap to use on new
 * tattoo" — which is not a substring of, and does not contain, any of the eight.
 * The gap is in the mapping, not in the content.
 *
 * Drafting eight posts here would also recreate the cannibalization that was
 * resolved the day before: on 2026-08-22 (commit 55780323) the near-duplicate
 * best-soap-for-tattoos-what-to-use-for-safe-healing was unpublished and 301'd
 * into the winner above, precisely to stop this intent being split across two
 * URLs. CLAUDE.md's Prime Directive: "Optimize the pages that exist before
 * creating another."
 *
 * The winner's real problem is CTR, not coverage: 102 clicks on 16,553
 * impressions is 0.62%, at average positions 8–18. CLAUDE.md names that as a
 * first-class revenue leak. So the eight become one refresh of the page that
 * already ranks, carrying the eight as secondary terms.
 *
 * WHAT IT DOES
 * ────────────
 *   1. Removes the eight duplicate items from data/calendar/calendar.json.
 *   2. Adds ONE item, slug `best-soap-for-tattoos-refresh`, describing the
 *      refresh. It is deliberately status:"review" + publish_date:null, so
 *      agents/calendar-runner can never draft it as a new post (its filter at
 *      index.js:97 is `i.publishDate && i.status !== 'review'` — this item fails
 *      BOTH halves, so approving it in the dashboard Ideas inbox still cannot
 *      make it draft). The refresh is executed by hand:
 *
 *        node agents/content-refresher/index.js \
 *          --slug best-soap-for-tattoos-what-to-use-for-safe-healing-2 --apply
 *
 *   3. Adds the eight keywords to data/rejected-keywords.json so the daily
 *      gsc-opportunity run cannot re-add them tomorrow (it skips a slug only if
 *      it is already on the calendar, so deleting alone is not idempotent).
 *
 * `coconut oil soap benefits` is a DIFFERENT intent and is left exactly as it is.
 *
 * SAFETY
 * ──────
 * scripts/triage-orphan-briefs.mjs --apply DELETES orphan briefs off disk
 * (unlinkSync) whose keyword is on the rejected list, so writing to that file is
 * a destructive act at one remove. lib/brief-triage.js matches rejections by
 * EXACT string equality, and no brief in data/briefs/ has any of these eight as
 * its target_keyword — but this script re-checks that at run time and refuses to
 * apply if it is ever untrue, rather than trusting a fact verified once.
 *
 * USAGE
 *   node scripts/consolidate-tattoo-soap-calendar-2026-08-23.mjs           # dry run
 *   node scripts/consolidate-tattoo-soap-calendar-2026-08-23.mjs --apply   # write
 *
 * Idempotent: a second --apply run detects the finished state and writes nothing,
 * not even a backup.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectRun } from '../lib/is-direct-run.js';

// SEO_CLAUDE_ROOT is the same test-isolation hook lib/calendar-store.js uses.
// Production never sets it. Both must agree or the script would back up one
// calendar and write another.
const ROOT = process.env.SEO_CLAUDE_ROOT
  || join(dirname(fileURLToPath(import.meta.url)), '..');

// ── the plan, as data ────────────────────────────────────────────────────────

/** The page that already ranks for all eight. */
export const WINNER = {
  slug: 'best-soap-for-tattoos-what-to-use-for-safe-healing-2',
  url: 'https://www.realskincare.com/blogs/news/best-soap-for-tattoos-what-to-use-for-safe-healing-2',
  target_keyword: 'best soap to use on new tattoo',
  gsc_90d: { impressions: 16553, clicks: 102, ctr: 0.0062 },
};

export const REFRESH_SLUG = 'best-soap-for-tattoos-refresh';

export const REFRESH_COMMAND =
  `node agents/content-refresher/index.js --slug ${WINNER.slug} --apply`;

/**
 * The eight duplicates, listed explicitly by slug rather than matched by regex:
 * a regex over "tattoo" would also have swallowed coconut-oil-tattoo topics and
 * anything gsc-opportunity adds next week.
 *
 * gsc_90d numbers are from data/snapshots/gsc/ for the 90 days ending
 * 2026-08-20; `winner_share` is that keyword's impressions attributed to WINNER
 * in queriesByPage, which is the top internal page for every row here.
 */
export const DUPLICATE_ITEMS = [
  { slug: 'what-soap-to-use-for-tattoo',            keyword: 'what soap to use for tattoo',            gsc_90d: { impressions: 120, clicks: 5, position: 8.2 },  winner_share: 834 },
  { slug: 'what-soap-can-i-use-to-wash-my-tattoo',  keyword: 'what soap can i use to wash my tattoo',  gsc_90d: { impressions: 65,  clicks: 5, position: 9.1 },  winner_share: 211 },
  { slug: 'best-soaps-for-tattoos',                 keyword: 'best soaps for tattoos',                 gsc_90d: { impressions: 246, clicks: 4, position: 10.5 }, winner_share: 173 },
  { slug: 'best-soap-for-fresh-tattoo',             keyword: 'best soap for fresh tattoo',             gsc_90d: { impressions: 330, clicks: 2, position: 10.3 }, winner_share: 160 },
  { slug: 'what-soap-to-use-for-tattoos',           keyword: 'what soap to use for tattoos',           gsc_90d: { impressions: 49,  clicks: 3, position: 10.5 }, winner_share: 255 },
  { slug: 'best-antibacterial-soap-for-tattoos',    keyword: 'best antibacterial soap for tattoos',    gsc_90d: { impressions: 617, clicks: 4, position: 11.8 }, winner_share: 372 },
  { slug: 'best-tattoo-soap',                       keyword: 'best tattoo soap',                       gsc_90d: { impressions: 265, clicks: 2, position: 13.3 }, winner_share: 155 },
  { slug: 'best-soap-for-new-tattoo',               keyword: 'best soap for new tattoo',               gsc_90d: { impressions: 774, clicks: 8, position: 17.6 }, winner_share: 520 },
];

/** Left alone on purpose — a different intent, and a different page ranks for it. */
export const KEEP_DISTINCT_SLUG = 'coconut-oil-soap-benefits';

const REJECTION_REASON =
  `Same intent as ${WINNER.url}, which is already the top-ranked internal page `
  + `for this query (GSC 90d to 2026-08-20). Consolidated into the `
  + `${REFRESH_SLUG} refresh on 2026-08-23 rather than drafted as a new post, `
  + `one day after commit 55780323 unpublished + 301'd a near-duplicate on this `
  + `exact intent. Re-open only if this query stops being served by that page.`;

// ── pure planner ─────────────────────────────────────────────────────────────

/**
 * Decide what to change. No I/O — every input is supplied.
 *
 * @param {object}   args
 * @param {object}   args.calendar     parsed data/calendar/calendar.json
 * @param {Array}    args.rejections   parsed data/rejected-keywords.json
 * @param {string[]} args.briefKeywords every brief's target_keyword, lowercased
 * @param {object|null} args.winnerMeta the winner post's meta.json, or null if absent
 * @param {string}   args.now          ISO timestamp
 */
export function planConsolidation({ calendar, rejections = [], briefKeywords = [], winnerMeta = null, now = new Date().toISOString() }) {
  const items = calendar?.items || [];
  const bySlug = new Map(items.map((i) => [i.slug, i]));
  const dupSlugs = new Set(DUPLICATE_ITEMS.map((d) => d.slug));
  const blockers = [];
  const warnings = [];

  // A slug can never be both removed and kept.
  if (dupSlugs.has(KEEP_DISTINCT_SLUG)) {
    blockers.push(`internal error: ${KEEP_DISTINCT_SLUG} is in both the remove and keep lists`);
  }
  if (dupSlugs.has(REFRESH_SLUG)) {
    blockers.push(`internal error: ${REFRESH_SLUG} is in the remove list`);
  }

  // GUARD: writing a keyword to rejected-keywords.json makes any orphan brief
  // with that exact target_keyword deletable by triage-orphan-briefs --apply.
  const briefSet = new Set(briefKeywords.map((k) => String(k || '').toLowerCase().trim()));
  for (const d of DUPLICATE_ITEMS) {
    if (briefSet.has(d.keyword.toLowerCase())) {
      blockers.push(
        `rejecting "${d.keyword}" would make data/briefs/ entry with that exact `
        + `target_keyword deletable by scripts/triage-orphan-briefs.mjs --apply`,
      );
    }
  }

  // GUARD: the rejections are broad (substring) matches, which is what
  // gsc-opportunity, content-strategist and calendar-runner all apply. A term
  // that also matched some UNRELATED surviving item would silently stop that
  // item drafting (calendar-runner:690 filters on the same predicate). The
  // calendar already carries can-you-use-coconut-oil-on-a-new-tattoo, a
  // different intent scheduled for 2026-10-01, so this is a live risk.
  const survivorKeywords = items
    .filter((i) => !dupSlugs.has(i.slug))
    .map((i) => String(i?.keyword || '').toLowerCase().trim())
    .filter(Boolean);
  for (const d of DUPLICATE_ITEMS) {
    const term = d.keyword.toLowerCase();
    const collateral = survivorKeywords.filter((k) => k.includes(term));
    if (collateral.length) {
      blockers.push(`broad rejection "${d.keyword}" would also block surviving calendar item(s): ${collateral.join(', ')}`);
    }
  }

  // GUARD: never point a refresh at a page that is not live.
  if (winnerMeta && winnerMeta.shopify_status && winnerMeta.shopify_status !== 'published') {
    blockers.push(`winner post ${WINNER.slug} is shopify_status="${winnerMeta.shopify_status}", not "published"`);
  }
  if (!winnerMeta) {
    warnings.push(`no meta.json found for ${WINNER.slug} — cannot confirm it is published from disk (expected in a local checkout; the server has it)`);
  }

  const removed = DUPLICATE_ITEMS
    .filter((d) => bySlug.has(d.slug))
    .map((d) => ({ ...d, item: bySlug.get(d.slug) }));

  const refreshExists = bySlug.has(REFRESH_SLUG);
  const rejectedSet = new Set(rejections.map((r) => String(r?.keyword || '').toLowerCase().trim()));
  const newRejections = DUPLICATE_ITEMS
    .filter((d) => !rejectedSet.has(d.keyword.toLowerCase()))
    .map((d) => ({
      keyword: d.keyword,
      slug: d.slug,
      matchType: 'broad',
      reason: REJECTION_REASON,
      rejected_at: now,
      source: 'consolidate-tattoo-soap-calendar-2026-08-23',
    }));

  const distinctKept = bySlug.get(KEEP_DISTINCT_SLUG) || null;

  const nextItems = items
    .filter((i) => !dupSlugs.has(i.slug))
    .filter((i) => i.slug !== REFRESH_SLUG)
    .concat([buildRefreshItem(now, bySlug.get(REFRESH_SLUG))]);

  // GUARD: phased publishing — never two drafts landing the same day. This
  // change only removes items and adds a non-draftable one, so it cannot
  // introduce a collision; the check enforces that rather than assuming it.
  const before = draftableCollisions(items);
  const after = draftableCollisions(nextItems);
  const introduced = after.filter((d) => !before.includes(d));
  if (introduced.length) {
    blockers.push(`would put two draftable items on the same publish day: ${introduced.join(', ')}`);
  }
  if (before.length) {
    warnings.push(`pre-existing same-day draftable collisions (not caused by this change): ${before.join(', ')}`);
  }

  const alreadyDone = removed.length === 0 && refreshExists && newRejections.length === 0;

  return { alreadyDone, blockers, warnings, removed, newRejections, nextItems, refreshExists, distinctKept };
}

/** The single item the eight collapse into. Not draftable, by construction. */
export function buildRefreshItem(now, prev = null) {
  return {
    slug: REFRESH_SLUG,
    keyword: WINNER.target_keyword,
    title:
      `REFRESH ${WINNER.url} — fold in 8 tattoo-soap secondary terms and fix `
      + `${(WINNER.gsc_90d.ctr * 100).toFixed(2)}% CTR (${WINNER.gsc_90d.impressions} impr / `
      + `${WINNER.gsc_90d.clicks} clicks, 90d). Run: ${REFRESH_COMMAND}`,
    category: 'Bar Soap',
    content_type: 'refresh',
    priority: 'High',
    week: null,
    // Deliberately null. calendar-runner:97 requires a publish_date AND a
    // non-review status to draft; this item has neither, so no code path turns
    // it into a new post. A refresh is executed by REFRESH_COMMAND, not by the
    // calendar, which only schedules new drafts.
    publish_date: null,
    original_publish_date: null,
    kd: null,
    volume: null,
    source: 'refresh',
    topical_hub: 'soap',
    priority_score: 33,
    status_override: null,
    status: 'review',
    impressions: WINNER.gsc_90d.impressions,
    added_at: prev?.added_at || now,
    last_updated: now,
  };
}

/** Publish days (America/Los_Angeles) carrying 2+ items calendar-runner would draft. */
export function draftableCollisions(items) {
  const byDay = new Map();
  for (const i of items) {
    if (!i?.publish_date || i.status === 'review') continue;
    const d = new Date(i.publish_date);
    if (Number.isNaN(d.getTime())) continue;
    const day = d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    byDay.set(day, (byDay.get(day) || 0) + 1);
  }
  return [...byDay.entries()].filter(([, n]) => n > 1).map(([day, n]) => `${day} (${n})`).sort();
}

// ── I/O ──────────────────────────────────────────────────────────────────────

function readJson(p, fallback) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; }
}

function collectBriefKeywords(briefsDir) {
  if (!existsSync(briefsDir)) return [];
  const out = [];
  for (const f of readdirSync(briefsDir).filter((x) => x.endsWith('.json'))) {
    const b = readJson(join(briefsDir, f), null);
    const kw = b?.target_keyword || b?.keyword;
    if (kw) out.push(String(kw));
  }
  return out;
}

export async function main(argv = process.argv.slice(2)) {
  const apply = argv.includes('--apply');
  const now = new Date().toISOString();
  const stamp = now.replace(/[:.]/g, '-');

  const calendarPath = join(ROOT, 'data', 'calendar', 'calendar.json');
  const rejectedPath = join(ROOT, 'data', 'rejected-keywords.json');
  const briefsDir = join(ROOT, 'data', 'briefs');
  const winnerMetaPath = join(ROOT, 'data', 'posts', WINNER.slug, 'meta.json');

  if (!existsSync(calendarPath)) {
    console.error(`No calendar at ${calendarPath}. Run this on the server, where cron owns the file.`);
    return 1;
  }

  const calendar = readJson(calendarPath, null);
  if (!calendar?.items) {
    console.error(`${calendarPath} did not parse into { items: [] }.`);
    return 1;
  }

  const plan = planConsolidation({
    calendar,
    rejections: readJson(rejectedPath, []) || [],
    briefKeywords: collectBriefKeywords(briefsDir),
    winnerMeta: readJson(winnerMetaPath, null),
    now,
  });

  console.log('\nTattoo-soap calendar consolidation\n');
  console.log(`  calendar: ${calendarPath} (${calendar.items.length} items)`);
  console.log(`  winner:   ${WINNER.url}`);
  console.log(`            ${WINNER.gsc_90d.impressions} impr / ${WINNER.gsc_90d.clicks} clicks / ${(WINNER.gsc_90d.ctr * 100).toFixed(2)}% CTR (90d, all tattoo queries)\n`);

  for (const w of plan.warnings) console.log(`  ! ${w}`);
  if (plan.warnings.length) console.log('');

  if (plan.blockers.length) {
    console.error('BLOCKED — nothing written:');
    for (const b of plan.blockers) console.error(`  ✗ ${b}`);
    return 1;
  }

  if (plan.alreadyDone) {
    console.log('  Already consolidated. Nothing to do.');
    console.log(`  Refresh still to run: ${REFRESH_COMMAND}\n`);
    return 0;
  }

  console.log(`  REMOVE — ${plan.removed.length} duplicate item(s), all the same intent:`);
  for (const r of plan.removed) {
    const g = r.gsc_90d;
    console.log(`    ${r.slug}`);
    console.log(`        "${r.keyword}" — ${g.impressions} impr, ${g.clicks} clicks, pos ${g.position}`);
    console.log(`        winner already holds ${r.winner_share} impr of this query`);
    if (r.item.publish_date) console.log(`        (had publish_date ${r.item.publish_date} — preserved in the run record + backup)`);
  }

  console.log(`\n  ADD — 1 item${plan.refreshExists ? ' (updating the existing one)' : ''}:`);
  console.log(`    ${REFRESH_SLUG}  status=review  publish_date=null  → not draftable by calendar-runner`);
  console.log(`    ${REFRESH_COMMAND}`);

  console.log(`\n  KEEP — different intent, untouched:`);
  console.log(`    ${KEEP_DISTINCT_SLUG}${plan.distinctKept ? '' : '  (NOT on the calendar — nothing to keep)'}`);

  console.log(`\n  REJECT — ${plan.newRejections.length} keyword(s) → data/rejected-keywords.json`);
  console.log(`    (so the daily gsc-opportunity run cannot re-add them tomorrow)`);
  for (const r of plan.newRejections) console.log(`    "${r.keyword}"`);

  if (!apply) {
    console.log(`\n  Dry run. Re-run with --apply to write.\n`);
    return 0;
  }

  // Back up both files before touching either.
  const calBackup = `${calendarPath}.bak-consolidate-tattoo-${stamp}`;
  copyFileSync(calendarPath, calBackup);
  console.log(`\n  backup: ${calBackup}`);
  if (existsSync(rejectedPath)) {
    const rejBackup = `${rejectedPath}.bak-consolidate-tattoo-${stamp}`;
    copyFileSync(rejectedPath, rejBackup);
    console.log(`  backup: ${rejBackup}`);
  }

  // Run record FIRST, so the removed items' full JSON survives even if a later
  // write fails. Includes every field of every removed item verbatim.
  const recordDir = join(ROOT, 'data', 'reports', 'calendar-consolidation');
  mkdirSync(recordDir, { recursive: true });
  const recordPath = join(recordDir, `tattoo-soap-${now.slice(0, 10)}.json`);
  writeFileSync(recordPath, JSON.stringify({
    generated_at: now,
    script: 'scripts/consolidate-tattoo-soap-calendar-2026-08-23.mjs',
    winner: WINNER,
    refresh_command: REFRESH_COMMAND,
    refresh_item_slug: REFRESH_SLUG,
    kept_distinct: KEEP_DISTINCT_SLUG,
    removed_items: plan.removed,
    added_rejections: plan.newRejections,
    calendar_backup: calBackup,
  }, null, 2));
  console.log(`  record: ${recordPath}`);

  // Calendar. writeCalendar() normalizes items to the documented schema and
  // regenerates the markdown view, so it is used instead of a raw JSON write.
  //
  // The ?root= query is a TEST hook and a no-op in production, where
  // SEO_CLAUDE_ROOT is never set. calendar-store.js resolves its paths from that
  // env var once, at module load, and the ESM cache is keyed on the specifier —
  // so without this a second test root would silently write into the first one's
  // calendar, i.e. the module would back up one file and modify another.
  const storeUrl = new URL('../lib/calendar-store.js', import.meta.url);
  if (process.env.SEO_CLAUDE_ROOT) storeUrl.searchParams.set('root', process.env.SEO_CLAUDE_ROOT);
  const { writeCalendar } = await import(storeUrl.href);
  const written = writeCalendar({ items: plan.nextItems, preserve_metadata: true });
  console.log(`  calendar: ${written.items.length} items (was ${calendar.items.length})`);

  if (plan.newRejections.length) {
    const rejected = readJson(rejectedPath, []) || [];
    writeFileSync(rejectedPath, JSON.stringify([...rejected, ...plan.newRejections], null, 2));
    console.log(`  rejected-keywords.json: +${plan.newRejections.length}`);
  }

  console.log(`\n  Done. Next: ${REFRESH_COMMAND}\n`);
  return 0;
}

if (isDirectRun(import.meta.url)) {
  main().then((code) => process.exit(code)).catch((err) => {
    console.error('consolidation failed:', err);
    process.exit(1);
  });
}
