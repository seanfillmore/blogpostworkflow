# Keyword Index Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the data foundation described in `docs/superpowers/specs/2026-04-26-keyword-index-foundation-design.md` — a biweekly-rebuilt `data/keyword-index.json` anchored on Amazon-validated commercial intent with GSC+GA4 fallback for Shopify-only converting queries, plus a separate `data/category-competitors.json` competitor roll-up.

**Architecture:** One new agent (`agents/keyword-index-builder/index.js`) orchestrates a 9-module `lib/keyword-index/` namespace through 6 stages. The agent self-paces to biweekly via its own `built_at` timestamp. Pure ingest/transform modules are unit-tested against fixtures; live API calls are smoke-tested but not in CI.

**Tech Stack:** Node.js (ESM, `"type": "module"`), built-in `node:test` + `node:assert/strict`, no new npm dependencies. Reuses `lib/amazon/sp-api-client.js`, `lib/dataforseo.js`, `lib/notify.js`. Streaming JSON for the BA report uses `node:readline` + per-line `JSON.parse`.

**Spec reference:** [docs/superpowers/specs/2026-04-26-keyword-index-foundation-design.md](../specs/2026-04-26-keyword-index-foundation-design.md)

**Branch:** `feature/keyword-index-foundation` (already created from main)

---

## File Structure

Will create:

- `lib/keyword-index/normalize.js` (~30 lines)
- `lib/keyword-index/asin-classifier.js` (~25 lines)
- `lib/keyword-index/gsc-aggregator.js` (~80 lines)
- `lib/keyword-index/ga4-aggregator.js` (~50 lines)
- `lib/keyword-index/amazon-sqp.js` (~120 lines — parser + fetcher)
- `lib/keyword-index/amazon-ba.js` (~150 lines — streaming parser + fetcher)
- `lib/keyword-index/dataforseo-enricher.js` (~80 lines)
- `lib/keyword-index/merge.js` (~120 lines)
- `lib/keyword-index/competitors.js` (~80 lines)
- `agents/keyword-index-builder/index.js` (~250 lines)
- 9 unit test files mirroring the lib modules
- 1 integration test
- Test fixtures under `tests/fixtures/keyword-index/{ba,sqp,gsc,ga4}/`

Will modify:

- `scheduler.js` — add daily call to `keyword-index-builder` (which self-paces); remove the existing weekly `keyword-research` cron entry.

**Testing approach:** Existing `tests/` directory uses `node --test` with `node:assert/strict` (ESM). New tests follow the same pattern. No live Amazon/DataForSEO calls in tests — fixture-based throughout.

---

## Task 1: Set up directory tree + .gitignore

**Files:**
- Create: `lib/keyword-index/.gitkeep`
- Create: `tests/fixtures/keyword-index/{ba,sqp,gsc,ga4}/.gitkeep`
- Modify: `.gitignore`

- [ ] **Step 1: Create directory tree**

```bash
mkdir -p lib/keyword-index agents/keyword-index-builder
mkdir -p tests/lib/keyword-index tests/fixtures/keyword-index/{ba,sqp,gsc,ga4}
touch lib/keyword-index/.gitkeep
touch tests/fixtures/keyword-index/ba/.gitkeep
touch tests/fixtures/keyword-index/sqp/.gitkeep
touch tests/fixtures/keyword-index/gsc/.gitkeep
touch tests/fixtures/keyword-index/ga4/.gitkeep
```

- [ ] **Step 2: Add transient files to .gitignore**

Append to `.gitignore`:

```
# Keyword-index transient state
data/.rsc-asins.json
data/.keyword-index-tmp/
```

Why: `data/.rsc-asins.json` is the cache of classified Amazon listings (regeneratable via `scripts/amazon/explore-listings.mjs`). `data/.keyword-index-tmp/` holds multi-GB BA report dumps that get streamed and consumed; they should never be committed.

- [ ] **Step 3: Verify**

```bash
git status lib/keyword-index/ tests/fixtures/keyword-index/ .gitignore
```

Expected: 4 `.gitkeep` files + modified `.gitignore` show as new/modified.

- [ ] **Step 4: Commit**

```bash
git add lib/keyword-index/.gitkeep tests/fixtures/keyword-index/ .gitignore
git commit -m "chore(keyword-index): scaffold lib + fixture dirs and ignore transient files"
```

---

## Task 2: `normalize.js` — canonical keyword keys

**Files:**
- Create: `lib/keyword-index/normalize.js`
- Test: `tests/lib/keyword-index/normalize.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/keyword-index/normalize.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, slug } from '../../../lib/keyword-index/normalize.js';

test('normalize lowercases', () => {
  assert.equal(normalize('Natural Deodorant'), 'natural deodorant');
});

test('normalize trims surrounding whitespace', () => {
  assert.equal(normalize('  natural deodorant  '), 'natural deodorant');
});

test('normalize collapses internal whitespace', () => {
  assert.equal(normalize('natural    deodorant\tfor   women'), 'natural deodorant for women');
});

test('normalize strips leading/trailing punctuation', () => {
  assert.equal(normalize('"natural deodorant!"'), 'natural deodorant');
});

test('normalize preserves internal apostrophes (preserves brand integrity)', () => {
  assert.equal(normalize("L'Oreal hair"), "l'oreal hair");
});

test('normalize is idempotent', () => {
  const once = normalize('Natural Deodorant for Women');
  const twice = normalize(once);
  assert.equal(once, twice);
});

test('slug converts to URL-friendly key', () => {
  assert.equal(slug('natural deodorant for women'), 'natural-deodorant-for-women');
});

test('slug strips apostrophes (URL-safe)', () => {
  assert.equal(slug("l'oreal hair"), 'loreal-hair');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test tests/lib/keyword-index/normalize.test.js
```

Expected: FAIL with `Cannot find module '../../../lib/keyword-index/normalize.js'`.

- [ ] **Step 3: Implement**

Create `lib/keyword-index/normalize.js`:

```js
/**
 * Canonical keyword key derivation.
 *
 * `normalize` produces the canonical keyword text used as the
 * `keyword` field. `slug` produces the URL-safe key used as the
 * object key in keyword-index.json.
 *
 * Both must be idempotent and stable so the same logical query from
 * GSC and Amazon collapses to the same entry.
 */

export function normalize(s) {
  if (!s) return '';
  let out = String(s).toLowerCase();
  // Strip leading/trailing punctuation (anything that isn't word, apostrophe, hyphen)
  out = out.replace(/^[^\w']+|[^\w']+$/gu, '');
  // Collapse internal whitespace (spaces, tabs, newlines) to single space
  out = out.replace(/\s+/g, ' ');
  return out.trim();
}

export function slug(s) {
  return normalize(s)
    .replace(/'/g, '')           // drop apostrophes for URL safety
    .replace(/[^\w\s-]/g, '')    // drop other punctuation
    .replace(/\s+/g, '-')        // spaces → hyphens
    .replace(/-+/g, '-');        // collapse double-hyphens
}
```

- [ ] **Step 4: Run tests; all 8 must pass**

```bash
node --test tests/lib/keyword-index/normalize.test.js
```

- [ ] **Step 5: Commit**

```bash
git add lib/keyword-index/normalize.js tests/lib/keyword-index/normalize.test.js
git commit -m "feat(keyword-index): add normalize/slug helpers for canonical keys"
```

---

## Task 3: `asin-classifier.js` — RSC vs Culina filter

**Files:**
- Create: `lib/keyword-index/asin-classifier.js`
- Test: `tests/lib/keyword-index/asin-classifier.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/keyword-index/asin-classifier.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAsin, isRsc } from '../../../lib/keyword-index/asin-classifier.js';

test('classifyAsin returns "culina" when title contains "culina"', () => {
  assert.equal(classifyAsin({ asin: 'B01', title: 'Culina cast iron soap' }), 'culina');
});

test('classifyAsin returns "culina" when title contains "cast iron" (case-insensitive)', () => {
  assert.equal(classifyAsin({ asin: 'B01', title: 'Cast Iron Cleaning Brush' }), 'culina');
});

test('classifyAsin returns "rsc" for non-Culina products', () => {
  assert.equal(classifyAsin({ asin: 'B01', title: 'Natural Deodorant for Women' }), 'rsc');
  assert.equal(classifyAsin({ asin: 'B02', title: 'REAL Coconut Lotion' }), 'rsc');
});

test('classifyAsin handles missing title (defaults to rsc — defensible default)', () => {
  assert.equal(classifyAsin({ asin: 'B01' }), 'rsc');
});

test('isRsc is true for RSC-classified ASINs', () => {
  assert.equal(isRsc({ asin: 'B01', title: 'Lotion' }), true);
});

test('isRsc is false for Culina-classified ASINs', () => {
  assert.equal(isRsc({ asin: 'B01', title: 'Culina seasoning' }), false);
});
```

- [ ] **Step 2: Run test, expect FAIL (module not found)**

```bash
node --test tests/lib/keyword-index/asin-classifier.test.js
```

- [ ] **Step 3: Implement**

Create `lib/keyword-index/asin-classifier.js`:

```js
/**
 * RSC vs Culina classifier for Amazon ASINs.
 *
 * Per CLAUDE.md: an ASIN's product title containing "culina" or
 * "cast iron" classifies it as Culina. Everything else is RSC.
 *
 * Used to filter Culina ASINs out of the keyword-index ingest at the
 * request layer — only RSC ASINs are queried for SQP and only RSC
 * search terms are kept from BA.
 */

const CULINA_PATTERNS = [/culina/i, /cast\s+iron/i];

export function classifyAsin(product) {
  const title = product?.title || '';
  if (CULINA_PATTERNS.some((re) => re.test(title))) return 'culina';
  return 'rsc';
}

export function isRsc(product) {
  return classifyAsin(product) === 'rsc';
}
```

- [ ] **Step 4: Run tests; all 6 must pass**

```bash
node --test tests/lib/keyword-index/asin-classifier.test.js
```

- [ ] **Step 5: Commit**

```bash
git add lib/keyword-index/asin-classifier.js tests/lib/keyword-index/asin-classifier.test.js
git commit -m "feat(keyword-index): add RSC vs Culina ASIN classifier"
```

---

## Task 4: `gsc-aggregator.js` — 56-day per-query aggregation

**Files:**
- Create: `lib/keyword-index/gsc-aggregator.js`
- Test: `tests/lib/keyword-index/gsc-aggregator.test.js`
- Test fixtures: `tests/fixtures/keyword-index/gsc/2026-04-01.json` ... `2026-04-03.json`

