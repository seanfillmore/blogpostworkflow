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

const args = process.argv.slice(2);
const dryFlag = args.includes('--dry-run') ? ' --dry-run' : '';

log('──────────────────────────────────────────────────────────────────');
log('Content Scheduler starting');

// Defer all notifications from this process and any child processes to the daily summary
process.env.NOTIFY_DEFERRED = '1';

// Step 0: daily review monitor
const NODE = process.execPath; // full path to the running node binary

const reviewCmd = `"${NODE}" agents/review-monitor/index.js`;
log(`  ${reviewCmd}`);
try {
  execSync(reviewCmd, { stdio: 'inherit', cwd: __dirname });
  log('  ✓ review-monitor complete');
} catch (e) {
  log(`  ✗ review-monitor failed (exit ${e.status})`);
}

// Step 1: flip any scheduled drafts that are due live (+ post-publish steps)

const publishDueCmd = `"${NODE}" agents/calendar-runner/index.js --publish-due${dryFlag}`;
log(`  ${publishDueCmd}`);
try {
  execSync(publishDueCmd, { stdio: 'inherit', cwd: __dirname });
  log('  ✓ publish-due complete');
} catch (e) {
  log(`  ✗ publish-due failed (exit ${e.status})`);
}

// Step 2: run the next pending calendar item through the full pipeline
const runCmd = `"${NODE}" agents/calendar-runner/index.js --run${dryFlag}`;
log(`  ${runCmd}`);
try {
  execSync(runCmd, { stdio: 'inherit', cwd: __dirname });
  log('  ✓ calendar-runner complete');
} catch (e) {
  log(`  ✗ calendar-runner failed (exit ${e.status})`);
}

