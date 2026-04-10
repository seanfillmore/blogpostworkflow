# Tier 2 — Structural SEO + Signal Loops Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automate product schema injection with reviews, detect collection keyword gaps from GSC signals, resolve keyword cannibalization weekly, and feed GA4 conversion data back into content strategy.

**Architecture:** Four independent workstreams extending existing agents: (1) `product-schema` gets `--auto` mode with Judge.me and GSC filtering, (2) `collection-creator` gets `--from-opportunities` + queue mode, (3) `cannibalization-resolver` gets cross-type detection + dashboard card, (4) new `ga4-content-analyzer` agent feeds into `content-strategist` and `cro-cta-injector`. All weekly jobs added to `scheduler.js` with Sunday gating.

**Tech Stack:** Node.js (ESM), Anthropic SDK, Shopify REST API, Google Search Console API, GA4 Analytics Data API, Judge.me API, existing `lib/` clients.

---

## File Structure

| Action | File | Responsibility |
|---|---|---|
| Modify | `agents/product-schema/index.js` | Add `--auto` mode: GSC filtering + Judge.me AggregateRating |
| Create | `tests/agents/product-schema-auto.test.js` | Tests for GSC filtering and review schema building |
| Modify | `agents/collection-creator/index.js` | Add `--from-opportunities`, `--queue`, `--publish-approved` modes |
| Create | `tests/agents/collection-creator-opportunities.test.js` | Tests for opportunity filtering and queue item shape |
| Modify | `agents/cannibalization-resolver/index.js` | Extend to all URL types, add `--report-json` |
| Create | `tests/agents/cannibalization-extended.test.js` | Tests for cross-type detection |
| Modify | `agents/dashboard/lib/data-loader.js` | Load cannibalization report |
| Modify | `agents/dashboard/public/js/dashboard.js` | Add cannibalization card |
| Create | `agents/ga4-content-analyzer/index.js` | New agent: classify pages by traffic/conversion |
| Create | `tests/agents/ga4-content-analyzer.test.js` | Tests for page classification |
| Modify | `agents/content-strategist/index.js` | Read GA4 feedback for cluster weighting |
| Modify | `agents/cro-cta-injector/index.js` | Add `--from-ga4` mode |
| Modify | `scheduler.js` | Add weekly steps 6–9 |
| Modify | `package.json` | Add npm scripts |
| Modify | `docs/signal-manifest.md` | Add new signal entries |

---

## Task 1: Product schema — tests for `--auto` mode

**Files:**
- Create: `tests/agents/product-schema-auto.test.js`

- [ ] **Step 1: Write the test file**

```javascript
// tests/agents/product-schema-auto.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

function filterByGscImpressions(products, gscUrls, minImpressions = 50) {
  return products.filter((p) => {
    const impr = gscUrls.get(p.url);
    return impr != null && impr >= minImpressions;
  });
}

function buildProductSchemaWithReviews(baseSchema, reviewStats) {
  if (!reviewStats || reviewStats.reviewCount === 0) return baseSchema;
  return {
    ...baseSchema,
    aggregateRating: {
      '@type': 'AggregateRating',
      ratingValue: String(Math.round(reviewStats.rating * 10) / 10),
      reviewCount: reviewStats.reviewCount,
      bestRating: '5',
      worstRating: '1',
    },
  };
}

test('filterByGscImpressions keeps products with >= 50 impressions', () => {
  const products = [
    { url: 'https://example.com/products/a', title: 'A' },
    { url: 'https://example.com/products/b', title: 'B' },
    { url: 'https://example.com/products/c', title: 'C' },
  ];
  const gscUrls = new Map([
    ['https://example.com/products/a', 200],
    ['https://example.com/products/b', 30],
  ]);
  const result = filterByGscImpressions(products, gscUrls);
  assert.equal(result.length, 1);
  assert.equal(result[0].title, 'A');
});

test('filterByGscImpressions with custom threshold', () => {
  const products = [{ url: 'https://example.com/products/a', title: 'A' }];
  const gscUrls = new Map([['https://example.com/products/a', 30]]);
  assert.equal(filterByGscImpressions(products, gscUrls, 20).length, 1);
  assert.equal(filterByGscImpressions(products, gscUrls, 50).length, 0);
});

test('buildProductSchemaWithReviews adds aggregateRating when reviews exist', () => {
  const base = { '@type': 'Product', name: 'Lotion' };
  const stats = { rating: 4.75, reviewCount: 12 };
  const result = buildProductSchemaWithReviews(base, stats);
  assert.equal(result.aggregateRating['@type'], 'AggregateRating');
  assert.equal(result.aggregateRating.ratingValue, '4.8');
  assert.equal(result.aggregateRating.reviewCount, 12);
  assert.equal(result.aggregateRating.bestRating, '5');
});

test('buildProductSchemaWithReviews returns base schema when no reviews', () => {
  const base = { '@type': 'Product', name: 'Lotion' };
  assert.deepEqual(buildProductSchemaWithReviews(base, null), base);
  assert.deepEqual(buildProductSchemaWithReviews(base, { rating: 0, reviewCount: 0 }), base);
});
```