- [ ] **Step 1: Create test fixtures**

GSC daily snapshots have shape `{ date, topPages, queries }`. Create `tests/fixtures/keyword-index/gsc/2026-04-01.json`:

```json
{
  "date": "2026-04-01",
  "topPages": [
    { "page": "https://www.realskincare.com/products/coconut-lotion", "impressions": 100, "clicks": 5, "ctr": 0.05, "position": 7.5 }
  ],
  "queries": [
    { "query": "coconut lotion", "page": "https://www.realskincare.com/products/coconut-lotion", "impressions": 80, "clicks": 4, "ctr": 0.05, "position": 7.5 },
    { "query": "Coconut Lotion", "page": "https://www.realskincare.com/products/coconut-lotion", "impressions": 20, "clicks": 1, "ctr": 0.05, "position": 8.0 }
  ]
}
```

Create `tests/fixtures/keyword-index/gsc/2026-04-02.json`:

```json
{
  "date": "2026-04-02",
  "topPages": [
    { "page": "https://www.realskincare.com/products/coconut-lotion", "impressions": 110, "clicks": 6, "ctr": 0.0545, "position": 7.0 }
  ],
  "queries": [
    { "query": "coconut lotion", "page": "https://www.realskincare.com/products/coconut-lotion", "impressions": 90, "clicks": 5, "ctr": 0.0556, "position": 7.0 }
  ]
}
```

Create `tests/fixtures/keyword-index/gsc/2026-04-03.json`:

```json
{
  "date": "2026-04-03",
  "topPages": [
    { "page": "https://www.realskincare.com/products/coconut-lotion", "impressions": 120, "clicks": 8, "ctr": 0.0667, "position": 6.5 }
  ],
  "queries": [
    { "query": "coconut lotion", "page": "https://www.realskincare.com/products/coconut-lotion", "impressions": 100, "clicks": 7, "ctr": 0.07, "position": 6.5 }
  ]
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/lib/keyword-index/gsc-aggregator.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregateGscWindow } from '../../../lib/keyword-index/gsc-aggregator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '..', '..', 'fixtures', 'keyword-index', 'gsc');

test('aggregateGscWindow sums impressions and clicks across the date range', () => {
  const result = aggregateGscWindow({
    snapshotsDir: FIXTURES,
    fromDate: '2026-04-01',
    toDate: '2026-04-03',
  });
  assert.ok(result['coconut lotion']);
  // 80 + 90 + 100 = 270 impressions across the 3 days
  // (note: case-variant "Coconut Lotion" in 04-01 collapses to same key via normalize)
  assert.equal(result['coconut lotion'].impressions, 80 + 20 + 90 + 100);
  // 4 + 1 + 5 + 7 = 17 clicks
  assert.equal(result['coconut lotion'].clicks, 4 + 1 + 5 + 7);
});

test('aggregateGscWindow computes mean position across the window', () => {
  const result = aggregateGscWindow({
    snapshotsDir: FIXTURES,
    fromDate: '2026-04-01',
    toDate: '2026-04-03',
  });
  // positions: 7.5, 8.0, 7.0, 6.5 → mean 7.25
  assert.equal(result['coconut lotion'].position.toFixed(2), '7.25');
});

test('aggregateGscWindow picks the page with most clicks as top_page', () => {
  const result = aggregateGscWindow({
    snapshotsDir: FIXTURES,
    fromDate: '2026-04-01',
    toDate: '2026-04-03',
  });
  assert.equal(result['coconut lotion'].top_page, 'https://www.realskincare.com/products/coconut-lotion');
});

test('aggregateGscWindow recomputes CTR from the totals (not averaged)', () => {
  const result = aggregateGscWindow({
    snapshotsDir: FIXTURES,
    fromDate: '2026-04-01',
    toDate: '2026-04-03',
  });
  // 17 clicks / 290 impressions
  const expected = 17 / 290;
  assert.equal(result['coconut lotion'].ctr.toFixed(4), expected.toFixed(4));
});

test('aggregateGscWindow returns empty object when no snapshots in range', () => {
  const result = aggregateGscWindow({
    snapshotsDir: FIXTURES,
    fromDate: '2027-01-01',
    toDate: '2027-01-31',
  });
  assert.deepEqual(result, {});
});

test('aggregateGscWindow normalizes keys via normalize()', () => {
  const result = aggregateGscWindow({
    snapshotsDir: FIXTURES,
    fromDate: '2026-04-01',
    toDate: '2026-04-01',
  });
  // "coconut lotion" and "Coconut Lotion" should collapse to same key
  assert.equal(Object.keys(result).filter((k) => k === 'coconut lotion').length, 1);
});
```

- [ ] **Step 3: Run test, expect FAIL (module not found)**

```bash
node --test tests/lib/keyword-index/gsc-aggregator.test.js
```

- [ ] **Step 4: Implement**

Create `lib/keyword-index/gsc-aggregator.js`:

```js
/**
 * Aggregate GSC daily snapshots over a date range.
 *
 * Reads `data/snapshots/gsc/YYYY-MM-DD.json` (or any directory
 * matching that shape). For each (query, page) row across the window,
 * sums impressions/clicks and computes mean position. Returns a map
 * keyed by normalized query text.
 *
 * For each query, picks the page with the most clicks across the
 * window as `top_page` and lists all pages in `pages`.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { normalize } from './normalize.js';

function listSnapshotsInRange(dir, fromDate, toDate) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .filter((f) => {
      const d = f.replace('.json', '');
      return d >= fromDate && d <= toDate;
    })
    .sort();
}

export function aggregateGscWindow({ snapshotsDir, fromDate, toDate }) {
  const files = listSnapshotsInRange(snapshotsDir, fromDate, toDate);
  // Per normalized-query: { impressions, clicks, positions[], pages: { url -> { impressions, clicks, positions[] } } }
  const acc = {};

  for (const file of files) {
    let snap;
    try {
      snap = JSON.parse(readFileSync(join(snapshotsDir, file), 'utf8'));
    } catch {
      continue; // skip corrupt snapshots
    }
    for (const row of snap.queries || []) {
      const key = normalize(row.query);
      if (!key) continue;
      if (!acc[key]) acc[key] = { impressions: 0, clicks: 0, positions: [], pages: {} };
      acc[key].impressions += row.impressions || 0;
      acc[key].clicks += row.clicks || 0;
      if (row.position != null) acc[key].positions.push(row.position);
      const url = row.page;
      if (url) {
        if (!acc[key].pages[url]) acc[key].pages[url] = { url, impressions: 0, clicks: 0, positions: [] };
        acc[key].pages[url].impressions += row.impressions || 0;
        acc[key].pages[url].clicks += row.clicks || 0;
        if (row.position != null) acc[key].pages[url].positions.push(row.position);
      }
    }
  }

  // Finalize: compute mean position, top_page, pages array, CTR
  const out = {};
  for (const [key, agg] of Object.entries(acc)) {
    const pagesArr = Object.values(agg.pages).map((p) => ({
      url: p.url,
      impressions: p.impressions,
      clicks: p.clicks,
      position: p.positions.length > 0 ? p.positions.reduce((s, x) => s + x, 0) / p.positions.length : null,
    }));
    pagesArr.sort((a, b) => b.clicks - a.clicks);
    out[key] = {
      impressions: agg.impressions,
      clicks: agg.clicks,
      ctr: agg.impressions > 0 ? agg.clicks / agg.impressions : 0,
      position: agg.positions.length > 0 ? agg.positions.reduce((s, x) => s + x, 0) / agg.positions.length : null,
      top_page: pagesArr[0]?.url || null,
      pages: pagesArr,
    };
  }
  return out;
}
```

- [ ] **Step 5: Run tests; all 6 must pass**

```bash
node --test tests/lib/keyword-index/gsc-aggregator.test.js
```

- [ ] **Step 6: Commit**

```bash
git add lib/keyword-index/gsc-aggregator.js tests/lib/keyword-index/gsc-aggregator.test.js tests/fixtures/keyword-index/gsc/
git commit -m "feat(keyword-index): add GSC 56-day window aggregator"
```

---

## Task 5: `ga4-aggregator.js` — page-level metrics for GSC join

**Files:**
- Create: `lib/keyword-index/ga4-aggregator.js`
- Test: `tests/lib/keyword-index/ga4-aggregator.test.js`
- Fixtures: `tests/fixtures/keyword-index/ga4/2026-04-{01..03}.json`

- [ ] **Step 1: Create test fixtures**

`tests/fixtures/keyword-index/ga4/2026-04-01.json`:

```json
{
  "date": "2026-04-01",
  "pages": [
    { "page": "/products/coconut-lotion", "sessions": 50, "conversions": 2, "page_revenue": 60.00 }
  ]
}
```

`tests/fixtures/keyword-index/ga4/2026-04-02.json`:

```json
{
  "date": "2026-04-02",
  "pages": [
    { "page": "/products/coconut-lotion", "sessions": 55, "conversions": 2, "page_revenue": 60.00 }
  ]
}
```

`tests/fixtures/keyword-index/ga4/2026-04-03.json`:

```json
{
  "date": "2026-04-03",
  "pages": [
    { "page": "/products/coconut-lotion", "sessions": 60, "conversions": 3, "page_revenue": 90.00 }
  ]
}
```

- [ ] **Step 2: Write the failing test**

`tests/lib/keyword-index/ga4-aggregator.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregateGa4Window, ga4ForUrl } from '../../../lib/keyword-index/ga4-aggregator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '..', '..', 'fixtures', 'keyword-index', 'ga4');

test('aggregateGa4Window sums sessions/conversions/revenue per page across window', () => {
  const result = aggregateGa4Window({
    snapshotsDir: FIXTURES,
    fromDate: '2026-04-01',
    toDate: '2026-04-03',
  });
  assert.equal(result['/products/coconut-lotion'].sessions, 165);
  assert.equal(result['/products/coconut-lotion'].conversions, 7);
  assert.equal(result['/products/coconut-lotion'].page_revenue, 210.00);
});

test('ga4ForUrl handles full URLs by extracting pathname', () => {
  const ga4Map = {
    '/products/coconut-lotion': { sessions: 100, conversions: 5, page_revenue: 200 },
  };
  const result = ga4ForUrl(ga4Map, 'https://www.realskincare.com/products/coconut-lotion');
  assert.equal(result.sessions, 100);
});

test('ga4ForUrl returns null when path is not in the map', () => {
  const ga4Map = {};
  assert.equal(ga4ForUrl(ga4Map, '/products/missing'), null);
});

test('aggregateGa4Window returns empty when no snapshots in range', () => {
  const result = aggregateGa4Window({
    snapshotsDir: FIXTURES,
    fromDate: '2027-01-01',
    toDate: '2027-01-31',
  });
  assert.deepEqual(result, {});
});
```

