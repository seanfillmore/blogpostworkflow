/**
 * Site Crawler Agent
 *
 * Crawls the site via DataForSEO On-Page API, normalizes results into
 * categorized issues, and saves them for the technical-seo agent.
 *
 * Usage:
 *   node agents/site-crawler/index.js
 *
 * Output: data/technical_seo/crawl-results.json
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCrawl, getCrawlSummary, getCrawlPages, getCrawlTasksReady } from '../../lib/dataforseo.js';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const OUTPUT_DIR = join(ROOT, 'data', 'technical_seo');
const OUTPUT_PATH = join(OUTPUT_DIR, 'crawl-results.json');

const config = JSON.parse(readFileSync(join(ROOT, 'config', 'site.json'), 'utf8'));

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function getDomain() {
  return config.url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

// ── Normalize DataForSEO page data into issue categories ─────────────────────

function normalizePages(pages) {
  const issues = {
    error_404: [],
    meta_missing: [],
    meta_too_long: [],
    meta_too_short: [],
    title_too_long: [],
    h1_missing: [],
    alt_missing: [],
    redirect_chain: [],
    duplicate_meta: [],
    duplicate_title: [],
    orphan: [],
    single_link: [],
    links_to_404: [],
    links_to_redirect: [],
  };

  for (const p of pages) {
    const url = p.url || '';
    const title = p.meta?.title || '';
    const checks = p.checks || {};
    const statusCode = p.status_code || 200;
    const inlinks = p.meta?.internal_links_count ?? 0;
    const metaDescLen = p.meta?.description_length ?? 0;
    const titleLen = p.meta?.title_length ?? 0;
    const isIndexable = !checks.is_redirect && statusCode < 300;

    const row = {
      url,
      title,
      pr: '',
      status_code: statusCode,
      meta_description_length: metaDescLen,
      title_length: titleLen,
      'no._of_all_inlinks': inlinks,
    };

    if (statusCode >= 400) {
      issues.error_404.push(row);
      continue;
    }

    if (!isIndexable) continue;

    if (!p.meta?.description || metaDescLen === 0) {
      issues.meta_missing.push(row);
    } else if (metaDescLen > 160) {
      issues.meta_too_long.push(row);
    } else if (metaDescLen < 70) {
      issues.meta_too_short.push(row);
    }

    if (titleLen > 60) {
      issues.title_too_long.push(row);
    }

    if (checks.no_h1_tag) {
      issues.h1_missing.push(row);
    }

    if (checks.no_image_alt) {
      issues.alt_missing.push(row);
    }

    if (checks.redirect_chain) {
      issues.redirect_chain.push(row);
    }

    if (checks.duplicate_description) {
      issues.duplicate_meta.push(row);
    }
    if (checks.duplicate_title) {
      issues.duplicate_title.push(row);
    }

    if (inlinks === 0) {
      issues.orphan.push(row);
    } else if (inlinks === 1) {
      issues.single_link.push(row);
    }

    if (checks.has_links_to_redirects) {
      issues.links_to_redirect.push(row);
    }
    if (checks.broken_links) {
      issues.links_to_404.push(row);
    }
  }

  return issues;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function findReadyTask(domain) {
  try {
    const tasks = await getCrawlTasksReady();
    const match = tasks.find((t) => t.target === domain);
    return match ? match.id : null;
  } catch { return null; }
}

async function main() {
  const domain = getDomain();
  console.log(`\nSite Crawler — ${config.name}`);
  console.log(`  Domain: ${domain}\n`);

  // 1. Check for an already-finished task first
  let taskId;
  const readyId = await findReadyTask(domain);
  if (readyId) {
    taskId = readyId;
    console.log(`  Found ready task: ${taskId}`);
  } else {
    // Submit new crawl
    console.log('  Submitting crawl task...');
    const { taskId: newId, cost } = await startCrawl(domain);
    taskId = newId;
    console.log(`  Task ID: ${taskId} (cost: $${cost})`);
  }

  // 2. Poll until finished (skip if already ready)
  const POLL_INTERVAL = 30_000;
  const TIMEOUT = 30 * 60_000;
  const startTime = Date.now();

  while (true) {
    const summary = await getCrawlSummary(taskId);
    console.log(`  Progress: ${summary.progress} — ${summary.pagesCrawled} crawled, ${summary.pagesInQueue} in queue`);

    if (summary.progress === 'finished') break;

    if (Date.now() - startTime > TIMEOUT) {
      throw new Error('Crawl timed out after 30 minutes');
    }
    await sleep(POLL_INTERVAL);
  }

  // 3. Fetch all page results
  console.log('\n  Fetching page results...');
  const allPages = [];
  let offset = 0;
  const PAGE_SIZE = 1000;

  while (true) {
    const batch = await getCrawlPages(taskId, { offset, limit: PAGE_SIZE });
    if (batch.length === 0) break;
    allPages.push(...batch);
    console.log(`    Fetched ${allPages.length} pages so far...`);
    if (batch.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  console.log(`  Total pages fetched: ${allPages.length}`);

  // 4. Normalize into issue categories
  const issues = normalizePages(allPages);

  const issueSummary = Object.entries(issues)
    .filter(([, arr]) => arr.length > 0)
    .map(([cat, arr]) => `${cat}: ${arr.length}`)
    .join(', ');
  console.log(`\n  Issues found: ${issueSummary || 'none'}`);

  // 5. Save
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const result = {
    crawled_at: new Date().toISOString(),
    task_id: taskId,
    pages_crawled: allPages.length,
    domain,
    issues,
  };
  writeFileSync(OUTPUT_PATH, JSON.stringify(result, null, 2));
  console.log(`  Saved: ${OUTPUT_PATH}`);

  // 6. Notify
  const totalIssues = Object.values(issues).reduce((s, arr) => s + arr.length, 0);
  await notify({
    subject: `Site Crawler: ${allPages.length} pages crawled, ${totalIssues} issues`,
    body: `Domain: ${domain}\nPages crawled: ${allPages.length}\n\n${issueSummary || 'No issues found.'}`,
    status: totalIssues > 0 ? 'warning' : 'success',
  });

  console.log('\nCrawl complete.');
}

main().catch((err) => {
  notify({ subject: 'Site Crawler failed', body: err.message || String(err), status: 'error' });
  console.error('Error:', err.message);
  process.exit(1);
});
