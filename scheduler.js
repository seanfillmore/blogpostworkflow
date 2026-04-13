#!/usr/bin/env node
/**
 * Content Scheduler (redirects to calendar-runner)
 *
 * Previously ran the full pipeline on the calendar publish date.
 * Now delegates to calendar-runner which handles:
 *   --publish-due  : flip scheduled drafts live + run post-publish steps
 *   --run          : execute next pending pipeline item
 *
 * USAGE (legacy):
 *   node scheduler.js               # publish due + run next pending item
 *   node scheduler.js --dry-run     # print without executing
 *
 * Cron: 0 8 * * * cd /path/to/project && node scheduler.js >> data/reports/scheduler/scheduler.log 2>&1
 */

import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { appendFileSync, mkdirSync, existsSync, readdirSync, readFileSync } from 'fs';
import { notify, notifyLatestReport } from './lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_DIR  = join(__dirname, 'data/reports/scheduler');
const LOG_PATH = join(LOG_DIR, 'scheduler.log');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_PATH, line + '\n');
  } catch { /* ignore */ }
}

const failures = [];

function runStep(name, cmd, { retries = 0, critical = false, indent = '  ' } = {}) {
  log(`${indent}${cmd}`);
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      execSync(cmd, { stdio: 'inherit', cwd: __dirname });
      log(`${indent}✓ ${name} complete`);
      return true;
    } catch (e) {
      if (attempt < retries) {
        log(`${indent}⚠ ${name} failed (attempt ${attempt + 1}/${retries + 1}), retrying...`);
      } else {
        log(`${indent}✗ ${name} failed (exit ${e.status})`);
        failures.push({ name, critical, error: e.message || `exit ${e.status}` });
      }
    }
  }
  return false;
}

const args = process.argv.slice(2);
const dryFlag = args.includes('--dry-run') ? ' --dry-run' : '';

log('──────────────────────────────────────────────────────────────────');
log('Content Scheduler starting');

// Defer all notifications from this process and any child processes to the daily summary
process.env.NOTIFY_DEFERRED = '1';

// Step -1: rebuild keyword index (used by researcher and other agents)
const NODE = process.execPath; // full path to the running node binary

runStep('keyword-index', `"${NODE}" lib/keyword-index.js --rebuild`);

// Step 0: daily review monitor
runStep('review-monitor', `"${NODE}" agents/review-monitor/index.js`);

// Step 1: flip any scheduled drafts that are due live (+ post-publish steps)

runStep('publish-due', `"${NODE}" agents/calendar-runner/index.js --publish-due${dryFlag}`, { retries: 1, critical: true });

// Step 2: run the next pending calendar item through the full pipeline
runStep('calendar-runner --run', `"${NODE}" agents/calendar-runner/index.js --run${dryFlag}`, { retries: 1, critical: true });

// Step 3: auto-repair broken links in any published/scheduled post
if (!dryFlag) {
  const { listAllSlugs, getEditorReportPath, getPostMeta, getContentPath, getMetaPath } = await import('./lib/posts.js');
  const brokenItems = []; // { slug }

  for (const slug of listAllSlugs()) {
    try {
      const reportPath = getEditorReportPath(slug);
      if (!existsSync(reportPath)) continue;
      const report = readFileSync(reportPath, 'utf8');
      const has404 = /\|\s*https?:\/\/[^|]+\|\s*[^|]*\|\s*404\s*\|/m.test(report);
      if (!has404) continue;

      const meta = getPostMeta(slug);
      if (!meta?.shopify_article_id) continue; // not on Shopify yet

      brokenItems.push({ slug });
    } catch { /* skip */ }
  }

  if (brokenItems.length > 0) {
    log(`  Link repair: ${brokenItems.length} post(s) with broken links detected`);
    for (const { slug } of brokenItems) {
      log(`    Repairing: ${slug}`);
      try {
        execSync(`"${NODE}" agents/link-repair/index.js ${slug}`, { stdio: 'inherit', cwd: __dirname });
        // Re-run editor to update the report (clears broken link count in dashboard)
        execSync(`"${NODE}" agents/editor/index.js data/posts/${slug}/content.html`, { stdio: 'inherit', cwd: __dirname });
        // Re-upload the fixed body to Shopify (--force skips editor gate since post is already live)
        // Preserve shopify_publish_at if it's in the future (keeps scheduled posts from going live immediately)
        const meta = getPostMeta(slug);
        const futurePublishAt = meta.shopify_publish_at && new Date(meta.shopify_publish_at) > new Date()
          ? ` --publish-at "${meta.shopify_publish_at}"` : '';
        execSync(`"${NODE}" agents/publisher/index.js data/posts/${slug}/meta.json --force${futurePublishAt}`, { stdio: 'inherit', cwd: __dirname });
        log(`    ✓ ${slug} repaired and re-uploaded`);
      } catch (e) {
        log(`    ✗ ${slug} repair failed (exit ${e.status})`);
      }
    }
  } else {
    log('  Link repair: no broken links detected');
  }
}