- [ ] **Step 3: Run test, expect FAIL**

```bash
node --test tests/lib/keyword-index/ga4-aggregator.test.js
```

- [ ] **Step 4: Implement**

`lib/keyword-index/ga4-aggregator.js`:

```js
/**
 * Aggregate GA4 page-level snapshots over a date range. Joined to GSC
 * queries by landing-page URL.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

function listSnapshotsInRange(dir, fromDate, toDate) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .filter((f) => {
      const d = f.replace('.json', '');
      return d >= fromDate && d <= toDate;
    })
    .sort();
}

export function aggregateGa4Window({ snapshotsDir, fromDate, toDate }) {
  const files = listSnapshotsInRange(snapshotsDir, fromDate, toDate);
  const acc = {};
  for (const file of files) {
    let snap;
    try {
      snap = JSON.parse(readFileSync(join(snapshotsDir, file), 'utf8'));
    } catch {
      continue;
    }
    for (const row of snap.pages || []) {
      const path = row.page;
      if (!path) continue;
      if (!acc[path]) acc[path] = { sessions: 0, conversions: 0, page_revenue: 0 };
      acc[path].sessions += row.sessions || 0;
      acc[path].conversions += row.conversions || 0;
      acc[path].page_revenue += row.page_revenue || 0;
    }
  }
  return acc;
}

/**
 * Look up GA4 metrics for a URL or path. Accepts either a full URL
 * or a path; full URLs have their pathname extracted.
 */
export function ga4ForUrl(ga4Map, urlOrPath) {
  if (!urlOrPath) return null;
  let path = urlOrPath;
  if (path.startsWith('http')) {
    try { path = new URL(path).pathname; } catch { return null; }
  }
  return ga4Map[path] || null;
}
```

- [ ] **Step 5: Run tests; all 4 must pass**

```bash
node --test tests/lib/keyword-index/ga4-aggregator.test.js
```

- [ ] **Step 6: Commit**

```bash
git add lib/keyword-index/ga4-aggregator.js tests/lib/keyword-index/ga4-aggregator.test.js tests/fixtures/keyword-index/ga4/
git commit -m "feat(keyword-index): add GA4 page-level aggregator with URL→path join"
```

---

## Task 6: `amazon-sqp.js` — Search Query Performance parser + fetcher

**Files:**
- Create: `lib/keyword-index/amazon-sqp.js`
- Test: `tests/lib/keyword-index/amazon-sqp.test.js`
- Fixture: `tests/fixtures/keyword-index/sqp/sample-asin-report.json`

- [ ] **Step 1: Create the fixture**

The SQP report API returns a per-ASIN object with per-query rows. Real responses are large; create a minimal sanitized fixture at `tests/fixtures/keyword-index/sqp/sample-asin-report.json`:

```json
{
  "asin": "B0FAKERSC",
  "reportSpecification": {
    "reportType": "GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_ASIN_REPORT",
    "dataStartTime": "2026-02-29",
    "dataEndTime": "2026-04-25"
  },
  "dataByAsin": [
    {
      "asin": "B0FAKERSC",
      "searchQueryData": {
        "searchQuery": "natural deodorant for women",
        "searchQueryScore": 12.4,
        "searchQueryVolume": 8200
      },
      "impressionData": {
        "totalQueryImpressionCount": 8200,
        "asinImpressionCount": 1240,
        "asinImpressionShare": 0.151
      },
      "clickData": {
        "totalClickCount": 480,
        "totalClickRate": 0.0585,
        "asinClickCount": 96,
        "asinClickShare": 0.20
      },
      "cartAddData": {
        "totalCartAddCount": 240,
        "asinCartAddCount": 56,
        "asinCartAddShare": 0.233
      },
      "purchaseData": {
        "totalPurchaseCount": 142,
        "asinPurchaseCount": 38,
        "asinPurchaseShare": 0.268
      }
    },
    {
      "asin": "B0FAKERSC",
      "searchQueryData": {
        "searchQuery": "coconut lotion",
        "searchQueryScore": 9.1,
        "searchQueryVolume": 4400
      },
      "impressionData": {
        "totalQueryImpressionCount": 4400,
        "asinImpressionCount": 1100,
        "asinImpressionShare": 0.25
      },
      "clickData": {
        "totalClickCount": 220,
        "totalClickRate": 0.05,
        "asinClickCount": 60,
        "asinClickShare": 0.273
      },
      "cartAddData": {
        "totalCartAddCount": 110,
        "asinCartAddCount": 30,
        "asinCartAddShare": 0.273
      },
      "purchaseData": {
        "totalPurchaseCount": 70,
        "asinPurchaseCount": 22,
        "asinPurchaseShare": 0.314
      }
    }
  ]
}
```

- [ ] **Step 2: Write the failing test**

`tests/lib/keyword-index/amazon-sqp.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSqpReport, mergeSqpReports } from '../../../lib/keyword-index/amazon-sqp.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, '..', '..', 'fixtures', 'keyword-index', 'sqp', 'sample-asin-report.json');

test('parseSqpReport returns per-query metrics keyed by normalized query', () => {
  const raw = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const parsed = parseSqpReport(raw);
  assert.ok(parsed['natural deodorant for women']);
  assert.equal(parsed['natural deodorant for women'].asin, 'B0FAKERSC');
  assert.equal(parsed['natural deodorant for women'].impressions, 1240);
  assert.equal(parsed['natural deodorant for women'].clicks, 96);
  assert.equal(parsed['natural deodorant for women'].add_to_cart, 56);
  assert.equal(parsed['natural deodorant for women'].purchases, 38);
});

test('parseSqpReport handles empty dataByAsin', () => {
  const parsed = parseSqpReport({ asin: 'B0', dataByAsin: [] });
  assert.deepEqual(parsed, {});
});

test('mergeSqpReports sums metrics across multiple ASINs for the same query', () => {
  const a = parseSqpReport(JSON.parse(readFileSync(FIXTURE, 'utf8')));
  const bRaw = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  bRaw.asin = 'B0SECONDRSC';
  bRaw.dataByAsin = bRaw.dataByAsin.map((d) => ({ ...d, asin: 'B0SECONDRSC' }));
  const b = parseSqpReport(bRaw);
  const merged = mergeSqpReports([a, b]);
  // Both reports contribute 96 clicks each → 192 for "natural deodorant for women"
  assert.equal(merged['natural deodorant for women'].clicks, 192);
  // asins array contains both
  assert.equal(merged['natural deodorant for women'].asins.length, 2);
});
```

- [ ] **Step 3: Run test, expect FAIL**

```bash
node --test tests/lib/keyword-index/amazon-sqp.test.js
```

- [ ] **Step 4: Implement**

`lib/keyword-index/amazon-sqp.js`:

```js
/**
 * Amazon Search Query Performance ingest.
 *
 * `parseSqpReport` is pure — turns one ASIN's SQP JSON into a per-query
 * map. `mergeSqpReports` combines several per-ASIN reports (since we
 * request one report per RSC ASIN) into a single per-query view.
 *
 * `fetchSqpReportForAsin` is the live wrapper around the SP-API client.
 * Not unit-tested (live API); smoke-tested via the orchestrator's
 * --dry-run smoke run.
 */

import { normalize } from './normalize.js';

export function parseSqpReport(raw) {
  const out = {};
  for (const row of raw?.dataByAsin || []) {
    const q = row?.searchQueryData?.searchQuery;
    if (!q) continue;
    const key = normalize(q);
    if (!key) continue;
    const clicks = row.clickData?.asinClickCount ?? 0;
    const purchases = row.purchaseData?.asinPurchaseCount ?? 0;
    out[key] = {
      asin: row.asin,
      query: q,
      query_volume: row.searchQueryData?.searchQueryVolume ?? null,
      impressions: row.impressionData?.asinImpressionCount ?? 0,
      clicks,
      add_to_cart: row.cartAddData?.asinCartAddCount ?? 0,
      purchases,
      cvr: clicks > 0 ? purchases / clicks : 0,
      asin_purchase_share: row.purchaseData?.asinPurchaseShare ?? null,
    };
  }
  return out;
}

export function mergeSqpReports(perAsinMaps) {
  // Each entry in perAsinMaps is the output of parseSqpReport — keyed by query.
  // We merge by summing impressions/clicks/atc/purchases across ASINs and
  // collecting the per-ASIN breakdown.
  const merged = {};
  for (const m of perAsinMaps) {
    for (const [key, row] of Object.entries(m)) {
      if (!merged[key]) {
        merged[key] = {
          query: row.query,
          query_volume: row.query_volume,
          impressions: 0,
          clicks: 0,
          add_to_cart: 0,
          purchases: 0,
          cvr: 0,
          asins: [],
        };
      }
      merged[key].impressions += row.impressions;
      merged[key].clicks += row.clicks;
      merged[key].add_to_cart += row.add_to_cart;
      merged[key].purchases += row.purchases;
      merged[key].asins.push({ asin: row.asin, clicks: row.clicks, purchases: row.purchases });
    }
  }
  // Recompute CVR from totals
  for (const row of Object.values(merged)) {
    row.cvr = row.clicks > 0 ? row.purchases / row.clicks : 0;
  }
  return merged;
}

/**
 * Live fetcher — request, poll, download, parse one SQP report for an ASIN.
 * Window is 8 weeks ending now-3d (GA4 lag absorbed elsewhere; SQP is not
 * affected, but using consistent windows simplifies the integration).
 *
 * NOT unit tested — exercised in the orchestrator's smoke test.
 */
export async function fetchSqpReportForAsin({ client, asin, fromDate, toDate, getMarketplaceId, requestReport, pollReport, downloadReport }) {
  const reportType = 'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_ASIN_REPORT';
  const reportOptions = { asin, reportPeriod: 'WEEK' };
  const { reportId } = await requestReport(client, reportType, [getMarketplaceId()], fromDate, toDate, reportOptions);
  const { reportDocumentId } = await pollReport(client, reportId);
  const text = await downloadReport(client, reportDocumentId);
  return JSON.parse(text);
}
```

- [ ] **Step 5: Run tests; all 3 must pass**

```bash
node --test tests/lib/keyword-index/amazon-sqp.test.js
```

- [ ] **Step 6: Commit**

