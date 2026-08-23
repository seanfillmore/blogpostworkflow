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
import { existsSync, readdirSync, readFileSync } from 'fs';
import { notify, notifyLatestReport } from './lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_DIR  = join(__dirname, 'data/reports/scheduler');

// The cron entry redirects stdout into data/reports/scheduler/scheduler.log
// already, so appending to that same file from here too
// wrote every line twice — which is why a single nightly run reads as if each
// step executed twice, and why scheduler.log had grown to ~12 MB. Write to
// stdout only and let the redirect own the file.
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
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

// Step 5a.9: GA4 collection check — runs BEFORE the monitors and attribution
// steps below, because every one of them is downstream of GA4 actually
// collecting. A Shopify app disconnect trashed the property on 2026-07-26 and
// nothing noticed for 8 days: /g/collect answers 204 for a trashed property and
// the Admin API still reads it, so empty reports look identical to a quiet week.
// This asserts the property is not in the trash and that a real page load comes
// back out of the Realtime API. Emails immediately on failure — paid spend and
// every CVR number depend on it.
runStep('verify-ga4-collect', `"${NODE}" scripts/verify-ga4-collect.mjs`);

// Step 5b: rank alerter — flag sudden position changes
runStep('rank-alerter', `"${NODE}" agents/rank-alerter/index.js`);

// Step 5b.0a: Google Ads conversion upload — MUST run before shopping-test-monitor,
// which reports the ROAS these conversions feed. Uploads Shopify purchases carrying a
// Google click id to Ads as offline conversions (Data Manager API).
// Google Ads counted 0 conversions Apr–Aug 2026 because its only counted purchase
// action was a GA4 import and GA4 missed most of the data (264 ad clicks → 85 GA4
// sessions; 7 orders → 4 GA4 transactions). Uploading from the order book is immune to
// that client-side loss. Idempotent — Google dedupes on the Shopify order number, so
// re-scanning the same window daily cannot double-count.
runStep('ads-conversion-uploader', `"${NODE}" agents/ads-conversion-uploader/index.js`);

// Step 5b.1: shopping-test monitor — spend/clicks/conv/ROAS for the paid Shopping
// test campaigns. Cheap (2 GAQL queries, no LLM). Reports into the daily digest;
// flags only genuinely dead spend (gate: ~1× ROAS is a win, no auto-pause).
runStep('shopping-test-monitor', `"${NODE}" agents/shopping-test-monitor/index.js`);

// Step 5b.1a: pagespeed monitor — mobile+desktop Lighthouse scores for commercial
// pages (config/pagespeed.json) → data/snapshots/pagespeed/. Flags score regressions
// vs. the prior snapshot into the daily digest. Cheap (PSI API, no LLM).
runStep('pagespeed-monitor', `"${NODE}" agents/pagespeed-monitor/index.js`);

// Step 5b.1b: RUM monitor — aggregates the real-user Core Web Vitals beacons the
// storefront sends to the dashboard's /api/rum collector into p75 by page and
// device. This is the field counterpart to pagespeed-monitor above: CrUX has no
// data for this origin (traffic is below Google's reporting threshold), so
// without this the only speed signal is Lighthouse's throttled lab emulation.
// Prunes raw beacon files past their retention window on the way through.
runStep('rum-monitor', `"${NODE}" agents/rum-monitor/index.js --days 7`);
runStep('rum-monitor-prune', `"${NODE}" agents/rum-monitor/index.js --prune`);

// Step 5b.2: amazon snapshot — WEEKLY (Sundays). RSC Amazon net (post-Finance-role),
// fees, per-ASIN net, and hero-lotion stockout guard → data/snapshots/amazon/ + digest.
// Weekly, not daily: the 30-day finance pull is heavy and Amazon data moves slowly.
if (new Date().getDay() === 0) {
  runStep('amazon-snapshot', `"${NODE}" agents/amazon-snapshot/index.js`);
} else {
  log('  amazon-snapshot: skipped (weekly, Sundays only)');
}

// Step 5b.3: shopping calibrator — WEEKLY (Sundays, after the SQP pull settles).
// Joins Google Shopping search terms to Amazon SQP purchase data so paid search
// is tuned on what actually SELLS rather than on what we happened to spend on.
// Auto-negates queries where the market clears far below our price (a 3x price
// gap is not a bidding problem); never negates a query that produced a sale.
if (new Date().getDay() === 0) {
  runStep('shopping-calibrator', `"${NODE}" agents/shopping-calibrator/index.js${dryFlag ? '' : ' --apply'}`);
} else {
  log('  shopping-calibrator: skipped (weekly, Sundays only)');
}

