#!/usr/bin/env node
/**
 * Indexing Fixer
 *
 * Takes action on the indexing gaps identified by indexing-checker. Three-tier
 * escalation:
 *
 *   Tier 1 — Automatic sitemap resubmission
 *     Posts flagged verdict.action === 'resubmit_sitemap' get a sitemap ping
 *     to nudge Google to re-crawl.
 *
 *   Tier 2 — Automatic Indexing API submission (no approval required)
 *     Posts flagged verdict.action === 'submit_indexing_api' are submitted
 *     directly to the Google Indexing API. No human approval step.
 *
 *   Tier 3 — Manual investigation flag
 *     Posts with >= 2 prior Tier 2 submissions that remain not-indexed at
 *     30+ days get indexing_blocked: true on their post JSON.
 *
 * crawled_not_indexed — Content quality path (separate from the tiers above)
 *     Google crawled the page but declined to index it, signalling a content
 *     quality issue. The fixer auto-triggers refresh-runner to rewrite the post
 *     (if not refreshed within the last 30 days). After the refresh, the next
 *     indexing-checker run will re-inspect and submit via Tier 2 if needed.
 *
 * True critical verdicts (noindex tag, robots.txt block, canonical conflict,
 * page fetch failure) go straight to manual flag — these are technical
 * misconfigurations that neither resubmission nor refresh can fix.
 *
 * Cron: daily 3:30 AM PT (after indexing-checker at 3:00 AM PT).
 *
 * Usage:
 *   node agents/indexing-fixer/index.js              # normal run
 *   node agents/indexing-fixer/index.js --dry-run    # preview actions
 *   node agents/indexing-fixer/index.js --approve <slug>   # force Indexing API submit
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { notify } from '../../lib/notify.js';
import { resubmitSitemap, submitUrlForIndexing, getQuotaStatus } from '../../lib/gsc-indexing.js';

import { getMetaPath, POSTS_DIR, ROOT } from '../../lib/posts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
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
  try { return JSON.parse(readFileSync(getMetaPath(slug), 'utf8')); } catch { return null; }
}

function stampPostMeta(slug, patch) {
  const meta = loadPostMeta(slug);
  if (!meta) return;
  const merged = { ...meta, ...patch };
  writeFileSync(getMetaPath(slug), JSON.stringify(merged, null, 2));
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

function ageInDays(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.floor((Date.now() - t) / 86400000);
}

// ── critical action handlers ──────────────────────────────────────────────────

function handleCriticalVerdict(result) {
  const reasons = {
    fix_noindex_tag: 'Page has a noindex meta tag. Remove it in the Shopify article HTML.',
    fix_robots_txt: 'robots.txt blocks this URL. Check the Shopify theme robots.txt.liquid file.',
    fix_canonical_mismatch: `Google picked a different canonical (${result.google_canonical || '?'}) than what the page declares. Update the canonical tag or content to match.`,
    fix_page_fetch: `Page fetch failed with ${result.page_fetch_state}. URL may be 404 or returning an error.`,
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
  const contentQuality = actionable.filter((r) => r.verdict.action === 'content_quality_review');
  const critical = actionable.filter((r) => [
    'fix_noindex_tag', 'fix_robots_txt', 'fix_canonical_mismatch', 'fix_page_fetch',
  ].includes(r.verdict.action));

  console.log(`  Tier 1 (sitemap ping — auto):        ${tierOne.length}`);
  console.log(`  Tier 2 (indexing API — auto):        ${tierTwo.length}`);
  console.log(`  Content quality (auto-refresh):      ${contentQuality.length}`);
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

  // ── Tier 2: auto-submit to Indexing API ───────────────────────────────────
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

    if (quota.submission.remaining === 0) {
      console.log(`  Tier 2 skip: ${r.slug} — Indexing API quota exhausted for today`);
      continue;
    }

    console.log(`  Tier 2 submitting: ${r.slug} (prior: ${priorSitemap} sitemap, ${priorIndexing} indexing)`);
    if (DRY_RUN) {
      console.log('    (dry-run — skipping)');
    } else {
      try {
        const result = await submitUrlForIndexing(r.url, 'URL_UPDATED');
        console.log(`    ✓ submitted ${r.url}`);
        recordSubmission(r.slug, {
          method: 'indexing_api',
          type: 'URL_UPDATED',
          submitted_at: result.submitted_at,
          notification_time: result.notification_time,
          result: 'ok',
        });
        upsertQueueItem({
          slug: r.slug,
          title: r.title,
          url: r.url,
          state: r.state,
          age_days: r.age_days,
          status: 'submitted',
          submitted_at: result.submitted_at,
          updated_at: new Date().toISOString(),
        });
      } catch (err) {
        console.error(`    ✗ submission failed: ${err.message}`);
        recordSubmission(r.slug, {
          method: 'indexing_api',
          submitted_at: new Date().toISOString(),
          result: 'error',
          error: err.message,
        });
      }
    }
  }

  // ── Content quality: auto-refresh via refresh-runner ──────────────────────
  // Google crawled but declined to index — content quality is the fix, not
  // resubmission. Trigger refresh-runner if not refreshed in the last 30 days.
  const REFRESH_COOLDOWN_DAYS = 30;
  for (const r of contentQuality) {
    const meta = loadPostMeta(r.slug);
    const lastRefresh = meta ? ageInDays(meta.last_refreshed_at) : null;

    if (lastRefresh != null && lastRefresh < REFRESH_COOLDOWN_DAYS) {
      console.log(`  Content quality skip: ${r.slug} — refreshed ${lastRefresh}d ago, waiting for Google to re-crawl`);
      continue;
    }

    console.log(`  Content quality: triggering refresh for ${r.slug} (last refresh: ${lastRefresh != null ? lastRefresh + 'd ago' : 'never'})`);
    if (DRY_RUN) {
      console.log('    (dry-run — skipping)');
    } else {
      try {
        execSync(`node agents/refresh-runner/index.js ${r.slug}`, { cwd: ROOT, stdio: 'inherit' });
        console.log(`    ✓ refresh complete for ${r.slug}`);
      } catch (err) {
        console.error(`    ✗ refresh failed for ${r.slug}: ${err.message}`);
      }
    }
  }

  // ── Tier 3: true technical misconfigurations ───────────────────────────────
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
  if (tierOne.length) summary.push(`Sitemap pinged (${tierOne.length} URLs)`);
  if (tierTwo.length) summary.push(`${tierTwo.length} submitted to Indexing API`);
  if (contentQuality.length) summary.push(`${contentQuality.length} content-quality refresh triggered`);
  if (critical.length) summary.push(`${critical.length} flagged for manual fix`);

  if (summary.length > 0) {
    await notify({
      subject: `Indexing Fixer: ${summary.join(', ')}`,
      body: [
        ...tierOne.map((r) => `[tier1] ${r.slug}: sitemap pinged (${r.age_days}d old, ${r.state})`),
        ...tierTwo.map((r) => `[tier2] ${r.slug}: submitted to Indexing API (${r.age_days}d old)`),
        ...contentQuality.map((r) => `[refresh] ${r.slug}: refresh-runner triggered (crawled_not_indexed)`),
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
