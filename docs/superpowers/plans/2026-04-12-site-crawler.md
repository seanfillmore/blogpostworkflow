# Site Crawler Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Ahrefs CSV-based technical SEO auditing with automated DataForSEO On-Page API crawling.

**Architecture:** New `agents/site-crawler/index.js` handles the crawl lifecycle (submit → poll → fetch → normalize → save). Three new methods added to `lib/dataforseo.js`. The existing technical-seo agent gains a new data loader that reads crawl results instead of CSVs. The scheduler runs the crawler weekly.

**Tech Stack:** DataForSEO On-Page API v3, Node.js ES modules

---

### Task 1: Add On-Page API methods to lib/dataforseo.js

**Files:**
- Modify: `lib/dataforseo.js`

- [ ] **Step 1: Add the `startCrawl` method**

Append after the `getBalance` function at the end of `lib/dataforseo.js`:

```js
// ── On-Page Crawl ─────────────────────────────────────────────────────────────

/**
 * Start a site crawl via the On-Page API.
 * @param {string} domain - e.g. "www.realskincare.com"
 * @param {object} opts
 * @returns {{ taskId: string, cost: number }}
 */
export async function startCrawl(domain, { maxPages = 1000, loadResources = true } = {}) {
  const res = await fetch(`${BASE}/on_page/task_post`, {
    method: 'POST',
    headers: { Authorization: `Basic ${AUTH}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([{
      target: domain,
      max_crawl_pages: maxPages,
      load_resources: loadResources,
      enable_javascript: false,
      respect_sitemap: true,
      store_raw_html: false,
    }]),
  });
  if (!res.ok) throw new Error(`DataForSEO task_post → ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const task = data.tasks?.[0];
  if (!task || task.status_code !== 20100) {
    throw new Error(`DataForSEO task_post: ${task?.status_message || 'no task returned'}`);
  }
  return { taskId: task.id, cost: data.cost || 0 };
}

/**
 * Get crawl progress summary.
 * @param {string} taskId
 * @returns {{ progress: string, pagesCrawled: number, pagesInQueue: number, maxPages: number }}
 */
export async function getCrawlSummary(taskId) {
  const result = await apiGet(`/on_page/summary/${taskId}`);
  const r = result[0] || {};
  return {
    progress: r.crawl_progress || 'unknown',
    pagesCrawled: r.crawl_status?.pages_crawled ?? 0,
    pagesInQueue: r.crawl_status?.pages_in_queue ?? 0,
    maxPages: r.crawl_status?.max_crawl_pages ?? 0,
  };
}

/**
 * Fetch crawled page results.
 * @param {string} taskId
 * @param {object} opts
 * @returns {Array<object>} raw page objects from DataForSEO
 */
export async function getCrawlPages(taskId, { offset = 0, limit = 1000 } = {}) {
  const { result } = await api(`/on_page/pages`, {
    id: taskId,
    limit,
    offset,
  });
  return result[0]?.items || [];
}
```

- [ ] **Step 2: Verify the module parses without errors**

Run: `node -e "import('./lib/dataforseo.js').then(() => console.log('OK'))"`

Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add lib/dataforseo.js
git commit -m "feat: add On-Page crawl methods to DataForSEO client"
```

---

### Task 2: Create the site-crawler agent

**Files:**
- Create: `agents/site-crawler/index.js`

- [ ] **Step 1: Create the agent directory**

```bash
mkdir -p agents/site-crawler
```

- [ ] **Step 2: Write the agent**

Create `agents/site-crawler/index.js`:

```js
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
import { startCrawl, getCrawlSummary, getCrawlPages } from '../../lib/dataforseo.js';
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

function pageType(url) {
  if (url.includes('/blogs/')) return 'article';
  if (url.includes('/products/')) return 'product';
  if (url.includes('/collections/')) return 'collection';
  if (url.includes('/pages/')) return 'page';
  return 'other';
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

    // 404 pages
    if (statusCode >= 400) {
      issues.error_404.push(row);
      continue;
    }

    if (!isIndexable) continue;

    // Meta description issues
    if (!p.meta?.description || metaDescLen === 0) {
      issues.meta_missing.push(row);
    } else if (metaDescLen > 160) {
      issues.meta_too_long.push(row);
    } else if (metaDescLen < 70) {
      issues.meta_too_short.push(row);
    }

    // Title too long
    if (titleLen > 60) {
      issues.title_too_long.push(row);
    }

    // H1 missing
    if (checks.no_h1_tag) {
      issues.h1_missing.push(row);
    }

    // Missing alt text
    if (checks.no_image_alt) {
      issues.alt_missing.push(row);
    }

    // Redirect chain
    if (checks.redirect_chain) {
      issues.redirect_chain.push(row);
    }

    // Duplicate meta/title
    if (checks.duplicate_description) {
      issues.duplicate_meta.push(row);
    }
    if (checks.duplicate_title) {
      issues.duplicate_title.push(row);
    }

    // Orphan pages (no inbound internal links)
    if (inlinks === 0) {
      issues.orphan.push(row);
    } else if (inlinks === 1) {
      issues.single_link.push(row);
    }

    // Links to broken or redirected pages
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

async function main() {
  const domain = getDomain();
  console.log(`\nSite Crawler — ${config.name}`);
  console.log(`  Domain: ${domain}\n`);

  // 1. Submit crawl
  console.log('  Submitting crawl task...');
  const { taskId, cost } = await startCrawl(domain);
  console.log(`  Task ID: ${taskId} (cost: $${cost})`);

  // 2. Poll until finished
  const POLL_INTERVAL = 30_000; // 30 seconds
  const TIMEOUT = 15 * 60_000; // 15 minutes
  const startTime = Date.now();

  while (true) {
    if (Date.now() - startTime > TIMEOUT) {
      throw new Error('Crawl timed out after 15 minutes');
    }

    const summary = await getCrawlSummary(taskId);
    console.log(`  Progress: ${summary.progress} — ${summary.pagesCrawled} crawled, ${summary.pagesInQueue} in queue`);

    if (summary.progress === 'finished') break;
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
```

- [ ] **Step 3: Commit**

```bash
git add agents/site-crawler/index.js
git commit -m "feat: add site-crawler agent — DataForSEO On-Page API"
```

---

### Task 3: Add crawl results loader to technical-seo agent

**Files:**
- Modify: `agents/technical-seo/index.js`

- [ ] **Step 1: Add `loadCrawlResults` function**

In `agents/technical-seo/index.js`, add this function after `loadAllCSVs()` (after line 151):

```js
function loadCrawlResults() {
  const crawlPath = join(CSV_DIR, 'crawl-results.json');
  if (!existsSync(crawlPath)) return null;

  let data;
  try { data = JSON.parse(readFileSync(crawlPath, 'utf8')); } catch { return null; }

  // Check freshness — skip if older than 14 days
  const age = Date.now() - new Date(data.crawled_at).getTime();
  if (age > 14 * 24 * 60 * 60 * 1000) return null;

  const issues = data.issues || {};

  // Map crawl issue categories to Ahrefs CSV key names
  return {
    'Error-404_page': issues.error_404 || [],
    'Warning-indexable-Meta_description_tag_missing_or_empty': issues.meta_missing || [],
    'Warning-indexable-Meta_description_too_long': issues.meta_too_long || [],
    'Warning-indexable-Meta_description_too_short': issues.meta_too_short || [],
    'Warning-indexable-Title_too_long': issues.title_too_long || [],
    'Warning-indexable-H1_tag_missing_or_empty': issues.h1_missing || [],
    'Warning-Missing_alt_text': issues.alt_missing || [],
    'Notice-Redirect_chain': issues.redirect_chain || [],
    'Error-indexable-Multiple_meta_description_tags': issues.duplicate_meta || [],
    'Error-indexable-Multiple_title_tags': issues.duplicate_title || [],
    'Error-indexable-Orphan_page_(has_no_incoming_internal_links)': issues.orphan || [],
    'Notice-indexable-Page_has_only_one_dofollow_incoming_internal_link': issues.single_link || [],
    'Error-indexable-Page_has_links_to_broken_page': issues.links_to_404 || [],
    'Warning-indexable-Page_has_links_to_redirect': issues.links_to_redirect || [],
  };
}
```

- [ ] **Step 2: Update the `audit()` function to prefer crawl results**

Find this line in the `audit()` function (around line 317-318):

```js
  console.log('\nLoading all Ahrefs CSV files...\n');
  const csvs = loadAllCSVs();
```

Replace with:

```js
  let csvs = loadCrawlResults();
  if (csvs) {
    console.log('\nLoading crawl results from DataForSEO...\n');
  } else {
    console.log('\nNo recent crawl data found — loading Ahrefs CSV files...\n');
    csvs = loadAllCSVs();
  }
```

- [ ] **Step 3: Commit**

```bash
git add agents/technical-seo/index.js
git commit -m "feat: technical-seo reads DataForSEO crawl results, falls back to CSV"
```

---

### Task 4: Add site-crawler to the scheduler

**Files:**
- Modify: `scheduler.js`

- [ ] **Step 1: Add the site-crawler step**

In `scheduler.js`, find the weekly jobs section (around line 148). Add the site-crawler step before the cannibalization resolver (before line 162). Insert after the collection-creator publish step:

Find:
```js
  // Step 8: cannibalization detection + resolution
```

Insert before it:
```js
  // Step 7c: site crawl via DataForSEO On-Page API
  runStep('site-crawler', `"${NODE}" agents/site-crawler/index.js`, { indent: '    ' });

```

- [ ] **Step 2: Commit**

```bash
git add scheduler.js
git commit -m "feat: add site-crawler to weekly scheduler"
```

---

### Task 5: Run initial crawl and verify

- [ ] **Step 1: Run the site-crawler on the server**

```bash
ssh root@137.184.119.230 'cd ~/seo-claude && node agents/site-crawler/index.js'
```

Wait for crawl to complete (~2-5 minutes). Expected output:
```
Site Crawler — Real Skin Care
  Domain: www.realskincare.com

  Submitting crawl task...
  Task ID: <uuid> (cost: $0.125)
  Progress: in_progress — 0 crawled, ... in queue
  ...
  Progress: finished — N crawled, 0 in queue

  Fetching page results...
    Fetched N pages so far...
  Total pages fetched: N

  Issues found: error_404: X, meta_missing: Y, ...
  Saved: data/technical_seo/crawl-results.json

Crawl complete.
```

- [ ] **Step 2: Run the technical-seo audit using crawl data**

```bash
ssh root@137.184.119.230 'cd ~/seo-claude && node agents/technical-seo/index.js audit 2>&1 | head -30'
```

Expected: should print "Loading crawl results from DataForSEO..." (not "Loading Ahrefs CSV files")

- [ ] **Step 3: Commit and push all changes, deploy**

```bash
git push
ssh root@137.184.119.230 'cd ~/seo-claude && git pull && pm2 restart seo-dashboard'
```
