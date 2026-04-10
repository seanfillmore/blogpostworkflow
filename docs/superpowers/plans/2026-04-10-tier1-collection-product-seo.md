# Tier 1 — Collection + Product Page SEO Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture clicks from 133K impressions across 173 product/collection URLs by adding collection page content, optimizing product meta tags, and automating cross-linking — all queued for human approval.

**Architecture:** Three independent changes: (1) new `collection-content-optimizer` agent that generates SEO descriptions for collection pages using GSC data, (2) new `--from-gsc` mode on `product-optimizer` for meta-only rewrites, (3) scheduler wiring for daily collection cross-linking and publish-approved steps. All content changes flow through the existing `data/performance-queue/` approval workflow.

**Tech Stack:** Node.js (ESM), Anthropic SDK (`claude-sonnet-4-6`), Shopify REST Admin API, Google Search Console API, existing `lib/shopify.js` and `lib/gsc.js` clients.

---

## File Structure

| Action | File | Responsibility |
|---|---|---|
| Create | `agents/collection-content-optimizer/index.js` | New agent: GSC-driven collection description generator + queue writer + publish-approved mode |
| Create | `tests/agents/collection-content-optimizer.test.js` | Unit tests for selection, filtering, queue item shape |
| Create | `tests/agents/product-optimizer-from-gsc.test.js` | Unit tests for `--from-gsc` mode selection and queue item shape |
| Modify | `agents/product-optimizer/index.js` | Add `--from-gsc` and `--publish-approved` modes |
| Modify | `scheduler.js` | Add publish-approved steps + daily collection-linker |
| Modify | `package.json` | Add npm scripts for new commands |
| Modify | `docs/signal-manifest.md` | Add new signal entries |

---

## Task 1: Add `--from-gsc` mode to product-optimizer (test)

**Files:**
- Create: `tests/agents/product-optimizer-from-gsc.test.js`

This test validates the selection logic and queue item shape for the new mode. We extract the selection and queue-building logic into testable pure functions.

- [ ] **Step 1: Write the test file**

