// lib/brief-archive.js
//
// Dropping a content brief must be reversible.
//
// WHY THIS EXISTS. Between 2026-08-19 15:00 UTC and 2026-08-23 13:17 UTC,
// `lib/cluster-revenue.js` wrongly stamped the `soap` cluster `proven_dud` — a
// taxonomy first-match bug, fixed in PR #624. In that window
// `scripts/triage-orphan-briefs.mjs --drop-non-earning --apply` called
// `unlinkSync` on the briefs that verdict condemned, and three of them are
// permanently gone: `vegan-soap.json`, `oatmeal-soap.json` and
// `coconut-oil-soap-benefits.json` (probably a fourth, `soap-making.json`,
// undatable). Absent from the server, from both checkouts, and from git — they
// were never committed, so git was never a safety net for them. Each was a full
// content-researcher run: paid SERP calls and a paid LLM pass, thrown away on a
// measurement that was wrong. `data/logs/calendar-runner.log:34622-34623` shows
// `vegan soap` and `oatmeal soap` flipping `📋 briefed` → `⬜ pending` as it
// happened, and nothing in the 5 AM digest mentioned it, because the script did
// not import `notify` at all.
//
// PR #627 made that script refuse to run on a stale seo-impact report. That is
// the UPSTREAM guard — it stops a bad verdict being acted on. This is the
// DOWNSTREAM one: when a verdict IS acted on and turns out to be wrong, the
// work comes back. They are complementary, and neither removes the need for the
// other: #627 could not have helped here, because the report was fresh. It was
// simply wrong.
//
// WHY A DIRECTORY INSIDE data/briefs/. `data/briefs/_dropped/` and not a
// sibling like `data/briefs-dropped/`, because the person who notices a brief
// has vanished opens `data/briefs/` — the recovery path has to be visible from
// the scene of the loss, alongside a README that spells out the restore
// command.
//
// WHY THAT IS SAFE. Every reader of `data/briefs/` does a non-recursive
// `readdirSync` filtered on `.endsWith('.json')`. `_dropped` is a directory
// with no `.json` suffix, so all six of them — blog-post-writer,
// content-researcher, gsc-opportunity, unmapped-query-promoter, seo-reporter
// and the triage script itself — skip it, and the per-slug
// `existsSync(join(BRIEFS_DIR, `${slug}.json`))` checks in calendar-runner,
// rank-tracker, post-performance and the dashboard cannot see into a
// subdirectory at all. That property is a convention six files happen to share,
// not something the language enforces, so
// `tests/lib/briefs-dir-readers.test.js` pins it: a seventh reader without the
// filter, or an existing one switched to a recursive walk, fails there.
//
// WHY THERE IS NO RETENTION SWEEP. CLAUDE.md's disk history is real — unpruned
// Amazon dumps filled the box and killed four days of cron — but that was
// GB-scale image and report output. A brief is ~25 KB of JSON; the 73-brief
// orphan backlog that started all this is 1.8 MB, and ten thousand drops would
// be ~250 MB against ~9.9 GB free. A timer that deleted archived briefs would
// reintroduce the exact bug this module exists to prevent, on a delay — the
// same reasoning that makes `lib/creatives-budget.js` purge pixels but never
// JSON. So nothing here deletes anything, ever. Instead every apply run
// measures the directory and says so in the digest once it passes
// SIZE_WARN_BYTES, so it can become a known problem but never a silent one.
//
// NOT GITIGNORED, on purpose. `data/briefs/*.json` is tracked (23 files), so
// archiving a tracked brief is a rename git can follow and undo. Ignoring
// `_dropped/` would make the archive itself untracked — which is precisely the
// condition that made the original loss unrecoverable.

import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync,
  renameSync, copyFileSync, unlinkSync, appendFileSync, statSync,
} from 'node:fs';
import { join, basename } from 'node:path';

/** Not `.json`, and that is load-bearing — see the header. */
export const DROPPED_DIRNAME = '_dropped';
export const DROP_RECORD_SUFFIX = '.drop.json';
export const DROP_LOG_FILENAME = 'log.jsonl';
export const README_FILENAME = 'README.md';

/**
 * Report the archive's size past this, never prune it.
 * ~25 KB per brief, so this is roughly ten thousand drops.
 */
export const SIZE_WARN_BYTES = 256 * 1024 * 1024;

/** The command a human runs. Written into every record and into the digest. */
export const RESTORE_COMMAND = 'node scripts/triage-orphan-briefs.mjs --restore';

