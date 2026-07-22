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

const NODE = process.execPath; // full path to the running node binary

// Step 0: daily review monitor
runStep('review-monitor', `"${NODE}" agents/review-monitor/index.js`);

// Step 0a: catch any manual Shopify edits before agents start their daily work
runStep('change-diff-detector', `"${NODE}" agents/change-diff-detector/index.js${dryFlag}`);

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

// Step 5: run collection linker to inject cross-links from blog posts to collections.
// WEEKLY (Mondays), not daily: it makes ~1 Claude call per (target × article) and
// re-analyzed the same pairs every day — the #1 metered cost driver (~250 Haiku
// calls/run, ~$7.7/wk). Internal cross-linking is slow-moving; a weekly sweep keeps
// the benefit at ~1/7 the cost. Tighter --limit halves per-run calls too.
// (Dashboard "Approve & Run" still triggers single-target runs on demand.)
if (new Date().getDay() === 1) {
  runStep('collection-linker', `"${NODE}" agents/collection-linker/index.js --top-targets --apply --limit 12${dryFlag}`);
} else {
  log('  collection-linker: skipped (weekly, Mondays only)');
}

// Step 5b: rank alerter — flag sudden position changes
runStep('rank-alerter', `"${NODE}" agents/rank-alerter/index.js`);

// Step 5b.1: shopping-test monitor — spend/clicks/conv/ROAS for the paid Shopping
// test campaigns. Cheap (2 GAQL queries, no LLM). Reports into the daily digest;
// flags only genuinely dead spend (gate: ~1× ROAS is a win, no auto-pause).
runStep('shopping-test-monitor', `"${NODE}" agents/shopping-test-monitor/index.js`);

// Step 5b.2: amazon snapshot — WEEKLY (Sundays). RSC Amazon net (post-Finance-role),
// fees, per-ASIN net, and hero-lotion stockout guard → data/snapshots/amazon/ + digest.
// Weekly, not daily: the 30-day finance pull is heavy and Amazon data moves slowly.
if (new Date().getDay() === 0) {
  runStep('amazon-snapshot', `"${NODE}" agents/amazon-snapshot/index.js`);
} else {
  log('  amazon-snapshot: skipped (weekly, Sundays only)');
}

// Step 5c: insight aggregator — refresh writer standing rules
runStep('insight-aggregator', `"${NODE}" agents/insight-aggregator/index.js`);

// Step 5c.1: keep the Winback 25% dynamic-coupon pool topped up (Klaviyo skips
// the email at 0 codes). Cheap daily check; auto-refills + alerts when low.
runStep('winback-coupon-monitor', `"${NODE}" agents/winback-coupon-monitor/index.js${dryFlag}`);

// Step 5d: submit pending pages to indexing API (daily, up to quota limit)
runStep('submit-indexing', `"${NODE}" agents/technical-seo/index.js fix-submit-indexing`);

// Step 5d.1: redirect-table maintenance — daily, audit-only ops (no crawl needed).
//   - prune-zombies deletes redirect entries whose source returns 200 (live page wins).
//   - flatten-chains collapses A→B→C into A→C to preserve PageRank across hops.
// Both are safe to run daily and idempotent. Auto-apply unless dry-run.
runStep('prune-zombies', `"${NODE}" agents/technical-seo/index.js prune-zombies${dryFlag ? '' : ' --apply'}`);
runStep('flatten-chains', `"${NODE}" agents/technical-seo/index.js flatten-chains${dryFlag}`);

// Step 5f: rebuild legacy / editor-tagged posts — max 5 per day, daily until backlog clears
runStep('legacy-rebuilder', `"${NODE}" agents/legacy-rebuilder/index.js --limit 5 --apply${dryFlag}`);

// Step 5g: refresh stale year references in titles + meta descriptions (idempotent)
runStep('meta-optimizer --refresh-stale-years', `"${NODE}" agents/meta-optimizer/index.js --refresh-stale-years${dryFlag ? '' : ' --apply'}`);

// Step 5e: (removed 2026-06-21) — crawled_not_indexed refresh is owned by the
// indexing-fixer (cron 11:30 UTC) via refresh-runner, which keeps posts PUBLISHED
// and respects a 30-day refresh cooldown. This step duplicated that but called
// `content-refresher --apply`, which sets `published:false` ("draft for review")
// on the LIVE article — silently 404'ing ranking posts. With no cooldown it fired
// daily, oscillating against `publish-drift --fix` (4 posts flipped draft↔live every
// day). The "draft for review" output has no consumer. Removed entirely; the
// indexing-fixer path is the single correct owner. See project_shopify_unpublish_drift.

// Step 5z: change-log verdict + queue release (run daily, after all agent runs)
runStep('change-verdict', `"${NODE}" agents/change-verdict/index.js${dryFlag}`);
runStep('change-queue-processor', `"${NODE}" agents/change-queue-processor/index.js${dryFlag}`);

// Step 5z.1: seo-impact — "what's actually working?" revenue/ROI analysis.
// Read-only GA4+GSC join over a 28-day window; feeds the daily digest, dashboard,
// and the prioritizers (which expect it fresh within 3 days). Runs daily.
runStep('seo-impact', `"${NODE}" agents/seo-impact/index.js`);

// Keyword-index foundation — runs daily but self-paces to biweekly via built_at.
runStep('keyword-index-builder', `"${NODE}" agents/keyword-index-builder/index.js${dryFlag}`);