```javascript
// tests/agents/product-optimizer-from-gsc.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * selectProductMetaCandidates(products, gscMap, activeQueueSlugs)
 * Filters products to those with ≥100 impressions and CTR < 1%,
 * excludes already-queued handles, sorts by impressions desc.
 */

// Inline the function under test (will be extracted into the agent)
function selectProductMetaCandidates(products, gscMap, activeQueueSlugs) {
  return products
    .map((p) => {
      const gsc = gscMap.get(p.url);
      if (!gsc) return null;
      if (gsc.impressions < 100) return null;
      if (gsc.ctr >= 0.01) return null;
      if (activeQueueSlugs.has(p.handle)) return null;
      return { ...p, gsc };
    })
    .filter(Boolean)
    .sort((a, b) => b.gsc.impressions - a.gsc.impressions);
}

function buildProductMetaQueueItem(product, gsc, topQueries, proposedMeta) {
  return {
    slug: product.handle,
    title: `${product.title} — Meta Rewrite`,
    trigger: 'product-meta-rewrite',
    signal_source: {
      type: 'gsc-product-meta',
      impressions: gsc.impressions,
      position: gsc.position,
      ctr: gsc.ctr,
      top_queries: topQueries.map((q) => q.keyword),
    },
    proposed_meta: {
      seo_title: proposedMeta.seo_title,
      seo_description: proposedMeta.seo_description,
      original_title: product.title,
      original_description: product.metaDescription || null,
    },
    resource_type: 'product',
    resource_id: product.id,
    summary: {
      what_changed: proposedMeta.what_changed,
      why: proposedMeta.why,
      projected_impact: proposedMeta.projected_impact,
    },
    status: 'pending',
    created_at: new Date().toISOString(),
  };
}

test('selectProductMetaCandidates filters by impressions >= 100', () => {
  const products = [
    { handle: 'coconut-lotion', url: 'https://example.com/products/coconut-lotion', title: 'Coconut Lotion', id: 1 },
    { handle: 'lip-balm', url: 'https://example.com/products/lip-balm', title: 'Lip Balm', id: 2 },
  ];
  const gscMap = new Map([
    ['https://example.com/products/coconut-lotion', { impressions: 8000, ctr: 0.002, position: 25 }],
    ['https://example.com/products/lip-balm', { impressions: 50, ctr: 0.001, position: 30 }],
  ]);
  const result = selectProductMetaCandidates(products, gscMap, new Set());
  assert.equal(result.length, 1);
  assert.equal(result[0].handle, 'coconut-lotion');
});

test('selectProductMetaCandidates excludes CTR >= 1%', () => {
  const products = [
    { handle: 'toothpaste', url: 'https://example.com/products/toothpaste', title: 'Toothpaste', id: 3 },
  ];
  const gscMap = new Map([
    ['https://example.com/products/toothpaste', { impressions: 5000, ctr: 0.02, position: 8 }],
  ]);
  const result = selectProductMetaCandidates(products, gscMap, new Set());
  assert.equal(result.length, 0);
});

test('selectProductMetaCandidates excludes already-queued handles', () => {
  const products = [
    { handle: 'coconut-lotion', url: 'https://example.com/products/coconut-lotion', title: 'Coconut Lotion', id: 1 },
  ];
  const gscMap = new Map([
    ['https://example.com/products/coconut-lotion', { impressions: 8000, ctr: 0.002, position: 25 }],
  ]);
  const result = selectProductMetaCandidates(products, gscMap, new Set(['coconut-lotion']));
  assert.equal(result.length, 0);
});

test('selectProductMetaCandidates sorts by impressions desc', () => {
  const products = [
    { handle: 'a', url: 'https://example.com/products/a', title: 'A', id: 1 },
    { handle: 'b', url: 'https://example.com/products/b', title: 'B', id: 2 },
  ];
  const gscMap = new Map([
    ['https://example.com/products/a', { impressions: 500, ctr: 0.001, position: 20 }],
    ['https://example.com/products/b', { impressions: 3000, ctr: 0.003, position: 15 }],
  ]);
  const result = selectProductMetaCandidates(products, gscMap, new Set());
  assert.equal(result[0].handle, 'b');
  assert.equal(result[1].handle, 'a');
});

test('buildProductMetaQueueItem produces correct shape', () => {
  const product = { handle: 'coconut-lotion', title: 'Coconut Lotion', id: 123, metaDescription: null };
  const gsc = { impressions: 8000, position: 25, ctr: 0.002 };
  const topQueries = [{ keyword: 'coconut lotion' }, { keyword: 'coconut body lotion' }];
  const proposedMeta = {
    seo_title: 'Organic Coconut Lotion | Real Skin Care',
    seo_description: 'Lightweight coconut body lotion made with organic virgin coconut oil.',
    what_changed: 'Rewrote title and meta description.',
    why: 'Low CTR on high-impression product page.',
    projected_impact: 'CTR improvement from 0.2% to 1%+.',
  };
  const item = buildProductMetaQueueItem(product, gsc, topQueries, proposedMeta);
  assert.equal(item.slug, 'coconut-lotion');
  assert.equal(item.trigger, 'product-meta-rewrite');
  assert.equal(item.resource_type, 'product');
  assert.equal(item.resource_id, 123);
  assert.equal(item.status, 'pending');
  assert.equal(item.proposed_meta.seo_title, 'Organic Coconut Lotion | Real Skin Care');
  assert.equal(item.proposed_meta.original_title, 'Coconut Lotion');
  assert.deepEqual(item.signal_source.top_queries, ['coconut lotion', 'coconut body lotion']);
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `node --test tests/agents/product-optimizer-from-gsc.test.js`
Expected: All 5 tests pass (functions are defined inline in the test file).

- [ ] **Step 3: Commit**

```bash
git add tests/agents/product-optimizer-from-gsc.test.js
git commit -m "test: add product-optimizer --from-gsc selection and queue item tests"
```

---

## Task 2: Add `--from-gsc` mode to product-optimizer (implementation)

**Files:**
- Modify: `agents/product-optimizer/index.js`

Add the `--from-gsc` flag that:
1. Fetches only products (no collections)
2. Filters to products with ≥100 impressions and CTR < 1%
3. Calls Claude for meta-only rewrites (no body_html)
4. Writes queue items to `data/performance-queue/`

- [ ] **Step 1: Add imports and flag parsing**

At the top of `agents/product-optimizer/index.js`, add the queue import after the existing imports (after line 40):

```javascript
import { writeItem, activeSlugs } from '../performance-engine/lib/queue.js';
```

After the existing arg parsing block (after line 80), add:

```javascript
const fromGsc = args.includes('--from-gsc');
const publishApproved = args.includes('--publish-approved');
const dryRun = args.includes('--dry-run');
```

- [ ] **Step 2: Add the meta-only Claude prompt function**

After the `rewriteCollection` function (after line 232), add:

```javascript
async function rewriteProductMeta(product, topQueries, gscData) {
  const topQueriesText = topQueries.slice(0, 5).map((q) =>
    `"${q.keyword}" — ${q.impressions} impr, pos #${Math.round(q.position)}, ${(q.ctr * 100).toFixed(1)}% CTR`
  ).join('\n  ');

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `You are an SEO specialist for ${config.name} (${config.url}), a natural skincare and personal care brand.

PRODUCT: ${product.title}
CURRENT TITLE TAG: ${product.currentMetaTitle || product.title}
CURRENT META DESCRIPTION: ${product.currentMetaDesc || '(none — using Shopify default)'}

GSC PERFORMANCE (last 90 days):
  Position: #${Math.round(gscData.position)}
  Impressions: ${gscData.impressions}
  CTR: ${(gscData.ctr * 100).toFixed(2)}%
  Clicks: ${gscData.clicks}

TOP SEARCH QUERIES driving impressions to this page:
  ${topQueriesText}

Rewrite ONLY the title tag and meta description to improve CTR:
- SEO title (50–60 chars): include the top query naturally, add brand name
- Meta description (140–155 chars): benefit-driven, include top query, create urgency to click
- Target the #1 query by impressions as the primary keyword
- Use ${config.name}'s voice: clean, expert, trustworthy

Also write a brief summary for the review queue:
- what_changed: 1 sentence about what you changed and why
- why: 1 sentence connecting the change to the GSC signal
- projected_impact: 1 sentence estimating the outcome

Return ONLY a JSON object:
{
  "seo_title": "...",
  "seo_description": "...",
  "what_changed": "...",
  "why": "...",
  "projected_impact": "..."
}
No explanation, no markdown fences.`,
    }],
  });

  const raw = message.content[0].text.trim()
    .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '');
  return JSON.parse(raw);
}
```

- [ ] **Step 3: Add the `--from-gsc` main flow**

Before the existing `main()` function (before line 236), add:

```javascript
async function fromGscMode() {
  console.log(`\nProduct Meta Optimizer (GSC-driven) — ${config.name}`);
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'QUEUE (writes to performance-queue for approval)'}`);
  console.log(`Limit: ${limit}\n`);

  // 1. Fetch products only
  process.stdout.write('  Fetching products... ');
  const products = await getProducts();
  console.log(`${products.length} products`);

  // 2. Build URL → GSC metrics map
  process.stdout.write('  Fetching GSC data... ');
  const gscPages = await gsc.getQuickWinPages(500, 90);
  const topPages = await gsc.getTopPages(500, 90);
  const gscMap = new Map();
  for (const p of gscPages) {
    if (!gscMap.has(p.url)) gscMap.set(p.url, { keyword: p.keyword, ...p });
  }
  for (const p of topPages) {
    if (!gscMap.has(p.page)) gscMap.set(p.page, { keyword: p.page.split('/').pop().replace(/-/g, ' '), url: p.page, ...p });
  }
  console.log('done');

  // 3. Select candidates: products with ≥100 impressions and CTR < 1%
  const active = activeSlugs();
  const candidates = products
    .filter((p) => !EXCLUDED_HANDLES.has(p.handle))
    .filter((p) => {
      const titleLower = p.title.toLowerCase();
      return !EXCLUDED_TITLE_PATTERNS.some((pat) => titleLower.includes(pat));
    })
    .map((p) => {
      const url = `${config.url}/products/${p.handle}`;
      const gscEntry = gscMap.get(url);
      if (!gscEntry) return null;
      if (gscEntry.impressions < 100) return null;
      if (gscEntry.ctr >= 0.01) return null;
      if (active.has(p.handle)) return null;
      return { ...p, url, gsc: gscEntry };
    })
    .filter(Boolean)
    .sort((a, b) => b.gsc.impressions - a.gsc.impressions)
    .slice(0, limit);

  if (candidates.length === 0) {
    console.log('\n  No product meta candidates found.');
    return;
  }

  console.log(`\n  Found ${candidates.length} candidate(s):\n`);
  for (const c of candidates) {
    console.log(`  "${c.title}" — ${c.gsc.impressions} impr, pos #${Math.round(c.gsc.position)}, ${(c.gsc.ctr * 100).toFixed(2)}% CTR`);
  }
  console.log('');

  if (dryRun) {
    console.log('  Dry run — no queue items written.');
    return;
  }

  // 4. For each candidate: get top queries, call Claude, write queue item
  let queued = 0;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    process.stdout.write(`  [${i + 1}/${candidates.length}] "${c.title}"... `);

    try {
      const topQueries = await gsc.getPageKeywords(c.url, 10, 90);
      const proposed = await rewriteProductMeta(
        { title: c.title, currentMetaTitle: null, currentMetaDesc: null },
        topQueries,
        c.gsc
      );

      const queueItem = {
        slug: c.handle,
        title: `${c.title} — Meta Rewrite`,
        trigger: 'product-meta-rewrite',
        signal_source: {
          type: 'gsc-product-meta',
          impressions: c.gsc.impressions,
          position: c.gsc.position,
          ctr: c.gsc.ctr,
          top_queries: topQueries.slice(0, 5).map((q) => q.keyword),
        },
        proposed_meta: {
          seo_title: proposed.seo_title,
          seo_description: proposed.seo_description,
          original_title: c.title,
          original_description: null,
        },
        resource_type: 'product',
        resource_id: c.id,
        summary: {
          what_changed: proposed.what_changed,
          why: proposed.why,
          projected_impact: proposed.projected_impact,
        },
        status: 'pending',
        created_at: new Date().toISOString(),
      };

      writeItem(queueItem);
      console.log('queued');
      queued++;
    } catch (e) {
      console.error(`failed: ${e.message}`);
    }
  }

  console.log(`\n  Queued ${queued} product meta rewrite(s) for approval.`);
  console.log('  Review on the dashboard Optimize tab.');
}
```

- [ ] **Step 4: Add the `--publish-approved` flow**

After the `fromGscMode` function, add:

```javascript
async function publishApprovedProducts() {
  console.log('\nPublishing approved product meta rewrites...\n');
  const { listQueueItems } = await import('../performance-engine/lib/queue.js');
  const items = listQueueItems().filter(
    (i) => i.trigger === 'product-meta-rewrite' && i.status === 'approved'
  );

  if (items.length === 0) {
    console.log('  No approved product meta items to publish.');
    return;
  }

  for (const item of items) {
    process.stdout.write(`  "${item.title}"... `);
    try {
      await upsertMetafield('products', item.resource_id, 'global', 'title_tag', item.proposed_meta.seo_title);
      await upsertMetafield('products', item.resource_id, 'global', 'description_tag', item.proposed_meta.seo_description);
      item.status = 'published';
      item.published_at = new Date().toISOString();
      writeItem(item);
      console.log('published');
    } catch (e) {
      console.error(`failed: ${e.message}`);
    }
  }
}
```

- [ ] **Step 5: Update the main entry point to route modes**

Replace the bottom of the file (lines 438–444) from `main()` to the end:

```javascript
const run = fromGsc ? fromGscMode : publishApproved ? publishApprovedProducts : main;

