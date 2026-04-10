# Tier 3 — Platform-Level Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add review monitoring with sentiment-aware product descriptions, Puppeteer+Lighthouse theme auditing, static page SEO optimization, and automated A/B testing for all meta rewrites.

**Architecture:** Four independent workstreams: (1) new `review-monitor` agent + Judge.me lib extension + daily-summary/product-optimizer integration, (2) new `theme-seo-auditor` agent with Puppeteer rendering + Lighthouse scoring, (3) extend `product-optimizer` with `--pages-from-gsc` and `--expand-faq` modes, (4) new `lib/meta-test.js` shared module + auto-trigger in publish flows + extended `meta-ab-tracker` + dashboard card.

**Tech Stack:** Node.js (ESM), Puppeteer, Lighthouse, Judge.me API, Anthropic SDK, Shopify REST API, GSC API, existing `lib/` clients.

---

## File Structure

| Action | File | Responsibility |
|---|---|---|
| Modify | `lib/judgeme.js` | Add `fetchRecentReviews()` function |
| Create | `agents/review-monitor/index.js` | Daily review pull, sentiment classification, report |
| Create | `tests/agents/review-monitor.test.js` | Tests for review classification |
| Modify | `agents/daily-summary/index.js` | Add Reviews section |
| Modify | `agents/product-optimizer/index.js` | Add review sentiment to prompts + pages modes |
| Create | `agents/theme-seo-auditor/index.js` | Puppeteer+Lighthouse theme audit |
| Create | `tests/agents/theme-seo-auditor.test.js` | Tests for DOM audit logic |
| Create | `lib/meta-test.js` | Shared A/B test creation module |
| Create | `tests/lib/meta-test.test.js` | Tests for test file creation |
| Modify | `agents/meta-ab-tracker/index.js` | Extend revert to all resource types |
| Modify | `agents/collection-content-optimizer/index.js` | Call createMetaTest after publish |
| Modify | `agents/collection-creator/index.js` | Call createMetaTest after publish |
| Modify | `agents/dashboard/public/js/dashboard.js` | Add meta test card |
| Modify | `scheduler.js` | Add daily review-monitor, weekly meta-ab-tracker, monthly theme audit |
| Modify | `package.json` | Add lighthouse dep + npm scripts |
| Modify | `docs/signal-manifest.md` | Add new signal entries |

---

## Task 1: Judge.me lib — add `fetchRecentReviews` + tests

**Files:**
- Modify: `lib/judgeme.js`
- Create: `tests/lib/review-monitor.test.js`

- [ ] **Step 1: Write the test file**

```javascript
// tests/lib/review-monitor.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

function classifyReview(rating) {
  if (rating >= 4) return 'positive';
  if (rating === 3) return 'neutral';
  return 'negative';
}

const COMPLAINT_PATTERNS = ['thick', 'greasy', 'smell', 'irritat', 'burn', 'broke out', 'rash', 'sticky', 'dry', 'oily'];

function extractComplaintThemes(body) {
  const lower = body.toLowerCase();
  return COMPLAINT_PATTERNS.filter((p) => lower.includes(p));
}

test('classifyReview: 5 stars = positive', () => {
  assert.equal(classifyReview(5), 'positive');
  assert.equal(classifyReview(4), 'positive');
});

test('classifyReview: 3 stars = neutral', () => {
  assert.equal(classifyReview(3), 'neutral');
});

test('classifyReview: 1-2 stars = negative', () => {
  assert.equal(classifyReview(2), 'negative');
  assert.equal(classifyReview(1), 'negative');
});

test('extractComplaintThemes finds matching patterns', () => {
  const themes = extractComplaintThemes('This lotion is too thick and greasy for my skin');
  assert.deepEqual(themes, ['thick', 'greasy']);
});

test('extractComplaintThemes returns empty for positive review', () => {
  const themes = extractComplaintThemes('Love this product! Smooth and light.');
  assert.deepEqual(themes, []);
});

test('extractComplaintThemes handles partial matches', () => {
  const themes = extractComplaintThemes('Caused irritation on my face');
  assert.deepEqual(themes, ['irritat']);
});
```

- [ ] **Step 2: Run tests**

Run: `node --test tests/lib/review-monitor.test.js`
Expected: All 6 tests pass.

- [ ] **Step 3: Add `fetchRecentReviews` to `lib/judgeme.js`**

After the existing `fetchProductStats` function (after line 114), add:

