#!/usr/bin/env node
/**
 * Reconcile data/posts/<slug>/meta.json across a deploy, without losing either side.
 *
 * WHY THIS EXISTS
 * ───────────────
 * On 2026-08-23 the deploy recovery CLAUDE.md documented — `git stash push` →
 * `git pull` → `git stash pop` — produced INVALID JSON on the production server
 * twice in one day. Incident 1 (PR #629, data/rejected-keywords.json) left 20
 * conflict markers in a tracked JSON file. Incident 2 (PR #634) conflicted five
 * `meta.json` files, all invalid, and could not be fixed by taking a side: HEAD
 * was missing `indexing_state`, `indexing_submissions`, `published_at` and
 * `shopify_status: published` — including a backfill run hours earlier —
 * because the committed copies are stale by construction, while the server was
 * missing the compliance edits to `title`/`meta_description` the deploy existed
 * to ship. It was resolved by hand, field by field.
 *
 * `lib/post-meta-reconcile.js` is that hand-resolution as a rule. This script
 * is its I/O: it reads the two (or three) sides, backs up before writing,
 * validates before writing, refuses rather than writing a broken file, and
 * leaves a run record naming every field-level decision.
 *
 * WHY THE STASH DANCE CANNOT BE MADE TO WORK HERE
 * ──────────────────────────────────────────────
 * `git stash pop` runs a three-way MERGE, and its merge driver for JSON is the
 * line-based text driver. Two sides that edited nearby lines of the same
 * pretty-printed object produce conflict markers *inside the JSON*, and the
 * file is then unparseable to every reader on the box — including the cron jobs
 * that will run before anyone notices. The stash is not the bug; running a
 * text merge over a machine-written data file is. So this script replaces the
 * merge with a semantic one and the deploy sequence never lets git text-merge
 * these paths at all.
 *
 * USAGE
 * ─────
 *   # BEFORE the pull — detect, and gate the deploy on the exit code
 *   node scripts/reconcile-post-metas.mjs --ref origin/main
 *
 *   # BEFORE the pull — save the box's truth so the pull can be allowed to win
 *   node scripts/reconcile-post-metas.mjs --snapshot
 *
 *   # AFTER the pull — merge the box's truth back into the pulled files
 *   node scripts/reconcile-post-metas.mjs --against <snapshot-dir> --apply
 *
 *   # anywhere — what does the working tree hold that HEAD does not?
 *   node scripts/reconcile-post-metas.mjs
 *
 * FLAGS
 *   --apply             write the merge (default is report-only)
 *   --ref <ref>         the git side (default HEAD)
 *   --base <ref>        merge base for a 3-way. Defaults to HEAD when --ref is
 *                       not HEAD; absent otherwise (2-way union — safe, but it
 *                       arbitrates more often than it needs to)
 *   --against <dir>     read the machine side from a snapshot directory instead
 *                       of the working tree, and treat the WORKING TREE as the
 *                       git side. This is the post-pull direction.
 *   --snapshot [dir]    copy every working-tree meta.json plus a manifest
 *                       (recording HEAD's SHA) into a snapshot directory
 *   --slug <slug>       restrict to one post — rehearse before bulk-applying
 *   --quiet             suppress the human report (the run record still lands)
 *   --no-run-record     do not write data/reports/post-meta-reconcile/ at all.
 *                       For the SCHEDULED detector only (see
 *                       scripts/check-post-meta-drift.mjs): a deploy runs this
 *                       a handful of times and its run record is the audit
 *                       trail, but a daily cron would leave a run-<id>/
 *                       directory every morning forever, and this box has
 *                       already lost four days of cron to a full disk. The
 *                       detector never writes a meta.json, so there is no
 *                       decision to audit — its human report goes to the cron
 *                       log and its verdict to the 5 AM digest. Ignored (and
 *                       refused) when --apply is set: a run that WROTE files
 *                       must always leave the record naming what lost.
 *
 * EXIT CODES — a deploy step can gate on these
 *   0  in sync, or --apply completed with every decision classified
 *   1  divergence detected and nothing was written (the gate)
 *   2  a field changed on both sides and has no owner — classify it in
 *      lib/post-meta-reconcile.js. Raised whether or not --apply ran, because a
 *      merge nobody has taken a position on is not a clean deploy.
 *   3  refused: a side would not parse, or a write did not verify. Files that
 *      failed are left exactly as they were.
 *
 * SAFE TO RUN BEFORE AND AFTER A PULL, and safe to run twice: the merge is
 * defined against what the target file already holds, so a second run is a
 * no-op that exits 0.
 *
 * This script never runs a git command that mutates anything. It only ever
 * reads (`git show`, `git rev-parse`, `git ls-tree`).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync, unlinkSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  reconcilePosts,
  renderReconcileReport,
  serializeMeta,
  parseMetaText,
  valuesEqual,
  FIELD_OWNERS,
  CONTESTED_FIELDS,
} from '../lib/post-meta-reconcile.js';

const ROOT = process.env.SEO_CLAUDE_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');
const POSTS_REL = 'data/posts';
const REPORT_DIR = join(ROOT, 'data', 'reports', 'post-meta-reconcile');

const EXIT_OK = 0;
const EXIT_DIVERGED = 1;
const EXIT_UNCLASSIFIED = 2;
const EXIT_REFUSED = 3;

// ── args ─────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback = null) => {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : fallback;
};

const APPLY = flag('--apply');
const QUIET = flag('--quiet');
// A run that writes files ALWAYS leaves the record naming every value that lost
// an arbitration — that half of "never silently drop a field" is the whole
// point, and no flag may switch it off.
const NO_RUN_RECORD = flag('--no-run-record') && !APPLY;
const REF = opt('--ref', 'HEAD');
const AGAINST = opt('--against', null);
const ONLY_SLUG = opt('--slug', null);
const DO_SNAPSHOT = flag('--snapshot');
const SNAPSHOT_DIR = opt('--snapshot', null);
// A base only helps when it differs from the git side. `--ref HEAD` with
// `--base HEAD` would make "the repo side never moved" true for every field and
// hand the server every arbitration — a 3-way that is really a one-way.
const BASE_REF = opt('--base', REF === 'HEAD' && !AGAINST ? null : 'HEAD');

// ── git, read-only ───────────────────────────────────────────────────────────

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function revParse(ref) {
  try { return git(['rev-parse', ref]).trim(); } catch { return null; }
}

/**
 * Every meta.json a ref carries, as slug → object.
 *
 * A ref that does not exist is not an error — it is the answer "git has nothing
 * here", and merging against nothing loses nothing. A ref that carries a file
 * this module cannot parse IS an error: reading a conflict-markered blob and
 * "merging" it would launder the corruption into a clean-looking write.
 */