export function briefsDir(root) { return join(root, 'data', 'briefs'); }
export function droppedDir(root) { return join(briefsDir(root), DROPPED_DIRNAME); }

/**
 * A filename-safe id for one run, so a record can be traced back to the run
 * that wrote it even after several runs have touched the same slug.
 */
export function newRunId(now = new Date(), pid = process.pid) {
  return `${now.toISOString().replace(/[:.]/g, '-')}-${pid}`;
}

/**
 * Pick names that cannot overwrite an earlier drop.
 *
 * The first drop of a slug keeps its own name, so the common case reads
 * naturally in `ls`. A repeat drop gets `--2`, `--3`, … Both the brief name and
 * the record name have to be free: a slug literally called `x--2` would
 * otherwise take a fresh brief name while landing on an existing sidecar.
 *
 * @param {string[]} existing  filenames already in the archive
 * @param {string} slug
 * @returns {{brief: string, record: string}}
 */
export function allocateArchiveName(existing, slug) {
  const taken = new Set(existing || []);
  const free = (base) => !taken.has(`${base}.json`) && !taken.has(`${base}${DROP_RECORD_SUFFIX}`);
  if (free(slug)) return { brief: `${slug}.json`, record: `${slug}${DROP_RECORD_SUFFIX}` };
  let n = 2;
  while (!free(`${slug}--${n}`)) n += 1;
  return { brief: `${slug}--${n}.json`, record: `${slug}--${n}${DROP_RECORD_SUFFIX}` };
}

/**
 * The sidecar: when, why, on what evidence, and by which run.
 *
 * `cluster_verdict` carries the classification object verbatim — including its
 * `evidence` and `corroboration` strings — because "the soap cluster does not
 * earn" is not reviewable six weeks later, whereas "attributed $0 on 268 clicks
 * across 32 pages, measured 2026-08-22" is. That is the difference between a
 * record and a note.
 */
export function buildDropRecord({
  slug, keyword, reason, cluster = null, clusterStats = null,
  archivedFile, runId, droppedBy = 'scripts/triage-orphan-briefs.mjs',
  now = new Date(), report = null,
}) {
  return {
    schema: 'brief-drop/1',
    slug,
    keyword: keyword || null,
    dropped_at: now.toISOString(),
    dropped_by: droppedBy,
    run_id: runId,
    reason: reason || null,
    cluster,
    cluster_verdict: clusterStats || null,
    report: report || null,
    archived_file: archivedFile,
    restore: `${RESTORE_COMMAND} ${slug}`,
    note: 'This brief was MOVED here, not deleted. Restoring it puts it back in data/briefs/.',
  };
}

/** Deterministic, so re-writing it on every run never churns the diff. */
export const DROPPED_README = `# Dropped content briefs

Briefs in here were taken out of circulation by \`scripts/triage-orphan-briefs.mjs\`.
**Nothing here has been deleted.** Each one was moved, with a record of why.

This directory exists because dropping a brief used to be permanent. Between
2026-08-19 and 2026-08-23 a wrong \`soap\` cluster verdict (a taxonomy bug, fixed
in PR #624) sent \`--drop-non-earning --apply\` through \`unlinkSync\`, and three
paid-for briefs — \`vegan-soap\`, \`oatmeal-soap\` and \`coconut-oil-soap-benefits\` —
were destroyed with no backup, no report and no digest row. They are gone.

## Layout

    <slug>.json           the brief, byte for byte as it was
    <slug>.drop.json      why it went, when, on what evidence, and by which run
    log.jsonl             append-only history of every drop and every restore

A slug dropped more than once becomes \`<slug>--2.json\`, \`<slug>--3.json\`, … so an
earlier drop is never overwritten.

## Restoring

    node scripts/triage-orphan-briefs.mjs --list-dropped        # what is in here
    node scripts/triage-orphan-briefs.mjs --restore <slug>      # newest drop of one brief
    node scripts/triage-orphan-briefs.mjs --restore --all       # everything in here

Restore puts the file back in \`data/briefs/\` and leaves the \`.drop.json\` record
here as the audit trail. It refuses to overwrite a live \`data/briefs/<slug>.json\`
unless you pass \`--force\`.

## Nothing sweeps this directory

A brief is about 25 KB of JSON. The whole orphan backlog that started this was
1.8 MB, and ten thousand drops would be ~250 MB against the production box's
~9.9 GB free. The disk incident this project actually suffered was GB-scale
Amazon dumps. A retention timer here would reintroduce the bug this directory
exists to prevent, just on a delay — so there isn't one. Every apply run
measures this directory and says so in the 5 AM digest if it ever passes 256 MB.

## This is not a live brief directory

Every reader of \`data/briefs/\` does a non-recursive \`readdirSync\` filtered on
\`.endsWith('.json')\`, so \`_dropped\` — a directory, no \`.json\` suffix — is
invisible to all of them, and a dropped brief cannot be re-read, re-briefed or
re-counted as coverage. \`tests/lib/briefs-dir-readers.test.js\` pins that
invariant so a future reader cannot quietly drop the filter.
`;