```javascript
/**
 * Fetch all reviews from the last N days across all products.
 * Returns array of { product_handle, rating, reviewer, body, verified, created_at }.
 */
export async function fetchRecentReviews(days, shopDomain, apiToken) {
  const cutoff = new Date(Date.now() - days * 86400000);
  const qs = new URLSearchParams({ api_token: apiToken, shop_domain: shopDomain, per_page: '100' });
  const res = await fetch(`${JUDGEME_BASE}/reviews?${qs}`);
  if (!res.ok) {
    console.warn(`  Judge.me recent reviews → HTTP ${res.status} (skipping)`);
    return [];
  }
  const data = await res.json();
  return (data.reviews || [])
    .filter((r) => new Date(r.created_at) >= cutoff)
    .map((r) => ({
      product_external_id: r.product_external_id,
      rating: r.rating,
      reviewer: r.reviewer?.name || 'Anonymous',
      body: r.body || '',
      verified: r.reviewer?.verified_buyer === true,
      created_at: r.created_at,
    }));
}
```

- [ ] **Step 4: Commit**

```bash
git add lib/judgeme.js tests/lib/review-monitor.test.js
git commit -m "feat(judgeme): add fetchRecentReviews + review classification tests"
```

---

## Task 2: Review monitor agent

**Files:**
- Create: `agents/review-monitor/index.js`

- [ ] **Step 1: Write the agent**

Create `agents/review-monitor/index.js` following the standard agent pattern:

The agent:
1. Loads env for `JUDGEME_API_TOKEN` and `SHOPIFY_STORE`
2. Calls `fetchRecentReviews(days, shopDomain, apiToken)` from `lib/judgeme.js`
3. For each review: resolves product handle (Judge.me returns `product_external_id`, need to map back — use `fetchProductStats` for all products from Shopify `getProducts()` as a lookup, or simpler: call Judge.me `/products/-1` endpoint to get product handle from external_id)
4. Classifies each review: positive (4-5), neutral (3), negative (1-2)
5. For negative reviews: extracts complaint themes via keyword matching
6. Calls `fetchProductStats()` for each unique product to get aggregate rating/count
7. Writes `data/reports/reviews/latest.json` with the schema from the spec
8. Sends notification summary

Key details:
- CLI: `--days N` (default 1)
- Standard `loadEnv()`, `config` from `site.json`, `notify`/`notifyLatestReport` entry point
- Use `getProducts()` from `lib/shopify.js` to build a `Map<external_id, handle>` for resolving review product handles
- The Judge.me external_id → Shopify product mapping: iterate products, call `resolveExternalId(handle)` to build lookup. Cache this so it's not called per-review.
- Actually simpler: fetch all products from Shopify, for each product call `resolveExternalId(handle, shopDomain, apiToken)` to build `Map<externalId, { handle, title }>`. Then match reviews by `product_external_id`.

- [ ] **Step 2: Run tests**

Run: `node --test tests/lib/review-monitor.test.js`
Expected: All 6 tests pass.

- [ ] **Step 3: Commit**

```bash
git add agents/review-monitor/index.js
git commit -m "feat: add review-monitor agent for daily Judge.me review pull and sentiment classification"
```

---

## Task 3: Wire reviews into daily-summary

**Files:**
- Modify: `agents/daily-summary/index.js`

- [ ] **Step 1: Add Reviews section**

In the daily-summary agent, after the existing section builders, add a function that reads `data/reports/reviews/latest.json` and builds an HTML section:

```javascript
function buildReviewSection() {
  const reviewPath = join(ROOT, 'data', 'reports', 'reviews', 'latest.json');
  if (!existsSync(reviewPath)) return '';
  try {
    const data = JSON.parse(readFileSync(reviewPath, 'utf8'));
    if (!data.new_reviews || data.new_reviews.length === 0) return '';
    const { summary } = data;
    let html = '<h2>Reviews</h2>';
    html += `<p>${summary.total_new} new review${summary.total_new !== 1 ? 's' : ''}: `;
    html += `${summary.positive} positive, ${summary.neutral} neutral, ${summary.negative} negative</p>`;
    if (summary.flagged_for_response?.length > 0) {
      html += '<p style="color:#dc2626"><strong>⚠️ Needs Response:</strong></p><ul>';
      for (const f of summary.flagged_for_response) {
        html += `<li><strong>${f.product_handle}</strong> (${f.rating}★): ${f.complaint}</li>`;
      }
      html += '</ul>';
    }
    return html;
  } catch { return ''; }
}
```

Wire this into the email body assembly (find where other sections are concatenated and add `buildReviewSection()` after the pipeline section).

- [ ] **Step 2: Commit**

```bash
git add agents/daily-summary/index.js
git commit -m "feat(daily-summary): add Reviews section with negative review flagging"
```

---

## Task 4: Wire reviews into product-optimizer prompts

**Files:**
- Modify: `agents/product-optimizer/index.js`