function readRefMetas(ref, problems) {
  const sha = revParse(ref);
  if (!sha) return { metas: new Map(), sha: null, missing: true };
  const metas = new Map();
  let listing = '';
  try {
    listing = git(['ls-tree', '-r', '--name-only', sha, '--', POSTS_REL]);
  } catch {
    return { metas, sha, missing: true };
  }
  for (const path of listing.split('\n')) {
    if (!path.endsWith('/meta.json')) continue;
    const slug = path.slice(POSTS_REL.length + 1, -'/meta.json'.length);
    if (ONLY_SLUG && slug !== ONLY_SLUG) continue;
    try {
      metas.set(slug, parseMetaText(git(['show', `${sha}:${path}`]), `${ref}:${path}`));
    } catch (err) {
      problems.push({ slug, side: `git ${ref}`, error: err.message });
    }
  }
  return { metas, sha, missing: false };
}

/** Every meta.json in the working tree, as slug → object. */
function readWorkingTreeMetas(problems) {
  const dir = join(ROOT, POSTS_REL);
  const metas = new Map();
  const style = new Map(); // slug → trailing-newline style of the file on disk
  if (!existsSync(dir)) return { metas, style };
  for (const slug of readdirSync(dir)) {
    if (ONLY_SLUG && slug !== ONLY_SLUG) continue;
    const p = join(dir, slug, 'meta.json');
    if (!existsSync(p)) continue;
    let text;
    try { text = readFileSync(p, 'utf8'); } catch (err) { problems.push({ slug, side: 'working tree', error: err.message }); continue; }
    style.set(slug, text.endsWith('\n'));
    try { metas.set(slug, parseMetaText(text, `${POSTS_REL}/${slug}/meta.json`)); }
    catch (err) { problems.push({ slug, side: 'working tree', error: err.message }); }
  }
  return { metas, style };
}

/** Every meta.json in a snapshot directory, as slug → object. */
function readSnapshotMetas(dir, problems) {
  const metas = new Map();
  const metaDir = join(dir, 'metas');
  if (!existsSync(metaDir)) return { metas, manifest: null };
  for (const file of readdirSync(metaDir)) {
    if (!file.endsWith('.json')) continue;
    const slug = file.slice(0, -'.json'.length);
    if (ONLY_SLUG && slug !== ONLY_SLUG) continue;
    try { metas.set(slug, parseMetaText(readFileSync(join(metaDir, file), 'utf8'), `snapshot/${file}`)); }
    catch (err) { problems.push({ slug, side: `snapshot ${dir}`, error: err.message }); }
  }
  let manifest = null;
  const mp = join(dir, 'manifest.json');
  if (existsSync(mp)) { try { manifest = JSON.parse(readFileSync(mp, 'utf8')); } catch { /* manifest is a convenience, not a requirement */ } }
  return { metas, manifest };
}