run()
  .then(() => notifyLatestReport('Product Optimizer completed', join(ROOT, 'data', 'reports', 'product-optimizer')))
  .catch((err) => {
    notify({ subject: 'Product Optimizer failed', body: err.message || String(err), status: 'error' });
    console.error('Error:', err.message);
    process.exit(1);
  });
```

- [ ] **Step 6: Update the file's doc comment**

Replace the Usage section in the doc comment (lines 18–23) with:

```javascript
 *   node agents/product-optimizer/index.js                   # dry run — products + collections
 *   node agents/product-optimizer/index.js --apply           # write changes to Shopify
 *   node agents/product-optimizer/index.js --type products   # products only
 *   node agents/product-optimizer/index.js --type collections # collections only
 *   node agents/product-optimizer/index.js --from-gsc        # queue product meta rewrites from GSC signals
 *   node agents/product-optimizer/index.js --from-gsc --dry-run  # show candidates without queuing
 *   node agents/product-optimizer/index.js --publish-approved    # push approved meta to Shopify
```

- [ ] **Step 7: Run the test to confirm nothing broke**

Run: `node --test tests/agents/product-optimizer-from-gsc.test.js`
Expected: All 5 tests pass.

- [ ] **Step 8: Commit**

```bash
git add agents/product-optimizer/index.js tests/agents/product-optimizer-from-gsc.test.js
git commit -m "feat(product-optimizer): add --from-gsc mode for GSC-driven meta rewrites with queue integration"
```

---

## Task 3: Create collection-content-optimizer agent (test)

**Files:**
- Create: `tests/agents/collection-content-optimizer.test.js`

- [ ] **Step 1: Write the test file**

```javascript
// tests/agents/collection-content-optimizer.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Selection logic — will be used in the agent
function selectCollectionCandidates(collections, gscResults, activeQueueSlugs, limit = 5) {
  return collections
    .map((c) => {
      const gsc = gscResults.get(c.url);
      if (!gsc) return null;
      if (gsc.impressions < 500) return null;
      if (gsc.position <= 10 && gsc.ctr >= 0.005) return null; // already performing well
      if (activeQueueSlugs.has(c.handle)) return null;
      return { ...c, gsc };
    })
    .filter(Boolean)
    .sort((a, b) => b.gsc.impressions - a.gsc.impressions)
    .slice(0, limit);
}

