# Featured Product Injector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the mid-article dashed CTA in blog posts with a rich featured product card (product image, real Judge.me review quote, star rating, price, Add to Cart button) positioned above the site-wide average scroll depth.

**Architecture:** A new `featured-product-injector` agent with two modes — pipeline (`--handle <slug>`) modifies local HTML files for new posts, retroactive (`--top <n>`) fetches the top-N traffic posts from GSC, injects, and updates Shopify directly. A new `lib/judgeme.js` handles all Judge.me API calls. Pure helper functions are exported from the agent for testability.

**Tech Stack:** Node.js ESM, Shopify REST API (via existing `lib/shopify.js`), Judge.me REST API v1, existing `lib/notify.js`

---

## File Structure

| File | Action | Purpose |
|------|--------|---------|
| `lib/judgeme.js` | Create | Judge.me API client — `fetchTopReview()`, `fetchProductStats()` |
| `agents/featured-product-injector/index.js` | Create | Main agent — CLI arg parsing, scroll depth loading, pipeline + retroactive modes, exported pure helpers |
| `tests/lib/judgeme.test.js` | Create | Unit tests for pure judgeme helpers (tag stripping, truncation, word count) |
| `tests/agents/featured-product-injector.test.js` | Create | Unit tests for pure agent helpers (findPrimaryProduct, renderStars, removeMidArticleCta, findInsertionPoint, buildFeaturedProductHtml) |
| `agents/dashboard/index.js` | Modify | Add allowlist entry, run-log `<pre>`, and "Inject Featured Products" button |
| `CLAUDE.md` | Modify | Add `JUDGEME_API_TOKEN`/`JUDGEME_SHOP_DOMAIN` env vars, update pipeline order |

---

## Task 1: Judge.me API client (`lib/judgeme.js`)

**Files:**
- Create: `lib/judgeme.js`
- Create: `tests/lib/judgeme.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/lib/judgeme.test.js`:

```js
import { strict as assert } from 'assert';
import { stripHtmlForReview, truncateToWord, renderReviewBody } from '../../lib/judgeme.js';

// stripHtmlForReview removes tags and collapses whitespace
assert.equal(
  stripHtmlForReview('<p>Great <strong>product</strong>!</p>'),
  'Great product!'
);
assert.equal(
  stripHtmlForReview('  <br>  Hello  <br>  world  '),
  'Hello world'
);

// truncateToWord does not cut mid-word
assert.equal(truncateToWord('one two three four five', 14), 'one two three');
assert.equal(truncateToWord('short', 200), 'short');
assert.equal(truncateToWord('exactlytwenty!', 14), 'exactlytwenty!');

// renderReviewBody: strips HTML, checks word count ≥ 20, truncates to 200
const longReview = 'word '.repeat(25).trim(); // 25 words
assert.equal(renderReviewBody(longReview), longReview.slice(0, 200).trimEnd());
assert.equal(renderReviewBody('too short'), null); // under 20 words
assert.equal(renderReviewBody('<p>' + 'word '.repeat(25).trim() + '</p>'), 'word '.repeat(25).trim().slice(0, 200).trimEnd());

console.log('✓ judgeme lib unit tests pass');
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
node tests/lib/judgeme.test.js
```
Expected: Error — `lib/judgeme.js` does not exist yet.

- [ ] **Step 3: Create `lib/judgeme.js`**