// Step 5c: insight-aggregator moved to the Sunday block below. It was the single
// largest line item in the fleet's LLM bill — ~370k input tokens per call, 41% of
// all input tokens, $9.72 of a $26.74 week — because it re-reads every changed
// report and runs daily. Its output is standing guidance other agents load at
// startup, and guidance synthesized from a week of reports is steadier than
// guidance that churns every morning under the writer.

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

// Step 5f.1: resolve hard-blocked posts. Runs AFTER legacy-rebuilder (and after
// the link-repair + editor + publisher work in Step 3) so it sees the freshest
// editor verdicts and only picks up what those left blocked.
//
// This closes the loop the digest could not: "Action Required — N posts
// hard-blocked" appeared every morning and nothing acted on it, so three LIVE
// HTTP-200 pages sat flagged from 2026-08-16 to 2026-08-22. --apply because the
// scheduled path applies (Autonomy Principle); the repair loop still pushes only
// a revision that PASSES the gate, and on exhaustion it softens the claim and
// leaves the page live rather than ever unpublishing it.
runStep('blocked-post-resolver', `"${NODE}" agents/blocked-post-resolver/index.js --limit 5${dryFlag ? '' : ' --apply'}`);

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

// gsc-query-miner — WEEKLY (Sundays), immediately before the index build so a
// fresh untapped-candidates feed is on disk when the builder reads it. Surfaces
// queries with impressions and zero clicks, which the index's conversion-based
// qualification can never admit on its own. One Anthropic call per run.
if (new Date().getDay() === 0) {
  if (!dryFlag) {
    runStep('gsc-query-miner', `"${NODE}" agents/gsc-query-miner/index.js`);
  } else {
    log('  gsc-query-miner: skipped (dry-run — makes a live Anthropic call and overwrites untapped-candidates.json, a real keyword-index build input)');
  }
} else {
  log('  gsc-query-miner: skipped (weekly, Sundays only)');
}

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

  // Refresh the writer's standing rules once a week (moved from the daily block —
  // see Step 5c above for why). Runs first among the weekly jobs so the rest of
  // Sunday's work reads freshly-synthesized guidance.
  runStep('insight-aggregator', `"${NODE}" agents/insight-aggregator/index.js`, { indent: '    ' });

  // Bing Webmaster snapshot → data/snapshots/bing/. WEEKLY because Bing's own data
  // refreshes weekly: GetQueryStats returns ~26 distinct dates across a 177-day
  // traffic window, so a daily job would write six identical files a week. Lives in
  // the scheduler rather than in its own 13:xx crontab entry with the daily
  // collectors — this feed is not a daily one and does not belong in that row.
  // Cheap (3 GETs, no LLM). It is the only query-level view of the index DuckDuckGo
  // serves from, and holds ~6 months of history where GA4 now retains 2.
  runStep('bing-collector', `"${NODE}" agents/bing-collector/index.js`, { indent: '    ' });

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
  // REMOVED FROM THE SCHEDULE 2026-07-27. Running it weekly produced 62 live
  // collections for 9 distinct products — near-duplicate pages that split
  // ranking signal and earned 51 clicks on 93,785 impressions in 90 days. The
  // agent remains in the repo for deliberate manual use; it no longer runs on a
  // timer. A collection is now created only where a category holds 2+ distinct
  // products. See the 2026-07-27 collection-consolidation spec.
  // runStep('collection-creator --from-opportunities', `"${NODE}" agents/collection-creator/index.js --from-opportunities --queue${dryFlag}`, { indent: '    ' });

  // Step 7b: publish approved new collections
  // REMOVED FROM THE SCHEDULE 2026-07-27 (see Step 7a comment).
  // if (!dryFlag) {
  //   runStep('collection-creator --publish-approved', `"${NODE}" agents/collection-creator/index.js --publish-approved`, { indent: '    ' });
  // }

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

  // Step 13: voice-of-customer — mine Judge.me reviews + Reddit/SERP friction into
  // data/context/{voice-of-customer,personas}.md and personas.json. Monthly because
  // reviews accrue a handful a week and Reddit sentiment moves slowly.
  runStep('voice-of-customer', `"${NODE}" agents/voice-of-customer/index.js`, { indent: '    ' });

  // Step 14: demand-miner — seeds Google PAA/related-search harvesting from GSC
  // impression leaks + persona objections, classifies each question by funnel stage.
  // Must run AFTER voice-of-customer: it reads data/context/personas.json, which
  // voice-of-customer rewrites in this same block, and running first would seed
  // from last month's personas instead of the ones just written.
  runStep('demand-miner', `"${NODE}" agents/demand-miner/index.js`, { indent: '    ' });
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