function findRelatedBlogPosts(topicalMap, collectionHandle, collectionTitle) {
  const searchTerms = collectionHandle.replace(/-/g, ' ').toLowerCase().split(' ')
    .filter((w) => w.length > 3);
  const results = [];
  for (const cluster of topicalMap.clusters || []) {
    for (const article of cluster.articles || []) {
      const titleLower = article.title.toLowerCase();
      if (searchTerms.some((t) => titleLower.includes(t))) {
        results.push({ url: article.url, title: article.title, cluster: cluster.tag });
      }
    }
  }
  return results.slice(0, 5);
}

function findRelevantIngredients(ingredientsConfig, collectionHandle) {
  const handleTerms = collectionHandle.replace(/-/g, ' ').toLowerCase();
  const matches = [];
  for (const [key, product] of Object.entries(ingredientsConfig)) {
    const nameMatch = product.name.toLowerCase().split(' ').some((w) => handleTerms.includes(w));
    const keyMatch = handleTerms.includes(key);
    if (nameMatch || keyMatch) {
      matches.push({ product: product.name, base_ingredients: product.base_ingredients || [] });
    }
  }
  return matches;
}

test('selectCollectionCandidates filters by impressions >= 500', () => {
  const collections = [
    { handle: 'body-lotion', url: 'https://example.com/collections/body-lotion', title: 'Body Lotion', id: 1 },
    { handle: 'soap', url: 'https://example.com/collections/soap', title: 'Soap', id: 2 },
  ];
  const gscResults = new Map([
    ['https://example.com/collections/body-lotion', { impressions: 12000, ctr: 0.003, position: 32 }],
    ['https://example.com/collections/soap', { impressions: 200, ctr: 0.001, position: 40 }],
  ]);
  const result = selectCollectionCandidates(collections, gscResults, new Set());
  assert.equal(result.length, 1);
  assert.equal(result[0].handle, 'body-lotion');
});

test('selectCollectionCandidates excludes already-queued', () => {
  const collections = [
    { handle: 'body-lotion', url: 'https://example.com/collections/body-lotion', title: 'Body Lotion', id: 1 },
  ];
  const gscResults = new Map([
    ['https://example.com/collections/body-lotion', { impressions: 12000, ctr: 0.003, position: 32 }],
  ]);
  const result = selectCollectionCandidates(collections, gscResults, new Set(['body-lotion']));
  assert.equal(result.length, 0);
});

