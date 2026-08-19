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
 * Usage:
 *   node scripts/triage-orphan-briefs.mjs            # dry run, report only
 *   node scripts/triage-orphan-briefs.mjs --apply    # delete the drops
 */

import { readFileSync, readdirSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { triageOrphanBrief } from '../lib/brief-triage.js';
import { listAllSlugs, getPostMeta, getContentPath } from '../lib/posts.js';
import { isInProductScope } from '../lib/product-scope.js';
import { classifyClusters } from '../lib/cluster-revenue.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BRIEFS_DIR = join(ROOT, 'data', 'briefs');
const APPLY = process.argv.includes('--apply');
// Off by default: it deletes work in bulk on a cluster judgement, so it is opt-in.
const DROP_NON_EARNING = process.argv.includes('--drop-non-earning');

function readJson(p, fallback) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; }
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

const clusterRevenue = DROP_NON_EARNING
  ? classifyClusters(readJson(join(ROOT, 'data', 'reports', 'seo-impact', 'latest.json'), {}).clusters)
  : null;
if (DROP_NON_EARNING && !clusterRevenue) {
  console.error('--drop-non-earning needs data/reports/seo-impact/latest.json. Run agents/seo-impact first.');
  process.exit(1);
}

// ── walk the orphans ─────────────────────────────────────────────────────────

const briefFiles = existsSync(BRIEFS_DIR)
  ? readdirSync(BRIEFS_DIR).filter((f) => f.endsWith('.json'))
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
  (verdict.keep ? keep : drop).push({ slug, path, keyword, reason: verdict.reason });
}

// ── report ───────────────────────────────────────────────────────────────────

console.log(`\nOrphaned briefs (no post written): ${keep.length + drop.length} of ${briefFiles.length} total\n`);

console.log(`DROP — ${drop.length}:`);
for (const d of drop) console.log(`  ${d.slug}\n      "${d.keyword}" — ${d.reason}`);

console.log(`\nKEEP — ${keep.length} (these go back on the calendar and get written):`);
for (const k of keep) console.log(`  ${k.slug}  "${k.keyword}"`);

if (!APPLY) {
  console.log(`\nDry run. Re-run with --apply to delete the ${drop.length} drop(s).`);
  if (!DROP_NON_EARNING) {
    console.log('Add --drop-non-earning to also drop briefs in clusters that have proven they do not earn.');
  }
  process.exit(0);
}

let deleted = 0;
for (const d of drop) {
  try { unlinkSync(d.path); deleted++; }
  catch (e) { console.error(`  ✗ ${d.slug}: ${e.message}`); }
}
console.log(`\nDeleted ${deleted} orphaned brief(s). ${keep.length} kept.`);