```js
/**
 * Judge.me API v1 client
 *
 * Required .env keys:
 *   JUDGEME_API_TOKEN   — private API token from Judge.me dashboard
 *   JUDGEME_SHOP_DOMAIN — must be the .myshopify.com domain (e.g. realskincare.myshopify.com)
 */

const JUDGEME_BASE = 'https://judge.me/api/v1';

// ── Pure helpers (exported for testing) ───────────────────────────────────────

export function stripHtmlForReview(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

export function truncateToWord(text, maxLen) {
  if (text.length <= maxLen) return text;
  const cut = text.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(' ');
  return lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
}

/**
 * Strip HTML, check ≥ 20 words, truncate to 200 chars.
 * Returns cleaned string or null if too short.
 */
export function renderReviewBody(rawBody) {
  const text = stripHtmlForReview(rawBody);
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (wordCount < 20) return null;
  return truncateToWord(text, 200);
}

// ── API calls ─────────────────────────────────────────────────────────────────

/**
 * Fetch the best qualifying 5-star review for a product.
 * Returns { quote, verified } or null.
 */
export async function fetchTopReview(productHandle, shopDomain, apiToken) {
  const qs = new URLSearchParams({
    api_token: apiToken,
    shop_domain: shopDomain,
    product_handle: productHandle,
    per_page: '10',
    'rating[gte]': '5',
  });
  const res = await fetch(`${JUDGEME_BASE}/reviews?${qs}`);
  if (!res.ok) {
    console.warn(`  Judge.me reviews → HTTP ${res.status} (skipping)`);
    return null;
  }
  const data = await res.json();
  for (const review of (data.reviews || [])) {
    const quote = renderReviewBody(review.body || '');
    if (quote) {
      return { quote, verified: review.reviewer?.verified_buyer === true };
    }
  }
  return null;
}

/**
 * Fetch aggregate rating and review count for a product.
 * Returns { rating, reviewCount } or null.
 * Note: -1 is a Judge.me sentinel meaning "look up by handle, not by numeric ID".
 */
export async function fetchProductStats(productHandle, shopDomain, apiToken) {
  const qs = new URLSearchParams({
    api_token: apiToken,
    shop_domain: shopDomain,
    handle: productHandle,
  });
  const res = await fetch(`${JUDGEME_BASE}/products/-1?${qs}`);
  if (!res.ok) {
    console.warn(`  Judge.me product stats → HTTP ${res.status} (skipping)`);
    return null;
  }
  const data = await res.json();
  const p = data.product;
  if (!p) return null;
  return { rating: p.rating, reviewCount: p.reviews_count };
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
node tests/lib/judgeme.test.js
```
Expected: `✓ judgeme lib unit tests pass`

- [ ] **Step 5: Commit**

```bash
git add lib/judgeme.js tests/lib/judgeme.test.js
git commit -m "feat: Judge.me API client with fetchTopReview and fetchProductStats"
```

---

## Task 2: Pure injection helpers (inside agent, exported for tests)

**Files:**
- Create: `agents/featured-product-injector/index.js` (pure exports only, no main() yet)
- Create: `tests/agents/featured-product-injector.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/agents/featured-product-injector.test.js`:

```js
import { strict as assert } from 'assert';
import {
  findPrimaryProduct,
  renderStars,
  removeMidArticleCta,
  findInsertionPoint,
  buildFeaturedProductHtml,
} from '../../agents/featured-product-injector/index.js';

// findPrimaryProduct: returns the most-linked /products/<handle>
assert.equal(
  findPrimaryProduct('<a href="/products/foo">x</a><a href="/products/foo">x</a><a href="/products/bar">x</a>'),
  'foo'
);
assert.equal(findPrimaryProduct('<p>no links here</p>'), null);
assert.equal(
  findPrimaryProduct('<a href="/collections/foo">x</a>'),
  null
);

// renderStars: rounds to nearest integer, returns ★/☆ string
assert.equal(renderStars(4.8), '★★★★★');
assert.equal(renderStars(4.2), '★★★★☆');
assert.equal(renderStars(3.5), '★★★★☆'); // rounds to 4
assert.equal(renderStars(5),   '★★★★★');

// removeMidArticleCta: strips <section> with border:1px dashed
const withDashed = '<p>before</p><section style="border:1px dashed #ddd;padding:10px"><p>CTA</p></section><p>after</p>';
const withoutDashed = removeMidArticleCta(withDashed);
assert.ok(!withoutDashed.includes('border:1px dashed'), 'dashed section removed');
assert.ok(withoutDashed.includes('<p>before</p>'), 'content before preserved');
assert.ok(withoutDashed.includes('<p>after</p>'), 'content after preserved');

// removeMidArticleCta: no-op when no dashed section
const clean = '<p>just content</p>';
assert.equal(removeMidArticleCta(clean), clean);

// findInsertionPoint: returns index after </p> near target word count
const html = '<p>' + 'word '.repeat(50) + '</p><p>' + 'word '.repeat(50) + '</p>';
const idx = findInsertionPoint(html, 40); // target 40 words
assert.ok(idx > 0, 'returns a positive index');
assert.ok(idx <= html.indexOf('</p>') + 4 + 1, 'inserts after first </p>');

// buildFeaturedProductHtml: contains required fields
const html2 = buildFeaturedProductHtml({
  title: 'My Product',
  handle: 'my-product',
  imageUrl: 'https://cdn.example.com/img.jpg',
  price: '18.99',
  quote: 'Great stuff',
  verified: true,
  stars: '★★★★★',
  reviewCount: 42,
});
assert.ok(html2.includes('rsc-featured-product'), 'has idempotency class');
assert.ok(html2.includes('My Product'), 'has product title');
assert.ok(html2.includes('/products/my-product'), 'has product URL');
assert.ok(html2.includes('Great stuff'), 'has review quote');
assert.ok(html2.includes('$18.99'), 'has price');
assert.ok(html2.includes('★★★★★'), 'has stars');
assert.ok(html2.includes('42 reviews'), 'has review count');
assert.ok(html2.includes('img.jpg'), 'has image');

// buildFeaturedProductHtml: graceful when optional fields missing
const minHtml = buildFeaturedProductHtml({
  title: 'My Product',
  handle: 'my-product',
  imageUrl: null,
  price: null,
  quote: null,
  verified: false,
  stars: null,
  reviewCount: null,
});
assert.ok(minHtml.includes('rsc-featured-product'), 'has class even with missing fields');
assert.ok(!minHtml.includes('<img'), 'no img when imageUrl is null');
assert.ok(!minHtml.includes('reviews'), 'no review count when null');

console.log('✓ featured-product-injector pure function tests pass');
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
node tests/agents/featured-product-injector.test.js
```
Expected: Error — agent file does not exist yet.