// Step 3: auto-repair broken links in any published/scheduled post
if (!dryFlag) {
  const POSTS_DIR   = join(__dirname, 'data', 'posts');
  const REPORTS_DIR = join(__dirname, 'data', 'reports', 'editor');
  const brokenSlugs = [];

  if (existsSync(POSTS_DIR) && existsSync(REPORTS_DIR)) {
    for (const f of readdirSync(POSTS_DIR).filter(f => f.endsWith('.json'))) {
      try {
        const meta = JSON.parse(readFileSync(join(POSTS_DIR, f), 'utf8'));
        if (!meta.shopify_article_id) continue; // not on Shopify yet
        const slug = f.replace('.json', '');
        const reportPath = join(REPORTS_DIR, `${slug}-editor-report.md`);
        if (!existsSync(reportPath)) continue;
        const report = readFileSync(reportPath, 'utf8');
        const has404 = /\|\s*https?:\/\/[^|]+\|\s*[^|]*\|\s*404\s*\|/m.test(report);
        if (has404) brokenSlugs.push(slug);
      } catch { /* skip */ }
    }
  }

  if (brokenSlugs.length > 0) {
    log(`  Link repair: ${brokenSlugs.length} post(s) with broken links detected`);
    for (const slug of brokenSlugs) {
      log(`    Repairing: ${slug}`);
      try {
        execSync(`"${NODE}" agents/link-repair/index.js ${slug}`, { stdio: 'inherit', cwd: __dirname });
        // Re-run editor to update the report (clears broken link count in dashboard)
        execSync(`"${NODE}" agents/editor/index.js data/posts/${slug}.html`, { stdio: 'inherit', cwd: __dirname });
        // Re-upload the fixed body to Shopify (--force skips editor gate since post is already live)
        // Preserve shopify_publish_at if it's in the future (keeps scheduled posts from going live immediately)
        const meta = JSON.parse(readFileSync(join(POSTS_DIR, `${slug}.json`), 'utf8'));
        const futurePublishAt = meta.shopify_publish_at && new Date(meta.shopify_publish_at) > new Date()
          ? ` --publish-at "${meta.shopify_publish_at}"` : '';
        execSync(`"${NODE}" agents/publisher/index.js data/posts/${slug}.json --force${futurePublishAt}`, { stdio: 'inherit', cwd: __dirname });
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
const pubProductCmd = `"${NODE}" agents/product-optimizer/index.js --publish-approved`;
log(`  ${pubProductCmd}`);
try {
  execSync(pubProductCmd, { stdio: 'inherit', cwd: __dirname });
  log('  ✓ product meta publish-approved complete');
} catch (e) {
  log(`  ✗ product meta publish-approved failed (exit ${e.status})`);
}

// Step 4b: publish approved collection content
const pubCollectionCmd = `"${NODE}" agents/collection-content-optimizer/index.js --publish-approved`;
log(`  ${pubCollectionCmd}`);
try {
  execSync(pubCollectionCmd, { stdio: 'inherit', cwd: __dirname });
  log('  ✓ collection content publish-approved complete');
} catch (e) {
  log(`  ✗ collection content publish-approved failed (exit ${e.status})`);
}

// Step 4c: pages from GSC
const pagesCmd = `"${NODE}" agents/product-optimizer/index.js --pages-from-gsc${dryFlag}`;
log(`  ${pagesCmd}`);
try {
  execSync(pagesCmd, { stdio: 'inherit', cwd: __dirname });
  log('  ✓ pages-from-gsc complete');
} catch (e) {
  log(`  ✗ pages-from-gsc failed (exit ${e.status})`);
}

// Step 5: run collection linker to inject cross-links from blog posts to collections
const collLinkCmd = `"${NODE}" agents/collection-linker/index.js --top-targets --apply${dryFlag}`;
log(`  ${collLinkCmd}`);
try {
  execSync(collLinkCmd, { stdio: 'inherit', cwd: __dirname });
  log('  ✓ collection-linker complete');
} catch (e) {
  log(`  ✗ collection-linker failed (exit ${e.status})`);
}

// Step 5b: rank alerter — flag sudden position changes
const rankAlertCmd = `"${NODE}" agents/rank-alerter/index.js`;
log(`  ${rankAlertCmd}`);
try {
  execSync(rankAlertCmd, { stdio: 'inherit', cwd: __dirname });
  log('  ✓ rank-alerter complete');
} catch (e) {
  log(`  ✗ rank-alerter failed (exit ${e.status})`);
}

// Step 5c: insight aggregator — refresh writer standing rules
const insightCmd = `"${NODE}" agents/insight-aggregator/index.js`;
log(`  ${insightCmd}`);
try {
  execSync(insightCmd, { stdio: 'inherit', cwd: __dirname });
  log('  ✓ insight-aggregator complete');
} catch (e) {
  log(`  ✗ insight-aggregator failed (exit ${e.status})`);
}

// ── Weekly jobs (Sundays only) ───────────────────────────────────────────────
if (new Date().getDay() === 0) {
  log('  Weekly jobs (Sunday):');

  // Step 6: product schema with Judge.me reviews (GSC-filtered)
  const schemaCmd = `"${NODE}" agents/product-schema/index.js --auto --apply${dryFlag}`;
  log(`    ${schemaCmd}`);
  try {
    execSync(schemaCmd, { stdio: 'inherit', cwd: __dirname });
    log('    ✓ product-schema --auto complete');
  } catch (e) {
    log(`    ✗ product-schema --auto failed (exit ${e.status})`);
  }

  // Step 7a: collection gap detection from GSC opportunities
  const gapCmd = `"${NODE}" agents/collection-creator/index.js --from-opportunities --queue${dryFlag}`;
  log(`    ${gapCmd}`);
  try {
    execSync(gapCmd, { stdio: 'inherit', cwd: __dirname });
    log('    ✓ collection-creator --from-opportunities complete');
  } catch (e) {
    log(`    ✗ collection-creator --from-opportunities failed (exit ${e.status})`);
  }

  // Step 7b: publish approved new collections
  if (!dryFlag) {
    const gapPubCmd = `"${NODE}" agents/collection-creator/index.js --publish-approved`;
    log(`    ${gapPubCmd}`);
    try {
      execSync(gapPubCmd, { stdio: 'inherit', cwd: __dirname });
      log('    ✓ collection-creator --publish-approved complete');
    } catch (e) {
      log(`    ✗ collection-creator --publish-approved failed (exit ${e.status})`);
    }
  }

  // Step 8: cannibalization detection + resolution
  const cannCmd = `"${NODE}" agents/cannibalization-resolver/index.js --apply --report-json${dryFlag}`;
  log(`    ${cannCmd}`);
  try {
    execSync(cannCmd, { stdio: 'inherit', cwd: __dirname });
    log('    ✓ cannibalization-resolver complete');
  } catch (e) {
    log(`    ✗ cannibalization-resolver failed (exit ${e.status})`);
  }

  // Step 9: GA4 content analysis
  const ga4Cmd = `"${NODE}" agents/ga4-content-analyzer/index.js`;
  log(`    ${ga4Cmd}`);
  try {
    execSync(ga4Cmd, { stdio: 'inherit', cwd: __dirname });
    log('    ✓ ga4-content-analyzer complete');
  } catch (e) {
    log(`    ✗ ga4-content-analyzer failed (exit ${e.status})`);
  }

  // Step 9b: meta A/B tracker
  const metaAbCmd = `"${NODE}" agents/meta-ab-tracker/index.js${dryFlag}`;
  log(`    ${metaAbCmd}`);
  try {
    execSync(metaAbCmd, { stdio: 'inherit', cwd: __dirname });
    log('    ✓ meta-ab-tracker complete');
  } catch (e) {
    log(`    ✗ meta-ab-tracker failed (exit ${e.status})`);
  }

  // Step 9c: backlink monitoring
  const backlinkCmd = `"${NODE}" agents/backlink-monitor/index.js`;
  log(`    ${backlinkCmd}`);
  try {
    execSync(backlinkCmd, { stdio: 'inherit', cwd: __dirname });
    log('    ✓ backlink-monitor complete');
  } catch (e) {
    log(`    ✗ backlink-monitor failed (exit ${e.status})`);
  }

  // Step 9d: backlink opportunity detection
  const backlinkOppCmd = `"${NODE}" agents/backlink-opportunity/index.js`;
  log(`    ${backlinkOppCmd}`);
  try {
    execSync(backlinkOppCmd, { stdio: 'inherit', cwd: __dirname });
    log('    ✓ backlink-opportunity complete');
  } catch (e) {
    log(`    ✗ backlink-opportunity failed (exit ${e.status})`);
  }

  // Step 9e: blog post verifier — check published posts for broken links/facts
  const verifyCmd = `"${NODE}" agents/blog-post-verifier/index.js --limit 10`;
  log(`    ${verifyCmd}`);
  try {
    execSync(verifyCmd, { stdio: 'inherit', cwd: __dirname });
    log('    ✓ blog-post-verifier complete');
  } catch (e) {
    log(`    ✗ blog-post-verifier failed (exit ${e.status})`);
  }

} else {
  log('  Weekly jobs: skipped (not Sunday)');
}

// ── Monthly jobs (1st of month) ──────────────────────────────────────────────
if (new Date().getDate() === 1) {
  log('  Monthly jobs (1st):');

  const themeCmd = `"${NODE}" agents/theme-seo-auditor/index.js`;
  log(`    ${themeCmd}`);
  try {
    execSync(themeCmd, { stdio: 'inherit', cwd: __dirname });
    log('    ✓ theme-seo-auditor complete');
  } catch (e) {
    log(`    ✗ theme-seo-auditor failed (exit ${e.status})`);
  }
} else {
  log('  Monthly jobs: skipped (not 1st)');
}

log('Scheduler done.');
await notifyLatestReport('Scheduler completed', LOG_DIR);