- [ ] **Step 1: Load review sentiment data**

In the `rewriteProduct` function (around line 134), before building the Claude prompt, add review sentiment context:

```javascript
// Load review sentiment if available
let reviewNote = '';
try {
  const reviewPath = join(ROOT, 'data', 'reports', 'reviews', 'latest.json');
  if (existsSync(reviewPath)) {
    const reviewData = JSON.parse(readFileSync(reviewPath, 'utf8'));
    const sentiment = reviewData.product_sentiment?.[product.handle];
    if (sentiment?.negative_themes?.length > 0) {
      reviewNote = `\nREVIEW FEEDBACK: Customers have mentioned concerns about: ${sentiment.negative_themes.join(', ')}. Address these concerns naturally in the description (e.g., if "thick" → mention lightweight/fast-absorbing).`;
    }
  }
} catch { /* ignore */ }
```

Then append `${reviewNote}` to the prompt content, after the `${gscNote}` line.

Add the `existsSync` import if not already present.

- [ ] **Step 2: Commit**

```bash
git add agents/product-optimizer/index.js
git commit -m "feat(product-optimizer): add review sentiment context to rewrite prompts"
```

---

## Task 5: Theme SEO auditor — tests

**Files:**
- Create: `tests/agents/theme-seo-auditor.test.js`

- [ ] **Step 1: Write the test file**

```javascript
// tests/agents/theme-seo-auditor.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

function auditHeadings(html) {
  const h1s = (html.match(/<h1[\s>]/gi) || []).length;
  const headings = [...html.matchAll(/<h([1-6])[\s>]/gi)].map((m) => parseInt(m[1]));
  let hierarchyValid = true;
  for (let i = 1; i < headings.length; i++) {
    if (headings[i] > headings[i - 1] + 1) { hierarchyValid = false; break; }
  }
  return { h1_count: h1s, heading_hierarchy_valid: hierarchyValid };
}

function auditMeta(html) {
  const canonical = /<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i.exec(html);
  const viewport = /<meta[^>]+name=["']viewport["']/i.test(html);
  const ogTitle = /<meta[^>]+property=["']og:title["']/i.test(html);
  const ogDesc = /<meta[^>]+property=["']og:description["']/i.test(html);
  const ogImage = /<meta[^>]+property=["']og:image["']/i.test(html);
  const ogUrl = /<meta[^>]+property=["']og:url["']/i.test(html);
  const twitterCard = /<meta[^>]+name=["']twitter:card["']/i.test(html);
  return {
    canonical_present: !!canonical,
    canonical_href: canonical ? canonical[1] : null,
    viewport_present: viewport,
    og_tags: { title: ogTitle, description: ogDesc, image: ogImage, url: ogUrl },
    twitter_tags: { card: twitterCard },
  };
}

function auditImages(html) {
  const imgs = [...html.matchAll(/<img[^>]*>/gi)];
  const withAlt = imgs.filter((m) => /alt=["'][^"']+["']/i.test(m[0]));
  return {
    image_count: imgs.length,
    images_with_alt: withAlt.length,
    alt_coverage: imgs.length > 0 ? withAlt.length / imgs.length : 1,
  };
}

test('auditHeadings: single H1, valid hierarchy', () => {
  const html = '<h1>Title</h1><h2>Sub</h2><h3>Detail</h3>';
  const result = auditHeadings(html);
  assert.equal(result.h1_count, 1);
  assert.equal(result.heading_hierarchy_valid, true);
});

test('auditHeadings: multiple H1s', () => {
  const html = '<h1>Title</h1><h1>Another</h1>';
  assert.equal(auditHeadings(html).h1_count, 2);
});

test('auditHeadings: skipped level = invalid', () => {
  const html = '<h1>Title</h1><h3>Skipped H2</h3>';
  assert.equal(auditHeadings(html).heading_hierarchy_valid, false);
});

test('auditMeta: finds canonical and OG tags', () => {
  const html = '<link rel="canonical" href="https://example.com/page"><meta property="og:title" content="T"><meta property="og:description" content="D"><meta property="og:image" content="I"><meta property="og:url" content="U"><meta name="viewport" content="width=device-width"><meta name="twitter:card" content="summary">';
  const result = auditMeta(html);
  assert.equal(result.canonical_present, true);
  assert.equal(result.canonical_href, 'https://example.com/page');
  assert.equal(result.viewport_present, true);
  assert.equal(result.og_tags.title, true);
  assert.equal(result.twitter_tags.card, true);
});

test('auditMeta: missing tags', () => {
  const result = auditMeta('<html><head></head></html>');
  assert.equal(result.canonical_present, false);
  assert.equal(result.viewport_present, false);
  assert.equal(result.og_tags.title, false);
});

test('auditImages: counts images and alt coverage', () => {
  const html = '<img src="a.jpg" alt="Photo"><img src="b.jpg"><img src="c.jpg" alt="Another">';
  const result = auditImages(html);
  assert.equal(result.image_count, 3);
  assert.equal(result.images_with_alt, 2);
  assert.ok(Math.abs(result.alt_coverage - 0.667) < 0.01);
});
```