- [ ] **Step 3: Create `agents/featured-product-injector/index.js` with pure exports only**

```js
#!/usr/bin/env node
/**
 * Featured Product Injector
 *
 * Replaces the mid-article dashed CTA with a review-forward product card.
 * Sources: Shopify (product image/price), Judge.me (review quote + rating),
 *          Clarity snapshots (scroll depth positioning).
 *
 * Usage:
 *   node agents/featured-product-injector/index.js --handle <slug>   # pipeline: update local HTML file
 *   node agents/featured-product-injector/index.js --top <n>         # retroactive: update top-N Shopify posts
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '..', '..');

// ── Pure helpers (exported for testing) ───────────────────────────────────────

/**
 * Find the most-linked /products/<handle> in the HTML.
 * Returns the handle string or null if none found.
 */
export function findPrimaryProduct(html) {
  const counts = {};
  const re = /href="\/products\/([^"/?#]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const handle = m[1];
    counts[handle] = (counts[handle] || 0) + 1;
  }
  const entries = Object.entries(counts);
  if (entries.length === 0) return null;
  entries.sort((a, b) => b[1] - a[1]);
  return entries[0][0];
}

/**
 * Render a decimal rating as filled/empty star characters.
 * Uses Math.round — 4.8 → 5 stars, 4.2 → 4 stars.
 */
export function renderStars(rating) {
  const filled = Math.round(rating);
  const clamped = Math.max(0, Math.min(5, filled));
  return '★'.repeat(clamped) + '☆'.repeat(5 - clamped);
}

/**
 * Remove the writer's mid-article dashed <section> CTA.
 * Pattern: <section ...border:1px dashed...>...</section>
 */
export function removeMidArticleCta(html) {
  return html.replace(/<section[^>]*border:1px dashed[^>]*>[\s\S]*?<\/section>/gi, '');
}

/**
 * Find the index to insert after, targeting the </p> whose cumulative word
 * count first meets or exceeds targetWords. Falls back to end of content.
 */
export function findInsertionPoint(html, targetWords) {
  let pos = 0;
  let cumulative = 0;
  while (pos < html.length) {
    const next = html.indexOf('</p>', pos);
    if (next === -1) break;
    const chunk = html.slice(pos, next + 4);
    const words = chunk.replace(/<[^>]+>/g, ' ').trim().split(/\s+/).filter(Boolean).length;
    cumulative += words;
    pos = next + 4;
    if (cumulative >= targetWords) return pos;
  }
  // Fallback: before </article> or at end
  const articleEnd = html.lastIndexOf('</article>');
  return articleEnd > 0 ? articleEnd : html.length;
}

/**
 * Build the rsc-featured-product HTML block.
 * All fields are optional except title and handle — missing fields are omitted gracefully.
 */
export function buildFeaturedProductHtml({ title, handle, imageUrl, price, quote, verified, stars, reviewCount }) {
  const imgHtml = imageUrl
    ? `<img src="${imageUrl}" style="width:130px;object-fit:cover;flex-shrink:0" alt="${escHtml(title)}">`
    : '';

  const quoteHtml = quote
    ? `<div style="font-size:13px;color:#374151;font-family:sans-serif;font-style:italic;line-height:1.5;margin-bottom:10px;padding-left:10px;border-left:3px solid #AEDEAC">&ldquo;${escHtml(quote)}&rdquo;</div>`
    : '';

  const reviewLineHtml = (stars && reviewCount != null)
    ? `<div style="font-size:11px;color:#6b7280;font-family:sans-serif;margin-bottom:12px">&#8212; Verified Buyer &nbsp;&middot;&nbsp; <span style="color:#f59e0b">${stars}</span> &nbsp;&middot;&nbsp; ${reviewCount} reviews</div>`
    : '';

  const priceHtml = price != null
    ? `<span style="font-size:18px;font-weight:800;color:#111">$${escHtml(String(price))}</span>`
    : '';

  return (
    '<div class="rsc-featured-product" style="border:2px solid #e5e7eb;border-radius:14px;overflow:hidden;margin:28px 0;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.06)">' +
    '<div style="display:flex;gap:0">' +
    imgHtml +
    '<div style="padding:16px 18px;flex:1">' +
    '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:#6b7280;font-family:sans-serif;margin-bottom:4px">Featured Pick</div>' +
    `<div style="font-size:15px;font-weight:800;color:#111;font-family:sans-serif;margin-bottom:6px;line-height:1.3">${escHtml(title)}</div>` +
    quoteHtml +
    reviewLineHtml +
    '<div style="display:flex;align-items:center;gap:10px;font-family:sans-serif">' +
    priceHtml +
    `<a href="https://www.realskincare.com/products/${handle}" style="background:#1e1b4b;color:#fff;padding:8px 18px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:700">Add to Cart &#x2192;</a>` +
    '</div>' +
    '</div>' +
    '</div>' +
    '</div>'
  );
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── main() will be added in Task 3 ───────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.error('main() not yet implemented — see Task 3');
  process.exit(1);
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
node tests/agents/featured-product-injector.test.js
```
Expected: `✓ featured-product-injector pure function tests pass`

- [ ] **Step 5: Run full test suite to confirm nothing broken**

```bash
npm test
```
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add agents/featured-product-injector/index.js tests/agents/featured-product-injector.test.js
git commit -m "feat: featured-product-injector pure helpers with tests"
```