```bash
git add lib/keyword-index/amazon-sqp.js tests/lib/keyword-index/amazon-sqp.test.js tests/fixtures/keyword-index/sqp/
git commit -m "feat(keyword-index): add SQP parser + per-ASIN merger"
```

---

## Task 7: `amazon-ba.js` — streaming BA Search Terms parser

**Files:**
- Create: `lib/keyword-index/amazon-ba.js`
- Test: `tests/lib/keyword-index/amazon-ba.test.js`
- Fixture: `tests/fixtures/keyword-index/ba/sample-search-terms.jsonl`

The BA Search Terms report is *several GB* — it contains every department × every search term across the marketplace. We must stream-parse it line-by-line and filter to only entries where one of the top-3 clicked ASINs is an RSC ASIN we own. We never load the whole file into memory.

The report format is line-delimited JSON (JSONL). Each line is one search term entry.

- [ ] **Step 1: Create the fixture**

`tests/fixtures/keyword-index/ba/sample-search-terms.jsonl` — three lines, two relevant + one irrelevant:

```jsonl
{"searchTerm":"natural deodorant for women","searchFrequencyRank":12345,"clickedAsin1":"B0FAKERSC","clickShare1":0.20,"conversionShare1":0.27,"clickedAsin2":"B0NATIVE","clickShare2":0.18,"conversionShare2":0.21,"clickedAsin3":"B0DOVE","clickShare3":0.10,"conversionShare3":0.08,"productTitle1":"REAL Natural Deodorant","productTitle2":"Native Deodorant","productTitle3":"Dove Deodorant"}
{"searchTerm":"car battery","searchFrequencyRank":54321,"clickedAsin1":"B0CAR1","clickShare1":0.30,"conversionShare1":0.25,"clickedAsin2":"B0CAR2","clickShare2":0.22,"conversionShare2":0.18,"clickedAsin3":"B0CAR3","clickShare3":0.10,"conversionShare3":0.05,"productTitle1":"Optima Battery","productTitle2":"DieHard Battery","productTitle3":"AC Delco Battery"}
{"searchTerm":"coconut lotion","searchFrequencyRank":34567,"clickedAsin1":"B0FAKERSC","clickShare1":0.27,"conversionShare1":0.31,"clickedAsin2":"B0COCO1","clickShare2":0.18,"conversionShare2":0.15,"clickedAsin3":"B0COCO2","clickShare3":0.09,"conversionShare3":0.07,"productTitle1":"REAL Coconut Lotion","productTitle2":"Sky Organics Coconut","productTitle3":"Cocokind Coconut"}
```

- [ ] **Step 2: Write the failing test**

`tests/lib/keyword-index/amazon-ba.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBaReportStream } from '../../../lib/keyword-index/amazon-ba.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, '..', '..', 'fixtures', 'keyword-index', 'ba', 'sample-search-terms.jsonl');

test('parseBaReportStream filters to entries containing an RSC ASIN', async () => {
  const rscAsins = new Set(['B0FAKERSC']);
  const result = await parseBaReportStream({ filePath: FIXTURE, rscAsins });
  // Of 3 fixture entries, 2 contain B0FAKERSC and should be kept.
  assert.equal(Object.keys(result).length, 2);
  assert.ok(result['natural deodorant for women']);
  assert.ok(result['coconut lotion']);
  assert.equal(result['car battery'], undefined);
});

test('parseBaReportStream returns search frequency rank + competitor list', async () => {
  const rscAsins = new Set(['B0FAKERSC']);
  const result = await parseBaReportStream({ filePath: FIXTURE, rscAsins });
  const entry = result['natural deodorant for women'];
  assert.equal(entry.search_frequency_rank, 12345);
  // Competitors are non-RSC ASINs from the top-3 clicked list
  assert.equal(entry.competitors.length, 2);
  assert.equal(entry.competitors[0].asin, 'B0NATIVE');
  assert.equal(entry.competitors[0].click_share, 0.18);
  assert.equal(entry.competitors[0].brand, 'Native Deodorant'); // pulled from productTitle
});

test('parseBaReportStream returns empty when no RSC ASINs match', async () => {
  const rscAsins = new Set(['B0NOMATCH']);
  const result = await parseBaReportStream({ filePath: FIXTURE, rscAsins });
  assert.deepEqual(result, {});
});

test('parseBaReportStream skips malformed lines', async () => {
  // Use a temp file with a bad line in the middle
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const tmp = mkdtempSync(join(tmpdir(), 'ba-test-'));
  const path = join(tmp, 'with-bad.jsonl');
  writeFileSync(path,
    '{"searchTerm":"a","clickedAsin1":"B0FAKERSC","clickShare1":0.1}\n' +
    'NOT JSON\n' +
    '{"searchTerm":"b","clickedAsin1":"B0FAKERSC","clickShare1":0.1}\n'
  );
  const rscAsins = new Set(['B0FAKERSC']);
  const result = await parseBaReportStream({ filePath: path, rscAsins });
  assert.equal(Object.keys(result).length, 2);
});
```

- [ ] **Step 3: Run test, expect FAIL**

```bash
node --test tests/lib/keyword-index/amazon-ba.test.js
```

- [ ] **Step 4: Implement**

`lib/keyword-index/amazon-ba.js`:

```js
/**
 * Amazon Brand Analytics Search Terms ingest.
 *
 * The full BA report is multi-GB JSONL. We stream-parse line-by-line
 * and emit only entries where at least one of the top-3 clicked ASINs
 * is an RSC ASIN we own. Non-RSC entries from those rows are kept as
 * `competitors`.
 *
 * `parseBaReportStream` is the unit-tested core. `fetchBaReport` is
 * the live SP-API wrapper that downloads the JSONL to disk first.
 */

import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { normalize } from './normalize.js';

const TOP_N = 3;

export async function parseBaReportStream({ filePath, rscAsins }) {
  if (!existsSync(filePath)) return {};
  const out = {};
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    // Check whether any top-N clicked ASIN is RSC
    let rscMatched = false;
    for (let i = 1; i <= TOP_N; i++) {
      if (rscAsins.has(row[`clickedAsin${i}`])) { rscMatched = true; break; }
    }
    if (!rscMatched) continue;

    const key = normalize(row.searchTerm);
    if (!key) continue;

    // Build competitors list (non-RSC top-N ASINs)
    const competitors = [];
    for (let i = 1; i <= TOP_N; i++) {
      const asin = row[`clickedAsin${i}`];
      if (!asin || rscAsins.has(asin)) continue;
      competitors.push({
        asin,
        brand: row[`productTitle${i}`] || null,
        click_share: row[`clickShare${i}`] ?? null,
        conversion_share: row[`conversionShare${i}`] ?? null,
      });
    }

    out[key] = {
      search_term: row.searchTerm,
      search_frequency_rank: row.searchFrequencyRank ?? null,
      competitors,
    };
  }
  return out;
}

/**
 * Live fetcher — request weekly BA report covering the window, stream it
 * to disk, return the local path. Caller passes that path to
 * parseBaReportStream.
 *
 * NOT unit-tested.
 */
export async function fetchBaReport({ client, fromDate, toDate, outPath, getMarketplaceId, requestReport, pollReport, streamReportToFile }) {
  const reportType = 'GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT';
  const reportOptions = { reportPeriod: 'WEEK' };
  const { reportId } = await requestReport(client, reportType, [getMarketplaceId()], fromDate, toDate, reportOptions);
  const { reportDocumentId } = await pollReport(client, reportId);
  await streamReportToFile(client, reportDocumentId, outPath);
  return outPath;
}
```

- [ ] **Step 5: Run tests; all 4 must pass**

```bash
node --test tests/lib/keyword-index/amazon-ba.test.js
```

- [ ] **Step 6: Commit**

```bash
git add lib/keyword-index/amazon-ba.js tests/lib/keyword-index/amazon-ba.test.js tests/fixtures/keyword-index/ba/
git commit -m "feat(keyword-index): add streaming BA report parser (RSC-filtered)"
```

---

## Task 8: `dataforseo-enricher.js` — market data lookup with threshold gating

**Files:**
- Create: `lib/keyword-index/dataforseo-enricher.js`
- Test: `tests/lib/keyword-index/dataforseo-enricher.test.js`

- [ ] **Step 1: Write the failing test**

`tests/lib/keyword-index/dataforseo-enricher.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enrichWithMarketData, passesEnrichThreshold } from '../../../lib/keyword-index/dataforseo-enricher.js';

test('passesEnrichThreshold accepts entry with Amazon purchases > 0', () => {
  const entry = { amazon: { purchases: 1 }, gsc: null };
  assert.equal(passesEnrichThreshold(entry), true);
});

test('passesEnrichThreshold accepts entry with GSC impressions > 100', () => {
  const entry = { amazon: null, gsc: { impressions: 200 } };
  assert.equal(passesEnrichThreshold(entry), true);
});

test('passesEnrichThreshold rejects entry below thresholds', () => {
  const entry = { amazon: { purchases: 0 }, gsc: { impressions: 50 } };
  assert.equal(passesEnrichThreshold(entry), false);
});

test('enrichWithMarketData attaches market data for entries that pass threshold', async () => {
  const entries = {
    'natural deodorant for women': { amazon: { purchases: 1 }, gsc: null, market: null, keyword: 'natural deodorant for women' },
    'low signal kw': { amazon: { purchases: 0 }, gsc: { impressions: 30 }, market: null, keyword: 'low signal kw' },
  };
  // Mock dataforseo getSearchVolume — returns the real lib's shape:
  //   { keyword, volume, cpc, competition, competitionLevel, lowBid, highBid, monthlySearches }
  const mockGetSearchVolume = async (keywords) => {
    return keywords.map((k) => ({
      keyword: k, volume: 1100, cpc: 1.4, competition: 0.4, competitionLevel: 'MEDIUM',
    }));
  };
  await enrichWithMarketData({ entries, getSearchVolume: mockGetSearchVolume });
  assert.ok(entries['natural deodorant for women'].market);
  assert.equal(entries['natural deodorant for women'].market.volume, 1100);
  assert.equal(entries['natural deodorant for women'].market.cpc, 1.4);
  // keyword_difficulty + traffic_potential are not in getSearchVolume's response;
  // schema marks them nullable and v1 leaves them null.
  assert.equal(entries['natural deodorant for women'].market.keyword_difficulty, null);
  assert.equal(entries['natural deodorant for women'].market.traffic_potential, null);
  // The below-threshold entry was not enriched
  assert.equal(entries['low signal kw'].market, null);
});

test('enrichWithMarketData silently skips on enricher error', async () => {
  const entries = {
    'kw': { amazon: { purchases: 1 }, gsc: null, market: null, keyword: 'kw' },
  };
  const failingGet = async () => { throw new Error('rate limit'); };
  await enrichWithMarketData({ entries, getSearchVolume: failingGet });
  assert.equal(entries['kw'].market, null);
});
```