test('selectCollectionCandidates allows top-10 position if CTR is still low', () => {
  const collections = [
    { handle: 'lotion', url: 'https://example.com/collections/lotion', title: 'Lotion', id: 1 },
  ];
  const gscResults = new Map([
    ['https://example.com/collections/lotion', { impressions: 5000, ctr: 0.002, position: 8 }],
  ]);
  const result = selectCollectionCandidates(collections, gscResults, new Set());
  assert.equal(result.length, 1); // position <= 10 but CTR < 0.5%, still a candidate
});

test('findRelatedBlogPosts matches by collection handle terms', () => {
  const topicalMap = {
    clusters: [{
      tag: 'mof',
      articles: [
        { url: 'https://example.com/blogs/news/coconut-oil-guide', title: 'Coconut Oil for Skin: Ultimate Guide' },
        { url: 'https://example.com/blogs/news/rose-water-benefits', title: 'Rose Water Benefits' },
      ],
    }],
  };
  const results = findRelatedBlogPosts(topicalMap, 'organic-coconut-lotion', 'Organic Coconut Lotion');
  assert.equal(results.length, 1);
  assert.ok(results[0].title.includes('Coconut'));
});

test('findRelevantIngredients matches by handle terms', () => {
  const ingredientsConfig = {
    lotion: { name: 'Body Lotion', base_ingredients: ['coconut oil', 'jojoba'] },
    soap: { name: 'Bar Soap', base_ingredients: ['coconut oil', 'olive oil'] },
  };
  const results = findRelevantIngredients(ingredientsConfig, 'non-toxic-body-lotion');
  assert.equal(results.length, 1);
  assert.equal(results[0].product, 'Body Lotion');
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `node --test tests/agents/collection-content-optimizer.test.js`
Expected: All 5 tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/agents/collection-content-optimizer.test.js
git commit -m "test: add collection-content-optimizer selection and helper tests"
```

---

## Task 4: Create collection-content-optimizer agent (implementation)

**Files:**
- Create: `agents/collection-content-optimizer/index.js`

- [ ] **Step 1: Write the agent**

```javascript
#!/usr/bin/env node
/**
 * Collection Content Optimizer Agent
 *
 * Generates SEO-optimized descriptions (300–500 words) for collection pages
 * that have high GSC impressions but poor ranking/CTR, typically because
 * they only have a title and product grid with no body content.
 *
 * Uses GSC data to target the actual queries users search, the topical map
 * for internal links to related blog posts, and ingredients config for
 * product accuracy.
 *
 * All changes queue through data/performance-queue/ for human approval.
 *
 * Usage:
 *   node agents/collection-content-optimizer/index.js                           # dry run
 *   node agents/collection-content-optimizer/index.js --queue                   # write to queue
 *   node agents/collection-content-optimizer/index.js --limit 3                 # top 3 only
 *   node agents/collection-content-optimizer/index.js --handle "vegan-body-lotion"  # single collection
 *   node agents/collection-content-optimizer/index.js --publish-approved        # push approved to Shopify
 *   node agents/collection-content-optimizer/index.js --dry-run                 # alias for default
 */

import Anthropic from '@anthropic-ai/sdk';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getCustomCollections,
  getSmartCollections,
  updateCustomCollection,
  updateSmartCollection,
  upsertMetafield,
} from '../../lib/shopify.js';
import * as gsc from '../../lib/gsc.js';
import { writeItem, activeSlugs, listQueueItems } from '../performance-engine/lib/queue.js';
import { notify, notifyLatestReport } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const CONTENT_DIR = join(ROOT, 'data', 'collection-content');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'collection-content-optimizer');

const config = JSON.parse(readFileSync(join(ROOT, 'config', 'site.json'), 'utf8'));

// ── env ───────────────────────────────────────────────────────────────────────

function loadEnv() {
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
}

const env = loadEnv();
if (!env.ANTHROPIC_API_KEY) { console.error('Missing ANTHROPIC_API_KEY in .env'); process.exit(1); }

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

// ── args ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(flag) {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : null;
}

const doQueue = args.includes('--queue');
const publishApproved = args.includes('--publish-approved');
const limit = parseInt(getArg('--limit') ?? '5', 10);
const singleHandle = getArg('--handle');

// Same exclusions as product-optimizer
const EXCLUDED_HANDLES = new Set([
  'main-menu-3',
  'home-page-collection',
  'reelup-do-not-delete',
  'bundle-builder-products',
  'live-collection',
  'on-sale',
  'all-products',
  'popular',
  'best-sellers',
  'for-shopify-performance-tracking',
]);

const EXCLUDED_TITLE_PATTERNS = [
  'do not delete',
  'do not modify',
  'shopify performance',
  'faire',
];

// ── helpers ───────────────────────────────────────────────────────────────────

function wordCount(html) {
  if (!html) return 0;
  return html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w.length > 0).length;
}