- [ ] **Step 2: Run tests**

Run: `node --test tests/agents/product-schema-auto.test.js`
Expected: All 4 tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/agents/product-schema-auto.test.js
git commit -m "test: add product-schema --auto mode tests for GSC filtering and review schema"
```

---

## Task 2: Product schema — implement `--auto` mode

**Files:**
- Modify: `agents/product-schema/index.js`

- [ ] **Step 1: Add imports**

After the existing imports (after line 38), add:

```javascript
import * as gsc from '../../lib/gsc.js';
import { fetchProductStats } from '../../lib/judgeme.js';
```

- [ ] **Step 2: Add `--auto` flag and env loading**

After the existing arg parsing (after line 56), add:

```javascript
const autoMode = args.includes('--auto');

// Judge.me credentials (only needed in --auto mode)
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
```

- [ ] **Step 3: Add GSC filtering and review integration to the products loop**

Replace the products processing block (lines 168–201) with a version that:
- In `--auto` mode: fetches GSC data, builds a URL → impressions map, filters products to those with ≥50 impressions
- For each product in `--auto` mode: calls `fetchProductStats()` for Judge.me review data, passes it to a new `buildProductSchemaWithReviews()` function
- In normal mode: keeps existing behavior (all products, no reviews)

The `buildProductSchemaWithReviews(baseSchema, reviewStats)` function:
```javascript
function buildProductSchemaWithReviews(baseSchema, reviewStats) {
  if (!reviewStats || reviewStats.reviewCount === 0) return baseSchema;
  return {
    ...baseSchema,
    aggregateRating: {
      '@type': 'AggregateRating',
      'ratingValue': String(Math.round(reviewStats.rating * 10) / 10),
      'reviewCount': reviewStats.reviewCount,
      'bestRating': '5',
      'worstRating': '1',
    },
  };
}
```

Key implementation details for auto mode:
- Build GSC impression map: `gsc.getQuickWinPages(500, 90)` + `gsc.getTopPages(500, 90)`, combine into `Map<url, impressions>`
- Filter products: `products.filter(p => gscImprMap.get(url) >= 50)`
- Load env for Judge.me: `const env = loadEnv(); const shopDomain = env.SHOPIFY_STORE; const judgeToken = env.JUDGEME_API_TOKEN;`
- For each product: `const stats = judgeToken ? await fetchProductStats(product.handle, shopDomain, judgeToken).catch(() => null) : null;`
- Build schema: `buildProductSchemaWithReviews(buildProductSchema(product), stats)`
- Log review info: `console.log(\`✓ (${stats ? stats.reviewCount + ' reviews' : 'no reviews'})\`)`

- [ ] **Step 4: Update doc comment**

Add to the Usage section:
```
 *   node agents/product-schema/index.js --auto --apply  # GSC-filtered + Judge.me reviews
```

- [ ] **Step 5: Update entry point for mode routing**

Replace the entry point (lines 279–285):
```javascript
const run = autoMode ? autoMain : main;

run()
  .then(() => notifyLatestReport('Product Schema completed', join(ROOT, 'data', 'reports', 'product-schema')))
  .catch((err) => {
    notify({ subject: 'Product Schema failed', body: err.message || String(err), status: 'error' });
    console.error('Error:', err.message);
    process.exit(1);
  });
```

Where `autoMain` is a new function that wraps the modified products loop + existing collections loop.

- [ ] **Step 6: Run tests**

Run: `node --test tests/agents/product-schema-auto.test.js`
Expected: All 4 tests pass.

- [ ] **Step 7: Commit**

```bash
git add agents/product-schema/index.js
git commit -m "feat(product-schema): add --auto mode with GSC filtering and Judge.me AggregateRating"
```

---

## Task 3: Cannibalization — tests for extended detection

**Files:**
- Create: `tests/agents/cannibalization-extended.test.js`

- [ ] **Step 1: Write the test file**

```javascript
// tests/agents/cannibalization-extended.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

function classifyUrl(url) {
  const path = new URL(url).pathname;
  if (path.startsWith('/blogs/')) return 'blog';
  if (path.startsWith('/products/')) return 'product';
  if (path.startsWith('/collections/')) return 'collection';
  return 'other';
}

function detectCannibalizationExtended(queryPageRows, minImpr = 50) {
  const byQuery = new Map();
  for (const row of queryPageRows) {
    const type = classifyUrl(row.page);
    if (type === 'other') continue;
    if (!byQuery.has(row.query)) byQuery.set(row.query, []);
    byQuery.get(row.query).push({ ...row, type });
  }

  return [...byQuery.entries()]
    .filter(([, pages]) => pages.length >= 2)
    .map(([query, pages]) => {
      const sorted = [...pages].sort((a, b) => b.impressions - a.impressions);
      const types = new Set(sorted.map((p) => p.type));
      const conflictType = types.size === 1 ? `${[...types][0]}-vs-${[...types][0]}` :
        [...types].sort().join('-vs-');
      return {
        query,
        conflictType,
        totalImpressions: pages.reduce((s, p) => s + p.impressions, 0),
        pages: sorted.map((p) => ({
          url: p.page,
          type: p.type,
          impressions: p.impressions,
          position: p.position,
        })),
      };
    })
    .filter((g) => g.totalImpressions >= minImpr)
    .sort((a, b) => b.totalImpressions - a.totalImpressions);
}

test('detectCannibalizationExtended finds blog-vs-blog conflicts', () => {
  const rows = [
    { query: 'coconut oil', page: 'https://example.com/blogs/news/a', impressions: 500, position: 5 },
    { query: 'coconut oil', page: 'https://example.com/blogs/news/b', impressions: 300, position: 12 },
  ];
  const result = detectCannibalizationExtended(rows);
  assert.equal(result.length, 1);
  assert.equal(result[0].conflictType, 'blog-vs-blog');
});

test('detectCannibalizationExtended finds blog-vs-product conflicts', () => {
  const rows = [
    { query: 'coconut lotion', page: 'https://example.com/blogs/news/a', impressions: 400, position: 6 },
    { query: 'coconut lotion', page: 'https://example.com/products/coconut-lotion', impressions: 300, position: 10 },
  ];
  const result = detectCannibalizationExtended(rows);
  assert.equal(result.length, 1);
  assert.equal(result[0].conflictType, 'blog-vs-product');
});

test('detectCannibalizationExtended ignores homepage and other URLs', () => {
  const rows = [
    { query: 'skincare', page: 'https://example.com/', impressions: 1000, position: 3 },
    { query: 'skincare', page: 'https://example.com/blogs/news/a', impressions: 200, position: 15 },
  ];
  const result = detectCannibalizationExtended(rows);
  assert.equal(result.length, 0); // only 1 valid URL, need >= 2
});

test('detectCannibalizationExtended respects minImpr threshold', () => {
  const rows = [
    { query: 'niche query', page: 'https://example.com/blogs/news/a', impressions: 10, position: 5 },
    { query: 'niche query', page: 'https://example.com/blogs/news/b', impressions: 10, position: 12 },
  ];
  assert.equal(detectCannibalizationExtended(rows, 50).length, 0);
  assert.equal(detectCannibalizationExtended(rows, 10).length, 1);
});
```

- [ ] **Step 2: Run tests**

Run: `node --test tests/agents/cannibalization-extended.test.js`
Expected: All 4 tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/agents/cannibalization-extended.test.js
git commit -m "test: add extended cannibalization detection tests for cross-type URLs"
```

---

## Task 4: Cannibalization — implement extended detection + `--report-json`

**Files:**
- Modify: `agents/cannibalization-resolver/index.js`

- [ ] **Step 1: Add URL classification helpers**

After the existing `isBlogPost` function (line 98), add:

```javascript
function isProduct(url) { return urlPath(url).startsWith('/products/'); }
function isCollection(url) { return urlPath(url).startsWith('/collections/'); }

function classifyUrl(url) {
  if (isBlogPost(url)) return 'blog';
  if (isProduct(url)) return 'product';
  if (isCollection(url)) return 'collection';
  return 'other';
}
```

- [ ] **Step 2: Add `--report-json` flag**

After existing arg parsing (line 89), add:

```javascript
const reportJson = args.includes('--report-json');
```

- [ ] **Step 3: Add extended detection function**

After the existing `detectCannibalization` function (after line 152), add a new `detectCannibalizationExtended(queryPageRows)` function that:
- Includes blog, product, and collection URLs (skips 'other')
- Tags each URL with its `type`
- Computes `conflictType` as sorted types joined with `-vs-` (e.g., `blog-vs-product`)
- Returns the same structure as existing detection but with `type` and `conflictType` fields added
- Applies the existing `minImpr` threshold

- [ ] **Step 4: Update main flow**

In the main function, after the existing blog-only detection:
- Run `detectCannibalizationExtended` on the same `queryPageRows`
- Separate results: blog-vs-blog conflicts go through existing triage + resolution flow
- Cross-type conflicts (blog-vs-product, blog-vs-collection, etc.) are logged as recommendations only — no auto-resolution

- [ ] **Step 5: Add JSON report output**

When `--report-json` flag is set, write `data/reports/cannibalization/latest.json`:

```javascript
if (reportJson) {
  const jsonReport = {
    generated_at: new Date().toISOString(),
    conflict_count: allConflicts.length,
    auto_resolved: blogOnlyResolved,
    recommended: crossTypeConflicts.length,
    conflicts: allConflicts.slice(0, 20).map((c) => ({
      query: c.query,
      total_impressions: c.totalImpressions,
      urls: c.pages.map((p) => ({
        url: p.url,
        position: p.position,
        impressions: p.impressions,
        type: p.type,
      })),
      conflict_type: c.conflictType,
      resolution: c.resolution || 'recommendation',
      auto_applied: c.autoApplied || false,
    })),
  };
  mkdirSync(join(ROOT, 'data', 'reports', 'cannibalization'), { recursive: true });
  writeFileSync(join(ROOT, 'data', 'reports', 'cannibalization', 'latest.json'), JSON.stringify(jsonReport, null, 2));
}
```

- [ ] **Step 6: Run tests**

Run: `node --test tests/agents/cannibalization-extended.test.js`
Expected: All 4 tests pass.

- [ ] **Step 7: Commit**

```bash
git add agents/cannibalization-resolver/index.js
git commit -m "feat(cannibalization-resolver): extend detection to products/collections, add --report-json"
```

---

## Task 5: Dashboard — cannibalization card

**Files:**
- Modify: `agents/dashboard/lib/data-loader.js`
- Modify: `agents/dashboard/public/js/dashboard.js`

- [ ] **Step 1: Add cannibalization data to data-loader**

In `agents/dashboard/lib/data-loader.js`, after the `legacyTriage` line (line 216), add:

```javascript
const cannibalization = readJsonIfExists(join(REPORTS_DIR, 'cannibalization', 'latest.json'));
```

Add `cannibalization` to the return object (after `legacyTriage` on line 301):

```javascript
    cannibalization,
```

- [ ] **Step 2: Add renderCannibalizationCard to dashboard.js**

Add a new function in `agents/dashboard/public/js/dashboard.js`:

```javascript
function renderCannibalizationCard(d) {
  var c = d.cannibalization;
  if (!c || !c.conflicts || c.conflicts.length === 0) return '';
  return '<div class="card"><div class="card-header accent-red"><h2>Keyword Cannibalization <span class="badge">' + c.conflict_count + '</span></h2></div>' +
    '<div class="card-body">' +
    '<p style="color:#6b7280;margin-bottom:12px">' + c.auto_resolved + ' auto-resolved, ' + c.recommended + ' recommendations</p>' +
    '<table class="data-table"><thead><tr><th>Query</th><th>Impressions</th><th>URLs</th><th>Type</th></tr></thead><tbody>' +
    c.conflicts.slice(0, 10).map(function(conflict) {
      var urls = conflict.urls.map(function(u) {
        return '<div style="font-size:12px">' + u.type + ' #' + Math.round(u.position) + ' — <a href="' + u.url + '" target="_blank">' + u.url.split('/').pop() + '</a></div>';
      }).join('');
      return '<tr><td><strong>' + conflict.query + '</strong></td><td>' + conflict.total_impressions + '</td><td>' + urls + '</td><td>' + conflict.conflict_type + '</td></tr>';
    }).join('') +
    '</tbody></table></div></div>';
}
```

- [ ] **Step 3: Add card to Optimize tab rendering**

In the `renderOptimizeTab` function (around line 150), add `renderCannibalizationCard(d)` after `renderPerformanceQueueCard(d)`:

Find:
```javascript
    renderPerformanceQueueCard(d) +
    renderIndexingCard(d) +
```

Replace with:
```javascript
    renderPerformanceQueueCard(d) +
    renderCannibalizationCard(d) +
    renderIndexingCard(d) +
```

- [ ] **Step 4: Commit**

```bash
git add agents/dashboard/lib/data-loader.js agents/dashboard/public/js/dashboard.js
git commit -m "feat(dashboard): add cannibalization card to Optimize tab"
```

---

## Task 6: GA4 content analyzer — tests

**Files:**
- Create: `tests/agents/ga4-content-analyzer.test.js`

- [ ] **Step 1: Write the test file**

```javascript
// tests/agents/ga4-content-analyzer.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

function classifyPage(sessions, conversions) {
  if (sessions >= 100 && conversions === 0) return 'high-traffic-low-conversion';
  if (sessions < 50 && conversions >= 1) return 'low-traffic-high-conversion';
  return 'balanced';
}

function aggregateSnapshots(snapshots) {
  const byPage = new Map();
  for (const snap of snapshots) {
    for (const lp of (snap.topLandingPages || [])) {
      const existing = byPage.get(lp.page) || { sessions: 0, conversions: 0, revenue: 0 };
      existing.sessions += lp.sessions || 0;
      existing.conversions += lp.conversions || 0;
      existing.revenue += lp.revenue || 0;
      byPage.set(lp.page, existing);
    }
  }
  return byPage;
}

function classifyCluster(pages) {
  const croCandidates = pages.filter((p) => p.classification === 'high-traffic-low-conversion');
  const expansionCandidates = pages.filter((p) => p.classification === 'low-traffic-high-conversion');
  return {
    cro_signal: croCandidates.length > expansionCandidates.length,
    expansion_signal: expansionCandidates.length > 0 && expansionCandidates.length >= croCandidates.length,
  };
}

test('classifyPage: high traffic, no conversions = CRO candidate', () => {
  assert.equal(classifyPage(500, 0), 'high-traffic-low-conversion');
});

test('classifyPage: low traffic, has conversions = expansion candidate', () => {
  assert.equal(classifyPage(30, 2), 'low-traffic-high-conversion');
});

test('classifyPage: moderate traffic with conversions = balanced', () => {
  assert.equal(classifyPage(200, 5), 'balanced');
});

test('classifyPage: low traffic, no conversions = balanced', () => {
  assert.equal(classifyPage(10, 0), 'balanced');
});

test('aggregateSnapshots sums sessions and conversions per page', () => {
  const snapshots = [
    { topLandingPages: [{ page: '/a', sessions: 50, conversions: 1, revenue: 10 }] },
    { topLandingPages: [{ page: '/a', sessions: 30, conversions: 0, revenue: 0 }, { page: '/b', sessions: 20, conversions: 1, revenue: 5 }] },
  ];
  const result = aggregateSnapshots(snapshots);
  assert.equal(result.get('/a').sessions, 80);
  assert.equal(result.get('/a').conversions, 1);
  assert.equal(result.get('/b').sessions, 20);
});

test('classifyCluster identifies CRO signal when more high-traffic pages', () => {
  const pages = [
    { classification: 'high-traffic-low-conversion' },
    { classification: 'high-traffic-low-conversion' },
    { classification: 'balanced' },
  ];
  const result = classifyCluster(pages);
  assert.equal(result.cro_signal, true);
  assert.equal(result.expansion_signal, false);
});

test('classifyCluster identifies expansion signal', () => {
  const pages = [
    { classification: 'low-traffic-high-conversion' },
    { classification: 'balanced' },
  ];
  const result = classifyCluster(pages);
  assert.equal(result.cro_signal, false);
  assert.equal(result.expansion_signal, true);
});
```

- [ ] **Step 2: Run tests**

Run: `node --test tests/agents/ga4-content-analyzer.test.js`
Expected: All 7 tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/agents/ga4-content-analyzer.test.js
git commit -m "test: add ga4-content-analyzer page classification and aggregation tests"
```

---

## Task 7: GA4 content analyzer — implementation

**Files:**
- Create: `agents/ga4-content-analyzer/index.js`

- [ ] **Step 1: Write the agent**

Create `agents/ga4-content-analyzer/index.js` following the standard agent pattern:

```javascript
#!/usr/bin/env node
/**
 * GA4 Content Analyzer Agent
 *
 * Reads GA4 daily snapshots, aggregates sessions/conversions per page,
 * classifies pages by traffic/conversion pattern, and maps to topical
 * clusters. Produces a signal file consumed by content-strategist
 * (for calendar weighting) and cro-cta-injector (for dynamic targeting).
 *
 * Classifications:
 *   high-traffic-low-conversion: >=100 sessions, 0 conversions → CRO candidate
 *   low-traffic-high-conversion: <50 sessions, >=1 conversion → cluster expansion signal
 *   balanced: everything else
 *
 * Usage:
 *   node agents/ga4-content-analyzer/index.js            # analyze last 30 days
 *   node agents/ga4-content-analyzer/index.js --days 60  # custom lookback
 */
```

The agent should:
1. Read all GA4 snapshot files from `data/snapshots/ga4/` for the last N days (default 30)
2. Aggregate per-page totals: sessions, conversions, revenue
3. Classify each page using the `classifyPage()` function
4. Map pages to clusters using `data/topical-map.json` (match by URL)
5. Compute per-cluster: total sessions, total conversions, conversion rate, dominant classification, `cro_signal`, `expansion_signal`
6. Extract `cro_candidates` (slugs of high-traffic-low-conversion blog posts)
7. Extract `expansion_candidates` (slugs of low-traffic-high-conversion blog posts)
8. Write `data/reports/ga4-content-feedback/latest.json`

Key details:
- Follow the same pattern as other agents: `loadEnv()`, `config` from `site.json`, standard entry point with `notify`/`notifyLatestReport`
- GA4 snapshots are JSON files named `YYYY-MM-DD.json` in `data/snapshots/ga4/`
- Each snapshot has `topLandingPages: [{ page, sessions, conversions, revenue }]`
- Blog post slugs extracted from URLs matching `/blogs/news/`
- Cluster mapping: for each page URL, find matching article in `topical-map.json` clusters, use the cluster tag

- [ ] **Step 2: Run tests**

Run: `node --test tests/agents/ga4-content-analyzer.test.js`
Expected: All 7 tests pass.

- [ ] **Step 3: Commit**

```bash
git add agents/ga4-content-analyzer/index.js
git commit -m "feat: add ga4-content-analyzer agent for traffic/conversion page classification"
```

---

## Task 8: Wire GA4 feedback into content-strategist

**Files:**
- Modify: `agents/content-strategist/index.js`

- [ ] **Step 1: Read GA4 feedback in `loadClusterPerformance()`**

After the existing `flopSlugs` loading (after line 112), add:

```javascript
  // GA4 conversion feedback — gives cluster weights based on actual revenue
  const ga4Path = join(ROOT, 'data', 'reports', 'ga4-content-feedback', 'latest.json');
  let ga4Clusters = {};
  if (existsSync(ga4Path)) {
    try {
      const ga4 = JSON.parse(readFileSync(ga4Path, 'utf8'));
      for (const c of (ga4.clusters || [])) {
        ga4Clusters[c.cluster] = c;
      }
    } catch { /* ignore */ }
  }
```

- [ ] **Step 2: Add GA4 weight adjustments**

In the cluster weight computation loop (inside `for (const [name, items] of Object.entries(groups))`, after the existing weight adjustments around line 169), add:

```javascript
    const ga4 = ga4Clusters[name];
    if (ga4 && ga4.expansion_signal) {
      weight += 2;
      reasons.push('+2 high-conversion cluster (GA4: low traffic but converting)');
    }
    if (ga4 && ga4.cro_signal) {
      reasons.push('CRO flag: high traffic but low conversion (GA4)');
    }
```

- [ ] **Step 3: Commit**

```bash
git add agents/content-strategist/index.js
git commit -m "feat(content-strategist): add GA4 conversion feedback to cluster weighting"
```

---

## Task 9: Wire GA4 feedback into CRO CTA injector

**Files:**
- Modify: `agents/cro-cta-injector/index.js`

- [ ] **Step 1: Add `--from-ga4` mode**

After the existing `TARGETS` array (after line 55), add:

```javascript
const fromGa4 = process.argv.includes('--from-ga4');
```

- [ ] **Step 2: Add dynamic target loading**

Before the main function, add a function that reads `ga4-content-feedback/latest.json` and builds targets:

```javascript
function loadGa4Targets() {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const feedbackPath = join(ROOT, 'data', 'reports', 'ga4-content-feedback', 'latest.json');
  if (!existsSync(feedbackPath)) return [];
  const feedback = JSON.parse(readFileSync(feedbackPath, 'utf8'));
  const topicalMap = JSON.parse(readFileSync(join(ROOT, 'data', 'topical-map.json'), 'utf8'));

  // Map cluster tags to collection handles (best effort)
  const clusterToCollection = {
    'deodorant': 'natural-deodorant',
    'toothpaste': 'vegan-toothpaste',
    'lotion': 'coconut-oil-body-lotion',
    'soap': 'natural-bar-soap',
    'lip balm': 'coconut-oil-lip-balm',
    'coconut oil': 'coconut-oil-body-lotion',
  };

  return (feedback.cro_candidates || []).map((slug) => {
    // Find cluster for this slug
    let cluster = null;
    for (const c of topicalMap.clusters || []) {
      if (c.articles?.some((a) => a.url.includes(slug))) { cluster = c.tag; break; }
    }
    const collection = clusterToCollection[cluster] || 'all-products';
    return {
      handle: slug,
      headline: 'Shop Our Natural Products',
      subhead: 'Organic, handmade, and free of harsh chemicals.',
      collection,
    };
  });
}
```

- [ ] **Step 3: Update main to use dynamic targets when `--from-ga4`**

At the start of the main execution flow, add:

```javascript
const targets = fromGa4 ? loadGa4Targets() : TARGETS;
if (targets.length === 0) {
  console.log('No CRO targets found.');
  process.exit(0);
}
```

Then use `targets` instead of `TARGETS` in the existing loop.

- [ ] **Step 4: Add necessary imports**

Add at the top of the file:

```javascript
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
```

- [ ] **Step 5: Commit**

```bash
git add agents/cro-cta-injector/index.js
git commit -m "feat(cro-cta-injector): add --from-ga4 mode for dynamic CTA targeting"
```

---

## Task 10: Collection creator — tests for `--from-opportunities`

**Files:**
- Create: `tests/agents/collection-creator-opportunities.test.js`

- [ ] **Step 1: Write the test file**

```javascript
// tests/agents/collection-creator-opportunities.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

function hasCollectionIntent(keyword) {
  const kw = keyword.toLowerCase();
  const patterns = [/\bbest\b/, /\bbuy\b/, /\bshop\b/, /\btop\b/, /\borganic\b/, /\bnatural\b/,
    /\bfor (?:women|men|kids|sensitive|oily|dry|acne)\b/,
    /\b(?:deodorant|lotion|soap|toothpaste|lip balm|shampoo)\b/];
  return patterns.some((p) => p.test(kw));
}

function filterOpportunities(opportunities, existingHandles) {
  return opportunities
    .filter((o) => hasCollectionIntent(o.keyword))
    .filter((o) => {
      const potentialHandle = o.keyword.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      return !existingHandles.some((h) => h === potentialHandle || potentialHandle.includes(h) || h.includes(potentialHandle));
    });
}

test('hasCollectionIntent detects commercial keywords', () => {
  assert.equal(hasCollectionIntent('best natural deodorant'), true);
  assert.equal(hasCollectionIntent('buy organic lotion'), true);
  assert.equal(hasCollectionIntent('how to make soap at home'), false);
});

test('filterOpportunities excludes keywords matching existing collections', () => {
  const opps = [
    { keyword: 'natural deodorant', impressions: 500 },
    { keyword: 'organic body lotion', impressions: 300 },
  ];
  const existing = ['natural-deodorant'];
  const result = filterOpportunities(opps, existing);
  assert.equal(result.length, 1);
  assert.equal(result[0].keyword, 'organic body lotion');
});

test('filterOpportunities excludes partial handle matches', () => {
  const opps = [{ keyword: 'coconut oil body lotion', impressions: 400 }];
  const existing = ['coconut-oil-body-lotion'];
  const result = filterOpportunities(opps, existing);
  assert.equal(result.length, 0);
});
```

- [ ] **Step 2: Run tests**

Run: `node --test tests/agents/collection-creator-opportunities.test.js`
Expected: All 3 tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/agents/collection-creator-opportunities.test.js
git commit -m "test: add collection-creator --from-opportunities filtering tests"
```

---

## Task 11: Collection creator — implement `--from-opportunities` + queue

**Files:**
- Modify: `agents/collection-creator/index.js`

- [ ] **Step 1: Add imports and flags**

Add queue imports after existing imports:

```javascript
import { writeItem, activeSlugs, listQueueItems } from '../performance-engine/lib/queue.js';
```

Add new flags after existing arg parsing:

```javascript
const fromOpportunities = args.includes('--from-opportunities');
const doQueue = args.includes('--queue');
const publishApproved = args.includes('--publish-approved');
```

- [ ] **Step 2: Add `fromOpportunitiesMode()` function**

This function:
1. Reads `data/reports/gsc-opportunity/latest.json`
2. Flattens `low_ctr`, `page_2`, `unmapped` sections into one array
3. Filters to commercial-intent keywords using existing `hasCollectionIntent()`
4. Cross-references against existing collection handles (exclude matches)
5. Deduplicates by handle similarity
6. Excludes slugs already in active performance queue
7. Sends top candidates to Claude for evaluation (reuse existing `evaluateAndPlanCollections()`)
8. If `--queue`: writes each proposed collection as a queue item with trigger `collection-gap`
9. If not `--queue`: dry run, shows candidates

Queue item shape per spec:
```javascript
{
  slug: spec.handle,
  title: `New Collection: ${spec.title}`,
  trigger: 'collection-gap',
  signal_source: { type: 'gsc-collection-gap', keyword, impressions, position, source_section },
  proposed_collection: { title, handle, body_html, seo_title, seo_description },
  summary: { what_changed, why, projected_impact },
  resource_type: 'new-collection',
  status: 'pending',
  created_at: new Date().toISOString(),
}
```

- [ ] **Step 3: Add `publishApprovedCollections()` function**

This function:
1. Reads approved `collection-gap` queue items
2. Creates collection via `createCustomCollection({ title, handle, body_html })`
3. Sets SEO metafields via `upsertMetafield()`
4. Runs `collection-linker` for the new handle: `execSync(\`node agents/collection-linker/index.js --url "${config.url}/collections/${handle}" --keyword "${keyword}" --apply\`)`
5. Marks `status: 'published'`
6. Validates required fields, tracks accurate success count

- [ ] **Step 4: Update entry point**

```javascript
const run = fromOpportunities ? fromOpportunitiesMode
  : publishApproved ? publishApprovedCollections
  : main;
```

- [ ] **Step 5: Run tests**

Run: `node --test tests/agents/collection-creator-opportunities.test.js`
Expected: All 3 tests pass.

- [ ] **Step 6: Commit**

```bash
git add agents/collection-creator/index.js
git commit -m "feat(collection-creator): add --from-opportunities + queue + --publish-approved modes"
```

---

## Task 12: Scheduler — add weekly Tier 2 jobs

**Files:**
- Modify: `scheduler.js`

- [ ] **Step 1: Add weekly steps after existing daily steps**

Before the `log('Scheduler done.')` line, add:

```javascript
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

} else {
  log('  Weekly jobs: skipped (not Sunday)');
}
```

- [ ] **Step 2: Verify syntax**

Run: `node --check scheduler.js`
Expected: No output (no syntax errors).

- [ ] **Step 3: Commit**

```bash
git add scheduler.js
git commit -m "feat(scheduler): add weekly Tier 2 jobs — schema, gap detection, cannibalization, GA4 analysis"
```

---

## Task 13: npm scripts + signal manifest

**Files:**
- Modify: `package.json`
- Modify: `docs/signal-manifest.md`

- [ ] **Step 1: Add npm scripts**

After the existing `product-schema` line in `package.json`, add:

```json
    "product-schema-auto": "node agents/product-schema/index.js --auto --apply",
    "collection-gap": "node agents/collection-creator/index.js --from-opportunities",
    "collection-gap-queue": "node agents/collection-creator/index.js --from-opportunities --queue",
    "collection-gap-publish": "node agents/collection-creator/index.js --publish-approved",
    "ga4-analyze": "node agents/ga4-content-analyzer/index.js",
    "cro-ga4": "node agents/cro-cta-injector/index.js --from-ga4",
```

- [ ] **Step 2: Update signal manifest**

Add new signal entries to `docs/signal-manifest.md`:

```markdown
| `data/reports/cannibalization/latest.json` | `cannibalization-resolver --report-json` | dashboard Optimize tab (cannibalization card) | healthy |
| `data/reports/ga4-content-feedback/latest.json` | `ga4-content-analyzer` | `content-strategist` (cluster weighting), `cro-cta-injector --from-ga4` | healthy |
| `data/performance-queue/<handle>.json` (trigger: `collection-gap`) | `collection-creator --from-opportunities` | dashboard, `collection-creator --publish-approved` | healthy |
```

Update existing consumers:
- `data/topical-map.json`: add `ga4-content-analyzer`
- `data/snapshots/ga4/*.json`: add `ga4-content-analyzer`

- [ ] **Step 3: Commit**

```bash
git add package.json docs/signal-manifest.md
git commit -m "docs: update npm scripts and signal manifest for Tier 2 agents"
```

---

## Task 14: Integration smoke test

- [ ] **Step 1: Run all Tier 2 tests**

Run: `node --test tests/agents/product-schema-auto.test.js tests/agents/cannibalization-extended.test.js tests/agents/ga4-content-analyzer.test.js tests/agents/collection-creator-opportunities.test.js`
Expected: All 18 tests pass.

- [ ] **Step 2: Syntax check all modified agents**

Run: `node --check agents/product-schema/index.js && node --check agents/cannibalization-resolver/index.js && node --check agents/collection-creator/index.js && node --check agents/ga4-content-analyzer/index.js && node --check agents/cro-cta-injector/index.js && node --check agents/content-strategist/index.js && node --check scheduler.js && echo "All syntax OK"`
Expected: "All syntax OK"

- [ ] **Step 3: Run scheduler dry-run**

Run: `node scheduler.js --dry-run 2>&1 | tail -30`
Expected: Shows all steps including weekly section (may show "skipped (not Sunday)" if not Sunday — that's correct).

- [ ] **Step 4: Commit if any fixes**

```bash
git add -A && git commit -m "fix: smoke test fixes for Tier 2 agents"
```
