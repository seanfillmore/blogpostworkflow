#!/usr/bin/env node
/**
 * Refresh Runner Agent
 *
 * Orchestrates the refresh sub-pipeline for an existing published post:
 *
 *   content-refresher --slug <slug>   (rewrites weak sections in place)
 *   editor data/posts/<slug>.html     (validates the refreshed HTML)
 *   publisher data/posts/<slug>.json  (updates the existing Shopify article)
 *
 * Trigger sources:
 *   1. Manual:     node agents/refresh-runner/index.js <slug>
 *   2. Auto-flop:  --from-post-performance     (refresh every REFRESH-verdict
 *                                                  flop in latest.json)
 *   3. Auto-quick: --from-quick-wins           (refresh top N quick-win
 *                                                  candidates from latest.json)
 *   4. Aging:      --aging-quarterly           (refresh any post >180 days old
 *                                                  with traffic; skip if refreshed
 *                                                  in the last 90 days)
 *
 * Skips publishing automatically — refreshed posts go through the editor and
 * are presented for human review before re-publish. Pass --publish to push
 * the update to Shopify in the same run.
 *
 * Usage:
 *   node agents/refresh-runner/index.js best-natural-deodorant-for-women
 *   node agents/refresh-runner/index.js --from-post-performance
 *   node agents/refresh-runner/index.js --from-quick-wins --limit 2
 *   node agents/refresh-runner/index.js --aging-quarterly
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const POSTS_DIR = join(ROOT, 'data', 'posts');

const args = process.argv.slice(2);
const FLAG_PUBLISH = args.includes('--publish');
const FLAG_PP = args.includes('--from-post-performance');
const FLAG_QW = args.includes('--from-quick-wins');
const FLAG_AGING = args.includes('--aging-quarterly');
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : 3;
const SLUG_ARG = args.find((a) => !a.startsWith('--') && a !== String(LIMIT));

const REFRESH_COOLDOWN_DAYS = 90;
const AGING_THRESHOLD_DAYS = 180;

function loadJSON(path, fallback) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

function listPublishedPosts() {
  if (!existsSync(POSTS_DIR)) return [];
  return readdirSync(POSTS_DIR).filter((f) => f.endsWith('.json')).map((f) => {
    try {
      const meta = JSON.parse(readFileSync(join(POSTS_DIR, f), 'utf8'));
      return meta.shopify_status === 'published' ? meta : null;
    } catch { return null; }
  }).filter(Boolean);
}

function ageInDays(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.floor((Date.now() - t) / 86400000);
}

function gatherSlugs() {
  // Manual single slug wins.
  if (SLUG_ARG) return [SLUG_ARG];

  const slugs = new Set();

  if (FLAG_PP) {
    const pp = loadJSON(join(ROOT, 'data', 'reports', 'post-performance', 'latest.json'), null);
    for (const f of (pp?.action_required || [])) {
      if (f.verdict === 'REFRESH' || f.verdict === 'BLOCKED') slugs.add(f.slug);
    }
  }

  if (FLAG_QW) {
    const qw = loadJSON(join(ROOT, 'data', 'reports', 'quick-wins', 'latest.json'), null);
    for (const c of (qw?.top || []).slice(0, LIMIT)) slugs.add(c.slug);
  }

  if (FLAG_AGING) {
    for (const meta of listPublishedPosts()) {
      const age = ageInDays(meta.published_at);
      if (age == null || age < AGING_THRESHOLD_DAYS) continue;
      // Skip if refreshed within cooldown
      const lastRefresh = ageInDays(meta.last_refreshed_at);
      if (lastRefresh != null && lastRefresh < REFRESH_COOLDOWN_DAYS) continue;
      // Only refresh posts that are actually getting traffic
      const recent = meta.performance_review?.['90d'] || meta.performance_review?.['60d'];
      if (recent && recent.clicks > 0) slugs.add(meta.slug);
    }
  }

  return [...slugs].slice(0, LIMIT);
}

function run(cmd, label) {
  console.log(`\n  → ${label}`);
  console.log(`    $ ${cmd}`);
  execSync(cmd, { cwd: ROOT, stdio: 'inherit' });
}

function refreshOne(slug) {
  const metaPath = join(POSTS_DIR, `${slug}.json`);
  if (!existsSync(metaPath)) {
    console.error(`  [skip] ${slug}: no post metadata at ${metaPath}`);
    return { slug, ok: false, reason: 'no metadata' };
  }

  // Suppress refresh for non-indexed posts — refreshing a page Google hasn't
  // indexed is wasted effort. Fix indexing first, then rewrite if needed.
  // See docs/signal-manifest.md (indexing-checker → refresh-runner loop).
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    const idx = meta.indexing_state;
    if (idx && idx.state && idx.state !== 'indexed') {
      console.log(`  [skip] ${slug}: indexing state is "${idx.state}" — run indexing-fixer first, not refresh`);
      return { slug, ok: false, reason: `indexing state ${idx.state}, refresh suppressed` };
    }
  } catch { /* fall through */ }

  console.log(`\n══ Refreshing: ${slug} ══`);

  try {
    run(`node agents/content-refresher/index.js --slug "${slug}"`, 'content-refresher');
  } catch (e) {
    return { slug, ok: false, reason: `content-refresher failed: ${e.message}` };
  }

  // The content-refresher writes data/posts/<slug>-refreshed.html. Move that
  // back over the canonical HTML so editor + publisher pick it up.
  const refreshedHtml = join(POSTS_DIR, `${slug}-refreshed.html`);
  const canonicalHtml = join(POSTS_DIR, `${slug}.html`);
  if (existsSync(refreshedHtml)) {
    // Backup the original alongside the refresh for safety.
    if (existsSync(canonicalHtml)) {
      const backup = join(POSTS_DIR, `${slug}.backup-${Date.now()}.html`);
      writeFileSync(backup, readFileSync(canonicalHtml));
    }
    writeFileSync(canonicalHtml, readFileSync(refreshedHtml));
  }

  try {
    run(`node agents/editor/index.js "${canonicalHtml}"`, 'editor');
  } catch (e) {
    return { slug, ok: false, reason: `editor failed: ${e.message}` };
  }

  // Stamp last_refreshed_at on the metadata
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    meta.last_refreshed_at = new Date().toISOString();
    writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  } catch { /* ignore */ }

  if (FLAG_PUBLISH) {
    try {
      run(`node agents/publisher/index.js "${metaPath}"`, 'publisher');
    } catch (e) {
      return { slug, ok: false, reason: `publisher failed: ${e.message}` };
    }
  } else {
    console.log(`\n  Refreshed HTML ready for review: ${canonicalHtml}`);
    console.log(`  To publish: node agents/publisher/index.js ${metaPath}`);
  }

  return { slug, ok: true };
}

async function main() {
  console.log('\nRefresh Runner\n');

  const slugs = gatherSlugs();
  if (!slugs.length) {
    console.log('  No slugs to refresh. Provide a slug argument or use --from-post-performance / --from-quick-wins / --aging-quarterly.');
    return;
  }
  console.log(`  Slugs to refresh (${slugs.length}): ${slugs.join(', ')}`);

  const results = [];
  for (const slug of slugs) {
    results.push(refreshOne(slug));
  }

  const ok = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  console.log(`\n  Refresh complete: ${ok} succeeded, ${failed.length} failed`);
  for (const f of failed) console.log(`    [fail] ${f.slug}: ${f.reason}`);

  await notify({
    subject: `Refresh Runner: ${ok} succeeded${failed.length ? `, ${failed.length} failed` : ''}`,
    body: results.map((r) => `${r.ok ? '[ok]' : '[fail]'} ${r.slug}${r.reason ? ` — ${r.reason}` : ''}`).join('\n'),
    status: failed.length ? 'error' : 'info',
    category: 'pipeline',
  }).catch(() => {});
}

main().catch((err) => {
  console.error('Refresh runner failed:', err);
  process.exit(1);
});