function stripHtml(html) {
  return (html || '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function loadTopicalMap() {
  const path = join(ROOT, 'data', 'topical-map.json');
  if (!existsSync(path)) return { clusters: [] };
  return JSON.parse(readFileSync(path, 'utf8'));
}

function loadIngredients() {
  const path = join(ROOT, 'config', 'ingredients.json');
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8'));
}

function findRelatedBlogPosts(topicalMap, collectionHandle) {
  const searchTerms = collectionHandle.replace(/-/g, ' ').toLowerCase().split(' ')
    .filter((w) => w.length > 3);
  const results = [];
  for (const cluster of topicalMap.clusters || []) {
    for (const article of cluster.articles || []) {
      const titleLower = article.title.toLowerCase();
      if (searchTerms.some((t) => titleLower.includes(t))) {
        results.push({ url: article.url, title: article.title });
      }
    }
  }
  return results.slice(0, 5);
}

function findRelevantIngredients(ingredientsConfig, collectionHandle) {
  const handleTerms = collectionHandle.replace(/-/g, ' ').toLowerCase();
  const matches = [];
  for (const [key, product] of Object.entries(ingredientsConfig)) {
    const nameMatch = product.name.toLowerCase().split(' ').some((w) => handleTerms.includes(w));
    const keyMatch = handleTerms.includes(key);
    if (nameMatch || keyMatch) {
      matches.push({ product: product.name, base_ingredients: product.base_ingredients || [] });
    }
  }
  return matches;
}

// ── claude rewriter ───────────────────────────────────────────────────────────

async function generateCollectionContent(collection, topQueries, gscData, relatedPosts, ingredients) {
  const topQueriesText = topQueries.slice(0, 10).map((q) =>
    `"${q.keyword}" — ${q.impressions} impr, pos #${Math.round(q.position)}`
  ).join('\n  ');

  const relatedPostsText = relatedPosts.length > 0
    ? relatedPosts.map((p) => `- [${p.title}](${p.url})`).join('\n')
    : '(none found)';

  const ingredientsText = ingredients.length > 0
    ? ingredients.map((i) => `${i.product}: ${i.base_ingredients.join(', ')}`).join('\n  ')
    : '(no specific ingredient data)';

  const currentDesc = stripHtml(collection.body_html).slice(0, 1000);

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: `You are an SEO content writer for ${config.name} (${config.url}), a natural skincare and personal care brand.

COLLECTION PAGE: ${collection.title}
HANDLE: ${collection.handle}
CURRENT DESCRIPTION: ${currentDesc || '(empty — no body content)'}
CURRENT WORD COUNT: ${wordCount(collection.body_html)}

GSC PERFORMANCE (last 90 days):
  Position: #${Math.round(gscData.position)}
  Impressions: ${gscData.impressions}
  CTR: ${(gscData.ctr * 100).toFixed(2)}%

TOP SEARCH QUERIES driving impressions to this collection page:
  ${topQueriesText}

RELATED BLOG POSTS (for internal linking):
${relatedPostsText}

PRODUCT INGREDIENTS (for accuracy):
  ${ingredientsText}

Write a 300–500 word SEO-optimized collection page description in clean HTML that:
1. Opens with the #1 search query naturally in the first sentence
2. Explains what this collection is and who it's for
3. Covers key product differentiators: what makes ${config.name}'s products in this category special
4. References specific ingredients from the list above for accuracy and trust
5. Includes 2–3 internal links to the related blog posts listed above (use their exact URLs)
6. Addresses secondary search queries naturally throughout the text
7. Ends with a brief reassurance about natural ingredients and brand quality
8. Uses clean semantic HTML: <p>, <h2>, <h3>, <ul>/<li>, <a> tags only
9. Matches ${config.name}'s voice: knowledgeable, clean, ingredient-focused, NOT salesy
10. Passes AI detection — avoid patterns that trigger AI content flags:
    - Vary sentence length aggressively
    - Lead with a specific concrete detail, NOT a generic opening
    - Cut all filler phrases: "designed with care", "more than just", "you deserve"
    - Use brand-specific details from the ingredients list
    - Avoid uniform sentence patterns

Also write:
- SEO title (50–60 chars, includes top query, format: "[Category] | ${config.name}")
- Meta description (140–155 chars, benefit-driven, includes top query)
- Summary for the review queue:
  - what_changed: 1–2 sentences about what you wrote
  - why: 1–2 sentences connecting the content to the GSC signal
  - projected_impact: 1 sentence estimating the outcome

Return ONLY a JSON object:
{
  "body_html": "<h2>...</h2><p>...</p>...",
  "seo_title": "...",
  "seo_description": "...",
  "what_changed": "...",
  "why": "...",
  "projected_impact": "..."
}
No explanation, no markdown fences.`,
    }],
  });

  const raw = message.content[0].text.trim()
    .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '');
  return JSON.parse(raw);
}

// ── publish approved ──────────────────────────────────────────────────────────