---

## Task 3: Main agent logic (`main()` function)

**Files:**
- Modify: `agents/featured-product-injector/index.js` (replace the stub `if` block at the bottom with full `loadEnv`, `main`, and error handler)

- [ ] **Step 1: Add `extractArticleContent` helper and `loadEnv` to the agent file**

Add these two functions after the `escHtml` function and before the `if (process.argv[1]...)` guard:

```js
function loadEnv() {
  try {
    const lines = readFileSync(join(ROOT, '.env'), 'utf8').split('\n');
    const env = {};
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const idx = t.indexOf('=');
      if (idx === -1) continue;
      env[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
    }
    return env;
  } catch { return {}; }
}

function extractArticleContent(html) {
  const start = html.indexOf('<article');
  const end = html.lastIndexOf('</article>');
  if (start !== -1 && end > start) {
    return html.slice(html.indexOf('>', start) + 1, end);
  }
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<meta[^>]*/gi, '')
    .replace(/<title[^>]*>[\s\S]*?<\/title>/gi, '');
}

function loadAvgScrollDepth() {
  const dir = join(ROOT, 'data', 'snapshots', 'clarity');
  if (!existsSync(dir)) return 40;
  const files = readdirSync(dir)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .slice(-60);
  const depths = files
    .map(f => { try { return JSON.parse(readFileSync(join(dir, f), 'utf8'))?.scrollDepth; } catch { return null; } })
    .filter(d => typeof d === 'number');
  return depths.length > 0 ? depths.reduce((a, b) => a + b, 0) / depths.length : 40;
}

function stripText(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function wordCount(text) {
  return text.split(/\s+/).filter(Boolean).length;
}
```

- [ ] **Step 2: Replace the stub `if` guard with full `main()` and error handler**

Replace the bottom of the file (the `if (process.argv[1]...)` stub block) with:

```js
// ── per-article injection ─────────────────────────────────────────────────────

async function injectIntoHtml(rawHtml, avgScrollDepth, judgemeToken, judgemeShopDomain) {
  const html = extractArticleContent(rawHtml);

  // Idempotency check — must be first
  if (html.includes('rsc-featured-product')) {
    return { html: rawHtml, skipped: true, reason: 'already has rsc-featured-product' };
  }

  const productHandle = findPrimaryProduct(html);
  if (!productHandle) {
    return { html: rawHtml, skipped: true, reason: 'no /products/ links found' };
  }

  // Fetch product from Shopify
  const { getProducts } = await import('../../lib/shopify.js');
  const products = await getProducts({ handle: productHandle });
  const product = products?.[0];
  if (!product) {
    return { html: rawHtml, skipped: true, reason: `product not found: ${productHandle}` };
  }

  const imageUrl = product.images?.[0]?.src ?? null;
  const price = product.variants?.[0]?.price ?? null;

  // Fetch Judge.me data (both calls in parallel)
  const { fetchTopReview, fetchProductStats } = await import('../../lib/judgeme.js');
  const [reviewData, statsData] = await Promise.all([
    judgemeToken ? fetchTopReview(productHandle, judgemeShopDomain, judgemeToken).catch(() => null) : Promise.resolve(null),
    judgemeToken ? fetchProductStats(productHandle, judgemeShopDomain, judgemeToken).catch(() => null) : Promise.resolve(null),
  ]);

  const stars = statsData ? renderStars(statsData.rating) : null;
  const reviewCount = statsData?.reviewCount ?? null;

  // Build featured product block
  const block = buildFeaturedProductHtml({
    title: product.title,
    handle: productHandle,
    imageUrl,
    price,
    quote: reviewData?.quote ?? null,
    verified: reviewData?.verified ?? false,
    stars,
    reviewCount,
  });

  // Remove mid-article dashed CTA, then insert block at scroll-depth position
  let processed = removeMidArticleCta(rawHtml);
  const plainText = stripText(extractArticleContent(processed));
  const total = wordCount(plainText);
  const targetWords = Math.floor(avgScrollDepth / 100 * total * 0.9);
  const insertIdx = findInsertionPoint(extractArticleContent(processed), targetWords);

  // Re-find the insertion point in the full rawHtml by adjusting for the article wrapper offset
  const articleStart = processed.indexOf('<article');
  const contentStart = articleStart !== -1 ? processed.indexOf('>', articleStart) + 1 : 0;
  const absoluteIdx = contentStart + insertIdx;

  const result = processed.slice(0, absoluteIdx) + block + processed.slice(absoluteIdx);

  return { html: result, skipped: false, productHandle, productTitle: product.title };
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const env = loadEnv();
  const judgemeToken = process.env.JUDGEME_API_TOKEN || env.JUDGEME_API_TOKEN || null;
  const judgemeShopDomain = process.env.JUDGEME_SHOP_DOMAIN || env.JUDGEME_SHOP_DOMAIN || null;

  if (!judgemeToken || !judgemeShopDomain) {
    throw new Error('Missing JUDGEME_API_TOKEN or JUDGEME_SHOP_DOMAIN in .env');
  }

  const args = process.argv.slice(2);
  const handleIdx = args.indexOf('--handle');
  const topIdx = args.indexOf('--top');
  const handle = handleIdx !== -1 ? args[handleIdx + 1] : null;
  const topN = topIdx !== -1 ? parseInt(args[topIdx + 1], 10) : null;

  if (!handle && !topN) {
    console.error('Usage: node index.js --handle <slug>  OR  --top <n>');
    process.exit(1);
  }

  const avgScrollDepth = loadAvgScrollDepth();
  console.log(`Featured Product Injector\n`);
  console.log(`  Avg scroll depth: ${avgScrollDepth.toFixed(1)}% (target insertion: ${(avgScrollDepth * 0.9).toFixed(1)}%)`);

  const { notify } = await import('../../lib/notify.js');

  // ── Pipeline mode: update local HTML file ──────────────────────────────────
  if (handle) {
    console.log(`  Mode: pipeline\n  Handle: ${handle}`);
    const filePath = join(ROOT, 'data', 'posts', `${handle}.html`);
    const rawHtml = readFileSync(filePath, 'utf8');
    const result = await injectIntoHtml(rawHtml, avgScrollDepth, judgemeToken, judgemeShopDomain);

    if (result.skipped) {
      console.log(`  Skipped: ${result.reason}`);
    } else {
      writeFileSync(filePath, result.html);
      console.log(`  Injected featured product: "${result.productTitle}" → ${filePath}`);
    }

    await notify({
      subject: `Featured Product Injector: ${handle}`,
      body: result.skipped ? `Skipped — ${result.reason}` : `Injected "${result.productTitle}" into ${handle}`,
      status: 'success',
    }).catch(() => {});
    return;
  }

  // ── Retroactive mode: update top-N Shopify posts ───────────────────────────
  console.log(`  Mode: retroactive (top ${topN})`);

  // Find top-N blog posts from GSC snapshot
  const gscDir = join(ROOT, 'data', 'snapshots', 'gsc');
  const gscFiles = readdirSync(gscDir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  if (gscFiles.length === 0) throw new Error('No GSC snapshots found in data/snapshots/gsc/');
  const gscSnap = JSON.parse(readFileSync(join(gscDir, gscFiles.at(-1)), 'utf8'));
  const blogPages = (gscSnap.pages || [])
    .filter(p => p.url && p.url.includes('/blogs/news/'))
    .sort((a, b) => (b.clicks || 0) - (a.clicks || 0))
    .slice(0, topN);

  if (blogPages.length === 0) throw new Error('No blog pages found in GSC snapshot');
  console.log(`  Top ${blogPages.length} pages: ${blogPages.map(p => p.url.split('/').at(-1)).join(', ')}`);

  // Fetch all articles from Shopify once
  const { getBlogs, getArticles, updateArticle } = await import('../../lib/shopify.js');
  const blogs = await getBlogs();
  const newsBlog = blogs.find(b => b.handle === 'news');
  if (!newsBlog) throw new Error('Blog "news" not found');
  const articles = await getArticles(newsBlog.id, { limit: 250 });
  const articleMap = new Map(articles.map(a => [a.handle, a]));

  const results = [];
  for (const page of blogPages) {
    const pageHandle = page.url.split('/').at(-1);
    const article = articleMap.get(pageHandle);
    if (!article) {
      console.log(`  ⚠  Article not found in Shopify: ${pageHandle}`);
      results.push({ handle: pageHandle, status: 'not_found' });
      continue;
    }

    console.log(`  Processing: ${pageHandle}`);
    const result = await injectIntoHtml(article.body_html || '', avgScrollDepth, judgemeToken, judgemeShopDomain);

    if (result.skipped) {
      console.log(`    Skipped: ${result.reason}`);
      results.push({ handle: pageHandle, status: 'skipped', reason: result.reason });
      continue;
    }

    await updateArticle(newsBlog.id, article.id, { body_html: result.html });
    console.log(`    Injected: "${result.productTitle}"`);
    results.push({ handle: pageHandle, status: 'injected', product: result.productTitle });
  }

  // Save report
  const reportsDir = join(ROOT, 'data', 'reports', 'featured-product');
  mkdirSync(reportsDir, { recursive: true });
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const reportLines = [
    `# Featured Product Injector Report — ${today}`,
    '',
    `Mode: retroactive (top ${topN})`,
    `Avg scroll depth: ${avgScrollDepth.toFixed(1)}%`,
    '',
    '## Results',
    ...results.map(r => `- **${r.handle}**: ${r.status}${r.product ? ` — "${r.product}"` : ''}${r.reason ? ` — ${r.reason}` : ''}`),
  ];
  writeFileSync(join(reportsDir, `${today}.md`), reportLines.join('\n'));
  console.log(`\n  Report saved to data/reports/featured-product/${today}.md`);

  const injected = results.filter(r => r.status === 'injected').length;
  await notify({
    subject: `Featured Product Injector: ${injected}/${results.length} posts updated`,
    body: reportLines.join('\n'),
    status: 'success',
  }).catch(() => {});
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(async err => {
    console.error('Error:', err.message);
    const { notify } = await import('../../lib/notify.js');
    await notify({ subject: 'Featured Product Injector failed', body: err.message, status: 'error' }).catch(() => {});
    process.exit(1);
  });
}
```

- [ ] **Step 3: Run the pure function tests again to confirm they still pass**

```bash
node tests/agents/featured-product-injector.test.js
```
Expected: `✓ featured-product-injector pure function tests pass`

- [ ] **Step 4: Run full test suite**

```bash
npm test
```
Expected: all 43+ tests pass.

- [ ] **Step 5: Commit**

```bash
git add agents/featured-product-injector/index.js
git commit -m "feat: featured-product-injector main() — pipeline and retroactive modes"
```

---

## Task 4: Dashboard integration

**Files:**
- Modify: `agents/dashboard/index.js`

Three changes are needed. Read the file first to locate exact insertion points.

- [ ] **Step 1: Add to `RUN_AGENT_ALLOWLIST`**

Find the `RUN_AGENT_ALLOWLIST` array. Add:
```js
'agents/featured-product-injector/index.js',
```

- [ ] **Step 2: Add run-log `<pre>` element inside `#tab-cro`**

