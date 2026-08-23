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
 * REVENUE-GATED BULK SELECTION. The three bulk pick lists (--from-post-
 * performance, --from-quick-wins, --aging-quarterly) are revenue-gated: a slug
 * whose cluster the revenue report shows earning $0 is
 * SKIPPED AND COUNTED (lib/cluster-hold.js) rather than bought a refresh. No
 * cluster is named in this file, and a held post is otherwise untouched —
 * still live, still indexed, still published. `--include-held` refreshes them.
 *
 * A SINGLE SLUG ARGUMENT IS NEVER HELD. That path is either an operator asking
 * by hand or a caller (indexing-fixer, legacy-rebuilder) that has already
 * applied the same hold to its own pick list; holding again here would be a
 * second, invisible gate whose skips nobody counts.
 *
 * Usage:
 *   node agents/refresh-runner/index.js best-natural-deodorant-for-women
 *   node agents/refresh-runner/index.js --from-post-performance
 *   node agents/refresh-runner/index.js --from-quick-wins --limit 2
 *   node agents/refresh-runner/index.js --aging-quarterly
 *   node agents/refresh-runner/index.js --aging-quarterly --include-held
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { notify } from '../../lib/notify.js';
import { getContentPath, getMetaPath, getRefreshedPath, getBackupsDir, getEditorReportPath, listAllSlugs, POSTS_DIR, ROOT } from '../../lib/posts.js';
import { mayRewriteBody } from '../../lib/post-lock.js';
import { runEditGateWithRepair } from '../../lib/edit-gate-repair.js';
import {
  loadClusterHold, partitionHeld, renderHoldLines, renderDisagreementLines, holdBanner,
  holdSummaryFragment, HOLD_FLAG,
} from '../../lib/cluster-hold.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const FLAG_PUBLISH = !args.includes('--no-publish');
const INCLUDE_HELD = args.includes(HOLD_FLAG);
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

/**
 * Split a bulk slug list into what gets refreshed and what is held because its
 * cluster earns $0. Returns BARE SLUGS in `kept` — the caller iterates strings.
 *
 * Exported for test; the rule itself lives in lib/cluster-hold.js.
 *
 * @param {string[]} slugs
 * @param {object} hold
 * @param {{includeHeld?:boolean, metaFor?:(slug:string)=>object|null}} opts
 * @returns {{kept:string[], held:Array, overridden:Array}}
 */
export function holdSlugs(slugs, hold, { includeHeld = false, metaFor = () => null } = {}) {
  return partitionHeld(slugs, hold, {
    includeHeld,
    describe: (s) => ({ slug: s, keyword: metaFor(s)?.target_keyword }),
  });
}

function metaForSlug(slug) {
  try { return JSON.parse(readFileSync(getMetaPath(slug), 'utf8')); } catch { return null; }
}

