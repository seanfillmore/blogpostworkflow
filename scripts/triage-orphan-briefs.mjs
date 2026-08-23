#!/usr/bin/env node
/**
 * Triage orphaned content briefs.
 *
 * An "orphan" is a brief in data/briefs/ with no post written for it. They
 * accumulated because content-strategist listed briefs under "already published
 * or briefed — DO NOT include these", so generating a brief permanently removed
 * the topic from every future calendar: never scheduled, never written, research
 * paid for and thrown away. 73 had piled up by 2026-08-18.
 *
 * The cause is fixed (lib/brief-triage.js splitInventory), so surviving orphans
 * flow back onto the calendar. This clears the ones that should NOT: keywords
 * that are rejected, branded, out of product scope, or already covered by a
 * published post. Same gates a fresh proposal would face — an orphan survives
 * only if it would be proposed today.
 *
 * DROPPING IS NOT DELETING — read lib/brief-archive.js for why.
 * A dropped brief MOVES to data/briefs/_dropped/ with a record of when, why, on
 * what cluster evidence, and by which run. It used to be `unlinkSync`, and on
 * 2026-08-19 a wrong `soap` cluster verdict destroyed three paid-for briefs
 * that way: vegan-soap, oatmeal-soap and coconut-oil-soap-benefits. Absent from
 * the server, both checkouts and git. Unrecoverable. The next wrong verdict
 * costs a `--restore` instead.
 *
 * Usage:
 *   node scripts/triage-orphan-briefs.mjs                       # dry run, report only
 *   node scripts/triage-orphan-briefs.mjs --apply               # archive the drops
 *   node scripts/triage-orphan-briefs.mjs --drop-non-earning --apply
 *   node scripts/triage-orphan-briefs.mjs --list-dropped        # what is archived
 *   node scripts/triage-orphan-briefs.mjs --restore <slug>...   # bring briefs back
 *   node scripts/triage-orphan-briefs.mjs --restore --all [--force]
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { triageOrphanBrief } from '../lib/brief-triage.js';
import { listAllSlugs, getPostMeta, getContentPath } from '../lib/posts.js';
import { isInProductScope } from '../lib/product-scope.js';
import { loadClusterHold, corroboratedClassification, holdBanner } from '../lib/cluster-hold.js';
import { staleNote } from '../lib/seo-impact-freshness.js';
import { notify } from '../lib/notify.js';
import {
  DROPPED_DIRNAME, RESTORE_COMMAND, archiveBriefs, listDropped, restoreDropped,
  droppedSizeBytes, newRunId, renderDropDigest,
} from '../lib/brief-archive.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BRIEFS_DIR = join(ROOT, 'data', 'briefs');
const ARGV = process.argv.slice(2);
const APPLY = ARGV.includes('--apply');
// Off by default: it takes work out of circulation in bulk on a cluster
// judgement, so it is opt-in.
const DROP_NON_EARNING = ARGV.includes('--drop-non-earning');
const RESTORE = ARGV.includes('--restore');
const LIST_DROPPED = ARGV.includes('--list-dropped');
const ALL = ARGV.includes('--all');
const FORCE = ARGV.includes('--force');
const RUN_ID = newRunId();

function readJson(p, fallback) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; }
}

// ── recovery paths — these run instead of a triage, and touch no verdict ──────

if (LIST_DROPPED) {
  const dropped = listDropped({ root: ROOT });
  console.log(`\ndata/briefs/${DROPPED_DIRNAME}/ — ${dropped.length} archived brief(s), `
    + `${(droppedSizeBytes({ root: ROOT }) / 1024).toFixed(1)} KB\n`);
  for (const d of dropped) {
    const r = d.record || {};
    console.log(`  ${d.file}`);
    console.log(`      "${r.keyword || d.slug}" — ${r.reason || 'no reason recorded'}`);
    console.log(`      dropped ${r.dropped_at || 'at an unrecorded time'} by ${r.dropped_by || 'an unrecorded run'}`);
    if (r.cluster_verdict) {
      const v = r.cluster_verdict;
      console.log(`      cluster "${r.cluster}": ${v.status}, $${Number(v.revenue || 0).toFixed(2)} on ${v.clicks} clicks / ${v.pages} pages`);
      if (v.evidence) console.log(`      evidence: ${v.evidence}`);
    }
    console.log(`      restore: ${RESTORE_COMMAND} ${d.slug}\n`);
  }
  if (!dropped.length) console.log('  (nothing archived)\n');
  process.exit(0);
}

if (RESTORE) {
  const slugs = ARGV.filter((a) => !a.startsWith('--'));
  if (!ALL && !slugs.length) {
    console.error(`--restore needs a slug, or --all. See \`--list-dropped\` for what is in ${DROPPED_DIRNAME}/.`);
    process.exit(1);
  }
  const res = restoreDropped({ root: ROOT, slugs, all: ALL, force: FORCE, runId: RUN_ID });
  for (const r of res.restored) console.log(`  ✓ restored ${r.slug} → data/briefs/${r.slug}.json`);
  for (const s of res.skipped) console.error(`  ✗ ${s.slug}: ${s.reason}`);
  console.log(`\nRestored ${res.restored.length}, skipped ${res.skipped.length}.`);

  if (res.restored.length) {
    const { subject, body, status } = renderDropDigest({
      dropped: [], kept: 0, restored: res.restored, sizeBytes: droppedSizeBytes({ root: ROOT }), runId: RUN_ID,
    });
    await notify({ subject, body, status, category: 'pipeline' });
  }
  process.exit(res.skipped.length ? 1 : 0);
}

// ── context: what already exists, what we refuse to write ────────────────────

const publishedKeywords = [];
const writtenSlugs = new Set();
for (const slug of listAllSlugs()) {
  let meta = null;
  try { meta = getPostMeta(slug); } catch { /* skip */ }
  if (!existsSync(getContentPath(slug)) && !meta?.shopify_article_id) continue;
  writtenSlugs.add(slug);
  if (meta?.target_keyword) publishedKeywords.push(meta.target_keyword);
}

