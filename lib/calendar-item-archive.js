// lib/calendar-item-archive.js
//
// Taking a planned topic off the content calendar must be reversible, and the
// calendar write that does it must be impossible to leave half-finished.
//
// WHY THIS EXISTS. Two incidents, and this module answers both.
//
//   1. `data/calendar/calendar.json` is the single most dangerous local data
//      structure in this repo. A re-plan REPLACES it, and between 2026-08-19 and
//      2026-08-21 that cleared 12 of the 19 scheduled items with the only trace
//      anywhere eight `[SKIP]` lines in an unattended cron log. Five of the
//      twelve had no log line of any kind.
//
//   2. `scripts/triage-orphan-briefs.mjs --drop-non-earning --apply` called
//      `unlinkSync` on three paid-for briefs on a verdict that was wrong, and
//      they are permanently gone. `lib/brief-archive.js` is the answer to that
//      one, and this module is the same answer in the calendar's shape: a
//      dropped item MOVES to `data/calendar/_dropped/` with a record of what it
//      was, why it went, on what evidence and by which run. Nothing here ever
//      deletes anything.
//
// NOT GITIGNORED, on purpose — the same reasoning as `data/briefs/_dropped/`.
// `data/calendar/calendar.json` is tracked, so archiving an item is a change git
// can follow and undo. An untracked archive is precisely the condition that made
// the 2026-08-19 loss unrecoverable.
//
// WHY THE CALENDAR IS NOT WRITTEN THROUGH `lib/calendar-store.js`. A sweep
// whose job is to remove items must not MODIFY the ones it keeps, and
// `writeCalendar` normalises every item it is handed: it re-stamps
// `last_updated` on all of them, applies defaults and prev-fallbacks, and
// regenerates the markdown view. `writeCalendarItems` below preserves each
// surviving item byte for byte and touches nothing but the membership of
// `items[]`.
//
// It used to drop unknown fields as well — including `possible_duplicate`,
// `ranked_match` and `duplicate_of`, the very flags PR #921 wired into
// `agents/pipeline-prioritizer` and `agents/content-strategist`. That is fixed
// (`writeCalendar` is preserve-by-default now), so it is no longer the reason
// this module exists; byte-for-byte preservation still is.

import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync,
  renameSync, copyFileSync, unlinkSync, appendFileSync, statSync,
} from 'node:fs';
import { join, basename } from 'node:path';

// Shared, not copied: these three are generic over "an archive of slugs" and
// already carry their own tests. A second spelling of the collision rule is a
// second spelling that drifts.
import { allocateArchiveName, newRunId, DROP_RECORD_SUFFIX } from './brief-archive.js';

export { allocateArchiveName, newRunId, DROP_RECORD_SUFFIX };

/** Not `.json`, so no reader of a directory of calendars can see into it. */
export const DROPPED_DIRNAME = '_dropped';
/** A restored item's archived copy moves here. Moved, never deleted. */
export const RESTORED_DIRNAME = 'restored';
export const DROP_LOG_FILENAME = 'log.jsonl';
export const README_FILENAME = 'README.md';
export const BACKUPS_DIRNAME = 'backups';

/** The command a human runs. Written into every record and into the digest. */
export const RESTORE_COMMAND = 'node scripts/sweep-duplicate-backlog.mjs --restore';

export function calendarDir(root) { return join(root, 'data', 'calendar'); }
export function calendarPath(root) { return join(calendarDir(root), 'calendar.json'); }
export function droppedDir(root) { return join(calendarDir(root), DROPPED_DIRNAME); }
export function restoredDir(root) { return join(droppedDir(root), RESTORED_DIRNAME); }
export function backupsDir(root) { return join(calendarDir(root), BACKUPS_DIRNAME); }

/**
 * The sidecar: what the item was, when it went, why, on what evidence, and by
 * which run.
 *
 * `evidence` carries the ranked match VERBATIM — page, query, position,
 * impressions — because "it was a duplicate" is not reviewable six weeks later
 * whereas "the query `sls free toothpaste` already lands on
 * data/posts/toothpaste-without-sls at position 4.0 on 1,412 impressions/28d"
 * is. That is the difference between a record and a note.
 */