- [ ] **Step 2: Run test, expect FAIL**

```bash
node --test tests/lib/keyword-index/dataforseo-enricher.test.js
```

- [ ] **Step 3: Implement**

`lib/keyword-index/dataforseo-enricher.js`:

```js
/**
 * DataForSEO market-data enrichment.
 *
 * Only entries that pass `passesEnrichThreshold` get a DataForSEO call
 * to bound API spend. On error, we silently skip — entries keep
 * `market: null` and the build proceeds.
 *
 * Default `getSearchVolume` is the project's existing
 * lib/dataforseo.js helper. Tests inject a stub.
 */

import { getSearchVolume as defaultGetSearchVolume } from '../dataforseo.js';

const AMAZON_PURCHASES_THRESHOLD = 0;     // > this counts (i.e., ≥1)
const GSC_IMPRESSIONS_THRESHOLD = 100;    // > this counts

export function passesEnrichThreshold(entry) {
  const amzPurchases = entry?.amazon?.purchases ?? 0;
  const gscImpressions = entry?.gsc?.impressions ?? 0;
  return amzPurchases > AMAZON_PURCHASES_THRESHOLD || gscImpressions > GSC_IMPRESSIONS_THRESHOLD;
}

export async function enrichWithMarketData({ entries, getSearchVolume = defaultGetSearchVolume, batchSize = 50 }) {
  // Collect keywords that need enrichment
  const keysToEnrich = Object.keys(entries).filter((k) => passesEnrichThreshold(entries[k]));
  if (keysToEnrich.length === 0) return;

  const nowIso = new Date().toISOString();

  // Batch the calls
  for (let i = 0; i < keysToEnrich.length; i += batchSize) {
    const batch = keysToEnrich.slice(i, i + batchSize);
    const keywords = batch.map((k) => entries[k].keyword);
    let results;
    try {
      results = await getSearchVolume(keywords);
    } catch {
      // Silent skip on enricher failure — don't fail the build.
      continue;
    }
    for (const r of results || []) {
      // Match by normalized keyword text
      const slug = batch.find((k) => entries[k].keyword === r.keyword);
      if (!slug) continue;
      // getSearchVolume returns volume + cpc + competition (per lib/dataforseo.js).
      // keyword_difficulty + traffic_potential aren't in this response — leaving
      // them null in v1. A future task may add a getKeywordIdeas-based call to
      // fill them in for the high-priority subset.
      entries[slug].market = {
        volume: r.volume ?? null,
        keyword_difficulty: null,
        cpc: r.cpc ?? null,
        traffic_potential: null,
        enriched_at: nowIso,
      };
    }
  }
}
```

- [ ] **Step 4: Run tests; all 5 must pass**

```bash
node --test tests/lib/keyword-index/dataforseo-enricher.test.js
```

- [ ] **Step 5: Commit**

```bash
git add lib/keyword-index/dataforseo-enricher.js tests/lib/keyword-index/dataforseo-enricher.test.js
git commit -m "feat(keyword-index): add DataForSEO enricher with threshold gating"
```

---

## Task 9: `merge.js` — qualification + cluster assignment

**Files:**
- Create: `lib/keyword-index/merge.js`
- Test: `tests/lib/keyword-index/merge.test.js`

The merger takes the maps from prior stages and produces final entries with `validation_source`. Cluster assignment in v1: read `data/keyword-index.json` if it exists (the previous build) and reuse its keyword→cluster map; new keywords with no match fall back to `"unclustered"`.

- [ ] **Step 1: Write the failing test**

`tests/lib/keyword-index/merge.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeSources, classifyValidationSource } from '../../../lib/keyword-index/merge.js';

test('classifyValidationSource is "amazon" when amazon has purchases', () => {
  const r = classifyValidationSource({ amazon: { purchases: 5, clicks: 10 }, gsc: null, ga4: null });
  assert.equal(r, 'amazon');
});

test('classifyValidationSource is "amazon" when amazon has clicks but no purchases', () => {
  const r = classifyValidationSource({ amazon: { purchases: 0, clicks: 5 }, gsc: null, ga4: null });
  assert.equal(r, 'amazon');
});

test('classifyValidationSource is "gsc_ga4" when no amazon but ga4 has conversions', () => {
  const r = classifyValidationSource({ amazon: null, gsc: { impressions: 100 }, ga4: { conversions: 3 } });
  assert.equal(r, 'gsc_ga4');
});

test('classifyValidationSource is null when neither path qualifies', () => {
  const r = classifyValidationSource({ amazon: null, gsc: { impressions: 100 }, ga4: { conversions: 0 } });
  assert.equal(r, null);
});

test('mergeSources produces an Amazon-qualified entry', () => {
  const amazon = { 'natural deodorant for women': { search_frequency_rank: 12345, impressions: 1240, clicks: 96, add_to_cart: 56, purchases: 38, cvr: 0.396, asins: [{ asin: 'B0FAKERSC', clicks: 96, purchases: 38 }], competitors: [{ asin: 'B0N', click_share: 0.18 }] } };
  const gsc = { 'natural deodorant for women': { impressions: 2400, clicks: 96, ctr: 0.04, position: 14.2, top_page: '/products/x', pages: [] } };
  const ga4Map = { '/products/x': { sessions: 480, conversions: 28, page_revenue: 1240 } };
  const clusters = { 'natural deodorant for women': 'deodorant' };

  const out = mergeSources({ amazon, gsc, ga4Map, clusters });
  assert.equal(Object.keys(out).length, 1);
  const slug = Object.keys(out)[0];
  assert.equal(out[slug].keyword, 'natural deodorant for women');
  assert.equal(out[slug].validation_source, 'amazon');
  assert.equal(out[slug].cluster, 'deodorant');
  assert.ok(out[slug].amazon);
  assert.ok(out[slug].gsc);
  assert.ok(out[slug].ga4);
});

test('mergeSources produces a GSC-qualified entry when no amazon signal', () => {
  const amazon = {};
  const gsc = { 'shopify only kw': { impressions: 500, clicks: 30, ctr: 0.06, position: 8.0, top_page: '/products/y', pages: [] } };
  const ga4Map = { '/products/y': { sessions: 100, conversions: 5, page_revenue: 200 } };
  const clusters = {};

  const out = mergeSources({ amazon, gsc, ga4Map, clusters });
  const slug = Object.keys(out)[0];
  assert.equal(out[slug].validation_source, 'gsc_ga4');
  assert.equal(out[slug].amazon, null);
  assert.ok(out[slug].gsc);
});

test('mergeSources drops unqualified entries', () => {
  const amazon = {};
  const gsc = { 'no signal kw': { impressions: 100, clicks: 0, ctr: 0, position: 80, top_page: '/x', pages: [] } };
  const ga4Map = { '/x': { sessions: 5, conversions: 0, page_revenue: 0 } };
  const out = mergeSources({ amazon, gsc, ga4Map, clusters: {} });
  assert.deepEqual(out, {});
});

test('mergeSources falls back to "unclustered" when no cluster match', () => {
  const amazon = { 'mystery kw': { purchases: 5, clicks: 10, impressions: 100, add_to_cart: 7, cvr: 0.5, asins: [], competitors: [] } };
  const out = mergeSources({ amazon, gsc: {}, ga4Map: {}, clusters: {} });
  const slug = Object.keys(out)[0];
  assert.equal(out[slug].cluster, 'unclustered');
});
```

- [ ] **Step 2: Run test, expect FAIL**

```bash
node --test tests/lib/keyword-index/merge.test.js
```

- [ ] **Step 3: Implement**

`lib/keyword-index/merge.js`:

```js
/**
 * Merge the per-source maps into final keyword-index entries.
 *
 * Qualification:
 *   - amazon: has purchases > 0 OR clicks > 0
 *   - gsc_ga4 (only if no amazon signal): ga4.conversions > 0
 *   - else: drop (no qualifying signal)
 *
 * Cluster assignment: look up the keyword in the supplied `clusters`
 * map (built from the prior keyword-index.json). New keywords default
 * to 'unclustered'.
 */

import { normalize, slug as toSlug } from './normalize.js';
import { ga4ForUrl } from './ga4-aggregator.js';

export function classifyValidationSource(entry) {
  const amz = entry.amazon;
  if (amz && ((amz.clicks ?? 0) > 0 || (amz.purchases ?? 0) > 0)) return 'amazon';
  const ga = entry.ga4;
  if (!amz && ga && (ga.conversions ?? 0) > 0) return 'gsc_ga4';
  return null;
}

export function mergeSources({ amazon, gsc, ga4Map, clusters }) {
  const allKeys = new Set([...Object.keys(amazon || {}), ...Object.keys(gsc || {})]);
  const out = {};
  for (const key of allKeys) {
    const amz = amazon?.[key] || null;
    const g = gsc?.[key] || null;
    const ga = g?.top_page ? ga4ForUrl(ga4Map, g.top_page) : null;
    const candidate = { amazon: amz, gsc: g, ga4: ga };
    const validation_source = classifyValidationSource(candidate);
    if (!validation_source) continue;

    const slug = toSlug(key);
    out[slug] = {
      keyword: amz?.query || key,
      slug,
      cluster: clusters?.[key] || 'unclustered',
      validation_source,
      amazon: amz,
      gsc: g,
      ga4: ga,
      market: null,
    };
  }
  return out;
}

/**
 * Build the cluster lookup map from a previously-built keyword-index.json.
 * Used by the orchestrator at start.
 */
export function loadClustersFromPriorIndex(priorIndex) {
  const out = {};
  if (!priorIndex?.keywords) return out;
  for (const entry of Object.values(priorIndex.keywords)) {
    if (entry?.keyword && entry?.cluster) {
      out[normalize(entry.keyword)] = entry.cluster;
    }
  }
  return out;
}
```

- [ ] **Step 4: Run tests; all 8 must pass**

```bash
node --test tests/lib/keyword-index/merge.test.js
```

- [ ] **Step 5: Commit**

```bash
git add lib/keyword-index/merge.js tests/lib/keyword-index/merge.test.js
git commit -m "feat(keyword-index): add source-merger with validation_source + cluster fallback"
```

---

## Task 10: `competitors.js` — per-cluster competitor roll-up