- [ ] **Step 2: Run tests**

Run: `node --test tests/agents/theme-seo-auditor.test.js`
Expected: All 6 tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/agents/theme-seo-auditor.test.js
git commit -m "test: add theme-seo-auditor DOM audit tests for headings, meta, images"
```

---

## Task 6: Theme SEO auditor — implementation

**Files:**
- Create: `agents/theme-seo-auditor/index.js`
- Modify: `package.json` — add lighthouse dependency

- [ ] **Step 1: Install lighthouse**

Run: `npm install lighthouse --save`

- [ ] **Step 2: Write the agent**

Create `agents/theme-seo-auditor/index.js`:

The agent:
1. Selects 5 representative URLs (homepage, product, collection, blog post, page) using Shopify API + GSC to find the best candidate per type
2. For each URL, launches Puppeteer, navigates to the page, waits for full render
3. Extracts rendered HTML via `page.content()` and runs DOM audit functions: `auditHeadings()`, `auditMeta()`, `auditImages()`, plus counts structured data blocks (`<script type="application/ld+json">`)
4. Runs Lighthouse via the `lighthouse` npm package using the existing Puppeteer browser instance (Lighthouse supports a `page` option)
5. Extracts Lighthouse scores: performance, seo, accessibility + Core Web Vitals (LCP, CLS, TBT) + specific audit failures
6. Compiles issues per template with severity (critical/warning/info)
7. Writes `data/reports/theme-seo-audit/latest.json` + `theme-seo-audit.md`

Key implementation details:
- Import `puppeteer` and `lighthouse`
- Lighthouse with Puppeteer: use `lighthouse(url, { output: 'json' }, undefined, page)` — the 4th argument passes an existing Puppeteer page
- Actually, the correct Lighthouse + Puppeteer integration is:
  ```javascript
  import lighthouse from 'lighthouse';
  const browser = await puppeteer.launch({ headless: 'new' });
  const port = new URL(browser.wsEndpoint()).port;
  const result = await lighthouse(url, {
    port,
    output: 'json',
    onlyCategories: ['performance', 'seo', 'accessibility'],
  });
  ```
- Extract scores: `result.lhr.categories.performance.score * 100`, etc.
- Extract CWV: `result.lhr.audits['largest-contentful-paint']?.numericValue`, `result.lhr.audits['cumulative-layout-shift']?.numericValue`, `result.lhr.audits['total-blocking-time']?.numericValue`
- Extract failures: `Object.values(result.lhr.audits).filter(a => a.score === 0 && a.title).map(a => a.title)`
- Close browser after all URLs are processed
- CLI: `--type <template>` to audit a single template type
- Standard entry point with `notify`/`notifyLatestReport`

- [ ] **Step 3: Run tests**

Run: `node --test tests/agents/theme-seo-auditor.test.js`
Expected: All 6 tests pass.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json agents/theme-seo-auditor/index.js
git commit -m "feat: add theme-seo-auditor agent with Puppeteer rendering + Lighthouse scoring"
```

---

## Task 7: Page optimization — add `--pages-from-gsc` and `--expand-faq` to product-optimizer

**Files:**
- Modify: `agents/product-optimizer/index.js`

- [ ] **Step 1: Add new flags**

After existing flag parsing, add:

```javascript
const pagesFromGsc = args.includes('--pages-from-gsc');
const expandFaq = args.includes('--expand-faq');
```

- [ ] **Step 2: Add `rewritePageMeta` function**

Similar to `rewriteProductMeta` but for pages:

```javascript
async function rewritePageMeta(page, topQueries, gscData) {
  // Same pattern as rewriteProductMeta but for static pages
  // Prompt mentions it's a static Shopify page, not a product
  // Returns { seo_title, seo_description, what_changed, why, projected_impact }
}
```

- [ ] **Step 3: Add `pagesFromGscMode` function**

Same flow as `fromGscMode` but:
- Fetches pages via `getPages()` from `lib/shopify.js` (import needed)
- Builds URLs as `${config.url}/pages/${page.handle}`
- Filter: ≥50 impressions, CTR < 2%
- Queue trigger: `page-meta-rewrite`
- Queue item has `resource_type: 'page'`

- [ ] **Step 4: Add `expandFaqMode` function**

