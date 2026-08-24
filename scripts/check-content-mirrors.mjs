#!/usr/bin/env node
/**
 * Does every local `data/posts/<slug>/content.html` still describe the article
 * that is actually live?
 *
 * `agents/publisher` republishes `body_html` FROM that file, so a local mirror
 * that has drifted is a queued overwrite of a live page. `agents/publisher` now
 * refuses the worst case at the moment of publishing (see lib/content-mirror.js).
 * This is the same question asked over the WHOLE corpus, on demand, before a
 * publish is in flight — the split `scripts/check-post-meta-drift.mjs` already
 * draws against `scripts/reconcile-post-metas.mjs`.
 *
 * READ-ONLY against Shopify. It issues GETs and nothing else; there is no code
 * path in this file that mutates a live article, and none that writes
 * `content.html`.
 *
 *   node scripts/check-content-mirrors.mjs                  # report, writes nothing
 *   node scripts/check-content-mirrors.mjs --json           # same, machine-readable
 *   node scripts/check-content-mirrors.mjs --slug <slug>    # one post
 *   node scripts/check-content-mirrors.mjs --snapshot-live           # DRY: what it would capture
 *   node scripts/check-content-mirrors.mjs --snapshot-live --apply   # capture live bodies to disk
 *
 * WHY THERE IS NO RESYNC MODE, AND WHY THAT IS THE FIX
 * ───────────────────────────────────────────────────
 * A blanket resync from live is not obviously right, and on inspection it is
 * not right at all: `content.html` is also the INPUT to legitimate work.
 * `agents/refresh-runner` writes a refreshed draft over it and then publishes,
 * so a file that is "ahead" of live is a normal, correct state for the minutes
 * between those two steps. Overwriting from live there destroys a paid LLM
 * rewrite.
 *
 * Distinguishing "stale because live moved on" from "ahead because somebody is
 * drafting" cannot be done reliably from the evidence available — see the
 * README-length note in lib/content-mirror.js. So this tool refuses to destroy
 * either side. What it CAN do without guessing is put the live body somewhere a
 * human can read it, which is what `--snapshot-live --apply` does.
 *
 * `--snapshot-live` writes to `data/reports/content-mirror/`, never into
 * `data/posts/<slug>/`. Everything under a post directory is a pipeline input:
 * dropping a live body in there is exactly the accidental resync this tool
 * exists to prevent, one filename typo away.
 *
 * Exit codes (the same vocabulary as scripts/check-post-meta-drift.mjs):
 *   0  every mirror is identical, cosmetic, or an ordinary edit apart
 *   1  at least one mirror has DIVERGED far enough to warn on
 *   2  at least one local file is a DIFFERENT ARTICLE from what is live
 *   3  a local post could not be read at all
 *  64  an argument this script refuses (see below)
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getBlogs, getArticles } from '../lib/shopify.js';
import { compareBodies, DIFFERENT_ARTICLE_MAX, DIVERGENT_WARN_MAX } from '../lib/content-mirror.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const POSTS_DIR = join(ROOT, 'data', 'posts');
const REPORT_DIR = join(ROOT, 'data', 'reports', 'content-mirror');

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const snapshot = args.includes('--snapshot-live');
const apply = args.includes('--apply');
const onlySlug = (() => {
  const i = args.indexOf('--slug');
  return i !== -1 ? args[i + 1] : null;
})();

// `--apply` is meaningless without `--snapshot-live`, and a reader who types it
// alone is asking for the resync this script does not have. Say so, loudly,
// rather than running a report and letting them believe something was applied.
if (apply && !snapshot) {
  console.error('check-content-mirrors: --apply only applies to --snapshot-live.');
  console.error('There is NO resync mode. This script never writes data/posts/<slug>/content.html');
  console.error('in either direction — see the header for why guessing is worse than refusing.');
  process.exit(64);
}

// ── local corpus ─────────────────────────────────────────────────────────────

function localSlugs() {
  if (!existsSync(POSTS_DIR)) return [];
  return readdirSync(POSTS_DIR)
    .filter((n) => {
      try { return statSync(join(POSTS_DIR, n)).isDirectory() && existsSync(join(POSTS_DIR, n, 'meta.json')); }
      catch { return false; }
    })
    .sort();
}

// ── the run ──────────────────────────────────────────────────────────────────

const blogs = await getBlogs();
const liveById = new Map();
for (const b of blogs) {
  // published_status=any: a DRAFT article is still an article this mirror can
  // overwrite, and three of the divergent posts measured are drafts.
  for (const a of await getArticles(b.id, { published_status: 'any' })) {
    liveById.set(String(a.id), { ...a, blog_id: b.id, blog_handle: b.handle });
  }
}

const rows = [];
for (const slug of localSlugs()) {
  if (onlySlug && slug !== onlySlug) continue;

  let meta;
  try { meta = JSON.parse(readFileSync(join(POSTS_DIR, slug, 'meta.json'), 'utf8')); }
  catch (err) { rows.push({ slug, state: 'meta-unreadable', detail: err.message }); continue; }

  if (!meta.shopify_article_id) { rows.push({ slug, state: 'no-article-id' }); continue; }

  const live = liveById.get(String(meta.shopify_article_id));
  if (!live) { rows.push({ slug, state: 'article-not-on-shopify', articleId: meta.shopify_article_id }); continue; }

  const contentPath = join(POSTS_DIR, slug, 'content.html');
  if (!existsSync(contentPath)) { rows.push({ slug, state: 'no-local-content', articleId: live.id }); continue; }

  let localHtml;
  try { localHtml = readFileSync(contentPath, 'utf8'); }
  catch (err) { rows.push({ slug, state: 'local-unreadable', detail: err.message }); continue; }

  const c = compareBodies(localHtml, live.body_html || '');
  rows.push({
    slug,
    state: 'compared',
    articleId: live.id,
    blogId: live.blog_id,
    handle: live.handle,
    published: !!live.published_at,
    liveUpdatedAt: live.updated_at,
    ...c,
  });
}

const compared = rows.filter((r) => r.state === 'compared');
const tally = (t) => compared.filter((r) => r.tier === t).length;
const warnable = compared.filter((r) => r.tier === 'divergent' && r.blockSimilarity < DIVERGENT_WARN_MAX);
const differentArticle = compared.filter((r) => r.tier === 'different-article');
const unreadable = rows.filter((r) => r.state === 'meta-unreadable' || r.state === 'local-unreadable');

const summary = {
  generated_at: new Date().toISOString(),
  posts_scanned: rows.length,
  compared: compared.length,
  identical: tally('identical'),
  cosmetic: tally('cosmetic'),
  divergent: tally('divergent'),
  divergent_deep: warnable.length,
  different_article: differentArticle.length,
  no_article_id: rows.filter((r) => r.state === 'no-article-id').length,
  article_not_on_shopify: rows.filter((r) => r.state === 'article-not-on-shopify').length,
  no_local_content: rows.filter((r) => r.state === 'no-local-content').length,
  unreadable: unreadable.length,
  thresholds: { different_article_max: DIFFERENT_ARTICLE_MAX, divergent_warn_max: DIVERGENT_WARN_MAX },
};

// ── snapshot (the one thing --apply writes) ──────────────────────────────────
//
// Additive by construction: it creates a NEW file in a report directory and
// touches neither the local mirror nor Shopify. Idempotent — a second run over
// unchanged live bodies rewrites byte-identical files. Atomic — every file is
// written to `<name>.tmp` and renamed into place, so a crash mid-run leaves the
// previous snapshot intact rather than a half-written body somebody diffs
// against and believes.

let snapshotDir = null;
if (snapshot) {
  const targets = compared.filter((r) => r.tier === 'divergent' || r.tier === 'different-article');
  snapshotDir = join(REPORT_DIR, 'live-bodies');
  if (!apply) {
    console.log(`\n[dry] would capture ${targets.length} live body/bodies to ${snapshotDir}`);
    console.log('[dry] nothing was written. Re-run with --apply.\n');
  } else {
    mkdirSync(snapshotDir, { recursive: true });
    let written = 0;
    for (const r of targets) {
      const dest = join(snapshotDir, `${r.slug}.live.html`);
      const body = liveById.get(String(r.articleId)).body_html || '';
      // Back up an existing snapshot before replacing it — an earlier capture is
      // the only record of what live looked like at that time.
      if (existsSync(dest) && readFileSync(dest, 'utf8') !== body) {
        copyFileSync(dest, `${dest}.prev`);
      }
      const tmp = `${dest}.tmp`;
      writeFileSync(tmp, body);
      renameSync(tmp, dest);
      written++;
    }
    console.log(`\nCaptured ${written} live body/bodies → ${snapshotDir}`);
    console.log('These are for READING. Nothing copies them into data/posts/<slug>/content.html.\n');
  }
}

// ── output ───────────────────────────────────────────────────────────────────

if (asJson) {
  console.log(JSON.stringify({ summary, rows, snapshot_dir: snapshotDir }, null, 2));
} else {
  const L = [];
  L.push('');
  L.push('data/posts/*/content.html vs live Shopify body_html — READ-ONLY');
  L.push('');
  L.push(`  ${summary.posts_scanned} local post(s) · ${summary.compared} comparable`);
  L.push(`  identical ${summary.identical} · cosmetic ${summary.cosmetic} · divergent ${summary.divergent} · DIFFERENT ARTICLE ${summary.different_article}`);
  L.push(`  not comparable: ${summary.no_article_id} without an article id, ${summary.article_not_on_shopify} whose article is not on Shopify, ${summary.no_local_content} without a local content.html`);
  L.push('');

  const fmt = (r) => [
    r.blockSimilarity.toFixed(3).padStart(5),
    `${r.sharedBlocks}/${r.localBlocks}→${r.liveBlocks}`.padStart(12),
    `-${r.liveOnlyBlocks}`.padStart(5),
    r.direction.padEnd(14),
    r.published ? 'live ' : 'DRAFT',
    r.slug,
  ].join('  ');

  if (differentArticle.length) {
    L.push(`DIFFERENT ARTICLE — republishing any of these replaces the live page (${differentArticle.length}):`);
    L.push('  sim         shared/l→v  lost  direction        state  slug');
    for (const r of [...differentArticle].sort((a, b) => a.blockSimilarity - b.blockSimilarity)) L.push('  ' + fmt(r));
    L.push('');
  }
  if (warnable.length) {
    L.push(`DEEP DIVERGENCE — allowed, but a republish drops a large slice of the live page (${warnable.length}):`);
    for (const r of [...warnable].sort((a, b) => a.blockSimilarity - b.blockSimilarity)) L.push('  ' + fmt(r));
    L.push('');
  }
  if (unreadable.length) {
    L.push('UNREADABLE:');
    for (const r of unreadable) L.push(`  ${r.slug}: ${r.state} — ${r.detail}`);
    L.push('');
  }

  L.push('Nothing was resynced, in either direction. `agents/publisher` refuses a');
  L.push('DIFFERENT ARTICLE republish at the point of publishing; use');
  L.push('--snapshot-live --apply to read the live bodies side by side.');
  L.push('');
  console.log(L.join('\n'));
}

process.exitCode = unreadable.length ? 3
  : differentArticle.length ? 2
    : warnable.length ? 1
      : 0;
