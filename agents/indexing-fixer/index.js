#!/usr/bin/env node
/**
 * Indexing Fixer
 *
 * Takes action on the indexing gaps identified by indexing-checker. Two-tier
 * escalation:
 *
 *   Tier 1 — Automatic sitemap resubmission (fully supported, no approval)
 *     Posts flagged verdict.action === 'resubmit_sitemap' get a sitemap ping
 *     to nudge Google to re-crawl. Tracks which sitemap URL to submit per
 *     post (defaults to the main sitemap.xml).
 *
 *   Tier 2 — Indexing API submission (human approval required)
 *     Posts flagged verdict.action === 'submit_indexing_api' are queued to
 *     data/performance-queue/indexing-submissions.json with status
 *     pending_approval. The dashboard surfaces this as an Action Required
 *     card. Approval triggers the Indexing API call.
 *
 *   Tier 3 — Manual investigation flag
 *     Posts with >= 2 prior Tier 2 submissions that remain not-indexed at
 *     30+ days get indexing_blocked: true on their post JSON and surface
 *     as a red Action Required card: "manual fix needed".
 *
 * Critical verdicts (noindex tag, robots.txt block, canonical conflict,
 * soft 404) skip Tier 1/2 entirely and go straight to manual flag — these
 * are technical misconfigurations that resubmission cannot fix.
 *
 * Cron: daily 6:30 AM PT (after indexing-checker).
 *
 * Usage:
 *   node agents/indexing-fixer/index.js              # normal run
 *   node agents/indexing-fixer/index.js --dry-run    # preview actions
 *   node agents/indexing-fixer/index.js --approve <slug>   # manually submit via Indexing API
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { notify } from '../../lib/notify.js';
import { resubmitSitemap, submitUrlForIndexing, getQuotaStatus } from '../../lib/gsc-indexing.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const POSTS_DIR = join(ROOT, 'data', 'posts');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'indexing');
const QUEUE_DIR = join(ROOT, 'data', 'performance-queue');
const QUEUE_FILE = join(QUEUE_DIR, 'indexing-submissions.json');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const approveIdx = args.indexOf('--approve');
const APPROVE_SLUG = approveIdx !== -1 ? args[approveIdx + 1] : null;

// Config: the primary sitemap URL to resubmit. Shopify sites expose sitemap.xml
// at the root. If multiple sitemap indexes exist they're nested under this.
function loadConfig() {
  const c = JSON.parse(readFileSync(join(ROOT, 'config', 'site.json'), 'utf8'));
  const siteUrl = (c.url || '').replace(/\/$/, '');
  return {
    name: c.name,
    siteUrl,
    sitemapUrl: `${siteUrl}/sitemap.xml`,
  };
}

// ── queue (shared shape with the future performance-engine approval loop) ────

function loadQueue() {
  if (!existsSync(QUEUE_FILE)) return { items: [] };
  try { return JSON.parse(readFileSync(QUEUE_FILE, 'utf8')); } catch { return { items: [] }; }
}

function saveQueue(q) {
  mkdirSync(QUEUE_DIR, { recursive: true });
  writeFileSync(QUEUE_FILE, JSON.stringify(q, null, 2));
}

function upsertQueueItem(item) {
  const q = loadQueue();
  const idx = q.items.findIndex((x) => x.slug === item.slug);
  if (idx === -1) q.items.push(item);
  else q.items[idx] = { ...q.items[idx], ...item, updated_at: new Date().toISOString() };
  saveQueue(q);
}

// ── post metadata ─────────────────────────────────────────────────────────────

function loadPostMeta(slug) {
  try { return JSON.parse(readFileSync(join(POSTS_DIR, `${slug}.json`), 'utf8')); } catch { return null; }
}

function stampPostMeta(slug, patch) {
  const meta = loadPostMeta(slug);
  if (!meta) return;
  const merged = { ...meta, ...patch };
  writeFileSync(join(POSTS_DIR, `${slug}.json`), JSON.stringify(merged, null, 2));
}

function recordSubmission(slug, submission) {
  const meta = loadPostMeta(slug);
  if (!meta) return;
  const history = meta.indexing_submissions || [];
  history.push(submission);
  stampPostMeta(slug, { indexing_submissions: history });
}

function countPriorSubmissions(slug, method) {
  const meta = loadPostMeta(slug);
  if (!meta || !meta.indexing_submissions) return 0;
  return meta.indexing_submissions.filter((s) => s.method === method).length;
}

// ── critical action handlers ──────────────────────────────────────────────────

function handleCriticalVerdict(result) {
  const reasons = {
    fix_noindex_tag: 'Page has a noindex meta tag. Remove it in the Shopify article HTML.',
    fix_robots_txt: 'robots.txt blocks this URL. Check the Shopify theme robots.txt.liquid file.',
    fix_canonical_mismatch: `Google picked a different canonical (${result.google_canonical || '?'}) than what the page declares. Update the canonical tag or content to match.`,
    fix_page_fetch: `Page fetch failed with ${result.page_fetch_state}. URL may be 404 or returning an error.`,
    content_quality_review: 'Google crawled but chose not to index — signals a content quality or duplicate-content issue. Manual review required.',
  };
  const action = result.verdict.action;
  return reasons[action] || 'Manual investigation required.';
}

// ── main ──────────────────────────────────────────────────────────────────────

async function processNormalRun() {
  const config = loadConfig();
  console.log('\nIndexing Fixer\n');

  const latestPath = join(REPORTS_DIR, 'latest.json');
  if (!existsSync(latestPath)) {
    console.error(`  No indexing report at ${latestPath}. Run indexing-checker first.`);
    process.exit(1);
  }

  const report = JSON.parse(readFileSync(latestPath, 'utf8'));
  const actionable = (report.results || []).filter((r) => r.verdict && r.verdict.severity !== 'ok');
  console.log(`  Actionable items from latest report: ${actionable.length}`);

  if (actionable.length === 0) {
    console.log('  Nothing to fix. Indexing is healthy.');
    return;
  }

  const quota = getQuotaStatus();
  console.log(`  Indexing API submissions remaining today: ${quota.submission.remaining}/${quota.submission.cap}\n`);

  const tierOne = actionable.filter((r) => r.verdict.action === 'resubmit_sitemap');
  const tierTwo = actionable.filter((r) => r.verdict.action === 'submit_indexing_api');
  const critical = actionable.filter((r) => [
    'fix_noindex_tag', 'fix_robots_txt', 'fix_canonical_mismatch',
    'fix_page_fetch', 'content_quality_review',
  ].includes(r.verdict.action));

  console.log(`  Tier 1 (sitemap ping — auto):        ${tierOne.length}`);
  console.log(`  Tier 2 (indexing API — approval):    ${tierTwo.length}`);
  console.log(`  Tier 3 (manual investigation):       ${critical.length}\n`);

  // ── Tier 1: sitemap resubmission ──────────────────────────────────────────
  // One sitemap ping covers all pending URLs simultaneously (the sitemap
  // contains all live posts), so we only need ONE resubmit per run regardless
  // of how many URLs are flagged.
  if (tierOne.length > 0) {
    console.log(`  Tier 1: Resubmitting sitemap ${config.sitemapUrl}...`);
    if (DRY_RUN) {
      console.log('    (dry-run — skipping)');
    } else {
      try {
        const result = await resubmitSitemap(config.sitemapUrl);
        console.log(`    ✓ sitemap resubmitted (HTTP ${result.status})`);
        const submission = {
          method: 'sitemap_resubmit',
          submitted_at: new Date().toISOString(),
          result: 'ok',
        };
        // Stamp every Tier 1 candidate with the submission record
        for (const r of tierOne) {
          recordSubmission(r.slug, submission);
        }
      } catch (err) {
        console.error(`    ✗ sitemap resubmit failed: ${err.message}`);
      }
    }
  }

  // ── Tier 2: queue for approval ─────────────────────────────────────────────
  for (const r of tierTwo) {
    const priorSitemap = countPriorSubmissions(r.slug, 'sitemap_resubmit');
    const priorIndexing = countPriorSubmissions(r.slug, 'indexing_api');

    // Escalation to Tier 3: if already submitted twice via Indexing API and
    // still not indexed, flag for manual investigation.
    if (priorIndexing >= 2) {
      console.log(`  Tier 3 flag: ${r.slug} — ${priorIndexing} prior Indexing API submissions, still not indexed`);
      if (!DRY_RUN) {
        stampPostMeta(r.slug, {
          indexing_blocked: true,
          indexing_blocked_reason: `${priorIndexing} prior Indexing API submissions failed to get the post indexed. Current state: ${r.state}. Manual investigation required.`,
          indexing_blocked_at: new Date().toISOString(),
        });
      }
      continue;
    }

    console.log(`  Tier 2 queued: ${r.slug} (prior: ${priorSitemap} sitemap, ${priorIndexing} indexing)`);
    if (!DRY_RUN) {
      upsertQueueItem({
        slug: r.slug,
        title: r.title,
        url: r.url,
        state: r.state,
        age_days: r.age_days,
        prior_sitemap_resubmits: priorSitemap,
        prior_indexing_api_submits: priorIndexing,
        status: 'pending_approval',
        queued_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }
  }

  // ── Tier 3: critical misconfigurations ────────────────────────────────────
  for (const r of critical) {
    const reason = handleCriticalVerdict(r);
    console.log(`  Tier 3 critical: ${r.slug} — ${r.verdict.action}`);
    console.log(`    ${reason}`);
    if (!DRY_RUN) {
      stampPostMeta(r.slug, {
        indexing_blocked: true,
        indexing_blocked_reason: reason,
        indexing_blocked_at: new Date().toISOString(),
      });
    }
  }

  // ── Daily digest notification ────────────────────────────────────────────
  const summary = [];
  if (tierOne.length) summary.push(`Sitemap pinged (${tierOne.length} URLs covered)`);
  if (tierTwo.length) summary.push(`${tierTwo.length} queued for Indexing API approval`);
  if (critical.length) summary.push(`${critical.length} flagged for manual fix`);

  if (summary.length > 0) {
    await notify({
      subject: `Indexing Fixer: ${summary.join(', ')}`,
      body: [
        ...tierOne.map((r) => `[tier1] ${r.slug}: sitemap pinged (${r.age_days}d old, ${r.state})`),
        ...tierTwo.map((r) => `[tier2 pending approval] ${r.slug}: ${r.state} (${r.age_days}d old)`),
        ...critical.map((r) => `[critical] ${r.slug}: ${r.verdict.action}`),
      ].join('\n'),
      status: critical.length > 0 ? 'error' : 'info',
      category: 'seo',
    }).catch(() => {});
  }

  console.log('\nIndexing fixer run complete.');
}

async function processApproval(slug) {
  console.log(`\nIndexing Fixer — manual approval for ${slug}\n`);

  const q = loadQueue();
  const item = q.items.find((x) => x.slug === slug);
  if (!item) { console.error(`  Not in queue: ${slug}`); process.exit(1); }
  if (item.status !== 'pending_approval') {
    console.error(`  Already ${item.status}`);
    process.exit(1);
  }

  const quota = getQuotaStatus();
  if (quota.submission.remaining === 0) {
    console.error(`  Daily Indexing API quota exhausted (${quota.submission.cap}/day). Try tomorrow.`);
    process.exit(1);
  }

  try {
    const result = await submitUrlForIndexing(item.url, 'URL_UPDATED');
    console.log(`  ✓ Submitted ${item.url} to Indexing API`);

    recordSubmission(slug, {
      method: 'indexing_api',
      type: 'URL_UPDATED',
      submitted_at: result.submitted_at,
      notification_time: result.notification_time,
      result: 'ok',
    });

    item.status = 'submitted';
    item.submitted_at = result.submitted_at;
    item.updated_at = new Date().toISOString();
    saveQueue(q);

    await notify({
      subject: `Indexing API submission: ${slug}`,
      body: `Submitted ${item.url} to Google Indexing API. Expect re-crawl within 24 hours.`,
      status: 'info',
      category: 'seo',
    }).catch(() => {});
  } catch (err) {
    console.error(`  ✗ Submission failed: ${err.message}`);
    recordSubmission(slug, {
      method: 'indexing_api',
      submitted_at: new Date().toISOString(),
      result: 'error',
      error: err.message,
    });
    process.exit(1);
  }
}

async function main() {
  if (APPROVE_SLUG) {
    await processApproval(APPROVE_SLUG);
  } else {
    await processNormalRun();
  }
}

main().catch((err) => {
  console.error('Indexing fixer failed:', err);
  process.exit(1);
});