// ── snapshot mode ────────────────────────────────────────────────────────────

/**
 * Save the box's truth before the pull is allowed to overwrite it.
 *
 * This is what makes the corrected deploy sequence safe: with the snapshot on
 * disk, the working tree can be reset at those paths so `git pull` fast-forwards
 * cleanly and git NEVER text-merges a machine-written JSON file. The manifest
 * records the SHA the box was sitting on, which becomes the merge base for the
 * post-pull reconcile — that is the difference between "arbitrate every
 * differing field" and "arbitrate only the handful both sides really touched".
 */
function runSnapshot() {
  const problems = [];
  const { metas, style } = readWorkingTreeMetas(problems);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = SNAPSHOT_DIR ? resolve(SNAPSHOT_DIR) : join(REPORT_DIR, `snapshot-${stamp}`);
  mkdirSync(join(dir, 'metas'), { recursive: true });

  for (const [slug, meta] of metas) {
    writeFileSync(join(dir, 'metas', `${slug}.json`), serializeMeta(meta, { trailingNewline: style.get(slug) }));
  }
  const head = revParse('HEAD');
  const manifest = {
    generated_at: new Date().toISOString(),
    head_sha: head,
    head_ref: (() => { try { return git(['rev-parse', '--abbrev-ref', 'HEAD']).trim(); } catch { return null; } })(),
    posts: metas.size,
    unreadable: problems,
    note: 'Pre-pull snapshot of data/posts/*/meta.json. head_sha is the merge base for the post-pull reconcile.',
  };
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`\nSnapshotted ${metas.size} meta.json file(s) at HEAD ${head?.slice(0, 8)} → ${dir}`);
  if (problems.length) {
    console.log(`\n  ${problems.length} file(s) could NOT be read and are NOT in the snapshot:`);
    for (const p of problems) console.log(`    ${p.slug}: ${p.error}`);
    console.log('  Fix those by hand before pulling — a snapshot missing a file cannot restore it.');
  }
  console.log('\nThe working tree can now be reset at these paths so `git pull` fast-forwards');
  console.log('without git text-merging a machine-written JSON file:\n');
  console.log(`  git checkout -- ${POSTS_REL}/*/meta.json`);
  console.log('\nThen, after the pull:\n');
  console.log(`  node scripts/reconcile-post-metas.mjs --against ${dir} --apply\n`);
  return problems.length ? EXIT_REFUSED : EXIT_OK;
}

// ── validated write ──────────────────────────────────────────────────────────

/**
 * Write a meta.json, or refuse.
 *
 * Three checks, because the whole point of this script is that a file on the
 * production box must never become unparseable: the serialized text is parsed
 * back and compared to the object BEFORE anything touches the disk; it is
 * written to a temp file and re-read from disk; and only then renamed into
 * place. A crash between any two of those leaves the original file intact.
 */