const rejectedKeywords = (readJson(join(ROOT, 'data', 'rejected-keywords.json'), []) || [])
  .map((r) => r.keyword).filter(Boolean);
const brandTerms = (readJson(join(ROOT, 'config', 'site.json'), {}).brand_terms || []);

// This flag takes paid-for research out of circulation in bulk, so it is the
// most evidence-hungry consumer of the cluster verdict, not the least. It reads
// the CORROBORATED classification: a $0 that real Shopify orders contradict is a
// broken-attribution finding, and on 2026-08-22 acting on one unchecked would
// have dropped every brief in a category earning 19% of all revenue.
// A STALE report is refused exactly like an absent one — `loadClusterHold`
// reports both as `available: false`, so this exit is the fail-safe for both.
// Nothing here may act on a measurement nobody has refreshed.
//
// That refusal (PR #627) is the UPSTREAM guard. The archive below is the
// DOWNSTREAM one, and it is not redundant with this: on 2026-08-19 the report
// was perfectly fresh and simply wrong, so this check would not have fired.
let clusterRevenue = null;
let reportContext = null;
if (DROP_NON_EARNING) {
  const hold = loadClusterHold({ root: ROOT });
  if (!hold.available) {
    console.error(hold.stale
      ? `--drop-non-earning refused: ${staleNote(hold.freshness)} Acting on a report this old is not the bar for dropping paid-for work.`
      : '--drop-non-earning needs data/reports/seo-impact/latest.json. Run agents/seo-impact first.');
    process.exit(1);
  }
  const banner = holdBanner(hold);
  if (banner) console.log(banner);
  clusterRevenue = corroboratedClassification(hold);
  // Stamped into every drop record, so a restore decision can start from the
  // measurement that condemned the brief rather than from today's.
  reportContext = { source: hold.source, generated_at: hold.generatedAt, freshness: hold.freshness || null };
}

// ── walk the orphans ─────────────────────────────────────────────────────────

// withFileTypes so `_dropped/` is skipped as a directory as well as by the
// `.json` filter. Either alone would do it; both, because re-reading an
// archived brief would undo the whole point of archiving it.
const briefFiles = existsSync(BRIEFS_DIR)
  ? readdirSync(BRIEFS_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => e.name)
  : [];

const keep = [];
const drop = [];

for (const file of briefFiles) {
  const slug = basename(file, '.json');
  if (writtenSlugs.has(slug)) continue;             // not an orphan — post exists

  const path = join(BRIEFS_DIR, file);
  const brief = readJson(path, null);
  if (!brief) {
    drop.push({ slug, path, keyword: '(unreadable)', reason: 'brief JSON will not parse' });
    continue;
  }

  const keyword = brief.target_keyword || brief.keyword || slug.replace(/-/g, ' ');
  const verdict = triageOrphanBrief(keyword, {
    publishedKeywords, rejectedKeywords, brandTerms, inScope: isInProductScope, clusterRevenue,
  });
  const row = {
    slug, path, keyword, reason: verdict.reason,
    cluster: verdict.cluster, clusterStats: verdict.clusterStats,
  };
  (verdict.keep ? keep : drop).push(row);
}

// ── report ───────────────────────────────────────────────────────────────────

console.log(`\nOrphaned briefs (no post written): ${keep.length + drop.length} of ${briefFiles.length} total\n`);

console.log(`DROP — ${drop.length}:`);
for (const d of drop) console.log(`  ${d.slug}\n      "${d.keyword}" — ${d.reason}`);

console.log(`\nKEEP — ${keep.length} (these go back on the calendar and get written):`);
for (const k of keep) console.log(`  ${k.slug}  "${k.keyword}"`);

if (!APPLY) {
  console.log(`\nDry run. Re-run with --apply to move the ${drop.length} drop(s) to data/briefs/${DROPPED_DIRNAME}/.`);
  console.log('Nothing is deleted — a dropped brief can be brought back with --restore <slug>.');
  if (!DROP_NON_EARNING) {
    console.log('Add --drop-non-earning to also drop briefs in clusters that have proven they do not earn.');
  }
  process.exit(0);
}

const { archived, failed, sizeBytes } = archiveBriefs({
  root: ROOT, drops: drop, runId: RUN_ID, report: reportContext,
});
for (const f of failed) console.error(`  ✗ ${f.slug}: ${f.error} (left in place)`);

console.log(`\nMoved ${archived.length} orphaned brief(s) to data/briefs/${DROPPED_DIRNAME}/. ${keep.length} kept.`);
if (archived.length) {
  console.log(`Nothing was deleted. Restore any of them with:  ${RESTORE_COMMAND} <slug>`);
}

// The 2026-08-19 run dropped three briefs and said nothing anywhere — this
// script had no `notify` import at all, so the 5 AM digest could not have
// mentioned it even in principle, and the loss was found days later by reading
// calendar-runner's log. Deferred per CLAUDE.md: this is a recoverable event
// now, so it does not warrant `immediate: true`.
if (archived.length || failed.length) {
  const { subject, body, status } = renderDropDigest({
    dropped: archived, kept: keep.length, failed, sizeBytes, runId: RUN_ID,
  });
  await notify({ subject, body, status, category: 'pipeline' });
}

process.exit(failed.length ? 1 : 0);