function ensureArchive(root) {
  const dir = droppedDir(root);
  mkdirSync(dir, { recursive: true });
  const readme = join(dir, README_FILENAME);
  // Rewrite only on drift, so an unchanged run touches nothing.
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

/**
 * Move condemned briefs into the archive. Replaces `unlinkSync`.
 *
 * Never throws for one bad file — a single unreadable brief must not abandon
 * the rest of the run half-archived. Failures come back in `failed` and are
 * reported to the operator and to the digest.
 *
 * @param {{root:string, drops:Array<{slug,path,keyword,reason,cluster?,clusterStats?}>,
 *          runId:string, now?:Date, report?:object, droppedBy?:string}} args
 * @returns {{archived:Array, failed:Array, dir:string, sizeBytes:number}}
 */
export function archiveBriefs({ root, drops = [], runId = newRunId(), now = new Date(), report = null, droppedBy }) {
  const dir = ensureArchive(root);
  const archived = []; const failed = [];

  for (const d of drops) {
    try {
      const names = allocateArchiveName(readdirSync(dir), d.slug);
      const record = buildDropRecord({
        slug: d.slug, keyword: d.keyword, reason: d.reason,
        cluster: d.cluster ?? null, clusterStats: d.clusterStats ?? null,
        archivedFile: names.brief, runId, now, report,
        ...(droppedBy ? { droppedBy } : {}),
      });
      // The brief moves first: if writing the sidecar fails the work still
      // survives, which is the priority. The reverse order could lose it.
      movePath(d.path, join(dir, names.brief));
      writeFileSync(join(dir, names.record), `${JSON.stringify(record, null, 2)}\n`);
      appendLog(dir, {
        event: 'drop', at: record.dropped_at, run_id: runId, slug: d.slug,
        keyword: record.keyword, reason: record.reason, cluster: record.cluster,
        archived_file: names.brief,
      });
      archived.push({ ...d, archivedFile: names.brief, recordFile: names.record, record });
    } catch (e) {
      failed.push({ slug: d.slug, path: d.path, error: e.message });
    }
  }

  return { archived, failed, dir, sizeBytes: droppedSizeBytes({ root }) };
}

/** Is this archive entry a brief (rather than a record, the log, or the README)? */
function isArchivedBrief(name) {
  return name.endsWith('.json') && !name.endsWith(DROP_RECORD_SUFFIX);
}

/** `vegan-soap--2.json` → `{ slug: 'vegan-soap', seq: 2 }` */
function parseArchiveName(name) {
  const base = basename(name, '.json');
  const m = base.match(/^(.*)--(\d+)$/);
  return m ? { slug: m[1], seq: Number(m[2]) } : { slug: base, seq: 1 };
}

/**
 * Everything in the archive, oldest drop of each slug first.
 * @returns {Array<{file:string, slug:string, seq:number, recordFile:string, record:object|null, bytes:number}>}
 */
export function listDropped({ root }) {
  const dir = droppedDir(root);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const file of readdirSync(dir).filter(isArchivedBrief)) {
    const { slug, seq } = parseArchiveName(file);
    const recordFile = `${basename(file, '.json')}${DROP_RECORD_SUFFIX}`;
    let record = null;
    try { record = JSON.parse(readFileSync(join(dir, recordFile), 'utf8')); } catch { /* record lost, brief is not */ }
    let bytes = 0;
    try { bytes = statSync(join(dir, file)).size; } catch { /* ignore */ }
    out.push({ file, slug, seq, recordFile, record, bytes, path: join(dir, file) });
  }
  return out.sort((a, b) => (a.slug === b.slug ? a.seq - b.seq : a.slug.localeCompare(b.slug)));
}