export function buildDropRecord({
  slug, keyword, reason, item, match = null, source = null, index = null,
  archivedFile, runId, droppedBy = 'scripts/sweep-duplicate-backlog.mjs',
  now = new Date(),
}) {
  return {
    schema: 'calendar-item-drop/1',
    slug,
    keyword: keyword || null,
    // Where it sat in `items[]`, so a restore puts it back rather than appending
    // it. A round trip that reorders the calendar is a round trip somebody has
    // to eyeball to convince themselves nothing else changed.
    calendar_index: Number.isInteger(index) ? index : null,
    dropped_at: now.toISOString(),
    dropped_by: droppedBy,
    run_id: runId,
    reason: reason || null,
    matched_page: match?.slug ? `data/posts/${match.slug}` : (match?.page || null),
    matched_query: match?.query ?? match?.keyword ?? null,
    matched_position: Number.isFinite(match?.position) ? match.position : null,
    matched_impressions: Number.isFinite(match?.impressions) ? match.impressions : null,
    matched_tier: match?.tier ?? null,
    evidence: match || null,
    source: source || null,
    archived_file: archivedFile,
    calendar_item: item,
    restore: `${RESTORE_COMMAND} ${slug}`,
    note: 'This calendar item was MOVED here, not deleted. Restoring it puts it back in data/calendar/calendar.json.',
  };
}

/** Deterministic, so re-writing it on every run never churns the diff. */
export const DROPPED_README = `# Dropped calendar items

Items in here were taken off \`data/calendar/calendar.json\` by
\`scripts/sweep-duplicate-backlog.mjs\`. **Nothing here has been deleted.** Each
one was moved, with a record of why.

Each was a *pure idea* at the moment it was dropped — no brief on disk, no
\`content.html\`, no Shopify article, no \`publish_date\` — and an existing page
already ranked for its exact keyword. No paid research was destroyed by removing
one, and any of them can be put straight back.

## Why this directory exists

Two incidents.

A calendar re-plan REPLACES the calendar. Between 2026-08-19 and 2026-08-21 that
cleared 12 of the 19 scheduled items and the only trace anywhere was eight
\`[SKIP]\` lines in an unattended cron log; five of the twelve had no log line at
all. And on 2026-08-19 \`scripts/triage-orphan-briefs.mjs --drop-non-earning\`
\`unlinkSync\`'d three paid-for briefs on a verdict that turned out to be wrong.
They are gone. Everything here exists so a wrong verdict costs a \`--restore\`
instead.

## Layout

    <slug>.json           the calendar item, exactly as it was
    <slug>.drop.json      why it went, when, on what evidence, and by which run
    log.jsonl             append-only history of every drop and every restore
    restored/             archived copies of items that have been put back

A slug dropped more than once becomes \`<slug>--2.json\`, \`<slug>--3.json\`, … so an
earlier drop is never overwritten.

## Restoring

    node scripts/sweep-duplicate-backlog.mjs --list-dropped     # what is in here
    node scripts/sweep-duplicate-backlog.mjs --restore <slug>   # newest drop of one item
    node scripts/sweep-duplicate-backlog.mjs --restore --all    # everything in here

A restore puts the item back in \`data/calendar/calendar.json\` and leaves the
\`.drop.json\` record here as the audit trail. It refuses to overwrite an item
already on the calendar under the same slug unless you pass \`--force\`.

## What was dropped, and what deliberately was not

Only the **exact ranked-query** tier of \`lib/ranked-coverage.js\` — the candidate
*is* a query an existing page already ranks for, above that module's position and
impression floors. That is the one tier measured at a zero false-positive rate
and the only one allowed to act silently.

A \`possible_duplicate\` (the phrase and semantic tiers) is **never** dropped here.
It is a judgement a human makes: \`agents/pipeline-prioritizer\` demotes it below
every clean idea and \`agents/content-strategist\` routes it to the digest's "Needs
your decision" section. Product scope is likewise a different question with its
own mechanism (\`data/rejected-keywords.json\`), and this sweep never acts on it.

## Nothing sweeps this directory

A calendar item is a few hundred bytes of JSON. There is no retention timer here,
for the same reason there is none in \`data/briefs/_dropped/\`: a timer that
deleted archived work would reintroduce the bug this directory exists to prevent,
just on a delay.
`;

