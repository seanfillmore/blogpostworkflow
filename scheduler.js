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

// Step 1: flip any scheduled drafts that are due live (+ post-publish steps)
const NODE = process.execPath; // full path to the running node binary

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

log('Scheduler done.');
await notifyLatestReport('Scheduler completed', LOG_DIR);