/**
 * Put archived briefs back where the pipeline reads them.
 *
 * The `.drop.json` record deliberately STAYS behind: the history of what was
 * dropped and why should outlive the restore, and the log records the restore
 * alongside it.
 *
 * @param {{root:string, slugs?:string[], all?:boolean, force?:boolean, runId?:string, now?:Date}} args
 * @returns {{restored:Array, skipped:Array}}
 */
export function restoreDropped({ root, slugs = [], all = false, force = false, runId = newRunId(), now = new Date() }) {
  const dir = droppedDir(root);
  const live = briefsDir(root);
  const restored = []; const skipped = [];
  const dropped = listDropped({ root });

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
      // Newest drop wins: a slug dropped, restored and dropped again should come
      // back as it last was, not as it first was.
      targets.push(forSlug[forSlug.length - 1]);
    }
  }

  mkdirSync(live, { recursive: true });
  for (const t of targets) {
    const dest = join(live, `${t.slug}.json`);
    if (existsSync(dest) && !force) {
      skipped.push({ slug: t.slug, file: t.file, reason: `data/briefs/${t.slug}.json already exists — pass --force to overwrite it` });
      continue;
    }
    try {
      movePath(join(dir, t.file), dest);
      appendLog(dir, {
        event: 'restore', at: now.toISOString(), run_id: runId, slug: t.slug,
        archived_file: t.file, forced: !!force && existsSync(dest),
      });
      restored.push({ slug: t.slug, file: t.file, dest });
    } catch (e) {
      skipped.push({ slug: t.slug, file: t.file, reason: e.message });
    }
  }

  return { restored, skipped };
}

/** Total bytes held in the archive. Reported, never acted on. */
export function droppedSizeBytes({ root }) {
  const dir = droppedDir(root);
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const f of readdirSync(dir)) {
    try { total += statSync(join(dir, f)).size; } catch { /* ignore */ }
  }
  return total;
}

function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * The digest row this script never had.
 *
 * The 2026-08-19 run dropped three briefs and said nothing anywhere — no
 * notify import, no report file. The loss was found days later by reading
 * calendar-runner's log. Deferred to the 5 AM digest per CLAUDE.md; this is
 * never `immediate: true`, because it is now a recoverable event.
 *
 * @returns {{subject:string, body:string, status:string}}
 */
export function renderDropDigest({ dropped = [], kept = 0, failed = [], restored = [], sizeBytes = 0, runId = '' }) {
  const parts = [];
  if (dropped.length) parts.push(`${dropped.length} brief${dropped.length === 1 ? '' : 's'} dropped`);
  if (restored.length) parts.push(`${restored.length} restored`);
  if (failed.length) parts.push(`${failed.length} failed`);
  const subject = `Brief triage — ${parts.join(', ') || 'no changes'}, ${kept} kept`;

  const lines = [];
  if (dropped.length) {
    lines.push(`Moved ${dropped.length} orphaned brief(s) to \`data/briefs/${DROPPED_DIRNAME}/\`. **Not deleted** — every one can be restored.`);
    lines.push('');
    for (const d of dropped) {
      lines.push(`- **${d.slug}** — "${d.keyword || ''}"`);
      lines.push(`  ${d.reason || 'no reason recorded'}`);
      lines.push(`  restore: \`${RESTORE_COMMAND} ${d.slug}\``);
    }
    lines.push('');
  }

  if (restored.length) {
    lines.push(`Restored ${restored.length} brief(s) to \`data/briefs/\`: ${restored.map((r) => r.slug).join(', ')}`);
    lines.push('');
  }

  if (failed.length) {
    lines.push(`⚠ ${failed.length} brief(s) could NOT be archived and were left in place:`);
    for (const f of failed) lines.push(`- ${f.slug}: ${f.error}`);
    lines.push('');
  }

  lines.push(`${kept} orphaned brief(s) kept and returned to the calendar.`);
  lines.push(`Archive: ${humanBytes(sizeBytes)} in data/briefs/${DROPPED_DIRNAME}/ (nothing in it is ever pruned).`);
  if (sizeBytes > SIZE_WARN_BYTES) {
    lines.push(`⚠ The archive is large (over ${humanBytes(SIZE_WARN_BYTES)}). It is not swept on a timer by design — `
      + 'review it by hand if the box is short of disk.');
  }
  if (runId) lines.push(`Run: ${runId}`);

  return { subject, body: lines.join('\n'), status: failed.length ? 'error' : 'success' };
}