Find the three existing CRO deep-dive run-log `<pre>` elements:
```html
<pre id="run-log-agents-cro-deep-dive-content-index-js" ...
<pre id="run-log-agents-cro-deep-dive-seo-index-js" ...
<pre id="run-log-agents-cro-deep-dive-trust-index-js" ...
```
Add a fourth immediately after them:
```html
<pre id="run-log-agents-featured-product-injector-index-js" style="display:none" class="run-log"></pre>
```

- [ ] **Step 3: Add button in the CRO tab actions group**

Find `id="tab-actions-cro"` div. Add a button alongside the existing CRO buttons:
```html
<button onclick="runAgent('agents/featured-product-injector/index.js', ['--top', '3'])" data-tip="Inject featured product sections into the 3 highest-traffic blog posts">Inject Featured Products</button>
```

- [ ] **Step 4: Run dashboard test suite**

```bash
npm test
```
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add agents/dashboard/index.js
git commit -m "feat: add Inject Featured Products button and run-log to dashboard"
```

---

## Task 5: Environment and pipeline docs

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add env vars under the Project Conventions section**

Find the line about `Ahrefs monetary values` in `## Project Conventions`. Add after it:
```
- `JUDGEME_API_TOKEN` — Judge.me private API token (from Judge.me dashboard → Settings → API)
- `JUDGEME_SHOP_DOMAIN` — must be the `.myshopify.com` domain (e.g. `realskincare.myshopify.com`), not the custom domain
```