1. Find FAQ page: `pages.find(p => p.handle === 'faq' || p.handle === 'faqs' || p.title.toLowerCase().includes('faq'))`
2. Get GSC queries: `gsc.getPageKeywords(url, 50, 90)`
3. Filter to question queries: `queries.filter(q => /^(who|what|where|when|why|how)\b/i.test(q.keyword) || q.keyword.includes('?'))`
4. Send to Claude: existing body + new questions → expanded HTML with FAQ schema
5. Save HTML to `data/page-content/faq.html`
6. Queue with trigger `faq-expansion`

- [ ] **Step 5: Update `publishApprovedProducts` to handle page triggers**

Add handling for `page-meta-rewrite` and `faq-expansion` triggers:
- Import `getPages`, `updatePage` from `lib/shopify.js`
- For `page-meta-rewrite`: `upsertMetafield('pages', resourceId, 'global', 'title_tag', ...)` and `description_tag`
- For `faq-expansion`: read HTML from `proposed_html_path`, call `updatePage(resourceId, { body_html })` + meta upserts

- [ ] **Step 6: Update entry point routing**

```javascript
const run = pagesFromGsc ? pagesFromGscMode
  : expandFaq ? expandFaqMode
  : fromGsc ? fromGscMode
  : publishApproved ? publishApprovedProducts
  : main;
```

- [ ] **Step 7: Update doc comment**

- [ ] **Step 8: Commit**

```bash
git add agents/product-optimizer/index.js
git commit -m "feat(product-optimizer): add --pages-from-gsc and --expand-faq modes for static page optimization"
```

---

## Task 8: Shared meta test module — `lib/meta-test.js` + tests

**Files:**
- Create: `lib/meta-test.js`
- Create: `tests/lib/meta-test.test.js`

- [ ] **Step 1: Write the test file**

```javascript
// tests/lib/meta-test.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

function buildTestData({ slug, url, resourceType, resourceId, blogId, originalTitle, newTitle, baselineCTR }) {
  const startDate = new Date().toISOString().slice(0, 10);
  const concludeDate = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
  return {
    slug,
    url,
    resourceType,
    resourceId,
    blogId: blogId || null,
    startDate,
    concludeDate,
    variantA: originalTitle,
    variantB: newTitle,
    baselineCTR,
    status: 'active',
    baselineMean: baselineCTR,
    testMean: null,
    currentDelta: null,
    daysRemaining: 14,
  };
}

test('buildTestData creates correct shape for product', () => {
  const data = buildTestData({
    slug: 'coconut-lotion', url: 'https://example.com/products/coconut-lotion',
    resourceType: 'product', resourceId: 123, originalTitle: 'Old', newTitle: 'New', baselineCTR: 0.02,
  });
  assert.equal(data.slug, 'coconut-lotion');
  assert.equal(data.resourceType, 'product');
  assert.equal(data.resourceId, 123);
  assert.equal(data.blogId, null);
  assert.equal(data.variantA, 'Old');
  assert.equal(data.variantB, 'New');
  assert.equal(data.status, 'active');
  assert.equal(data.daysRemaining, 14);
});

test('buildTestData creates correct shape for article', () => {
  const data = buildTestData({
    slug: 'my-post', url: 'https://example.com/blogs/news/my-post',
    resourceType: 'article', resourceId: 456, blogId: 789, originalTitle: 'A', newTitle: 'B', baselineCTR: null,
  });
  assert.equal(data.resourceType, 'article');
  assert.equal(data.blogId, 789);
  assert.equal(data.baselineCTR, null);
});

test('buildTestData sets 14-day conclude window', () => {
  const data = buildTestData({
    slug: 'test', url: 'u', resourceType: 'product', resourceId: 1, originalTitle: 'A', newTitle: 'B', baselineCTR: 0,
  });
  const start = new Date(data.startDate);
  const conclude = new Date(data.concludeDate);
  const diffDays = Math.round((conclude - start) / 86400000);
  assert.equal(diffDays, 14);
});
```

- [ ] **Step 2: Run tests**

Run: `node --test tests/lib/meta-test.test.js`
Expected: All 3 tests pass.

- [ ] **Step 3: Write `lib/meta-test.js`**

```javascript
/**
 * Shared Meta A/B Test Creator
 *
 * Creates a test file at data/meta-tests/{slug}.json tracking the CTR
 * impact of a meta title change. Does NOT apply the title to Shopify
 * (caller already did that).
 *
 * Usage:
 *   import { createMetaTest } from '../lib/meta-test.js';
 *   await createMetaTest({ slug, url, resourceType, resourceId, blogId, originalTitle, newTitle });
 */
```

