#!/usr/bin/env node
/**
 * One-time sweep: take the duplicate IDEAS off the content calendar.
 *
 * WHAT THIS IS FOR. The three coverage tiers in `lib/ranked-coverage.js` (PRs
 * #919, #920, #921) stop a NEW duplicate topic entering the pipeline. Nothing
 * re-screened what was already queued — CLAUDE.md records that gap in those
 * words. Measured read-only on production 2026-09-19, the backlog held 25 pure
 * ideas and 17 of them were EXACT ranked queries for pages already on page 1
 * (positions 4.0–8.6), sixteen collapsing onto four pages, one of them the
 * literal keyword "yes". None of the 25 had a brief on disk or written content,
 * so nothing paid for is destroyed by removing any of them.
 *
 * WHAT IT WILL AND WILL NOT DO — the whole point of the script is the second
 * list. See the header of `lib/calendar-backlog-sweep.js` for the reasoning.
 *
 *   DROPS   only the exact ranked-query tier, re-derived from today's index.
 *   KEEPS   every `possible_duplicate` (phrase and semantic tiers) — that is a
 *           judgement a human makes, and three PRs just established it.
 *   KEEPS   anything out of product scope — a different question with its own
 *           mechanism (`data/rejected-keywords.json`).
 *   NEVER   touches an item with a `publish_date`, or one whose DERIVED status
 *           is anything but `pending`. Status is re-derived through
 *           `agents/pipeline-prioritizer`'s own `statusOf`, never read off the
 *           item's `status` field — the raw values on the live calendar are
 *           `(none)` and `review` and neither means what it looks like.
 *   NEVER   deletes. A dropped item MOVES to `data/calendar/_dropped/` with a
 *           record, and comes back with `--restore`.
 *   REFUSES to run at all when the ranked index is unavailable or disarmed: a
 *           sweep that silently drops nothing looks identical to a clean one.
 *
 * Usage:
 *   node scripts/sweep-duplicate-backlog.mjs                    # dry run, report only
 *   node scripts/sweep-duplicate-backlog.mjs --apply            # archive the drops
 *   node scripts/sweep-duplicate-backlog.mjs --apply --limit 5  # at most 5, oldest first
 *   node scripts/sweep-duplicate-backlog.mjs --list-dropped     # what is archived
 *   node scripts/sweep-duplicate-backlog.mjs --restore <slug>…  # bring items back
 *   node scripts/sweep-duplicate-backlog.mjs --restore --all [--force]
 *
 * Exit codes:
 *   0   ran (dry or applied)
 *   64  usage error — an unrecognised flag or a bad --limit
 *   65  REFUSED: the ranked-query index is unavailable or disarmed
 *   70  the calendar could not be read, or a write was refused mid-run
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { statusOf } from '../agents/pipeline-prioritizer/index.js';
import { loadRankedIndex, loadAuthoredCoverage } from '../agents/gsc-opportunity/index.js';
import {
  buildAuthoredIndex,
  classifyRankedCoverage,
  slugifyKeyword,
  RANKED_WINDOW_DAYS,
  RANKED_POS_MAX,
  RANKED_MIN_IMPRESSIONS,
  SEMANTIC_THRESHOLD,
} from '../lib/ranked-coverage.js';
import {
  planSweep, oldestFirst, renderPlanLines, expectationNote, renderSweepDigest, EXPECTED,
} from '../lib/calendar-backlog-sweep.js';
import {
  DROPPED_DIRNAME, RESTORE_COMMAND, readCalendar, backupCalendar, writeCalendarItems,
  archiveItems, listDropped, restoreDropped, droppedSizeBytes, newRunId,
} from '../lib/calendar-item-archive.js';
import { notify } from '../lib/notify.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'calendar-backlog-sweep');
const RUN_ID = newRunId();

// ── arguments ───────────────────────────────────────────────────────────────

const KNOWN = new Set(['--apply', '--limit', '--restore', '--all', '--force', '--list-dropped', '--help']);
const ARGV = process.argv.slice(2);

function usage(msg) {
  if (msg) console.error(`\n${msg}`);
  console.error(`
Usage:
  node scripts/sweep-duplicate-backlog.mjs [--apply] [--limit N]
  node scripts/sweep-duplicate-backlog.mjs --list-dropped
  node scripts/sweep-duplicate-backlog.mjs --restore <slug>... [--force]
  node scripts/sweep-duplicate-backlog.mjs --restore --all [--force]
`);
  process.exit(64);
}

let APPLY = false; let RESTORE = false; let ALL = false; let FORCE = false; let LIST = false;
let LIMIT = Infinity;
const POSITIONALS = [];

for (let i = 0; i < ARGV.length; i++) {
  const a = ARGV[i];
  if (a === '--apply') { APPLY = true; continue; }
  if (a === '--restore') { RESTORE = true; continue; }
  if (a === '--all') { ALL = true; continue; }
  if (a === '--force') { FORCE = true; continue; }
  if (a === '--list-dropped') { LIST = true; continue; }
  if (a === '--help') usage(null);
  if (a === '--limit' || a.startsWith('--limit=')) {
    const raw = a.startsWith('--limit=') ? a.slice('--limit='.length) : ARGV[++i];
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) usage(`--limit needs a non-negative whole number, got "${raw}".`);
    LIMIT = n;
    continue;
  }
  if (a.startsWith('-')) usage(`Unrecognised flag "${a}". Known flags: ${[...KNOWN].join(', ')}.`);
  POSITIONALS.push(a);
}
if (POSITIONALS.length && !RESTORE) usage(`Unexpected argument "${POSITIONALS[0]}" — slugs are only meaningful with --restore.`);
if (RESTORE && !ALL && !POSITIONALS.length) usage('--restore needs one or more slugs, or --all.');

const rel = (p) => relative(ROOT, p) || p;

// ── recovery paths — these run instead of a sweep and decide no verdicts ─────

if (LIST) {
  const dropped = listDropped({ root: ROOT });
  console.log(`\ndata/calendar/${DROPPED_DIRNAME}/ — ${dropped.length} archived item(s), `
    + `${(droppedSizeBytes({ root: ROOT }) / 1024).toFixed(1)} KB\n`);
  for (const d of dropped) {
    const r = d.record || {};
    console.log(`  ${d.file}`);
    console.log(`      "${r.keyword || d.slug}"`);
    console.log(`      ${r.reason || 'no reason recorded'}`);
    console.log(`      dropped ${r.dropped_at || 'at an unrecorded time'} by ${r.dropped_by || 'an unrecorded run'}`);
    if (r.matched_page) console.log(`      collided with ${r.matched_page} on "${r.matched_query}"`);
  }
  if (dropped.length) console.log(`\nRestore any of them with:  ${RESTORE_COMMAND} <slug>\n`);
  process.exit(0);
}

if (RESTORE) {
  let result;
  try {
    result = restoreDropped({ root: ROOT, slugs: POSITIONALS, all: ALL, force: FORCE, runId: RUN_ID });
  } catch (e) {
    console.error(`\nRestore refused: ${e.message}`);
    process.exit(70);
  }
  for (const r of result.restored) console.log(`  ✓ restored ${r.slug} — "${r.item?.keyword ?? ''}"`);
  for (const s of result.skipped) console.log(`  – skipped ${s.slug}: ${s.reason}`);
  if (result.backup) console.log(`\nCalendar backed up to ${rel(result.backup)} before the write.`);
  console.log(`\n${result.restored.length} item(s) put back on the calendar, ${result.skipped.length} skipped.`);
  process.exit(0);
}

// ── the sweep ───────────────────────────────────────────────────────────────

console.log('\nBacklog duplicate sweep' + (APPLY ? '' : ' (dry run)') + '\n');

let calendar;
try {
  calendar = readCalendar(ROOT);
} catch (e) {
  console.error(`Cannot read the calendar: ${e.message}`);
  process.exit(70);
}

// Coverage index. REFUSES rather than degrading: everything this script drops
// comes from the ranked index, so a disarmed one produces an empty sweep that
// reads exactly like a clean corpus. Same reasoning as `hold.disarmed` — except
// that here the honest answer is to stop, because the alternative is a report
// somebody believes.
const rankedIndex = loadRankedIndex();
if (rankedIndex.disarmed || rankedIndex.available !== true) {
  console.error('REFUSING TO RUN — the ranked-query index is not available:');
  console.error(`  ${rankedIndex.disarmed || 'buildRankedIndex reported available: false with no reason'}`);
  console.error('');
  console.error('Every drop this script makes is evidence from that index, so a disarmed run would');
  console.error('screen nothing and report a clean backlog. `data/snapshots/gsc/` is gitignored and');
  console.error('written by cron on the production server, so a local checkout legitimately has');
  console.error('nothing here — run this on the server.');
  process.exit(65);
}
console.log(`  ranked-query coverage: ${rankedIndex.byQuery.size} queries from ${rankedIndex.files} snapshot(s), `
  + `position <= ${RANKED_POS_MAX}, >= ${RANKED_MIN_IMPRESSIONS} impressions/${RANKED_WINDOW_DAYS}d`);

// The semantic tier only ever produces FLAGS, which are reported and kept, so a
// disarmed authored index costs visibility rather than correctness. It is said
// out loud for the same reason the ranked one is.
const authoredIndex = buildAuthoredIndex(loadAuthoredCoverage());
if (authoredIndex.disarmed) {
  console.log(`  ⚠ ${authoredIndex.disarmed} — flagged duplicates will be UNDER-reported this run (nothing extra is dropped)`);
} else {
  console.log(`  semantic coverage: ${authoredIndex.entries.length} authored target keyword(s), similarity >= ${SEMANTIC_THRESHOLD}`);
}

const classify = (item) => classifyRankedCoverage(item.keyword, rankedIndex, {
  selfSlug: item.slug || slugifyKeyword(item.keyword),
  authored: authoredIndex,
});

const plan = planSweep({ items: calendar.items, statusOf, classify });

console.log(`\n  ${plan.considered} calendar item(s); ${plan.backlog} are pure backlog ideas `
  + `(derived status "pending", no publish_date). ${plan.ineligible.length} ineligible and never screened.\n`);

for (const line of renderPlanLines(plan)) console.log(line);

const note = expectationNote(plan);
console.log(note.line);
console.log('');

if (!APPLY) {
  console.log(`Dry run. Re-run with --apply to move the ${plan.drop.length} drop(s) to data/calendar/${DROPPED_DIRNAME}/.`);
  console.log('Nothing is deleted — an archived item comes back with --restore <slug>.');
  console.log(`The ${plan.flag.length} flagged item(s) and the ${plan.keep.length} kept item(s) are NOT touched by --apply.`);
  process.exit(0);
}

// ── apply ───────────────────────────────────────────────────────────────────

const ordered = oldestFirst(plan.drop);
const drops = Number.isFinite(LIMIT) ? ordered.slice(0, LIMIT) : ordered;
const limited = ordered.length - drops.length;
if (limited) console.log(`--limit ${LIMIT}: taking the ${drops.length} oldest, holding back ${limited}.\n`);

if (!drops.length) {
  console.log('Nothing to drop. Calendar untouched.');
  process.exit(0);
}

let backupPath = null;
try {
  backupPath = backupCalendar({ root: ROOT, label: 'sweep' });
  console.log(`Calendar backed up to ${rel(backupPath)}`);
} catch (e) {
  console.error(`Refusing to write without a backup: ${e.message}`);
  process.exit(70);
}

// ARCHIVE FIRST, then write the calendar. A calendar write that lands before the
// record exists can lose an item with nothing anywhere saying so; a record whose
// calendar write then fails is a harmless extra copy, and --restore refuses to
// clobber an item still on the calendar.
const { archived, failed, sizeBytes } = archiveItems({
  root: ROOT,
  drops: drops.map((r) => ({
    slug: r.slug, keyword: r.keyword, reason: r.reason, item: r.item, match: r.match,
    source: r.item?.source ?? null,
    // Where it sat in items[], so --restore puts it back rather than appending it.
    index: calendar.items.indexOf(r.item),
  })),
  runId: RUN_ID,
});
for (const f of failed) console.error(`  ✗ ${f.slug}: ${f.error} (left on the calendar)`);

const archivedSlugs = new Set(archived.map((a) => a.slug));
const kept = calendar.items.filter((i) => !archivedSlugs.has(i.slug));

try {
  writeCalendarItems({ root: ROOT, calendar, items: kept, runId: RUN_ID });
} catch (e) {
  console.error(`\n${e.message}`);
  console.error(`The calendar was NOT modified. ${archived.length} item(s) are recorded in data/calendar/${DROPPED_DIRNAME}/`);
  console.error(`and are still on the calendar — re-running --apply is safe, and ${rel(backupPath)} holds the original.`);
  process.exit(70);
}

console.log(`\nRemoved ${archived.length} idea(s) from the calendar (${kept.length} item(s) remain).`);
for (const a of archived) console.log(`  ✓ ${a.slug} → data/calendar/${DROPPED_DIRNAME}/${a.archivedFile}`);
console.log(`\nNothing was deleted. Restore any of them with:  ${RESTORE_COMMAND} <slug>`);
console.log('Note the markdown view (data/reports/content-strategist/content-calendar.md) is a rendered');
console.log('copy and still lists these rows until the next calendar write regenerates it.');

// Run record. This is a hand-run one-time script, not a cron job, so a per-run
// record costs nothing and the archive sidecars are the durable half anyway.
try {
  mkdirSync(REPORTS_DIR, { recursive: true });
  writeFileSync(join(REPORTS_DIR, `run-${RUN_ID}.json`), `${JSON.stringify({
    run_id: RUN_ID,
    ran_at: new Date().toISOString(),
    expectation: { ...EXPECTED, matched: note.matches, note: note.line },
    ranked_index: { queries: rankedIndex.byQuery.size, files: rankedIndex.files, unreadable: rankedIndex.unreadable ?? 0 },
    authored_index: { entries: authoredIndex.entries.length, disarmed: authoredIndex.disarmed },
    limit: Number.isFinite(LIMIT) ? LIMIT : null,
    held_back: limited,
    backup: rel(backupPath),
    dropped: archived.map((a) => ({ slug: a.slug, keyword: a.keyword, reason: a.reason, archived_file: a.archivedFile })),
    failed,
    flagged: plan.flag.map((r) => ({ slug: r.slug, keyword: r.keyword, tier: r.tier, reason: r.reason })),
    kept: plan.keep.map((r) => ({ slug: r.slug, keyword: r.keyword, reason: r.reason })),
    ineligible: plan.ineligible.map((r) => ({ slug: r.slug, status: r.status, reason: r.reason })),
    archive_bytes: sizeBytes,
  }, null, 2)}\n`);
} catch (e) {
  console.error(`  (could not write the run record: ${e.message})`);
}

// Deferred per CLAUDE.md — this is recoverable work being tidied off a queue, so
// it is never `immediate: true`, and it is `status: 'error'` only when an item
// could not be archived, which is the one thing a human is being asked to fix.
const digest = renderSweepDigest({
  plan, archived, failed, limited, applied: true, runId: RUN_ID,
  backupPath: rel(backupPath), restoreCommand: RESTORE_COMMAND,
});
await notify({ ...digest, category: 'pipeline' });

process.exit(failed.length ? 1 : 0);