// ── Calendar / brief refresh (Mon/Wed/Fri/Sun) ───────────────────────────────
// Used to live inside the Sunday-only block below; the pipeline ran dry by
// midweek as the calendar emptied out. Four times a week keeps a steady drip
// of new topics flowing into the writer without burning Anthropic spend daily.
const _dow = new Date().getDay();
if (_dow === 0 || _dow === 1 || _dow === 3 || _dow === 5) {
  runStep('content-strategist --generate-briefs', `"${NODE}" agents/content-strategist/index.js --generate-briefs`);
}

// ── Weekly jobs (Sundays only) ───────────────────────────────────────────────
if (new Date().getDay() === 0) {
  log('  Weekly jobs (Sunday):');

  // Amazon explore scripts — feed the keyword-index-builder's Stage 1.
  // These run weekly because BA is multi-GB and SQP is rate-limited.
  // The keyword-index-builder reads the latest dump from data/amazon-explore/.
  if (!dryFlag) {
    runStep('amazon-explore-listings',     `"${NODE}" scripts/amazon/explore-listings.mjs`,                       { indent: '    ' });
    runStep('amazon-explore-sqp',          `"${NODE}" scripts/amazon/explore-search-query-performance-rsc.mjs`,    { indent: '    ', retries: 1 });
    runStep('amazon-explore-ba',           `"${NODE}" scripts/amazon/explore-brand-analytics.mjs`,                 { indent: '    ', retries: 1 });
  }

  // Step 6: product-schema RETIRED 2026-07-20 — body_html JSON-LD injection
  // corrupted product/collection descriptions (nested schema leaked as raw text
  // into product pages + One-Click-Upsell offers). The theme emits valid native
  // Product schema, so this step added no SEO value. Agent kept as a self-healing
  // strip-only cleaner; run manually if a stray schema block ever reappears.
  // runStep('product-schema --auto', `"${NODE}" agents/product-schema/index.js --auto --apply${dryFlag}`, { indent: '    ' });

  // Step 7a: collection gap detection from GSC opportunities
  runStep('collection-creator --from-opportunities', `"${NODE}" agents/collection-creator/index.js --from-opportunities --queue${dryFlag}`, { indent: '    ' });

  // Step 7b: publish approved new collections
  if (!dryFlag) {
    runStep('collection-creator --publish-approved', `"${NODE}" agents/collection-creator/index.js --publish-approved`, { indent: '    ' });
  }

  // Step 7c: site crawl via DataForSEO On-Page API
  runStep('site-crawler', `"${NODE}" agents/site-crawler/index.js`, { indent: '    ' });

  // Step 7c.1: redirect creation + link fixes against fresh broken-link data.
  //   - create-redirects: scoring + cluster disambiguation; HIGH-confidence
  //     auto-apply, MEDIUM/LOW queued to redirect-proposals.json for review.
  //   - fix-links: rewrites internal links pointing to 404 pages
  //   - fix-redirects: rewrites internal links pointing to redirected URLs
  // These need fresh crawl data so they only run after site-crawler.
  runStep('create-redirects', `"${NODE}" agents/technical-seo/index.js create-redirects${dryFlag}`, { indent: '    ' });
  runStep('fix-links', `"${NODE}" agents/technical-seo/index.js fix-links${dryFlag}`, { indent: '    ' });
  runStep('fix-redirects', `"${NODE}" agents/technical-seo/index.js fix-redirects${dryFlag}`, { indent: '    ' });

  // Step 8: cannibalization detection + resolution
  runStep('cannibalization-resolver', `"${NODE}" agents/cannibalization-resolver/index.js --apply --report-json${dryFlag}`, { indent: '    ' });

  // Step 8a (content-strategist) lives above the Sunday block now — runs
  // Mon/Wed/Fri/Sun so the calendar doesn't empty out by midweek.

  // Step 8b: answer-first rewrite audit (fix intros for LLM citation)
  runStep('answer-first-rewriter', `"${NODE}" agents/answer-first-rewriter/index.js --apply`, { indent: '    ' });

  // Step 8b.1: re-gate flagged posts against LIVE Shopify so the dashboard's
  // editor verdict / broken-link counts reflect reality, not stale local
  // reports (posts fixed/refreshed live otherwise keep showing old failures).
  // Runs last in the content block, after the steps above may have changed live
  // content. Flagged-only by default — cheap; no live mutations, just refreshes
  // the local reports the dashboard reads.
  if (!dryFlag) {
    runStep('regate-live-posts', `"${NODE}" scripts/regate-live-posts.js`, { indent: '    ' });
  }

  // Step 8c: AI citation tracking across LLMs
  runStep('ai-citation-tracker', `"${NODE}" agents/ai-citation-tracker/index.js`, { indent: '    ' });

  // Step 8d: turn the citation data into a ranked PR target list (runs AFTER the
  // tracker so it consumes the freshest snapshot, with full citation URLs).
  runStep('pr-target-finder', `"${NODE}" agents/pr-target-finder/index.js`, { indent: '    ' });

  // Step 8e: generate llms.txt for LLM crawlers
  runStep('llms-txt-generator', `"${NODE}" agents/llms-txt-generator/index.js`, { indent: '    ' });

  // Step 8f: specificity audit — queue product description rewrites
  runStep('specificity-audit', `"${NODE}" agents/specificity-audit/index.js`, { indent: '    ' });

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
