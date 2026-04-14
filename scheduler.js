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

// Step 3: auto-repair broken links in ANY post (published or not).
// Previously this step was gated on shopify_article_id — which meant posts
// blocked by the editor gate over 404s would sit stuck forever because the
// scheduler refused to repair them. The fix: always repair when 404s are
// detected; only gate the re-upload step on "already on Shopify".
if (!dryFlag) {
  const { listAllSlugs, getEditorReportPath, getPostMeta, getContentPath, getMetaPath } = await import('./lib/posts.js');
  const brokenItems = []; // { slug, onShopify }

  for (const slug of listAllSlugs()) {
    try {
      const reportPath = getEditorReportPath(slug);
      if (!existsSync(reportPath)) continue;
      const report = readFileSync(reportPath, 'utf8');
      const has404 = /\|\s*https?:\/\/[^|]+\|\s*[^|]*\|\s*404\s*\|/m.test(report);
      if (!has404) continue;

      const meta = getPostMeta(slug);
      if (!meta) continue;
      brokenItems.push({ slug, onShopify: !!meta.shopify_article_id });
    } catch { /* skip */ }
  }

  if (brokenItems.length > 0) {
    const published = brokenItems.filter(i => i.onShopify).length;
    const unpublished = brokenItems.length - published;
    log(`  Link repair: ${brokenItems.length} post(s) with broken links (${published} on Shopify, ${unpublished} blocked pre-publish)`);
    for (const { slug, onShopify } of brokenItems) {
      log(`    Repairing: ${slug}`);
      try {
        execSync(`"${NODE}" agents/link-repair/index.js ${slug}`, { stdio: 'inherit', cwd: __dirname });
        // Re-run editor to refresh the verdict (clears the blocker on the dashboard/digest).
        execSync(`"${NODE}" agents/editor/index.js data/posts/${slug}/content.html`, { stdio: 'inherit', cwd: __dirname });
        if (onShopify) {
          // Already live on Shopify — push the repaired body back up.
          // --force skips the editor gate since the post is already published.
          // Preserve a future shopify_publish_at so scheduled posts don't flip
          // live immediately.
          const meta = getPostMeta(slug);
          const futurePublishAt = meta.shopify_publish_at && new Date(meta.shopify_publish_at) > new Date()
            ? ` --publish-at "${meta.shopify_publish_at}"` : '';
          execSync(`"${NODE}" agents/publisher/index.js data/posts/${slug}/meta.json --force${futurePublishAt}`, { stdio: 'inherit', cwd: __dirname });
          log(`    ✓ ${slug} repaired and re-uploaded`);
        } else {
          // Not yet on Shopify — repair complete; the normal publish pipeline
          // will pick it up on its next run once the editor verdict clears.
          log(`    ✓ ${slug} repaired (will publish via calendar-runner)`);
        }
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

// Step 5e: auto-refresh posts stuck in "crawled_not_indexed" for 45+ days
if (!dryFlag) {
  const { listAllSlugs, getPostMeta } = await import('./lib/posts.js');
  const reportPath = join(__dirname, 'data', 'reports', 'indexing', 'latest.json');
  if (existsSync(reportPath)) {
    try {
      const report = JSON.parse(readFileSync(reportPath, 'utf8'));
      const stale = (report.results || []).filter(r => {
        if (r.state !== 'crawled_not_indexed') return false;
        const age = r.age_days ?? 0;
        return age >= 45;
      });
      if (stale.length > 0) {
        log(`  Crawled-not-indexed refresh: ${stale.length} post(s) older than 45 days`);
        for (const r of stale) {
          log(`    Refreshing: ${r.slug} (${r.age_days}d old)`);
          try {
            execSync(`"${NODE}" agents/content-refresher/index.js --slug "${r.slug}" --apply`, { stdio: 'inherit', cwd: __dirname });
            log(`    ✓ ${r.slug} refreshed and pushed`);
          } catch (e) {
            log(`    ✗ ${r.slug} refresh failed (exit ${e.status})`);
          }
        }
      } else {
        log('  Crawled-not-indexed refresh: none older than 45 days');
      }
    } catch (e) {
      log(`  Crawled-not-indexed refresh: failed to read report (${e.message})`);
    }
  }
}

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

  // Step 8b: answer-first rewrite audit (fix intros for LLM citation)
  runStep('answer-first-rewriter', `"${NODE}" agents/answer-first-rewriter/index.js --apply`, { indent: '    ' });

  // Step 8c: AI citation tracking across LLMs
  runStep('ai-citation-tracker', `"${NODE}" agents/ai-citation-tracker/index.js`, { indent: '    ' });

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

  // Step 11: content gap analysis via DataForSEO
  runStep('content-gap', `"${NODE}" agents/content-gap/index.js`, { indent: '    ' });

  // Step 12: refresh device weights from the last 90 days of GA4 data. Downstream
  // agents (quick-win-targeter, content-strategist, legacy-triage) read these
  // weights to blend desktop and mobile rank positions by revenue share.
  runStep('device-weights', `"${NODE}" agents/device-weights/index.js`, { indent: '    ' });
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