// Step 4a: publish approved product meta rewrites
runStep('product meta publish-approved', `"${NODE}" agents/product-optimizer/index.js --publish-approved`);

// Step 4b: publish approved collection content
runStep('collection content publish-approved', `"${NODE}" agents/collection-content-optimizer/index.js --publish-approved`);

// Step 4c: pages from GSC
runStep('pages-from-gsc', `"${NODE}" agents/product-optimizer/index.js --pages-from-gsc${dryFlag}`);

// Step 5: run collection linker to inject cross-links from blog posts to collections
runStep('collection-linker', `"${NODE}" agents/collection-linker/index.js --top-targets --apply${dryFlag}`);

// Step 5b: rank alerter — flag sudden position changes
runStep('rank-alerter', `"${NODE}" agents/rank-alerter/index.js`);

// Step 5c: insight aggregator — refresh writer standing rules
runStep('insight-aggregator', `"${NODE}" agents/insight-aggregator/index.js`);

// Step 5d: submit pending pages to indexing API (daily, up to quota limit)
runStep('submit-indexing', `"${NODE}" agents/technical-seo/index.js fix-submit-indexing`);

// ── Weekly jobs (Sundays only) ───────────────────────────────────────────────
if (new Date().getDay() === 0) {
  log('  Weekly jobs (Sunday):');

  // Step 6: product schema with Judge.me reviews (GSC-filtered)
  runStep('product-schema --auto', `"${NODE}" agents/product-schema/index.js --auto --apply${dryFlag}`, { indent: '    ' });

  // Step 7a: collection gap detection from GSC opportunities
  runStep('collection-creator --from-opportunities', `"${NODE}" agents/collection-creator/index.js --from-opportunities --queue${dryFlag}`, { indent: '    ' });

  // Step 7b: publish approved new collections
  if (!dryFlag) {
    runStep('collection-creator --publish-approved', `"${NODE}" agents/collection-creator/index.js --publish-approved`, { indent: '    ' });
  }

  // Step 7c: site crawl via DataForSEO On-Page API
  runStep('site-crawler', `"${NODE}" agents/site-crawler/index.js`, { indent: '    ' });

  // Step 8: cannibalization detection + resolution
  runStep('cannibalization-resolver', `"${NODE}" agents/cannibalization-resolver/index.js --apply --report-json${dryFlag}`, { indent: '    ' });

  // Step 9: GA4 content analysis
  runStep('ga4-content-analyzer', `"${NODE}" agents/ga4-content-analyzer/index.js`, { indent: '    ' });

  // Step 9b: meta A/B tracker
  runStep('meta-ab-tracker', `"${NODE}" agents/meta-ab-tracker/index.js${dryFlag}`, { indent: '    ' });

  // Step 9c: backlink monitoring
  runStep('backlink-monitor', `"${NODE}" agents/backlink-monitor/index.js`, { indent: '    ' });

  // Step 9d: backlink opportunity detection
  runStep('backlink-opportunity', `"${NODE}" agents/backlink-opportunity/index.js`, { indent: '    ' });

  // Step 9e: blog post verifier — check published posts for broken links/facts
  runStep('blog-post-verifier', `"${NODE}" agents/blog-post-verifier/index.js --limit 10`, { indent: '    ' });

} else {
  log('  Weekly jobs: skipped (not Sunday)');
}

// ── Monthly jobs (1st of month) ──────────────────────────────────────────────
if (new Date().getDate() === 1) {
  log('  Monthly jobs (1st):');

  runStep('theme-seo-auditor', `"${NODE}" agents/theme-seo-auditor/index.js`, { indent: '    ' });
} else {
  log('  Monthly jobs: skipped (not 1st)');
}

// ── Failure summary + escalation ─────────────────────────────────────────────
if (failures.length > 0) {
  log(`\n  ⚠ ${failures.length} step(s) failed:`);
  for (const f of failures) {
    log(`    ${f.critical ? '🔴 CRITICAL' : '🟡'} ${f.name}: ${f.error}`);
  }
  const criticalFailures = failures.filter(f => f.critical);
  if (criticalFailures.length > 0) {
    await notify({
      subject: `⚠️ Scheduler: ${criticalFailures.length} critical failure(s)`,
      body: criticalFailures.map(f => `${f.name}: ${f.error}`).join('\n'),
      status: 'error',
      immediate: true,
    }).catch(() => {});
  }
}

log('Scheduler done.');
await notifyLatestReport('Scheduler completed', LOG_DIR);