function writeMetaSafely(path, merged, trailingNewline) {
  const text = serializeMeta(merged, { trailingNewline });

  const roundTrip = parseMetaText(text, path); // throws on anything unparseable
  if (!valuesEqual(roundTrip, merged)) {
    throw new Error(`${path}: serialized form does not round-trip to the merged object — refusing to write`);
  }

  const tmp = `${path}.reconcile-tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, text);
    const verify = parseMetaText(readFileSync(tmp, 'utf8'), tmp);
    if (!valuesEqual(verify, merged)) throw new Error(`${path}: file on disk does not match the merged object — refusing to install`);
    renameSync(tmp, path);
  } catch (err) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
    throw err;
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

function main() {
  if (DO_SNAPSHOT) return runSnapshot();

  const problems = [];
  let repoMetas; let serverMetas; let baseMetas = new Map();
  let repoLabel; let serverLabel; let baseLabel = null;
  let writeStyle; // slug → trailing-newline style of the file we will write
  let orderFor;

  const wt = readWorkingTreeMetas(problems);

  if (AGAINST) {
    // POST-PULL. The working tree is the freshly pulled git side; the snapshot
    // is the box's truth. The file we write is the working tree, so it keeps
    // its own key order.
    const snap = readSnapshotMetas(resolve(AGAINST), problems);
    if (!snap.metas.size && !existsSync(join(resolve(AGAINST), 'metas'))) {
      console.error(`--against: no snapshot at ${resolve(AGAINST)} (expected a metas/ directory)`);
      return EXIT_REFUSED;
    }
    repoMetas = wt.metas; repoLabel = 'working tree (pulled)';
    serverMetas = snap.metas; serverLabel = `snapshot ${AGAINST}`;
    const baseSha = snap.manifest?.head_sha || null;
    if (baseSha) {
      const b = readRefMetas(baseSha, problems);
      baseMetas = b.metas; baseLabel = `${baseSha.slice(0, 8)} (pre-pull HEAD, from the snapshot manifest)`;
    }
    writeStyle = wt.style;
    orderFor = (slug, sides) => sides.repo || sides.server;
  } else {
    // PRE-PULL / ad hoc. Git is the repo side, the working tree is the box.
    const r = readRefMetas(REF, problems);
    repoMetas = r.metas; repoLabel = `git ${REF}`;
    serverMetas = wt.metas; serverLabel = 'working tree';
    if (BASE_REF) {
      const b = readRefMetas(BASE_REF, problems);
      if (!b.missing) { baseMetas = b.metas; baseLabel = `git ${BASE_REF}`; }
    }
    writeStyle = wt.style;
    orderFor = (slug, sides) => sides.server || sides.repo;
  }

  const result = reconcilePosts({ base: baseMetas, repo: repoMetas, server: serverMetas, orderFor });
  const { summary } = result;

  if (!QUIET) {
    console.log('');
    console.log(renderReconcileReport(result, { repoLabel, serverLabel, baseLabel }));
    console.log('');
  }

  if (problems.length) {
    console.error(`REFUSED to consider ${problems.length} file(s) — they were left untouched:`);
    for (const p of problems) console.error(`  ${p.slug} [${p.side}]: ${p.error}`);
    console.error('');
  }

  // ── run record ─────────────────────────────────────────────────────────────
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = join(REPORT_DIR, `run-${runId}`);
  const applied = [];
  const refused = [...problems];

  if (APPLY && summary.changed) {
    mkdirSync(join(runDir, 'backup'), { recursive: true });
    for (const p of result.posts) {
      if (p.status !== 'changed') continue;
      const path = join(ROOT, POSTS_REL, p.slug, 'meta.json');
      if (!existsSync(path)) { refused.push({ slug: p.slug, side: 'working tree', error: 'file vanished between read and write' }); continue; }
      try {
        // Back up FIRST. A backup written after the rename is a backup of the
        // thing that replaced what you wanted to keep.
        writeFileSync(join(runDir, 'backup', `${p.slug}.json`), readFileSync(path, 'utf8'));
        writeMetaSafely(path, p.merged, writeStyle.get(p.slug) ?? false);
        applied.push(p.slug);
      } catch (err) {
        refused.push({ slug: p.slug, side: 'write', error: err.message });
        console.error(`  REFUSED ${p.slug}: ${err.message}`);
      }
    }
  }

  if (!NO_RUN_RECORD) mkdirSync(runDir, { recursive: true });
  const record = {
    run_id: runId,
    generated_at: new Date().toISOString(),
    mode: AGAINST ? 'against-snapshot' : 'against-git-ref',
    apply: APPLY,
    repo_side: repoLabel,
    server_side: serverLabel,
    base: baseLabel,
    three_way: !!baseLabel,
    only_slug: ONLY_SLUG,
    summary,
    applied,
    refused,
    field_owners: FIELD_OWNERS,
    contested_fields: [...CONTESTED_FIELDS],
    // Every field-level decision, including the value that lost. This is the
    // half of "never silently drop a field" that the file itself cannot carry.
    decisions: result.posts
      .filter((p) => p.decisions.some((d) => d.outcome !== 'agree'))
      .map((p) => ({
        slug: p.slug,
        status: p.status,
        fields: p.decisions.filter((d) => d.outcome !== 'agree'),
      })),
  };
  if (!NO_RUN_RECORD) {
    writeFileSync(join(runDir, 'run.json'), `${JSON.stringify(record, null, 2)}\n`);
    writeFileSync(join(runDir, 'run.md'), `${renderReconcileReport(result, { repoLabel, serverLabel, baseLabel })}\n`);
    writeFileSync(join(REPORT_DIR, 'latest.json'), `${JSON.stringify(record, null, 2)}\n`);
  }

  if (APPLY && applied.length) {
    console.log(`Wrote ${applied.length} meta.json file(s). Backups: ${join(runDir, 'backup')}`);
    console.log('Nothing was dropped — every field either side held is in the merged file, and every');
    console.log(`value that lost an arbitration is in ${join(runDir, 'run.json')}.`);
    console.log('');
    console.log('Commit these from a branch. It is the only way the box\'s state reaches git —');
    console.log('leaving it uncommitted is what made the committed copies stale in the first place.');
  } else if (!APPLY && summary.changed) {
    console.log(`Report only. Re-run with --apply to write ${summary.changed} reconciled file(s).`);
  }
  console.log(NO_RUN_RECORD ? 'Run record: not written (--no-run-record).' : `Run record: ${join(runDir, 'run.json')}`);
  console.log('');

  if (refused.length) return EXIT_REFUSED;
  if (summary.unclassifiedConflicts) return EXIT_UNCLASSIFIED;
  if (!APPLY && summary.changed) return EXIT_DIVERGED;
  return EXIT_OK;
}

process.exit(main());