- [ ] **Step 2: Update the pipeline order in memory (outside repo)**

Open `/Users/seanfillmore/.claude/projects/-Users-seanfillmore-Code-Claude/memory/MEMORY.md`.
This file lives outside the git repo — it does not need to be committed.

Find the Workflow section entry:
```
- Pipeline order: content-researcher → blog-post-writer → editor → image-generator → (manual review) → publisher
```
Update to:
```
- Pipeline order: content-researcher → blog-post-writer → featured-product-injector → editor → image-generator → (manual review) → publisher
```

- [ ] **Step 3: Commit CLAUDE.md**

```bash
git add CLAUDE.md
git commit -m "docs: add JUDGEME env vars and update pipeline order in CLAUDE.md"
```

---

## Task 6: Final verification

- [ ] **Step 1: Run full test suite one last time**

```bash
npm test
```
Expected: all tests pass (44+ now including judgeme and injector tests).

- [ ] **Step 2: Smoke-test the dashboard button**

```bash
node agents/dashboard/index.js
```
Open `http://localhost:4242`, navigate to the CRO tab, and confirm:
- "Inject Featured Products" button is visible in the actions bar
- Clicking it starts a run-log stream without a JavaScript console error

Stop the server (`Ctrl+C`) before continuing.

- [ ] **Step 3: Smoke-test pipeline mode with a local post**

```bash
# Requires real .env with JUDGEME_API_TOKEN and JUDGEME_SHOP_DOMAIN set
node agents/featured-product-injector/index.js --handle best-natural-deodorant-for-women
```
Expected output:
```
Featured Product Injector

  Avg scroll depth: XX.X% (target insertion: XX.X%)
  Mode: pipeline
  Handle: best-natural-deodorant-for-women
  Injected featured product: "..." → data/posts/best-natural-deodorant-for-women.html
```
Then inspect `data/posts/best-natural-deodorant-for-women.html` and confirm:
- `rsc-featured-product` class present
- No `border:1px dashed` section remaining
- Block appears roughly 35–45% into the content

- [ ] **Step 3: Commit if any fixes were needed**

```bash
git add -p
git commit -m "fix: <describe what was fixed>"
```
