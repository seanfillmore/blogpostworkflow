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
 * Publishes automatically after the editor passes. Pass --no-publish to skip
 * the Shopify update (useful for local testing or dry runs).
 *
 * Usage:
 *   node agents/refresh-runner/index.js best-natural-deodorant-for-women
 *   node agents/refresh-runner/index.js --from-post-performance
 *   node agents/refresh-runner/index.js --from-quick-wins --limit 2
 *   node agents/refresh-runner/index.js --aging-quarterly
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { notify } from '../../lib/notify.js';
import { getContentPath, getMetaPath, getRefreshedPath, getBackupsDir, getEditorReportPath, listAllSlugs, POSTS_DIR, ROOT } from '../../lib/posts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const FLAG_PUBLISH = !args.includes('--no-publish');
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
  return listAllSlugs().map((slug) => {
    try {
      const meta = JSON.parse(readFileSync(getMetaPath(slug), 'utf8'));
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

/** Returns true if the editor report at `reportPath` has an overall "Needs Work" verdict. */
function editorNeedsWork(reportPath) {
  if (!existsSync(reportPath)) return false;
  const report = readFileSync(reportPath, 'utf8');
  const overallMatch = report.match(/##[^\n]*OVERALL QUALITY[^\n]*\n[\s\S]*?VERDICT[:*\s]+([^\n]+)/i);
  return overallMatch ? /needs work/i.test(overallMatch[1]) : /VERDICT[:*\s]*Needs Work/i.test(report);
}

function refreshOne(slug) {
  const metaPath = getMetaPath(slug);
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
    // crawled_not_indexed = Google reached the page but rejected it on content
    // quality. Refreshing is exactly the right action here — allow it through.
    if (idx && idx.state && idx.state !== 'indexed' && idx.state !== 'crawled_not_indexed') {
      console.log(`  [skip] ${slug}: indexing state is "${idx.state}" — run indexing-fixer first, not refresh`);
      return { slug, ok: false, reason: `indexing state ${idx.state}, refresh suppressed` };
    }
  } catch { /* fall through */ }

  // Winner protection — legacy posts auto-locked by triage must not be refreshed
  try {
    const lockMeta = JSON.parse(readFileSync(metaPath, 'utf8'));
    if (lockMeta.legacy_locked) {
      console.log(`  [skip] ${slug}: legacy winner (locked)`);
      return { slug, ok: false, reason: 'legacy winner, locked' };
    }
  } catch { /* proceed */ }

  console.log(`\n══ Refreshing: ${slug} ══`);

  try {
    run(`node agents/content-refresher/index.js --slug "${slug}"`, 'content-refresher');
  } catch (e) {
    return { slug, ok: false, reason: `content-refresher failed: ${e.message}` };
  }

  // The content-refresher writes data/posts/<slug>-refreshed.html. Move that
  // back over the canonical HTML so editor + publisher pick it up.
  const refreshedHtml = getRefreshedPath(slug);
  const canonicalHtml = getContentPath(slug);
  if (existsSync(refreshedHtml)) {
    // Backup the original alongside the refresh for safety.
    if (existsSync(canonicalHtml)) {
      const backupsDir = getBackupsDir(slug);
      mkdirSync(backupsDir, { recursive: true });
      const backup = join(backupsDir, `content.backup-${Date.now()}.html`);
      writeFileSync(backup, readFileSync(canonicalHtml));
    }
    writeFileSync(canonicalHtml, readFileSync(refreshedHtml));
  }

  try {
    run(`node agents/editor/index.js "${canonicalHtml}"`, 'editor');
  } catch (e) {
    return { slug, ok: false, reason: `editor failed: ${e.message}` };
  }

  // Gate on editor verdict — the editor exits 0 even on "Needs Work", so we
  // must read the report ourselves. If the overall verdict is Needs Work,
  // run the link-repair agent automatically (it fixes broken links and
  // removes unfixable ones) then re-run the editor. Only fail if it still
  // reports Needs Work after repair.
  if (editorNeedsWork(getEditorReportPath(slug))) {
    console.log('\n  Editor verdict: Needs Work — running link-repair automatically...');
    try {
      run(`node agents/link-repair/index.js "${slug}"`, 'link-repair');
    } catch (e) {
      return { slug, ok: false, reason: `link-repair failed: ${e.message}` };
    }
    try {
      run(`node agents/editor/index.js "${canonicalHtml}"`, 'editor (post-repair)');
    } catch (e) {
      return { slug, ok: false, reason: `editor (post-repair) failed: ${e.message}` };
    }
    if (editorNeedsWork(getEditorReportPath(slug))) {
      console.log('\n  Editor still reports Needs Work after link repair — not publishing.');
      return { slug, ok: false, reason: 'editor: Needs Work after link repair — not published' };
    }
  }

  // Inject review-forward product card — replaces the mid-article dashed CTA
  // with a live block sourced from Shopify + Judge.me. Non-fatal: posts without
  // product links or missing credentials are skipped gracefully by the agent.
  try {
    run(`node agents/featured-product-injector/index.js --handle "${slug}"`, 'featured-product-injector');
  } catch (e) {
    console.log(`  featured-product-injector warning (non-fatal): ${e.message}`);
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
    console.log(`\n  Refreshed HTML ready (--no-publish mode): ${canonicalHtml}`);
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