The module exports one function `createMetaTest(opts)`:
1. Check if active test already exists for this slug — skip if so
2. Compute baseline CTR from GSC snapshots (28-day lookback, same logic as `scripts/create-meta-test.js` lines 78-102)
3. Build test data object with 14-day conclude window (spec says 14 days, not 28)
4. Write to `data/meta-tests/{slug}.json`
5. Log creation
6. Return the test data object (or null if skipped)

Key: read GSC snapshots from `data/snapshots/gsc/`, find page by URL path match, compute mean CTR over 28 days.

- [ ] **Step 4: Run tests**

Run: `node --test tests/lib/meta-test.test.js`
Expected: All 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/meta-test.js tests/lib/meta-test.test.js
git commit -m "feat: add lib/meta-test.js shared module for A/B test creation"
```

---

## Task 9: Extend meta-ab-tracker for all resource types

**Files:**
- Modify: `agents/meta-ab-tracker/index.js`

- [ ] **Step 1: Replace raw fetch revert with `upsertMetafield`**

Import `upsertMetafield` from `lib/shopify.js`:

```javascript
import { upsertMetafield } from '../../lib/shopify.js';
```

Replace the `revertMetafield` function (lines 74-88) with a version that handles all resource types:

```javascript
async function revertMetafield(test) {
  const { resourceType, resourceId, blogId, variantA } = test;
  if (!resourceId) { console.warn('Skipping revert: no resourceId'); return; }

  if (resourceType === 'article') {
    // Legacy blog post revert via blog/article path
    const env = loadEnv();
    const token = process.env.SHOPIFY_ACCESS_TOKEN || env.SHOPIFY_ACCESS_TOKEN;
    const store = process.env.SHOPIFY_STORE_DOMAIN || env.SHOPIFY_STORE_DOMAIN;
    if (!token || !store || !blogId) { console.warn('Skipping article revert: missing credentials or blogId'); return; }
    const url = `https://${store}/admin/api/2024-01/blogs/${blogId}/articles/${resourceId}/metafields.json`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ metafield: { namespace: 'global', key: 'title_tag', value: variantA, type: 'single_line_text_field' } }),
    });
    if (!res.ok) console.warn(`Article revert failed: ${res.status}`);
  } else {
    // Products, collections, pages — use upsertMetafield
    const resourceMap = { product: 'products', collection: 'custom_collections', page: 'pages' };
    const resource = resourceMap[resourceType];
    if (!resource) { console.warn(`Unknown resourceType: ${resourceType}`); return; }
    await upsertMetafield(resource, resourceId, 'global', 'title_tag', variantA);
  }
}
```

- [ ] **Step 2: Update the conclude block to use new revert**

In the main loop (around line 153), update the revert call:

Old: `await revertMetafield(meta.shopify_article_id, meta.shopify_blog_id, t.variantA);`

New: `await revertMetafield(t);`

Also update the `pagePath` resolution to handle non-blog URLs:

```javascript
let pagePath;
if (t.url) {
  try { pagePath = new URL(t.url).pathname; } catch { pagePath = `/${t.slug}`; }
} else if (meta?.shopify_url) {
  try { pagePath = new URL(meta.shopify_url).pathname; } catch { pagePath = `/${t.slug}`; }
} else {
  pagePath = `/${t.slug}`;
}
```

- [ ] **Step 3: Commit**

```bash
git add agents/meta-ab-tracker/index.js
git commit -m "feat(meta-ab-tracker): extend revert to products, collections, and pages via upsertMetafield"
```

---

## Task 10: Wire auto-trigger into publish flows

**Files:**
- Modify: `agents/product-optimizer/index.js`
- Modify: `agents/collection-content-optimizer/index.js`
- Modify: `agents/collection-creator/index.js`

- [ ] **Step 1: Add auto-trigger to product-optimizer `publishApprovedProducts`**

Import: `import { createMetaTest } from '../../lib/meta-test.js';`

After each successful publish in `publishApprovedProducts()` (after `item.status = 'published'`), add:

```javascript
      // Auto-create A/B test for the meta rewrite
      try {
        await createMetaTest({
          slug: item.slug,
          url: `${config.url}/products/${item.slug}`,
          resourceType: 'product',
          resourceId: item.resource_id,
          originalTitle: item.proposed_meta.original_title,
          newTitle: item.proposed_meta.seo_title,
        });
      } catch (e) {
        console.warn(`  A/B test creation failed: ${e.message}`);
      }
