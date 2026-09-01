#!/usr/bin/env node
//
// Split data/posts/<slug>/meta.json into authored copy + machine state.
//
//   node scripts/split-post-meta.mjs            # dry run — report only
//   node scripts/split-post-meta.mjs --apply    # write
//   node scripts/split-post-meta.mjs --slug <s> # one post
//
// WHAT IT DOES
//   Reads the MERGED view of each post (meta.json plus any state.json already
//   there) and writes it back through lib/posts.js's replacePostMeta, which
//   routes every field by FIELD_OWNERS. meta.json is left holding the ~6 authored
//   fields; everything a machine observes or stamps moves to state.json.
//
// WHY THIS IS SAFE TO RUN WHILE CRON IS WRITING
//   Every write is temp-file + rename, so no reader can observe a half-written
//   file — and this is the specific hazard, because every reader in the fleet
//   catch{}s a parse failure and carries on as though the post had no metadata.
//   Each post is verified AFTER its write: the merged view must still deep-equal
//   what was read, key for key. A post that fails that check is ROLLED BACK from
//   the pre-write backup and reported, rather than left half-split.
//
//   The residual race is real and is stated rather than papered over: a cron
//   writer that updates a post between this script's read and its write loses
//   that one update. The window is milliseconds per post, every writer now goes
//   through the same chokepoint, and DAILY_POST_META_GATE re-checks the corpus
//   every morning. Run it outside the 15:00 UTC scheduler window anyway.
//
// ORDER MATTERS — this is the LAST stage, not the first.
//   Until every writer goes through lib/posts.js, a writer that still does a raw
//   writeFileSync on meta.json would write a server field there while state.json
//   also holds it — and getPostMeta prefers state, so that writer's value would
//   be silently masked. Deploy the writer migration first; this script assumes it.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listAllSlugs, getPostMeta, getMetaPath, getStatePath, replacePostMeta,
  partitionMetaFields, POSTS_DIR, ROOT,
} from '../lib/posts.js';
import { isDirectRun } from '../lib/is-direct-run.js';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const slugIdx = args.indexOf('--slug');
const ONE = slugIdx !== -1 ? args[slugIdx + 1] : null;

/** Same keys, same values — the property the split must preserve exactly. */
export function sameMergedView(before, after) {
  const a = JSON.stringify(before, Object.keys(before || {}).sort());
  const b = JSON.stringify(after, Object.keys(before || {}).sort());
  const extra = Object.keys(after || {}).filter((k) => !(k in (before || {})));
  return a === b && extra.length === 0;
}

/** What a single post's split would do. Pure — no I/O. */
export function planSplit(merged) {
  const { meta, state, unclassified } = partitionMetaFields(merged || {});
  return {
    authored: Object.keys(meta).length,
    moved: Object.keys(state).length,
    unclassified,
    noop: Object.keys(state).length === 0,
  };
}

function run() {
  const slugs = ONE ? [ONE] : listAllSlugs();
  const rows = [];
  let moved = 0; let noop = 0; let failed = 0;
  const unclassifiedAll = new Set();

  for (const slug of slugs) {
    const before = getPostMeta(slug);
    if (!before) { rows.push({ slug, status: 'no meta.json' }); continue; }

    const plan = planSplit(before);
    plan.unclassified.forEach((k) => unclassifiedAll.add(k));

    // Already split: meta.json holds no server field and state.json exists.
    const metaOnDisk = JSON.parse(readFileSync(getMetaPath(slug), 'utf8'));
    const alreadySplit = planSplit(metaOnDisk).moved === 0 && existsSync(getStatePath(slug));
    if (alreadySplit) { noop++; rows.push({ slug, status: 'already split' }); continue; }

    if (!APPLY) {
      moved++;
      rows.push({ slug, status: `would move ${plan.moved} field(s), keep ${plan.authored}` });
      continue;
    }

    // Back up the pre-write meta.json so a failed verify can be rolled back.
    const backupDir = join(ROOT, 'data', 'reports', 'post-meta-split');
    mkdirSync(backupDir, { recursive: true });
    const backup = join(backupDir, `${slug}.meta.before.json`);
    writeFileSync(backup, readFileSync(getMetaPath(slug)));

    replacePostMeta(slug, before);

    const after = getPostMeta(slug);
    if (!sameMergedView(before, after)) {
      // Roll back rather than leave a post half-split.
      writeFileSync(getMetaPath(slug), readFileSync(backup));
      failed++;
      rows.push({ slug, status: 'VERIFY FAILED — rolled back from backup' });
      continue;
    }
    moved++;
    rows.push({ slug, status: `moved ${plan.moved} field(s), kept ${plan.authored}` });
  }

  console.log(`\nSplit data/posts/*/meta.json — ${APPLY ? 'APPLY' : 'DRY RUN'}\n`);
  console.log(`  ${slugs.length} post(s) · ${moved} ${APPLY ? 'split' : 'to split'} · ${noop} already split · ${failed} failed`);
  if (unclassifiedAll.size) {
    console.log(`\n  ${unclassifiedAll.size} field(s) FIELD_OWNERS has never classified — they go to state.json:`);
    for (const k of [...unclassifiedAll].sort()) console.log(`     ! ${k}`);
    console.log('  Classify them in lib/post-meta-reconcile.js; DAILY_POST_META_GATE exits 2 on one.');
  }
  if (failed) {
    console.log('\n  FAILED (rolled back):');
    for (const r of rows.filter((x) => x.status.startsWith('VERIFY'))) console.log(`     ${r.slug}`);
  }
  if (!APPLY) console.log('\nNothing was written. Re-run with --apply.');
  else console.log(`\nPre-write backups: data/reports/post-meta-split/`);

  return failed === 0 ? 0 : 1;
}

if (isDirectRun(import.meta.url)) process.exit(run());