function ensureArchive(root) {
  const dir = droppedDir(root);
  mkdirSync(dir, { recursive: true });
  const readme = join(dir, README_FILENAME);
  let current = null;
  try { current = readFileSync(readme, 'utf8'); } catch { /* absent */ }
  if (current !== DROPPED_README) writeFileSync(readme, DROPPED_README);
  return dir;
}

function appendLog(dir, entry) {
  try { appendFileSync(join(dir, DROP_LOG_FILENAME), `${JSON.stringify(entry)}\n`); }
  catch { /* the log is a convenience; never fail a move over it */ }
}

/** rename, falling back to copy+unlink across devices. */
function movePath(from, to) {
  try { renameSync(from, to); }
  catch (e) {
    if (e.code !== 'EXDEV') throw e;
    copyFileSync(from, to);
    unlinkSync(from);
  }
}

// ── the calendar file itself ────────────────────────────────────────────────

/** Read the calendar, or throw. A sweep may not guess at an unreadable one. */
export function readCalendar(root) {
  const path = calendarPath(root);
  if (!existsSync(path)) throw new Error(`no calendar at ${path}`);
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed || !Array.isArray(parsed.items)) throw new Error(`${path} has no items[] array`);
  return parsed;
}

/**
 * Copy the whole calendar aside before anything writes to it.
 *
 * Kept whatever happens afterwards, including a restore — a backup deleted once
 * the change is "known good" is a backup that is absent exactly when the change
 * turns out not to be.
 */
export function backupCalendar({ root, now = new Date(), label = 'sweep' }) {
  const src = calendarPath(root);
  if (!existsSync(src)) throw new Error(`no calendar at ${src}`);
  const dir = backupsDir(root);
  mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const dest = join(dir, `calendar-${label}-${stamp}.json`);
  copyFileSync(src, dest);
  return dest;
}

/**
 * Replace `items[]` and nothing else, and refuse to write a calendar that did
 * not survive the round trip.
 *
 * Serialize → write a temp file → re-read it FROM DISK → parse → compare against
 * what was intended → only then rename into place. The same shape
 * `scripts/reconcile-post-metas.mjs` uses, and for the same reason: every reader
 * in this fleet `catch {}`s a parse failure and carries on as though the file
 * were empty, so a half-written calendar is silent.
 *
 * @returns {{path:string, backup:string|null, items:number}}
 */
export function writeCalendarItems({ root, calendar, items, runId = newRunId() }) {
  const path = calendarPath(root);
  const tmp = `${path}.${runId}.tmp`;

  try {
    // Serialization is INSIDE the guard: an item that will not stringify has to
    // come back as "refusing to write", not as a raw TypeError halfway through a
    // run that has already archived things.
    const payload = { ...calendar, items };
    // No trailing newline: `lib/calendar-store.js` writes the file this way, and
    // matching it keeps a sweep's diff to the lines it actually changed.
    const json = JSON.stringify(payload, null, 2);
    writeFileSync(tmp, json);
    const readBack = JSON.parse(readFileSync(tmp, 'utf8'));
    if (!Array.isArray(readBack.items)) throw new Error('serialized calendar has no items[]');
    if (readBack.items.length !== items.length) {
      throw new Error(`serialized calendar holds ${readBack.items.length} items, expected ${items.length}`);
    }
    if (JSON.stringify(readBack.items) !== JSON.stringify(items)) {
      throw new Error('serialized calendar does not match the items it was built from');
    }
    renameSync(tmp, path);
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* ignore */ }
    throw new Error(`refusing to write ${path}: ${e.message}`);
  }
  return { path, items: items.length };
}