```

Same pattern for `page-meta-rewrite` trigger items (use `resourceType: 'page'` and URL `${config.url}/pages/${item.slug}`).

- [ ] **Step 2: Add auto-trigger to collection-content-optimizer `publishApprovedCollections`**

Import: `import { createMetaTest } from '../../lib/meta-test.js';`

After each successful publish:

```javascript
      try {
        await createMetaTest({
          slug: item.slug,
          url: `${config.url}/collections/${item.slug}`,
          resourceType: 'collection',
          resourceId: item.resource_id,
          originalTitle: item.proposed_meta.original_title,
          newTitle: item.proposed_meta.seo_title,
        });
      } catch (e) {
        console.warn(`  A/B test creation failed: ${e.message}`);
      }
```

- [ ] **Step 3: Add auto-trigger to collection-creator `publishApprovedCollections`**

Import: `import { createMetaTest } from '../../lib/meta-test.js';`

After each successful collection creation:

```javascript
      try {
        await createMetaTest({
          slug: item.proposed_collection.handle,
          url: `${config.url}/collections/${item.proposed_collection.handle}`,
          resourceType: 'collection',
          resourceId: newCollection.id,
          originalTitle: item.proposed_collection.title,
          newTitle: item.proposed_collection.seo_title,
        });
      } catch (e) {
        console.warn(`  A/B test creation failed: ${e.message}`);
      }
```

- [ ] **Step 4: Commit**

```bash
git add agents/product-optimizer/index.js agents/collection-content-optimizer/index.js agents/collection-creator/index.js
git commit -m "feat: auto-create A/B tests when meta rewrites are published"
```

---

## Task 11: Dashboard — meta test card

**Files:**
- Modify: `agents/dashboard/public/js/dashboard.js`

- [ ] **Step 1: Add `renderMetaTestCard` function**

```javascript
function renderMetaTestCard(d) {
  var tests = d.metaTests || [];
  if (tests.length === 0) return '';
  var active = tests.filter(function(t) { return t.status === 'active'; });
  var concluded = tests.filter(function(t) { return t.status === 'concluded'; })
    .sort(function(a, b) { return (b.concludedDate || '').localeCompare(a.concludedDate || ''); })
    .slice(0, 10);
  var bWins = concluded.filter(function(t) { return t.winner === 'B'; }).length;
  var winRate = concluded.length > 0 ? Math.round(bWins / concluded.length * 100) : 0;

  var html = '<div class="card"><div class="card-header accent-blue"><h2>Meta A/B Tests <span class="badge">' + active.length + ' active</span></h2></div><div class="card-body">';

  if (concluded.length > 0) {
    html += '<p style="color:#6b7280;margin-bottom:12px">Win rate: ' + bWins + '/' + concluded.length + ' (' + winRate + '%) — Variant B kept</p>';
  }

  if (active.length > 0) {
    html += '<h3 style="margin-top:0">Active Tests</h3><table class="data-table"><thead><tr><th>Page</th><th>Variant A</th><th>Variant B</th><th>CTR Delta</th><th>Days Left</th></tr></thead><tbody>';
    active.forEach(function(t) {
      var delta = t.currentDelta != null ? (t.currentDelta >= 0 ? '+' : '') + (t.currentDelta * 100).toFixed(2) + 'pp' : 'n/a';
      html += '<tr><td>' + t.slug + '</td><td style="font-size:12px">' + (t.variantA || '').slice(0, 40) + '</td><td style="font-size:12px">' + (t.variantB || '').slice(0, 40) + '</td><td>' + delta + '</td><td>' + (t.daysRemaining || '?') + '</td></tr>';
    });
    html += '</tbody></table>';
  }

  if (concluded.length > 0) {
    html += '<h3>Recent Results</h3><table class="data-table"><thead><tr><th>Page</th><th>Winner</th><th>CTR Change</th></tr></thead><tbody>';
    concluded.forEach(function(t) {
      var delta = t.currentDelta != null ? (t.currentDelta >= 0 ? '+' : '') + (t.currentDelta * 100).toFixed(2) + 'pp' : 'n/a';
      var color = t.winner === 'B' ? '#10b981' : '#ef4444';
      html += '<tr><td>' + t.slug + '</td><td style="color:' + color + '">Variant ' + t.winner + '</td><td>' + delta + '</td></tr>';
    });
    html += '</tbody></table>';
  }

  html += '</div></div>';
  return html;
}
```

- [ ] **Step 2: Add to Optimize tab**

In `renderOptimizeTab`, add `renderMetaTestCard(d)` after `renderCannibalizationCard(d)`:

```javascript
    renderCannibalizationCard(d) +
    renderMetaTestCard(d) +
    renderIndexingCard(d) +
