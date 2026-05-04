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
import { startCrawl, getCrawlSummary, getCrawlPages, getCrawlLinks, getCrawlTasksReady } from '../../lib/dataforseo.js';
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
    // links_to_404 / error_404 are populated separately via verifyBrokenLinks()
    // because DataForSEO's checks.broken_links field doesn't fire reliably and
    // page_to_status_code is null for any URL the crawler didn't visit.
  }

  return issues;
}

// Walks the on_page/links graph, identifies internal targets DataForSEO
// didn't visit (page_to_status_code: null), and HEAD-verifies them ourselves.
// Returns the broken targets and a per-source-page map of broken hrefs so the
// technical-seo agent can drive create-redirects + fix-links from the result.
async function verifyBrokenLinks(allLinks) {
  const targets = new Map(); // link_to → { sources: Set, status, isBroken }
  for (const l of allLinks) {
    if (!l.link_to) continue;
    const t = l.link_to;
    if (!targets.has(t)) targets.set(t, { sources: new Set(), status: null, isBroken: false });
    const e = targets.get(t);
    if (l.link_from) e.sources.add(l.link_from);
    if (l.page_to_status_code != null && e.status == null) e.status = l.page_to_status_code;
    if (l.is_broken) e.isBroken = true;
  }

  const dfsBroken = [];
  const candidates = [];
  for (const [url, e] of targets.entries()) {
    if (e.isBroken || (e.status != null && e.status >= 400)) {
      dfsBroken.push({ url, status: e.status || 404, sources: [...e.sources] });
      continue;
    }
    if (e.status != null) continue; // DFS confirmed live
    if (url.includes('?variant=')) continue; // Shopify product variant noise
    if (url.includes('sitemap_') && url.includes('?from=')) continue;
    if (url.includes('#')) continue;
    candidates.push({ url, sources: [...e.sources] });
  }

  console.log(`    Link graph: ${targets.size} unique targets, ${dfsBroken.length} pre-flagged broken, ${candidates.length} to HEAD-verify`);

  const UA = 'Mozilla/5.0 (compatible; SEO-Claude-Bot/1.0; broken-link-check)';
  async function checkOnce(url, attempt = 0) {
    try {
      const r = await fetch(url, { method: 'HEAD', redirect: 'follow', headers: { 'User-Agent': UA } });
      if (r.status === 429 && attempt < 3) {
        await new Promise((res) => setTimeout(res, 1000 * (attempt + 1)));
        return checkOnce(url, attempt + 1);
      }
      return r.status;
    } catch { return null; }
  }

  const newlyBroken = [];
  let idx = 0;
  async function worker() {
    while (idx < candidates.length) {
      const c = candidates[idx++];
      const status = await checkOnce(c.url);
      if (status != null && status !== 429 && status >= 400) {
        newlyBroken.push({ ...c, status });
      }
      await new Promise((res) => setTimeout(res, 200));
    }
  }
  await Promise.all(Array(4).fill(0).map(worker));

  console.log(`    HEAD-verify found ${newlyBroken.length} additional broken URLs`);
  return [...dfsBroken, ...newlyBroken];
}

function rowFromTarget(t) {
  return {
    url: t.url,
    title: '',
    pr: '',
    status_code: t.status,
    meta_description_length: 0,
    title_length: 0,
    'no._of_all_inlinks': t.sources.length,
  };
}

function rowFromSource(sourceUrl, brokenHrefs, pages) {
  const p = pages.find((pp) => pp.url === sourceUrl);
  const joined = brokenHrefs.join('\n');
  return {
    url: sourceUrl,
    title: p?.meta?.title || '',
    pr: '',
    status_code: p?.status_code || 200,
    meta_description_length: p?.meta?.description_length ?? 0,
    title_length: p?.meta?.title_length ?? 0,
    'no._of_all_inlinks': p?.meta?.internal_links_count ?? 0,
    'internal_outlinks_to_4xx': joined,
    'internal_outlinks_codes_(4xx)': joined,
  };
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
  const TIMEOUT = 60 * 60_000;
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

  // 4b. Discover broken links via the link graph + HEAD verification.
  // DataForSEO's per-page checks.broken_links flag doesn't fire for targets the
  // crawler didn't visit, so we walk on_page/links and verify unvisited targets.
  console.log('\n  Fetching link graph for broken-link discovery...');
  const allLinks = await getCrawlLinks(taskId);
  console.log(`    ${allLinks.length} internal link records`);
  const brokenTargets = await verifyBrokenLinks(allLinks);

  for (const t of brokenTargets) {
    issues.error_404.push(rowFromTarget(t));
  }

  const brokenBySource = new Map(); // sourceUrl → broken href[]
  for (const t of brokenTargets) {
    for (const src of t.sources) {
      if (!brokenBySource.has(src)) brokenBySource.set(src, []);
      brokenBySource.get(src).push(t.url);
    }
  }
  for (const [sourceUrl, brokenHrefs] of brokenBySource.entries()) {
    issues.links_to_404.push(rowFromSource(sourceUrl, brokenHrefs, allPages));
  }

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