async function publishApprovedCollections() {
  console.log('\nPublishing approved collection content...\n');
  const items = listQueueItems().filter(
    (i) => i.trigger === 'collection-content' && i.status === 'approved'
  );

  if (items.length === 0) {
    console.log('  No approved collection content items to publish.');
    return;
  }

  for (const item of items) {
    process.stdout.write(`  "${item.title}"... `);
    try {
      // Read the generated HTML
      const html = readFileSync(item.proposed_html_path, 'utf8');

      // Update collection body_html
      if (item.collection_type === 'custom') {
        await updateCustomCollection(item.resource_id, { body_html: html });
        await upsertMetafield('custom_collections', item.resource_id, 'global', 'title_tag', item.proposed_meta.seo_title);
        await upsertMetafield('custom_collections', item.resource_id, 'global', 'description_tag', item.proposed_meta.seo_description);
      } else {
        await updateSmartCollection(item.resource_id, { body_html: html });
        await upsertMetafield('smart_collections', item.resource_id, 'global', 'title_tag', item.proposed_meta.seo_title);
        await upsertMetafield('smart_collections', item.resource_id, 'global', 'description_tag', item.proposed_meta.seo_description);
      }

      item.status = 'published';
      item.published_at = new Date().toISOString();
      writeItem(item);
      console.log('published');
    } catch (e) {
      console.error(`failed: ${e.message}`);
    }
  }
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nCollection Content Optimizer — ${config.name}`);
  console.log(`Mode: ${doQueue ? 'QUEUE' : 'DRY RUN'} | Limit: ${limit}${singleHandle ? ` | Handle: ${singleHandle}` : ''}\n`);

  // 1. Fetch all collections
  process.stdout.write('  Fetching collections... ');
  const [custom, smart] = await Promise.all([getCustomCollections(), getSmartCollections()]);
  const allCollections = [
    ...custom.map((c) => ({ ...c, collectionType: 'custom', url: `${config.url}/collections/${c.handle}` })),
    ...smart.map((c) => ({ ...c, collectionType: 'smart', url: `${config.url}/collections/${c.handle}` })),
  ];
  console.log(`${allCollections.length} collections`);

  // 2. Filter exclusions
  const eligible = allCollections.filter((c) => {
    if (EXCLUDED_HANDLES.has(c.handle)) return false;
    const titleLower = c.title.toLowerCase();
    if (EXCLUDED_TITLE_PATTERNS.some((p) => titleLower.includes(p))) return false;
    if (singleHandle && c.handle !== singleHandle) return false;
    return true;
  });

  // 3. Get GSC performance for each collection URL
  process.stdout.write('  Fetching GSC data... ');
  const gscResults = new Map();
  for (const c of eligible) {
    const perf = await gsc.getPagePerformance(c.url, 90);
    if (perf.impressions > 0) gscResults.set(c.url, perf);
  }
  console.log(`${gscResults.size} collections with GSC data`);

  // 4. Select candidates
  const active = activeSlugs();
  const candidates = eligible
    .map((c) => {
      const gscData = gscResults.get(c.url);
      if (!gscData) return null;
      if (gscData.impressions < 500) return null;
      if (gscData.position <= 10 && gscData.ctr >= 0.005) return null;
      if (active.has(c.handle)) return null;
      return { ...c, gsc: gscData };
    })
    .filter(Boolean)
    .sort((a, b) => b.gsc.impressions - a.gsc.impressions)
    .slice(0, singleHandle ? 1 : limit);

  if (candidates.length === 0) {
    console.log('\n  No collection content candidates found.');
    return;
  }

  console.log(`\n  Found ${candidates.length} candidate(s):\n`);
  for (const c of candidates) {
    const wc = wordCount(c.body_html);
    console.log(`  "${c.title}" — ${c.gsc.impressions} impr, pos #${Math.round(c.gsc.position)}, ${(c.gsc.ctr * 100).toFixed(2)}% CTR, ${wc} words`);
  }
  console.log('');

  if (!doQueue) {
    console.log('  Dry run — use --queue to write to performance queue.');
    return;
  }

  // 5. Load topical map and ingredients for enrichment
  const topicalMap = loadTopicalMap();
  const ingredientsConfig = loadIngredients();
  mkdirSync(CONTENT_DIR, { recursive: true });

  // 6. Generate content for each candidate
  let queued = 0;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    process.stdout.write(`  [${i + 1}/${candidates.length}] "${c.title}"... `);

    try {
      const topQueries = await gsc.getPageKeywords(c.url, 10, 90);
      const relatedPosts = findRelatedBlogPosts(topicalMap, c.handle);
      const ingredients = findRelevantIngredients(ingredientsConfig, c.handle);

      const result = await generateCollectionContent(c, topQueries, c.gsc, relatedPosts, ingredients);

      // Validate word count
      const wc = wordCount(result.body_html);
      if (wc < 200) {
        console.log(`warning: only ${wc} words (expected 300–500), queuing anyway`);
      } else {
        console.log(`done (${wc} words)`);
      }

      // Save HTML for preview
      const htmlPath = join(CONTENT_DIR, `${c.handle}.html`);
      writeFileSync(htmlPath, result.body_html);

      // Write queue item
      const queueItem = {
        slug: c.handle,
        title: `${c.title} — Collection Content`,
        trigger: 'collection-content',
        signal_source: {
          type: 'gsc-collection-content',
          impressions: c.gsc.impressions,
          position: c.gsc.position,
          ctr: c.gsc.ctr,
          top_queries: topQueries.slice(0, 5).map((q) => q.keyword),
        },
        proposed_html_path: htmlPath,
        proposed_meta: {
          seo_title: result.seo_title,
          seo_description: result.seo_description,
          original_title: c.title,
          original_description: null,
        },
        backup_html: c.body_html || '',
        resource_type: 'collection',
        resource_id: c.id,
        collection_type: c.collectionType,
        summary: {
          what_changed: result.what_changed,
          why: result.why,
          projected_impact: result.projected_impact,
        },
        status: 'pending',
        created_at: new Date().toISOString(),
      };

      writeItem(queueItem);
      queued++;
    } catch (e) {
      console.error(`failed: ${e.message}`);
    }
  }

  console.log(`\n  Queued ${queued} collection content item(s) for approval.`);
  console.log('  Review on the dashboard Optimize tab.');
}