// ── the archive ─────────────────────────────────────────────────────────────

/**
 * Move dropped items into the archive.
 *
 * Never throws for one bad item — a single failure must not abandon the run
 * half-archived. Failures come back in `failed`, are reported to the operator
 * and to the digest, and their items stay on the calendar.
 *
 * NOTE THE ORDER THE CALLER MUST USE: archive first, then write the calendar. A
 * calendar write that lands before the record exists can lose an item with
 * nothing anywhere saying so; a record that lands before a calendar write that
 * then fails is a harmless extra copy, and `--restore` refuses to clobber an
 * item still on the calendar.
 *
 * @param {{root:string, drops:Array<{slug,keyword,reason,item,match,source}>,
 *          runId:string, now?:Date, droppedBy?:string}} args
 * @returns {{archived:Array, failed:Array, dir:string, sizeBytes:number}}
 */
export function archiveItems({ root, drops = [], runId = newRunId(), now = new Date(), droppedBy }) {
  const dir = ensureArchive(root);
  const archived = []; const failed = [];

  for (const d of drops) {
    try {
      const names = allocateArchiveName(readdirSync(dir), d.slug);
      const record = buildDropRecord({
        slug: d.slug, keyword: d.keyword, reason: d.reason, item: d.item,
        match: d.match ?? null, source: d.source ?? d.item?.source ?? null,
        index: Number.isInteger(d.index) ? d.index : null,
        archivedFile: names.brief, runId, now,
        ...(droppedBy ? { droppedBy } : {}),
      });
      // The item is written first, so a failure writing the sidecar still
      // leaves the work itself recoverable.
      writeFileSync(join(dir, names.brief), `${JSON.stringify(d.item, null, 2)}\n`);
      writeFileSync(join(dir, names.record), `${JSON.stringify(record, null, 2)}\n`);
      appendLog(dir, {
        event: 'drop', at: record.dropped_at, run_id: runId, slug: d.slug,
        keyword: record.keyword, reason: record.reason,
        matched_page: record.matched_page, matched_query: record.matched_query,
        archived_file: names.brief,
      });
      archived.push({ ...d, archivedFile: names.brief, recordFile: names.record, record });
    } catch (e) {
      failed.push({ slug: d.slug, error: e.message });
    }
  }

  return { archived, failed, dir, sizeBytes: droppedSizeBytes({ root }) };
}

/** Is this archive entry an item (rather than a record, the log, or the README)? */
function isArchivedItem(name) {
  return name.endsWith('.json') && !name.endsWith(DROP_RECORD_SUFFIX);
}

/** `sls-free-toothpaste--2.json` → `{ slug: 'sls-free-toothpaste', seq: 2 }` */
function parseArchiveName(name) {
  const base = basename(name, '.json');
  const m = base.match(/^(.*)--(\d+)$/);
  return m ? { slug: m[1], seq: Number(m[2]) } : { slug: base, seq: 1 };
}

/**
 * Everything in the archive, oldest drop of each slug first.
 * @returns {Array<{file:string, slug:string, seq:number, recordFile:string,
 *                  record:object|null, item:object|null, bytes:number, path:string}>}
 */
export function listDropped({ root }) {
  const dir = droppedDir(root);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const file of readdirSync(dir).filter(isArchivedItem)) {
    const { slug, seq } = parseArchiveName(file);
    const recordFile = `${basename(file, '.json')}${DROP_RECORD_SUFFIX}`;
    let record = null;
    try { record = JSON.parse(readFileSync(join(dir, recordFile), 'utf8')); } catch { /* record lost, item is not */ }
    let item = null;
    try { item = JSON.parse(readFileSync(join(dir, file), 'utf8')); } catch { /* unreadable */ }
    let bytes = 0;
    try { bytes = statSync(join(dir, file)).size; } catch { /* ignore */ }
    out.push({ file, slug, seq, recordFile, record, item, bytes, path: join(dir, file) });
  }
  return out.sort((a, b) => (a.slug === b.slug ? a.seq - b.seq : a.slug.localeCompare(b.slug)));
}