```

- [ ] **Step 3: Commit**

```bash
git add agents/dashboard/public/js/dashboard.js
git commit -m "feat(dashboard): add Meta A/B Tests card to Optimize tab"
```

---

## Task 12: Scheduler + npm scripts + signal manifest

**Files:**
- Modify: `scheduler.js`
- Modify: `package.json`
- Modify: `docs/signal-manifest.md`

- [ ] **Step 1: Add daily review-monitor to scheduler**

Before the existing Step 1 (calendar-runner --publish-due), add:

```javascript
// Step 0: daily review monitor
const reviewCmd = `"${NODE}" agents/review-monitor/index.js`;
log(`  ${reviewCmd}`);
try {
  execSync(reviewCmd, { stdio: 'inherit', cwd: __dirname });
  log('  ✓ review-monitor complete');
} catch (e) {
  log(`  ✗ review-monitor failed (exit ${e.status})`);
}
```

- [ ] **Step 2: Add weekly meta-ab-tracker to Sunday block**

Inside the existing `if (new Date().getDay() === 0)` block, add:

```javascript
  // Step 9b: meta A/B tracker
  const metaAbCmd = `"${NODE}" agents/meta-ab-tracker/index.js${dryFlag}`;
  log(`    ${metaAbCmd}`);
  try {
    execSync(metaAbCmd, { stdio: 'inherit', cwd: __dirname });
    log('    ✓ meta-ab-tracker complete');
  } catch (e) {
    log(`    ✗ meta-ab-tracker failed (exit ${e.status})`);
  }
```

- [ ] **Step 3: Add pages-from-gsc to daily publish-approved**

After the existing `product-optimizer --publish-approved` step, add:

```javascript
// Step 4c: pages from GSC (queue + publish)
const pagesCmd = `"${NODE}" agents/product-optimizer/index.js --pages-from-gsc${dryFlag}`;
log(`  ${pagesCmd}`);
try {
  execSync(pagesCmd, { stdio: 'inherit', cwd: __dirname });
  log('  ✓ pages-from-gsc complete');
} catch (e) {
  log(`  ✗ pages-from-gsc failed (exit ${e.status})`);
}
```

- [ ] **Step 4: Add monthly theme audit**

After the weekly block's closing brace, add:

```javascript
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
```

- [ ] **Step 5: Add npm scripts**

```json
    "review-monitor": "node agents/review-monitor/index.js",
    "theme-audit": "node agents/theme-seo-auditor/index.js",
    "pages-gsc": "node agents/product-optimizer/index.js --pages-from-gsc",
    "expand-faq": "node agents/product-optimizer/index.js --expand-faq",
```

- [ ] **Step 6: Update signal manifest**

Add new entries:
```markdown
| `data/reports/reviews/latest.json` | `review-monitor` | `daily-summary`, `product-optimizer` (sentiment context) | healthy |
| `data/reports/theme-seo-audit/latest.json` | `theme-seo-auditor` | manual review | healthy |
| `data/meta-tests/*.json` | `lib/meta-test.js` (via publish flows) | `meta-ab-tracker`, dashboard Optimize tab | healthy |
| `data/performance-queue/<slug>.json` (trigger: `page-meta-rewrite`) | `product-optimizer --pages-from-gsc` | dashboard, `product-optimizer --publish-approved` | healthy |
| `data/performance-queue/<slug>.json` (trigger: `faq-expansion`) | `product-optimizer --expand-faq` | dashboard, `product-optimizer --publish-approved` | healthy |
```

- [ ] **Step 7: Commit**

```bash
git add scheduler.js package.json docs/signal-manifest.md
git commit -m "feat(scheduler): add review-monitor, meta-ab-tracker, pages-from-gsc, theme audit + npm scripts + signal manifest"
```

---

## Task 13: Integration smoke test

- [ ] **Step 1: Run all Tier 3 tests**

Run: `node --test tests/lib/review-monitor.test.js tests/agents/theme-seo-auditor.test.js tests/lib/meta-test.test.js`
Expected: All 15 tests pass.

- [ ] **Step 2: Syntax check all modified/created files**

Run: `node --check agents/review-monitor/index.js && node --check agents/theme-seo-auditor/index.js && node --check agents/product-optimizer/index.js && node --check agents/meta-ab-tracker/index.js && node --check agents/collection-content-optimizer/index.js && node --check agents/collection-creator/index.js && node --check agents/daily-summary/index.js && node --check lib/meta-test.js && node --check scheduler.js && echo "All syntax OK"`
Expected: "All syntax OK"

- [ ] **Step 3: Run scheduler dry-run**

Run: `node scheduler.js --dry-run 2>&1 | tail -40`
Expected: Shows review-monitor step, all daily/weekly/monthly steps.

- [ ] **Step 4: Commit if any fixes**

```bash
git add -A && git commit -m "fix: smoke test fixes for Tier 3 agents"
```