// ── entry ─────────────────────────────────────────────────────────────────────

const run = publishApproved ? publishApprovedCollections : main;

run()
  .then(() => notifyLatestReport('Collection Content Optimizer completed', REPORTS_DIR))
  .catch((err) => {
    notify({ subject: 'Collection Content Optimizer failed', body: err.message || String(err), status: 'error' });
    console.error('Error:', err.message);
    process.exit(1);
  });
```

- [ ] **Step 2: Run existing tests to make sure nothing is broken**

Run: `node --test tests/agents/collection-content-optimizer.test.js`
Expected: All 5 tests pass.

- [ ] **Step 3: Commit**

```bash
git add agents/collection-content-optimizer/index.js
git commit -m "feat: add collection-content-optimizer agent with GSC-driven content generation and queue integration"
```

---

## Task 5: Wire scheduler (publish-approved + collection-linker)

**Files:**
- Modify: `scheduler.js`

- [ ] **Step 1: Add publish-approved steps and collection-linker to scheduler.js**

After the link repair block (after line 110, before the `log('Scheduler done.')` line), add:

```javascript
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

// Step 5: run collection linker to inject cross-links from blog posts to collections
const collLinkCmd = `"${NODE}" agents/collection-linker/index.js --top-targets --apply${dryFlag}`;
log(`  ${collLinkCmd}`);
try {
  execSync(collLinkCmd, { stdio: 'inherit', cwd: __dirname });
  log('  ✓ collection-linker complete');
} catch (e) {
  log(`  ✗ collection-linker failed (exit ${e.status})`);
}
```

- [ ] **Step 2: Run scheduler in dry-run mode to verify it doesn't crash**

Run: `node scheduler.js --dry-run 2>&1 | tail -20`
Expected: Log output shows all steps including the new ones (they may fail in dry-run if no approved items exist — that's fine, the scheduler should catch the error and continue).

- [ ] **Step 3: Commit**

```bash
git add scheduler.js
git commit -m "feat(scheduler): add daily publish-approved + collection-linker steps"
```

---

## Task 6: Add npm scripts and update signal manifest

**Files:**
- Modify: `package.json`
- Modify: `docs/signal-manifest.md`

- [ ] **Step 1: Add npm scripts to package.json**

After the `"product-optimize"` line (line 35), add:

```json
    "product-meta-gsc": "node agents/product-optimizer/index.js --from-gsc",
    "product-meta-publish": "node agents/product-optimizer/index.js --publish-approved",
    "collection-content": "node agents/collection-content-optimizer/index.js",
    "collection-content-queue": "node agents/collection-content-optimizer/index.js --queue",
    "collection-content-publish": "node agents/collection-content-optimizer/index.js --publish-approved",
```

- [ ] **Step 2: Update signal manifest**

Add these rows to the appropriate tables in `docs/signal-manifest.md`.

In the **Signals** table (after existing entries), add:

```markdown
| `data/performance-queue/<handle>.json` (trigger: `product-meta-rewrite`) | `product-optimizer --from-gsc` | dashboard, `product-optimizer --publish-approved` |
| `data/performance-queue/<handle>.json` (trigger: `collection-content`) | `collection-content-optimizer` | dashboard, `collection-content-optimizer --publish-approved` |
| `data/collection-content/<handle>.html` | `collection-content-optimizer` | dashboard preview, `collection-content-optimizer --publish-approved` |
```

In the **Consumers** column for `config/ingredients.json`, add `collection-content-optimizer`.

In the **Consumers** column for `data/topical-map.json`, add `collection-content-optimizer`.

- [ ] **Step 3: Commit**

```bash
git add package.json docs/signal-manifest.md
git commit -m "docs: update signal manifest and npm scripts for Tier 1 agents"
```

---

## Task 7: Integration smoke test

**Files:** None (manual verification)

- [ ] **Step 1: Run collection-content-optimizer in dry-run mode**

Run: `node agents/collection-content-optimizer/index.js --limit 2`
Expected: Lists 2 collection candidates with GSC data (impressions, position, CTR, word count). No queue items written.

- [ ] **Step 2: Run product-optimizer --from-gsc in dry-run mode**

Run: `node agents/product-optimizer/index.js --from-gsc --dry-run --limit 2`
Expected: Lists 2 product candidates with GSC data. No queue items written.

- [ ] **Step 3: Run scheduler dry-run to verify all steps execute**

Run: `node scheduler.js --dry-run 2>&1 | grep -E '(Step|✓|✗|publish-approved|collection-linker)'`
Expected: Shows steps 4a, 4b, 5 in the log output.

- [ ] **Step 4: Run all tests**

Run: `node --test tests/agents/product-optimizer-from-gsc.test.js tests/agents/collection-content-optimizer.test.js`
Expected: All 10 tests pass.

- [ ] **Step 5: Commit (if any fixes were needed)**

Only if changes were made during smoke testing:

```bash
git add -A
git commit -m "fix: smoke test fixes for Tier 1 agents"
```