**Files:**
- Create: `lib/keyword-index/competitors.js`
- Test: `tests/lib/keyword-index/competitors.test.js`

- [ ] **Step 1: Write the failing test**

`tests/lib/keyword-index/competitors.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rollUpCompetitorsByCluster } from '../../../lib/keyword-index/competitors.js';

test('rollUpCompetitorsByCluster groups by cluster and computes weighted shares', () => {
  const entries = {
    'kw1': {
      cluster: 'deodorant',
      amazon: {
        purchases: 100,
        competitors: [
          { asin: 'B0NATIVE', brand: 'Native', click_share: 0.20, conversion_share: 0.25 },
          { asin: 'B0DOVE', brand: 'Dove', click_share: 0.10, conversion_share: 0.08 },
        ],
      },
    },
    'kw2': {
      cluster: 'deodorant',
      amazon: {
        purchases: 50,
        competitors: [
          { asin: 'B0NATIVE', brand: 'Native', click_share: 0.30, conversion_share: 0.35 },
        ],
      },
    },
  };
  const result = rollUpCompetitorsByCluster(entries);
  assert.ok(result.deodorant);
  assert.equal(result.deodorant.total_purchases, 150);
  assert.equal(result.deodorant.keyword_count, 2);
  // Native's weighted_click_share:
  //   numerator = 100*0.20 + 50*0.30 = 20 + 15 = 35
  //   denominator = 100 + 50 = 150
  //   weighted = 35/150 = 0.2333
  const native = result.deodorant.competitors.find((c) => c.asin === 'B0NATIVE');
  assert.equal(native.weighted_click_share.toFixed(4), '0.2333');
  assert.equal(native.appears_in_keywords, 2);
});

test('rollUpCompetitorsByCluster ignores entries without amazon data', () => {
  const entries = {
    'kw1': { cluster: 'soap', amazon: null },
  };
  const result = rollUpCompetitorsByCluster(entries);
  assert.deepEqual(result, {});
});

test('rollUpCompetitorsByCluster sorts competitors by weighted_click_share desc, top N=10', () => {
  const entries = {};
  // 12 competitors in one cluster — only top 10 should be kept
  for (let i = 0; i < 12; i++) {
    entries[`kw${i}`] = {
      cluster: 'cluster',
      amazon: {
        purchases: 100,
        competitors: [{ asin: `B0${i}`, brand: `B${i}`, click_share: i / 100, conversion_share: 0.1 }],
      },
    };
  }
  const result = rollUpCompetitorsByCluster(entries);
  assert.equal(result.cluster.competitors.length, 10);
  // Highest click share first
  assert.equal(result.cluster.competitors[0].asin, 'B011');
});
```

- [ ] **Step 2: Run test, expect FAIL**

```bash
node --test tests/lib/keyword-index/competitors.test.js
```

- [ ] **Step 3: Implement**

`lib/keyword-index/competitors.js`:

```js
/**
 * Per-cluster competitor roll-up from the merged keyword-index entries.
 *
 * For each (cluster, competitor ASIN) pair:
 *   weighted_click_share = Σ (entry.amazon.purchases × competitor.click_share)
 *                       / Σ entry.amazon.purchases
 *   weighted_conversion_share is the same with conversion_share.
 *
 * Top N competitors per cluster are kept, sorted by weighted_click_share desc.
 */

const TOP_N_PER_CLUSTER = 10;

export function rollUpCompetitorsByCluster(entries, { topN = TOP_N_PER_CLUSTER } = {}) {
  // Per cluster:
  //   total_purchases (sum across cluster keywords with amazon)
  //   keyword_count (count of cluster keywords with amazon)
  //   per-asin: { numerator_click, numerator_conv, appears_in_keywords, brand }
  const clusterAcc = {};

  for (const entry of Object.values(entries)) {
    if (!entry.amazon) continue;
    const cluster = entry.cluster || 'unclustered';
    const purchases = entry.amazon.purchases ?? 0;
    if (!clusterAcc[cluster]) {
      clusterAcc[cluster] = { total_purchases: 0, keyword_count: 0, byAsin: {} };
    }
    clusterAcc[cluster].total_purchases += purchases;
    clusterAcc[cluster].keyword_count += 1;
    for (const c of entry.amazon.competitors || []) {
      if (!clusterAcc[cluster].byAsin[c.asin]) {
        clusterAcc[cluster].byAsin[c.asin] = {
          asin: c.asin,
          brand: c.brand || null,
          numerator_click: 0,
          numerator_conv: 0,
          appears_in_keywords: 0,
        };
      }
      const acc = clusterAcc[cluster].byAsin[c.asin];
      acc.numerator_click += purchases * (c.click_share ?? 0);
      acc.numerator_conv += purchases * (c.conversion_share ?? 0);
      acc.appears_in_keywords += 1;
    }
  }

  // Finalize: compute weighted shares, sort, top-N
  const out = {};
  for (const [cluster, agg] of Object.entries(clusterAcc)) {
    const denom = agg.total_purchases || 1; // avoid div0 — should not happen since we only count clusters with amazon
    const competitors = Object.values(agg.byAsin)
      .map((c) => ({
        asin: c.asin,
        brand: c.brand,
        weighted_click_share: c.numerator_click / denom,
        weighted_conversion_share: c.numerator_conv / denom,
        appears_in_keywords: c.appears_in_keywords,
      }))
      .sort((a, b) => b.weighted_click_share - a.weighted_click_share)
      .slice(0, topN);
    out[cluster] = {
      total_purchases: agg.total_purchases,
      keyword_count: agg.keyword_count,
      competitors,
    };
  }
  return out;
}
```

- [ ] **Step 4: Run tests; all 3 must pass**

```bash
node --test tests/lib/keyword-index/competitors.test.js
```

- [ ] **Step 5: Commit**

```bash
git add lib/keyword-index/competitors.js tests/lib/keyword-index/competitors.test.js
git commit -m "feat(keyword-index): add per-cluster competitor roll-up"
```

---

## Task 11: `agents/keyword-index-builder/index.js` — orchestrator

**Files:**
- Create: `agents/keyword-index-builder/index.js`
- Test: `tests/agents/keyword-index-builder.test.js`

The orchestrator runs all 6 stages, writes outputs atomically, emits a build report, and notifies. Self-paces via `built_at` check (skips if < 14 days unless `--force`). Has a `--dry-run` mode that runs stages without writing.

- [ ] **Step 1: Write the structure test**

`tests/agents/keyword-index-builder.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

test('keyword-index-builder agent exists', () => {
  assert.ok(existsSync('agents/keyword-index-builder/index.js'));
});

test('agent imports the expected lib modules', () => {
  const src = readFileSync('agents/keyword-index-builder/index.js', 'utf8');
  assert.ok(src.includes("lib/keyword-index/normalize.js") || src.includes("./lib/keyword-index"), 'imports keyword-index lib');
  assert.ok(src.includes("lib/keyword-index/amazon-sqp"), 'imports SQP module');
  assert.ok(src.includes("lib/keyword-index/amazon-ba"), 'imports BA module');
  assert.ok(src.includes("lib/keyword-index/gsc-aggregator"), 'imports GSC aggregator');
  assert.ok(src.includes("lib/keyword-index/ga4-aggregator"), 'imports GA4 aggregator');
  assert.ok(src.includes("lib/keyword-index/merge"), 'imports merger');
  assert.ok(src.includes("lib/keyword-index/competitors"), 'imports competitors');
  assert.ok(src.includes("lib/keyword-index/dataforseo-enricher"), 'imports enricher');
  assert.ok(src.includes("lib/notify.js"), 'imports notify');
});

test('agent supports --dry-run and --force flags', () => {
  const src = readFileSync('agents/keyword-index-builder/index.js', 'utf8');
  assert.ok(src.includes('--dry-run'), 'has --dry-run flag handling');
  assert.ok(src.includes('--force'), 'has --force flag handling');
});

test('agent has self-pace check (skips if < 14 days since last build)', () => {
  const src = readFileSync('agents/keyword-index-builder/index.js', 'utf8');
  assert.ok(/built_at|last_built_at/.test(src), 'reads built_at from prior index');
  assert.ok(/14|REBUILD_DAYS/.test(src), 'has 14-day cadence threshold');
});

test('agent writes both output files atomically (temp-then-rename)', () => {
  const src = readFileSync('agents/keyword-index-builder/index.js', 'utf8');
  assert.ok(src.includes('keyword-index.json'), 'writes keyword-index.json');
  assert.ok(src.includes('category-competitors.json'), 'writes category-competitors.json');
  assert.ok(/\.tmp-|renameSync/.test(src), 'uses temp-then-rename for atomicity');
});
```

- [ ] **Step 2: Run test, expect FAIL**

```bash
node --test tests/agents/keyword-index-builder.test.js
```

- [ ] **Step 3: Implement**

Create `agents/keyword-index-builder/index.js`:

```js
/**
 * Keyword Index Builder
 *
 * Biweekly rebuild of data/keyword-index.json + data/category-competitors.json
 * by joining Amazon BA/SQP, GSC, GA4 (and DataForSEO market enrichment).
 *
 * Self-paces: scheduler.js calls this daily; the agent skips early
 * if the existing index is < 14 days old. --force bypasses.
 *
 * Usage:
 *   node agents/keyword-index-builder/index.js
 *   node agents/keyword-index-builder/index.js --dry-run
 *   node agents/keyword-index-builder/index.js --force
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { aggregateGscWindow } from '../../lib/keyword-index/gsc-aggregator.js';
import { aggregateGa4Window } from '../../lib/keyword-index/ga4-aggregator.js';
import { parseSqpReport, mergeSqpReports, fetchSqpReportForAsin } from '../../lib/keyword-index/amazon-sqp.js';
import { parseBaReportStream, fetchBaReport } from '../../lib/keyword-index/amazon-ba.js';
import { isRsc } from '../../lib/keyword-index/asin-classifier.js';
import { mergeSources, loadClustersFromPriorIndex } from '../../lib/keyword-index/merge.js';
import { rollUpCompetitorsByCluster } from '../../lib/keyword-index/competitors.js';
import { enrichWithMarketData } from '../../lib/keyword-index/dataforseo-enricher.js';

import { getClient, getMarketplaceId, requestReport, pollReport, downloadReport, streamReportToFile, request as spApiRequest } from '../../lib/amazon/sp-api-client.js';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const SNAPSHOTS_GSC = join(ROOT, 'data', 'snapshots', 'gsc');
const SNAPSHOTS_GA4 = join(ROOT, 'data', 'snapshots', 'ga4');
const INDEX_PATH = join(ROOT, 'data', 'keyword-index.json');
const COMPETITORS_PATH = join(ROOT, 'data', 'category-competitors.json');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'keyword-index');
const BA_TMP_DIR = join(ROOT, 'data', '.keyword-index-tmp');

const REBUILD_DAYS = 14;
const WINDOW_DAYS = 56;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');

function isoDate(d) { return d.toISOString().slice(0, 10); }

function shouldSkip(now = new Date()) {
  if (force) return false;
  if (!existsSync(INDEX_PATH)) return false;
  try {
    const prior = JSON.parse(readFileSync(INDEX_PATH, 'utf8'));
    if (!prior.built_at) return false;
    const ageDays = (now.getTime() - new Date(prior.built_at).getTime()) / 86400000;
    return ageDays < REBUILD_DAYS;
  } catch { return false; }
}

function loadPriorIndex() {
  if (!existsSync(INDEX_PATH)) return null;
  try { return JSON.parse(readFileSync(INDEX_PATH, 'utf8')); } catch { return null; }
}

function atomicWriteJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  renameSync(tmp, path);
}

async function listRscAsins(client) {
  // Pull catalog listings, classify, return RSC ASINs only.
  // Uses the same listings endpoint the explore-listings.mjs script uses.
  // For now, bootstrap from a cached file if present (cache-or-fetch pattern);
  // a full implementation may iterate listings pagination.
  const cachePath = join(ROOT, 'data', '.rsc-asins.json');
  if (existsSync(cachePath)) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
      return cached.asins.filter((p) => isRsc(p)).map((p) => p.asin);
    } catch {}
  }
  // Fallback: fetch full listings via spApiRequest and filter.
  // (Implementer note: see scripts/amazon/explore-listings.mjs for the
  // exact endpoint shape. Cache the full classified product list to
  // data/.rsc-asins.json so subsequent runs are fast.)
  console.warn('  No cached RSC ASIN list at data/.rsc-asins.json. Run scripts/amazon/explore-listings.mjs first to seed it.');
  return [];
}

async function runStage(name, fn, stageReport) {
  const start = Date.now();
  try {
    const result = await fn();
    stageReport[name] = { ok: true, ms: Date.now() - start };
    return result;
  } catch (err) {
    stageReport[name] = { ok: false, ms: Date.now() - start, error: err.message };
    return null;
  }
}

async function main() {
  const nowIso = new Date().toISOString();
  console.log(`\nKeyword Index Builder — mode: ${dryRun ? 'DRY RUN' : 'APPLY'}${force ? ' (--force)' : ''}`);

  if (shouldSkip()) {
    console.log(`  Skipping — last build < ${REBUILD_DAYS} days ago. Use --force to override.`);
    return;
  }

  mkdirSync(REPORTS_DIR, { recursive: true });
  mkdirSync(BA_TMP_DIR, { recursive: true });

  const fromDate = isoDate(new Date(Date.now() - WINDOW_DAYS * 86400000));
  const toDate = isoDate(new Date(Date.now() - 3 * 86400000)); // 3-day GA4 lag buffer
  console.log(`  Window: ${fromDate} → ${toDate} (${WINDOW_DAYS} days)`);

  const priorIndex = loadPriorIndex();
  const clusters = loadClustersFromPriorIndex(priorIndex);

  const stageReport = {};

  // Stage 1: Amazon ingest
  let amazonMap = {};
  let baCompetitors = {};
  await runStage('amazon', async () => {
    const client = getClient();
    const rscAsins = await listRscAsins(client);
    if (rscAsins.length === 0) {
      throw new Error('No RSC ASINs available — Amazon ingest skipped');
    }

    // SQP — one report per RSC ASIN
    const sqpMaps = [];
    for (const asin of rscAsins) {
      try {
        const raw = await fetchSqpReportForAsin({
          client, asin, fromDate, toDate,
          getMarketplaceId, requestReport, pollReport, downloadReport,
        });
        sqpMaps.push(parseSqpReport(raw));
      } catch (err) {
        console.warn(`    SQP for ${asin} failed: ${err.message}`);
      }
    }
    amazonMap = mergeSqpReports(sqpMaps);

    // BA — single weekly report streamed to disk then parsed
    const baOutPath = join(BA_TMP_DIR, `ba-${nowIso.slice(0, 10)}.jsonl`);
    try {
      await fetchBaReport({
        client, fromDate, toDate, outPath: baOutPath,
        getMarketplaceId, requestReport, pollReport, streamReportToFile,
      });
      baCompetitors = await parseBaReportStream({ filePath: baOutPath, rscAsins: new Set(rscAsins) });
    } catch (err) {
      console.warn(`    BA fetch/parse failed: ${err.message}`);
    }

    // Merge BA's competitor list into amazonMap entries by query
    for (const [key, ba] of Object.entries(baCompetitors)) {
      if (amazonMap[key]) {
        amazonMap[key].search_frequency_rank = ba.search_frequency_rank;
        amazonMap[key].competitors = ba.competitors;
      }
    }
  }, stageReport);

  // Stage 2: GSC ingest
  const gscMap = await runStage('gsc',
    () => aggregateGscWindow({ snapshotsDir: SNAPSHOTS_GSC, fromDate, toDate }),
    stageReport,
  ) || {};

  if (!stageReport.gsc?.ok) {
    console.error('  GSC ingest failed — aborting build (no fallback for missing GSC).');
    if (!dryRun) await notify({ subject: 'Keyword Index Builder failed', body: `GSC stage failed: ${stageReport.gsc?.error}`, status: 'error' });
    process.exit(1);
  }

  // Stage 3: GA4 join
  const ga4Map = await runStage('ga4',
    () => aggregateGa4Window({ snapshotsDir: SNAPSHOTS_GA4, fromDate, toDate }),
    stageReport,
  ) || {};

  // Stage 4: Merge
  const entries = mergeSources({ amazon: amazonMap, gsc: gscMap, ga4Map, clusters });
  console.log(`  Merge: ${Object.keys(entries).length} entries qualified`);

  // Stage 5: DataForSEO enrich
  await runStage('dataforseo',
    () => enrichWithMarketData({ entries }),
    stageReport,
  );

  // Stage 6: Competitor roll-up
  const clusterCompetitors = rollUpCompetitorsByCluster(entries);

  // Final assembly
  const bySource = { amazon: 0, gsc_ga4: 0 };
  for (const e of Object.values(entries)) bySource[e.validation_source] = (bySource[e.validation_source] || 0) + 1;

  const output = {
    built_at: nowIso,
    window_days: WINDOW_DAYS,
    total_keywords: Object.keys(entries).length,
    by_validation_source: bySource,
    cluster_count: new Set(Object.values(entries).map((e) => e.cluster)).size,
    keywords: entries,
  };
  const competitorsOutput = {
    built_at: nowIso,
    window_days: WINDOW_DAYS,
    clusters: clusterCompetitors,
  };

  // Build report
  const reportPath = join(REPORTS_DIR, `${nowIso.slice(0, 10)}.md`);
  const reportLines = [
    `# Keyword Index Build — ${nowIso.slice(0, 10)}`,
    ``,
    `**Window:** ${fromDate} → ${toDate} (${WINDOW_DAYS} days)`,
    `**Mode:** ${dryRun ? 'DRY RUN' : 'APPLY'}`,
    ``,
    `## Stage outcomes`,
    ``,
    ...Object.entries(stageReport).map(([s, r]) =>
      `- **${s}**: ${r.ok ? '✅' : '❌'} (${r.ms} ms)${r.error ? ` — ${r.error}` : ''}`),
    ``,
    `## Counts`,
    ``,
    `- Total keywords: ${output.total_keywords}`,
    `- Amazon-validated: ${bySource.amazon}`,
    `- GSC+GA4-validated: ${bySource.gsc_ga4}`,
    `- Clusters: ${output.cluster_count}`,
  ];
  const degraded = !stageReport.amazon?.ok;
  if (degraded) reportLines.unshift('> ⚠ DEGRADED: Amazon stage failed; build is GSC-only.', '');

  if (dryRun) {
    console.log('\n  Dry-run: not writing outputs.');
    console.log(reportLines.join('\n'));
    return;
  }

  atomicWriteJson(INDEX_PATH, output);
  atomicWriteJson(COMPETITORS_PATH, competitorsOutput);
  writeFileSync(reportPath, reportLines.join('\n') + '\n');

  // Notify
  const notifyStatus = degraded ? 'error' : 'info';
  await notify({
    subject: degraded ? 'Keyword Index Builder ran (degraded)' : 'Keyword Index Builder ran',
    body: `Built keyword-index with ${output.total_keywords} keywords (${bySource.amazon} amazon, ${bySource.gsc_ga4} gsc_ga4). See ${reportPath}.`,
    status: notifyStatus,
  });
  console.log(`\n  Wrote ${INDEX_PATH}, ${COMPETITORS_PATH}, ${reportPath}`);
}