function gatherSlugs() {
  // Manual single slug wins — an operator naming a post is never held, and the
  // agents that call this with one slug have already applied the hold upstream.
  if (SLUG_ARG) return { slugs: [SLUG_ARG], held: [], hold: null };

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

  // Held BEFORE --limit: otherwise three held slugs consume the whole budget
  // and the run refreshes nothing that could ever earn.
  const hold = loadClusterHold({ root: ROOT });
  const banner = holdBanner(hold);
  if (banner) console.log(`${banner}\n`);
  const { kept, held } = holdSlugs([...slugs], hold, { includeHeld: INCLUDE_HELD, metaFor: metaForSlug });
  return { slugs: kept.slice(0, LIMIT), held, hold };
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
      return { slug, ok: false, skipped: true, reason: `indexing state ${idx.state}, refresh suppressed` };
    }
  } catch { /* fall through */ }

  // Winner protection — a refresh rewrites the BODY. See lib/post-lock.js:
  // locked or unreadable both refuse; the old bare `catch { /* proceed */ }`
  // meant an unparseable meta.json waved a winner straight through.
  const bodyLock = mayRewriteBody(slug);
  if (!bodyLock.allowed) {
    console.log(`  [skip] ${slug}: ${bodyLock.reason}`);
    return { slug, ok: false, skipped: true, reason: bodyLock.reason };
  }

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

  // Gate on editor verdict — the editor exits 0 even on "Needs Work", so the
  // gate (inside runEditGateWithRepair) reads the report itself. On a Needs Work
  // verdict, run the FULL editorial repair loop: route each blocker to the agent
  // that can fix it (citation-finder softens uncited claims, content-remediator
  // fixes prose/ingredient/factual issues, link-repair fixes links), re-running
  // the editor up to 3x. Only fail if it's still blocked after the loop.
  //
  // Previously this ran link-repair ONLY, so any refresh whose draft had a
  // non-link blocker (uncited claims, ingredient accuracy, factual concerns)
  // dead-ended on "Needs Work after link repair — not published". That was the
  // recurring refresh-runner failure across the deodorant/lotion/toothpaste posts.
  if (editorNeedsWork(getEditorReportPath(slug))) {
    console.log('\n  Editor verdict: Needs Work — running the editorial repair loop (citations, content, links)...');
    const { gate, attempts } = runEditGateWithRepair(slug, { maxAttempts: 3 });
    if (!gate.pass) {
      console.log(`\n  Editor still reports Needs Work after ${attempts} repair attempt(s) — not publishing.`);
      return { slug, ok: false, reason: `editor: ${gate.reason || 'Needs Work'} — not published after repair loop` };
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

  const { slugs, held, hold } = gatherSlugs();
  for (const line of renderHoldLines(held)) console.log(`  ${line}`);
  if (!slugs.length) {
    console.log('  No slugs to refresh. Provide a slug argument or use --from-post-performance / --from-quick-wins / --aging-quarterly.');
    // A run that refreshed nothing BECAUSE everything was held has to say so —
    // otherwise the hold looks like the agent quietly stopping.
    if (held.length) {
      await notify({
        subject: `Refresh Runner: 0 refreshed${holdSummaryFragment(held)}`,
        body: [...renderHoldLines(held), ...renderDisagreementLines(hold)].join('\n'),
        status: 'info',
        category: 'pipeline',
      }).catch(() => {});
    }
    return;
  }
  console.log(`  Slugs to refresh (${slugs.length}): ${slugs.join(', ')}`);

  const results = [];
  for (const slug of slugs) {
    results.push(refreshOne(slug));
  }

  const ok = results.filter((r) => r.ok).length;
  // A guard that deliberately declines to refresh a post (a locked legacy
  // winner, an indexing state that wants indexing-fixer instead) is NOT a
  // failure — it is the guard doing its job. Conflating the two sent
  // `status: 'error'` to the digest every single day for `natural-soap-bar`,
  // which trained the failures section to be ignored.
  const skipped = results.filter((r) => !r.ok && r.skipped);
  const failed = results.filter((r) => !r.ok && !r.skipped);
  console.log(`\n  Refresh complete: ${ok} succeeded, ${failed.length} failed, ${skipped.length} skipped`);
  for (const f of failed) console.log(`    [fail] ${f.slug}: ${f.reason}`);
  for (const s of skipped) console.log(`    [skip] ${s.slug}: ${s.reason}`);

  // A run that refreshed nothing (e.g. the slug didn't resolve to a post) is a
  // failure, not a success — exit non-zero so callers that observe the exit code
  // (the dashboard's seo-opportunity reconciler) can mark it failed rather than
  // completed. Partial success in a batch run still exits 0. A run whose only
  // non-successes were skips exits 0: nothing broke.
  if (failed.length && ok === 0) process.exitCode = 1;

  const counts = [`${ok} succeeded`];
  if (failed.length) counts.push(`${failed.length} failed`);
  if (skipped.length) counts.push(`${skipped.length} skipped`);
  if (held.length) counts.push(`${held.length} held`);
  await notify({
    subject: `Refresh Runner: ${counts.join(', ')}`,
    body: [
      results.map((r) => `${r.ok ? '[ok]' : r.skipped ? '[skip]' : '[fail]'} ${r.slug}${r.reason ? ` — ${r.reason}` : ''}`).join('\n'),
      ...renderHoldLines(held),
      ...renderDisagreementLines(hold),
    ].join('\n'),
    // A hold is the same class of thing as a skip: the guard doing its job, not
    // a failure. It never moves the status off 'info'.
    status: failed.length ? 'error' : 'info',
    category: 'pipeline',
  }).catch(() => {});
}

// Only run when invoked directly. Without this guard, any import of this module
// (tests import helpers from it) executes the whole agent — hitting live APIs and
// taking the host process down with it on any error.
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  main().catch((err) => {
    console.error('Refresh runner failed:', err);
    process.exit(1);
  });
}