/**
 * Put archived items back on the calendar.
 *
 * The calendar is backed up and written FIRST, and the archived copy is moved
 * into `restored/` only once that write has been verified — so a failed write
 * leaves the archive exactly as it was rather than losing the item in between.
 * The `.drop.json` record deliberately stays behind: the history of what was
 * dropped and why should outlive the restore.
 *
 * @param {{root:string, slugs?:string[], all?:boolean, force?:boolean,
 *          runId?:string, now?:Date}} args
 * @returns {{restored:Array, skipped:Array, backup:string|null}}
 */
export function restoreDropped({ root, slugs = [], all = false, force = false, runId = newRunId(), now = new Date() }) {
  const dir = droppedDir(root);
  const dropped = listDropped({ root });
  const restored = []; const skipped = [];

  let targets;
  if (all) {
    targets = dropped;
  } else {
    targets = [];
    for (const slug of slugs) {
      const forSlug = dropped.filter((d) => d.slug === slug);
      if (!forSlug.length) {
        skipped.push({ slug, reason: `nothing archived under that slug in ${DROPPED_DIRNAME}/` });
        continue;
      }
      // Newest drop wins: an item dropped, restored and dropped again comes back
      // as it last was, not as it first was.
      targets.push(forSlug[forSlug.length - 1]);
    }
  }

  const calendar = readCalendar(root);
  const items = [...calendar.items];
  const live = new Set(items.map((i) => i.slug));
  const toRestore = [];

  // Lowest recorded position first, so several items restored together land back
  // in their original order rather than in the order the archive happened to
  // list them. An item with no recorded position goes on the end.
  const at = (t) => (Number.isInteger(t?.record?.calendar_index) ? t.record.calendar_index : Number.MAX_SAFE_INTEGER);
  targets = [...targets].sort((a, b) => at(a) - at(b));

  for (const t of targets) {
    if (!t.item) {
      skipped.push({ slug: t.slug, file: t.file, reason: 'the archived item will not parse — left in place' });
      continue;
    }
    if (live.has(t.slug) && !force) {
      skipped.push({ slug: t.slug, file: t.file, reason: `"${t.slug}" is already on the calendar — pass --force to replace it` });
      continue;
    }
    if (live.has(t.slug)) {
      const idx = items.findIndex((i) => i.slug === t.slug);
      items[idx] = t.item;
    } else {
      const idx = at(t);
      if (idx >= 0 && idx < items.length) items.splice(idx, 0, t.item);
      else items.push(t.item);
      live.add(t.slug);
    }
    toRestore.push(t);
  }

  if (!toRestore.length) return { restored, skipped, backup: null };

  const backup = backupCalendar({ root, now, label: 'restore' });
  writeCalendarItems({ root, calendar, items, runId });

  mkdirSync(restoredDir(root), { recursive: true });
  for (const t of toRestore) {
    try {
      movePath(join(dir, t.file), join(restoredDir(root), t.file));
    } catch (e) {
      // The item IS back on the calendar; only the housekeeping move failed.
      skipped.push({ slug: t.slug, file: t.file, reason: `restored to the calendar, but the archived copy could not be moved aside: ${e.message}` });
    }
    appendLog(dir, { event: 'restore', at: now.toISOString(), run_id: runId, slug: t.slug, archived_file: t.file, forced: Boolean(force) });
    restored.push({ slug: t.slug, file: t.file, item: t.item });
  }

  return { restored, skipped, backup };
}

/** Total bytes held in the archive. Reported, never acted on. */
export function droppedSizeBytes({ root }) {
  const dir = droppedDir(root);
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const f of readdirSync(dir)) {
    try {
      const s = statSync(join(dir, f));
      total += s.isDirectory() ? 0 : s.size;
    } catch { /* ignore */ }
  }
  return total;
}
