#!/usr/bin/env node
/**
 * Re-home the paid refreshes stranded in orphan post directories, then archive
 * the directories. DRY BY DEFAULT.
 *
 * The content-refresher slug-mismatch fixed in PR #679 wrote its output to
 * `data/posts/<shopify handle>/` when the post already lived under a shorter
 * local slug, creating a SECOND directory holding a paid `content-refreshed.html`
 * and an editor report and nothing else. 34 on production, 31 with a refresh.
 * The fix stops new ones; this clears the backlog.
 *
 * TWO RULES, both from things that have already cost real work here:
 *
 *   NOTHING IS DELETED. An orphan directory is MOVED to data/posts/_orphaned/
 *   with a sidecar recording where it came from and what was decided — the same
 *   rule lib/brief-archive.js enforces after --drop-non-earning permanently
 *   destroyed three paid-for briefs on 2026-08-19.
 *
 *   A RE-HOMED REFRESH IS NEVER NAMED content-refreshed.html. That name is
 *   consumed: agents/refresh-runner moves it over content.html and PUBLISHES it
 *   once the editor gate passes. These refreshes are one to four months old and
 *   were generated against article bodies that have since changed, so the
 *   consumed name would queue stale content for publication over live ranking
 *   pages. It is written as orphaned-refresh-<date>.html, which nothing reads —
 *   verified: no reader globs *.html inside a post directory, they all use the
 *   exact name through getRefreshedPath.
 *
 * Usage:
 *   node scripts/rehome-orphan-refreshes.mjs            # report only
 *   node scripts/rehome-orphan-refreshes.mjs --apply    # move files
 */
// No unlinkSync, deliberately — see the "nothing is deleted" rule above. A test
// pins its absence, because the cheapest way for this script to become the thing
// it exists to prevent is somebody reaching for a delete to tidy up.
import { readdirSync, statSync, existsSync, mkdirSync, renameSync, copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePostSlug, getPostMeta, getRefreshedPath, POSTS_DIR, ROOT } from '../lib/posts.js';
import { decideOrphan, rehomedName, ORPHAN_DIR } from '../lib/orphan-refresh.js';

const APPLY = process.argv.includes('--apply');
const REFRESH = 'content-refreshed.html';

function orphanSlugs() {
  return readdirSync(POSTS_DIR).filter((s) => {
    if (s.startsWith('_') || s.startsWith('.')) return false;
    const d = join(POSTS_DIR, s);
    try { return statSync(d).isDirectory() && !existsSync(join(d, 'meta.json')); } catch { return false; }
  }).sort();
}

function plan() {
  return orphanSlugs().map((slug) => {
    const dir = join(POSTS_DIR, slug);
    const refresh = join(dir, REFRESH);
    const hasRefresh = existsSync(refresh);
    const target = resolvePostSlug(slug);
    const targetMeta = target && target !== slug ? getPostMeta(target) : null;
    const decision = decideOrphan({
      slug,
      hasRefresh,
      target: target === slug ? slug : target,
      targetIsLive: Boolean(targetMeta?.shopify_article_id),
      targetHasRefresh: Boolean(target && target !== slug && existsSync(getRefreshedPath(target))),
    });
    const mtime = hasRefresh ? statSync(refresh).mtime.toISOString() : null;
    return { slug, dir, refresh, hasRefresh, target, mtime, ...decision };
  });
}

function main() {
  const rows = plan();
  const rehome = rows.filter((r) => r.action === 'rehome');
  const archive = rows.filter((r) => r.action === 'archive');

  console.log(`\nOrphan post directories — ${APPLY ? 'APPLY' : 'DRY RUN'}\n`);
  console.log(`  ${rows.length} orphan(s) · ${rehome.length} refresh(es) to re-home · ${archive.length} to archive as-is\n`);

  if (rehome.length) {
    console.log(`RE-HOME — the paid refresh moves next to its real post, under an INERT name`);
    console.log(`          (never ${REFRESH}, which agents/refresh-runner publishes):\n`);
    for (const r of rehome) {
      console.log(`  ${r.slug}`);
      console.log(`      → data/posts/${r.target}/${rehomedName(r.mtime)}`);
    }
    console.log('');
  }
  if (archive.length) {
    console.log('ARCHIVE ONLY — nothing carried across, and nothing deleted:\n');
    for (const r of archive) console.log(`  ${r.slug}\n      ${r.reason}`);
    console.log('');
  }

  if (!APPLY) {
    console.log('Nothing was moved. Re-run with --apply.');
    console.log(`Every directory ends up under data/posts/${ORPHAN_DIR}/ with a .orphan.json sidecar.`);
    return;
  }

  const arcRoot = join(POSTS_DIR, ORPHAN_DIR);
  mkdirSync(arcRoot, { recursive: true });
  let moved = 0;
  let archived = 0;

  for (const r of rows) {
    if (r.action === 'rehome') {
      const destDir = join(POSTS_DIR, r.target);
      const dest = join(destDir, rehomedName(r.mtime));
      if (existsSync(dest)) {
        console.log(`  ⊘ ${r.target}/${rehomedName(r.mtime)} already exists — left alone`);
      } else {
        // Copy, then archive the whole directory (original included). The refresh
        // exists in two places for a moment rather than none.
        copyFileSync(r.refresh, dest);
        moved += 1;
        console.log(`  ✓ ${r.slug} → ${r.target}/${rehomedName(r.mtime)}`);
      }
    }

    const dest = join(arcRoot, r.slug);
    if (existsSync(dest)) {
      console.log(`  ⊘ ${ORPHAN_DIR}/${r.slug} already archived — left in place`);
      continue;
    }
    renameSync(r.dir, dest);
    writeFileSync(join(arcRoot, `${r.slug}.orphan.json`), `${JSON.stringify({
      slug: r.slug,
      archived_at: new Date().toISOString(),
      archived_by: 'scripts/rehome-orphan-refreshes.mjs',
      action: r.action,
      reason: r.reason,
      resolved_target: r.target,
      refresh_mtime: r.mtime,
      rehomed_to: r.action === 'rehome' ? `data/posts/${r.target}/${rehomedName(r.mtime)}` : null,
      cause: 'content-refresher slug mismatch, fixed in PR #679 — the agent wrote to data/posts/<shopify handle>/ instead of the existing local slug directory',
      restore: `mv data/posts/${ORPHAN_DIR}/${r.slug} data/posts/${r.slug}`,
    }, null, 2)}\n`);
    archived += 1;
  }

  console.log(`\n  ${moved} refresh(es) re-homed · ${archived} directory(ies) archived · 0 deleted.`);
  console.log(`  A re-homed file is INERT — nothing reads data/posts/<slug>/orphaned-refresh-*.html.`);
  console.log(`  Restore any directory with the command in its .orphan.json sidecar.`);
}

main();