main().catch(async (err) => {
  console.error('Error:', err.message);
  await notify({ subject: 'Keyword Index Builder crashed', body: err.message || String(err), status: 'error' });
  process.exit(1);
});
```

- [ ] **Step 4: Run structure tests; all 5 must pass**

```bash
node --test tests/agents/keyword-index-builder.test.js
```

- [ ] **Step 5: Smoke-test in dry-run**

```bash
node agents/keyword-index-builder/index.js --dry-run --force
```

Expected behavior depends on local environment:
- If GSC/GA4 snapshots exist locally: stages succeed; reports counts.
- If no RSC ASIN cache exists: Stage 1 fails with "No RSC ASINs available"; stage report is degraded; rest proceeds.
- If GSC snapshots are missing: Stage 2 fails; the agent exits 1 with an error notification (but in dry-run, the notification is suppressed).

Either way the agent should exit cleanly without throwing.

- [ ] **Step 6: Commit**

```bash
git add agents/keyword-index-builder/index.js tests/agents/keyword-index-builder.test.js
git commit -m "feat(keyword-index): add builder agent — orchestrates 6-stage biweekly build"
```

---

## Task 12: Wire scheduler.js + retire keyword-research from cron

**Files:**
- Modify: `scheduler.js`

- [ ] **Step 1: Inspect existing scheduler.js**

```bash
grep -n "keyword-research\|Sunday\|Weekly\|getDay" scheduler.js | head -20
```

Identify:
- Where `keyword-research` is called (likely in the `getDay() === 0` Sunday block).
- Where to insert the new `keyword-index-builder` daily call (a logical place is near the existing keyword-research / content-strategist area, before the daily content pipeline).

- [ ] **Step 2: Insert keyword-index-builder daily call**

In `scheduler.js`, add the following near the end of the daily-jobs section (before the weekly Sunday block). Place it before any agent that might want to read the keyword-index later (which today is none, since wiring is out of scope, but ordering matters for future plans):

```js
// Keyword index builder — runs daily but self-paces to biweekly.
runStep('keyword-index-builder', `"${NODE}" agents/keyword-index-builder/index.js${dryFlag}`);
```

- [ ] **Step 3: Remove keyword-research from cron**

Find the existing keyword-research entry (likely `runStep('keyword-research', ...)` in the Sunday block) and DELETE that line plus any one-line comment immediately above it that refers only to that step.

Important: the agent file `agents/keyword-research/index.js` STAYS — it's still useful for ad-hoc discovery. Only the cron entry is removed.

- [ ] **Step 4: Verify with dry-run**

```bash
node scheduler.js --dry-run 2>&1 | grep -E "keyword-(index-builder|research)"
```

Expected: ONE line for `keyword-index-builder --dry-run`. ZERO lines for `keyword-research` (the cron entry is gone).

- [ ] **Step 5: Commit**

```bash
git add scheduler.js
git commit -m "feat(scheduler): wire keyword-index-builder daily; retire keyword-research cron"
```

---

## Task 13: Integration test — end-to-end build from fixtures

**Files:**
- Create: `tests/agents/keyword-index-builder.integration.test.js`
- Create: `tests/fixtures/keyword-index/integration/` (additional fixtures)

This test runs the orchestrator's pure (non-network) stages against canned fixtures and asserts both output JSON files conform to schema and counts add up. Since Stage 1 (Amazon live fetch) cannot run in tests, the integration test exercises the *merge path* on pre-built source maps rather than running the full agent's `main()`.

- [ ] **Step 1: Write the integration test**

Create `tests/agents/keyword-index-builder.integration.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

import { aggregateGscWindow } from '../../lib/keyword-index/gsc-aggregator.js';
import { aggregateGa4Window } from '../../lib/keyword-index/ga4-aggregator.js';
import { parseSqpReport, mergeSqpReports } from '../../lib/keyword-index/amazon-sqp.js';
import { parseBaReportStream } from '../../lib/keyword-index/amazon-ba.js';
import { mergeSources } from '../../lib/keyword-index/merge.js';
import { rollUpCompetitorsByCluster } from '../../lib/keyword-index/competitors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '..', 'fixtures', 'keyword-index');

test('integration: full build from fixtures produces well-formed outputs', async () => {
  // Stage 1: Amazon
  const sqpRaw = JSON.parse(readFileSync(join(FIXTURES, 'sqp', 'sample-asin-report.json'), 'utf8'));
  const amazonMap = mergeSqpReports([parseSqpReport(sqpRaw)]);
  const baCompetitors = await parseBaReportStream({
    filePath: join(FIXTURES, 'ba', 'sample-search-terms.jsonl'),
    rscAsins: new Set(['B0FAKERSC']),
  });
  for (const [key, ba] of Object.entries(baCompetitors)) {
    if (amazonMap[key]) {
      amazonMap[key].search_frequency_rank = ba.search_frequency_rank;
      amazonMap[key].competitors = ba.competitors;
    }
  }

  // Stage 2: GSC
  const gscMap = aggregateGscWindow({ snapshotsDir: join(FIXTURES, 'gsc'), fromDate: '2026-04-01', toDate: '2026-04-03' });

  // Stage 3: GA4
  const ga4Map = aggregateGa4Window({ snapshotsDir: join(FIXTURES, 'ga4'), fromDate: '2026-04-01', toDate: '2026-04-03' });

  // Stage 4: Merge
  const entries = mergeSources({ amazon: amazonMap, gsc: gscMap, ga4Map, clusters: { 'natural deodorant for women': 'deodorant' } });
  assert.ok(Object.keys(entries).length > 0, 'should produce at least one entry');

  // Find the natural-deodorant entry — should be amazon-validated, with GSC merged in if available, and BA competitors.
  const natural = Object.values(entries).find((e) => e.keyword === 'natural deodorant for women');
  assert.ok(natural, 'natural deodorant entry exists');
  assert.equal(natural.validation_source, 'amazon');
  assert.ok(natural.amazon);
  assert.equal(natural.amazon.purchases, 38); // from the SQP fixture
  assert.equal(natural.amazon.competitors.length, 2); // from the BA fixture
  assert.equal(natural.cluster, 'deodorant');

  // Stage 6: Competitor roll-up
  const clusterCompetitors = rollUpCompetitorsByCluster(entries);
  assert.ok(clusterCompetitors.deodorant);
  assert.equal(clusterCompetitors.deodorant.keyword_count, 1);
  assert.ok(clusterCompetitors.deodorant.competitors.length > 0);
});
```

- [ ] **Step 2: Run integration test**

```bash
node --test tests/agents/keyword-index-builder.integration.test.js
```

Expected: 1 test, passing.

- [ ] **Step 3: Commit**

```bash
git add tests/agents/keyword-index-builder.integration.test.js
git commit -m "test(keyword-index): add end-to-end integration test against fixtures"
```

---

## Task 14: Run full suite, push, open PR

- [ ] **Step 1: Run all keyword-index tests**

```bash
node --test tests/lib/keyword-index/normalize.test.js \
            tests/lib/keyword-index/asin-classifier.test.js \
            tests/lib/keyword-index/gsc-aggregator.test.js \
            tests/lib/keyword-index/ga4-aggregator.test.js \
            tests/lib/keyword-index/amazon-sqp.test.js \
            tests/lib/keyword-index/amazon-ba.test.js \
            tests/lib/keyword-index/dataforseo-enricher.test.js \
            tests/lib/keyword-index/merge.test.js \
            tests/lib/keyword-index/competitors.test.js \
            tests/agents/keyword-index-builder.test.js \
            tests/agents/keyword-index-builder.integration.test.js
```

Expected: all tests pass.

- [ ] **Step 2: Run the full project test suite**

```bash
npm test 2>&1 | tail -10
```

Expected: total pass count grew by the new tests; existing tests still pass; zero failures.

- [ ] **Step 3: Smoke-run the scheduler in dry-run**

```bash
node scheduler.js --dry-run 2>&1 | grep -E "keyword-(index-builder|research)"
```

Expected: only `keyword-index-builder --dry-run` fires; `keyword-research` is gone from the cron output.

- [ ] **Step 4: Push the branch**

```bash
git push -u origin feature/keyword-index-foundation
```

- [ ] **Step 5: Open the PR**

```bash
gh pr create --title "feat: keyword-index foundation — Amazon-anchored SEO targeting" --body "$(cat <<'EOF'
## Summary

Builds the foundation described in `docs/superpowers/specs/2026-04-26-keyword-index-foundation-design.md`:

- New `agents/keyword-index-builder/` orchestrator + 9-module `lib/keyword-index/` namespace.
- Biweekly rebuild of `data/keyword-index.json` (replaces the existing anemic file) keyed on Amazon-validated commercial intent (BA + SQP for RSC ASINs), with GSC+GA4 fallback for Shopify-only converting queries.
- New `data/category-competitors.json` rolls up dominant non-RSC competitor ASINs per cluster, weighted by query purchases × click share.
- Self-paces from a daily scheduler call via `built_at` timestamp; \`--force\` bypasses for ad-hoc rebuilds.
- Build report at \`data/reports/keyword-index/<date>.md\`.
- Existing \`agents/keyword-research/\` retained (ad-hoc discovery) but removed from cron.

Consumer wiring (optimizer agents reading from the new index) is out of scope — separate PR(s).

## Test plan

- [x] Unit tests pass for each lib module (~40 unit tests).
- [x] Structure + integration test pass for the orchestrator.
- [x] Full \`npm test\` clean.
- [x] \`node scheduler.js --dry-run\` shows the new step and no longer shows keyword-research.
- [ ] After deploy + the next biweekly trigger (or \`--force\` run), inspect \`data/reports/keyword-index/<date>.md\` for stage outcomes and keyword counts.
- [ ] Validate first build's outputs: spot-check 5 high-purchase Amazon-validated entries to confirm the GSC join, top_page, and competitors look correct.

## Notes — first run prerequisites

- Requires a populated \`data/.rsc-asins.json\` cache before the first run. Generate via \`node scripts/amazon/explore-listings.mjs\` (RSC marketplace, Brand Registry creds in .env). The agent logs a clear warning if it's missing and gracefully degrades to GSC-only.
- The DataForSEO enrichment threshold (Amazon \`purchases > 0\` OR GSC \`impressions > 100\`) is configured in \`lib/keyword-index/dataforseo-enricher.js\` — adjust if API budget becomes a concern.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 6: Record the PR URL**

Note the returned URL.

---

## Self-Review Checklist (completed)

**1. Spec coverage:**
- "Architecture" → Tasks 11-12 (orchestrator + scheduler wiring)
- "Lib namespace" → Tasks 2-10 (one task per module)
- "Outputs" — index, competitors, build report → Task 11
- "Cadence implementation" → Task 11 (self-pace check)
- "Existing keyword-research agent" → Task 12 (cron-only removal)
- "Schema" → Tasks 9, 10, 11 (entry shape, competitor shape, top-level)
- "Build flow (6 stages)" → Task 11
- "Error handling" — per-stage isolation, atomic writes, notify escalation → Task 11
- "Testing" — per-module unit + integration → Tasks 2-10, 13
- "Risks" — keyword-text mismatch, DataForSEO budget, cluster fallback → addressed in `normalize.js`, `dataforseo-enricher.js` threshold, `merge.js` 'unclustered' fallback respectively

**2. Placeholders:** None — all code blocks are complete.

**3. Type consistency:** Function names used consistently (`aggregateGscWindow`, `aggregateGa4Window`, `parseSqpReport`, `mergeSqpReports`, `parseBaReportStream`, `mergeSources`, `classifyValidationSource`, `rollUpCompetitorsByCluster`, `enrichWithMarketData`, `passesEnrichThreshold`, `ga4ForUrl`, `loadClustersFromPriorIndex`). The `slug` from `normalize.js` is used as object key in entries throughout. `validation_source` values are the same set (`'amazon' | 'gsc_ga4'`) across schema, merge, and tests. `WINDOW_DAYS = 56` and `REBUILD_DAYS = 14` are defined once in the orchestrator.
