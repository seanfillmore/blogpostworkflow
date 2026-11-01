#!/usr/bin/env node
/**
 * One-off (2026-10-21): remove the 28-day `rewrite` stamps legacy-rebuilder's
 * light refresh wrote on pages whose body it never rewrote.
 *
 * The light refresh called recordMaterialEdit(slug, 'rewrite') unconditionally.
 * Measured from the scheduler log, all 29 light refreshes between 2026-10-05 and
 * 2026-10-20 applied ZERO answer-first rewrites; they only added a buy box,
 * schema and year fixes (enhance/repair, which start no clock). The weekly
 * re-gate then flagged 31 of those pages, and blocked-post-resolver was held off
 * every one by the false stamp. The agent no longer stamps; this clears the
 * stamps it already wrote.
 *
 * Exact by construction: only `last_material_edit.source === 'legacy-rebuilder'`
 * is touched. answer-first-rewriter (the only writer in a light refresh that
 * genuinely rewrites) stamps under its own source, and any later real rewrite
 * by another agent would have replaced the source. Title/meta events from
 * change-diff-detector are a separate clock and are untouched.
 *
 *   node scripts/clear-false-light-refresh-stamps.mjs           # dry run
 *   node scripts/clear-false-light-refresh-stamps.mjs --apply   # write (run on the server)
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listAllSlugs, getPostMeta, writePostMeta } from '../lib/posts.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const apply = process.argv.includes('--apply');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = join(ROOT, 'data', 'reports', 'false-stamp-clear', stamp);

export function isFalseLightRefreshStamp(meta) {
  const e = meta?.last_material_edit;
  return !!e && e.source === 'legacy-rebuilder' && e.kind === 'rewrite';
}

function main() {
  const hits = listAllSlugs()
    .map((slug) => ({ slug, meta: getPostMeta(slug) }))
    .filter(({ meta }) => isFalseLightRefreshStamp(meta));

  console.log(`${hits.length} post(s) carry a legacy-rebuilder rewrite stamp${apply ? '' : ' (dry run)'}:`);
  for (const { slug, meta } of hits) console.log(`  · ${slug} — stamped ${meta.last_material_edit.at}`);
  if (!apply || !hits.length) return;

  mkdirSync(backupDir, { recursive: true });
  for (const { slug, meta } of hits) {
    const statePath = join(ROOT, 'data', 'posts', slug, 'state.json');
    if (existsSync(statePath)) copyFileSync(statePath, join(backupDir, `${slug}.state.json`));
    writePostMeta(slug, { last_material_edit: undefined });
    if (isFalseLightRefreshStamp(getPostMeta(slug))) throw new Error(`stamp survived the write on ${slug}`);
  }
  console.log(`Cleared ${hits.length}. Backups: ${backupDir}`);
}

main();
