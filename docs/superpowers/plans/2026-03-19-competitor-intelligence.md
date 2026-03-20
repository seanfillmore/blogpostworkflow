# Competitor Intelligence & Page Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a competitor intelligence pipeline that identifies high-traffic competitor pages, analyzes their structure via scraping and Claude vision, generates per-page optimization briefs, and surfaces them in a new Optimize dashboard tab with a human approval gate before any Shopify changes are applied.

**Architecture:** Competitor Intelligence Agent (on-demand CLI) calls the Ahrefs REST API v3 directly, scrapes competitor pages, takes Puppeteer screenshots, analyzes with Claude vision, and writes brief JSON files to `data/competitor-intelligence/briefs/`. The dashboard reads those files to populate a new Optimize tab with a kanban review queue. Approved changes are applied by a separate Apply Agent, triggered from the dashboard via SSE-streamed POST endpoint. The dashboard also gains a Manual Actions panel on every tab and an Ahrefs CSV file upload endpoint.

**Tech Stack:** Node.js ESM, `node:http` (dashboard server), `node:test` (tests), `cheerio` (HTML parsing — already in deps), `puppeteer` (screenshots — new dep), Anthropic SDK (`claude-opus-4-6`), Ahrefs REST API v3 (direct `fetch()` calls using `AHREFS_API_KEY` env var), Shopify Admin API REST + Theme API, `lib/notify.js` (Resend), `lib/shopify.js`

---

## File Map

### New files
| File | Responsibility |
|---|---|
| `agents/competitor-intelligence/index.js` | Main agent entrypoint — orchestrates pipeline steps |
| `agents/competitor-intelligence/matcher.js` | Pure: match competitor URL to store slug via sitemap |
| `agents/competitor-intelligence/scraper.js` | Pure: extract page structure from raw HTML |
| `agents/competitor-intelligence/brief-writer.js` | Pure: deduplicate + merge changes across competitors into brief |
| `agents/apply-optimization/index.js` | Apply agent — pushes approved brief changes to Shopify |
| `scripts/ahrefs-reminder.js` | Sends Resend email 24h before rank tracker run |
| `tests/agents/competitor-intelligence.test.js` | Unit tests for matcher, scraper, brief-writer, KPI builder |
| `tests/agents/apply-optimization.test.js` | Unit tests for apply agent pure functions |
| `data/competitor-intelligence/screenshots/.gitkeep` | Establish directory |
| `data/competitor-intelligence/briefs/.gitkeep` | Establish directory |
| `data/ahrefs/.gitkeep` | Establish directory (if absent) |

### Modified files
| File | Changes |
|---|---|
| `agents/dashboard/index.js` | Add: `/run-agent` SSE endpoint, `/upload/ahrefs` endpoint, `/brief/:slug/change/:id` endpoint, `/apply/:slug` SSE endpoint, `/screenshot` endpoint, Optimize tab HTML/JS, Manual Actions panels per tab, new path constants |
| `package.json` | Add scripts: `competitor-intel`, `apply-optimization`; add dep: `puppeteer` |
| `scripts/setup-cron.sh` | Add ahrefs-reminder cron entry |

---

## Task 1: Data directories and npm scripts

**Files:**
- Create: `data/competitor-intelligence/screenshots/.gitkeep`
- Create: `data/competitor-intelligence/briefs/.gitkeep`
- Create: `data/ahrefs/.gitkeep` (skip if exists)
- Modify: `package.json`

- [ ] **Step 1: Create data directories**

```bash
mkdir -p data/competitor-intelligence/screenshots data/competitor-intelligence/briefs
touch data/competitor-intelligence/screenshots/.gitkeep
touch data/competitor-intelligence/briefs/.gitkeep
ls data/ahrefs 2>/dev/null || (mkdir -p data/ahrefs && touch data/ahrefs/.gitkeep)
```

- [ ] **Step 2: Add npm scripts to package.json**

In the `"scripts"` block, add:
```json
"competitor-intel": "node agents/competitor-intelligence/index.js",
"apply-optimization": "node agents/apply-optimization/index.js"
```

- [ ] **Step 3: Add puppeteer dependency**

```bash
npm install puppeteer
```

- [ ] **Step 4: Commit**

```bash
git add data/competitor-intelligence data/ahrefs package.json package-lock.json
git commit -m "chore: add competitor-intelligence dirs, puppeteer dep, npm scripts"
```

---

## Task 2: Slug matcher — pure function + tests

The matcher converts a competitor page URL into a store slug by cross-referencing the sitemap index.

**Files:**
- Create: `agents/competitor-intelligence/matcher.js`
- Create: `tests/agents/competitor-intelligence.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// tests/agents/competitor-intelligence.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchCompetitorUrl } from '../../agents/competitor-intelligence/matcher.js';

const pages = [
  { url: 'https://store.com/products/coconut-deodorant', slug: 'coconut-deodorant', type: 'product' },
  { url: 'https://store.com/collections/natural-deodorant', slug: 'natural-deodorant', type: 'collection' },
];

test('exact slug match for product URL', () => {
  const result = matchCompetitorUrl('https://competitor.com/products/coconut-deodorant', pages);
  assert.deepEqual(result, { slug: 'coconut-deodorant', type: 'product' });
});

test('exact slug match for collection URL', () => {
  const result = matchCompetitorUrl('https://competitor.com/collections/natural-deodorant', pages);
  assert.deepEqual(result, { slug: 'natural-deodorant', type: 'collection' });
});

test('token overlap match (2+ shared tokens)', () => {
  const result = matchCompetitorUrl('https://competitor.com/products/best-coconut-deodorant-stick', pages);
  assert.deepEqual(result, { slug: 'coconut-deodorant', type: 'product' });
});

test('returns null when no match', () => {
  const result = matchCompetitorUrl('https://competitor.com/products/totally-unrelated-thing', pages);
  assert.equal(result, null);
});

test('skips non-product non-collection URLs', () => {
  const result = matchCompetitorUrl('https://competitor.com/blogs/news/some-post', pages);
  assert.equal(result, null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --test tests/agents/competitor-intelligence.test.js
```

Expected: `ERR_MODULE_NOT_FOUND` — matcher module doesn't exist yet.

- [ ] **Step 3: Implement matcher.js**

```js
// agents/competitor-intelligence/matcher.js

/**
 * Match a competitor page URL to a store slug via sitemap index.
 * Returns { slug, type } or null if no match.
 */
export function matchCompetitorUrl(url, sitemapPages) {
  let pathSegment = null;
  let type = null;

  const productMatch = url.match(/\/products\/([^/?#]+)/);
  const collectionMatch = url.match(/\/collections\/([^/?#]+)/);

  if (productMatch) { pathSegment = productMatch[1]; type = 'product'; }
  else if (collectionMatch) { pathSegment = collectionMatch[1]; type = 'collection'; }
  else return null;

  const candidates = sitemapPages.filter(p => p.type === type);

  // (a) Exact slug match
  const exact = candidates.find(p => p.slug === pathSegment);
  if (exact) return { slug: exact.slug, type: exact.type };

  // (b) Token overlap — tokenize on '-', require ≥2 tokens of length >2 to match
  const competitorTokens = new Set(pathSegment.split('-').filter(t => t.length > 2));
  let best = null;
  let bestOverlap = 1; // require strictly more than 1 to match

  for (const page of candidates) {
    const pageTokens = page.slug.split('-').filter(t => t.length > 2);
    const overlap = pageTokens.filter(t => competitorTokens.has(t)).length;
    if (overlap > bestOverlap) { bestOverlap = overlap; best = page; }
  }

  return best ? { slug: best.slug, type: best.type } : null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --test tests/agents/competitor-intelligence.test.js
```

Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
git add agents/competitor-intelligence/matcher.js tests/agents/competitor-intelligence.test.js
git commit -m "feat: competitor-intelligence matcher — slug match via sitemap"
```

---

## Task 3: Page structure scraper — pure function + tests

Extracts SEO and structural signals from raw HTML.

**Files:**
- Create: `agents/competitor-intelligence/scraper.js`
- Modify: `tests/agents/competitor-intelligence.test.js` (add tests)

- [ ] **Step 1: Add failing tests**

Append to `tests/agents/competitor-intelligence.test.js`:

```js
import { extractPageStructure } from '../../agents/competitor-intelligence/scraper.js';

test('extracts H1 and heading hierarchy', () => {
  const html = '<html><body><h1>Best Deodorant</h1><h2>Why It Works</h2></body></html>';
  const result = extractPageStructure(html, ['best', 'deodorant']);
  assert.equal(result.h1, 'Best Deodorant');
  assert.deepEqual(result.h2s, ['Why It Works']);
});

test('detects keyword in H1', () => {
  const html = '<html><body><h1>Best Natural Deodorant</h1><p>First paragraph.</p></body></html>';
  const result = extractPageStructure(html, ['natural', 'deodorant']);
  assert.equal(result.keyword_in_h1, true);
});

test('identifies benefit list format as bullets', () => {
  const html = '<html><body><ul><li>Works all day</li><li>No stains</li></ul></body></html>';
  const result = extractPageStructure(html, []);
  assert.equal(result.benefit_format, 'bullets');
});

test('extracts CTA button text', () => {
  const html = '<html><body><button class="add-to-cart">Add to Cart — Free Shipping</button></body></html>';
  const result = extractPageStructure(html, []);
  assert.equal(result.cta_text, 'Add to Cart — Free Shipping');
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --test tests/agents/competitor-intelligence.test.js
```

Expected: first 5 pass, new 4 fail with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement scraper.js**

```js
// agents/competitor-intelligence/scraper.js
import { load } from 'cheerio';

/**
 * Extract SEO and structural signals from raw HTML.
 * slugTokens: array of tokens from the matched store slug (for keyword presence checks).
 */
export function extractPageStructure(html, slugTokens) {
  const $ = load(html);
  const tokens = slugTokens.map(t => t.toLowerCase());

  const h1 = $('h1').first().text().trim();
  const h2s = $('h2').map((_, el) => $(el).text().trim()).get();
  const h3s = $('h3').map((_, el) => $(el).text().trim()).get();

  // Section order heuristic
  const sectionKeywords = ['hero', 'benefit', 'ingredient', 'review', 'faq', 'feature', 'cta', 'description'];
  const sectionOrder = [];
  $('section, [class*="section"], [id]').each((_, el) => {
    const cls = ($(el).attr('class') || '') + ' ' + ($(el).attr('id') || '');
    for (const kw of sectionKeywords) {
      if (cls.toLowerCase().includes(kw) && !sectionOrder.includes(kw)) {
        sectionOrder.push(kw);
      }
    }
  });

  // CTA text
  let cta_text = '';
  $('button, a').each((_, el) => {
    if (cta_text) return;
    const cls = ($(el).attr('class') || '').toLowerCase();
    const text = $(el).text().trim();
    if (/cart|buy|shop|add/i.test(cls) || /add to cart|buy now|shop now/i.test(text)) {
      cta_text = text;
    }
  });

  // Description word count
  let descWords = 0;
  $('p, [class*="description"]').each((_, el) => {
    const wc = $(el).text().trim().split(/\s+/).length;
    if (wc > descWords) descWords = wc;
  });

  // Benefit format
  let benefit_format = 'prose';
  const lists = $('ul, ol');
  if (lists.length > 0) {
    const hasImages = lists.find('img, svg').length > 0;
    benefit_format = hasImages ? 'icon-bullets' : 'bullets';
  }

  // Keyword presence
  const h1Lower = h1.toLowerCase();
  const firstP = $('p').first().text().toLowerCase();
  const keyword_in_h1 = tokens.length > 0 && tokens.every(t => h1Lower.includes(t));
  const keyword_in_first_paragraph = tokens.length > 0 && tokens.every(t => firstP.includes(t));

  return {
    h1, h2s, h3s,
    section_order: sectionOrder,
    cta_text,
    description_words: descWords,
    benefit_format,
    keyword_in_h1,
    keyword_in_first_paragraph,
    conversion_patterns: [],
    recommended_changes: [],
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --test tests/agents/competitor-intelligence.test.js
```

Expected: 9 passing.

- [ ] **Step 5: Commit**

```bash
git add agents/competitor-intelligence/scraper.js tests/agents/competitor-intelligence.test.js
git commit -m "feat: competitor-intelligence scraper — extract page structure from HTML"
```

---

## Task 4: Brief writer — deduplication, merge, and KPI builder

**Files:**
- Create: `agents/competitor-intelligence/brief-writer.js`
- Modify: `tests/agents/competitor-intelligence.test.js` (add tests)

- [ ] **Step 1: Add failing tests**

Append to `tests/agents/competitor-intelligence.test.js`:

```js
import { deduplicateChanges, computeOptimizeKpis } from '../../agents/competitor-intelligence/brief-writer.js';

test('deduplicates by type, keeps highest traffic_value competitor', () => {
  const changes = [
    { type: 'meta_title', label: 'Meta A', proposed: 'Title A', rationale: 'reason A', fromTrafficValue: 1000 },
    { type: 'meta_title', label: 'Meta B', proposed: 'Title B', rationale: 'reason B', fromTrafficValue: 5000 },
    { type: 'body_html',  label: 'Desc',   proposed: '<p>Desc</p>', rationale: 'reason C', fromTrafficValue: 2000 },
  ];
  const result = deduplicateChanges(changes);
  assert.equal(result.length, 2);
  const metaChange = result.find(c => c.type === 'meta_title');
  assert.equal(metaChange.proposed, 'Title B'); // higher traffic value wins
});

test('assigns sequential IDs to changes', () => {
  const changes = [
    { type: 'meta_title', label: 'Meta', proposed: 'T', rationale: 'r', fromTrafficValue: 100 },
    { type: 'body_html',  label: 'Body', proposed: 'B', rationale: 'r', fromTrafficValue: 100 },
  ];
  const result = deduplicateChanges(changes);
  assert.equal(result[0].id, 'change-001');
  assert.equal(result[1].id, 'change-002');
});

test('computeOptimizeKpis counts pending pages correctly', () => {
  const briefs = [
    { proposed_changes: [{ status: 'pending' }, { status: 'approved' }], competitors: [], generated_at: new Date().toISOString() },
    { proposed_changes: [{ status: 'applied' }], competitors: [], generated_at: new Date().toISOString() },
  ];
  const kpis = computeOptimizeKpis({ briefs });
  assert.equal(kpis.pendingPages, 1);
  assert.equal(kpis.approvedChanges, 1);
  assert.equal(kpis.optimizedThisMonth, 1); // second brief: all changes applied, none approved
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --test tests/agents/competitor-intelligence.test.js
```

Expected: 9 pass, 3 fail.

- [ ] **Step 3: Implement brief-writer.js**

```js
// agents/competitor-intelligence/brief-writer.js

/**
 * Deduplicate recommended changes across competitors.
 * When multiple competitors suggest the same change type,
 * take the one from the competitor with the highest traffic_value.
 */
export function deduplicateChanges(changes) {
  const byType = new Map();
  for (const change of changes) {
    const existing = byType.get(change.type);
    if (!existing || change.fromTrafficValue > existing.fromTrafficValue) {
      byType.set(change.type, change);
    }
  }

  return Array.from(byType.values()).map((change, i) => {
    const { fromTrafficValue: _, ...rest } = change;
    return { id: `change-${String(i + 1).padStart(3, '0')}`, ...rest, status: 'pending' };
  });
}

/**
 * Compute Optimize tab KPI values from the briefs array.
 * Returns plain object (not the KPI array format — that's done in client JS).
 */
export function computeOptimizeKpis(d) {
  const briefs = d.briefs || [];
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const pendingPages = briefs.filter(b =>
    (b.proposed_changes || []).some(c => c.status === 'pending')
  ).length;

  const approvedChanges = briefs
    .flatMap(b => b.proposed_changes || [])
    .filter(c => c.status === 'approved').length;

  // A page is "optimized this month" if it has at least one applied change,
  // no remaining approved changes, and was generated within the current month.
  const optimizedThisMonth = briefs.filter(b => {
    const changes = b.proposed_changes || [];
    const hasApplied  = changes.some(c => c.status === 'applied');
    const noneApproved = !changes.some(c => c.status === 'approved');
    return hasApplied && noneApproved && new Date(b.generated_at) >= monthStart;
  }).length;

  const allTrafficValues = briefs.flatMap(b =>
    (b.competitors || []).map(c => (c.traffic_value || 0) / 100)
  );
  const avgTrafficValue = allTrafficValues.length
    ? Math.round(allTrafficValues.reduce((s, v) => s + v, 0) / allTrafficValues.length)
    : 0;

  return { pendingPages, approvedChanges, optimizedThisMonth, avgTrafficValue };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --test tests/agents/competitor-intelligence.test.js
```

Expected: 12 passing.

- [ ] **Step 5: Commit**

```bash
git add agents/competitor-intelligence/brief-writer.js tests/agents/competitor-intelligence.test.js
git commit -m "feat: competitor-intelligence brief-writer — deduplicate changes + KPI builder"
```

---

## Task 5: Competitor Intelligence Agent — main orchestrator

Wires together Ahrefs REST API, scraper, screenshots, Claude vision, and brief writer.

**Important:** Ahrefs MCP tools (`mcp__claude_ai_Ahrefs__*`) are only available within a Claude conversation context. This agent calls the **Ahrefs REST API v3 directly** using `AHREFS_API_KEY` from `.env`. The relevant endpoints are:
- Competitors: `GET https://api.ahrefs.com/v3/management/project/competitors`
- Top pages: `GET https://api.ahrefs.com/v3/site-explorer/top-pages?target=<domain>&limit=200&mode=domain`

**Also note:** The sitemap index does **not** include `shopify_id` for product/collection pages. The `resolveShopifyId()` call will always run and fetch from the Shopify API.

**Files:**
- Create: `agents/competitor-intelligence/index.js`

- [ ] **Step 1: Create the agent**

```js
// agents/competitor-intelligence/index.js
/**
 * Competitor Intelligence Agent
 *
 * Pulls top competitor pages from Ahrefs REST API, scrapes structure,
 * takes screenshots, runs Claude vision analysis, writes optimization briefs.
 *
 * Usage:
 *   node agents/competitor-intelligence/index.js
 *
 * Requires in .env: AHREFS_API_KEY, ANTHROPIC_API_KEY, SHOPIFY_STORE, SHOPIFY_SECRET
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import puppeteer from 'puppeteer';
import { getProducts, getCustomCollections, getSmartCollections, getMetafields } from '../../lib/shopify.js';
import { matchCompetitorUrl } from './matcher.js';
import { extractPageStructure } from './scraper.js';
import { deduplicateChanges } from './brief-writer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

function loadEnv() {
  try {
    const lines = readFileSync(join(ROOT, '.env'), 'utf8').split('\n');
    const env = {};
    for (const l of lines) {
      const t = l.trim(); if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('='); if (i === -1) continue;
      env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
    return env;
  } catch { return {}; }
}

const env = loadEnv();
const STORE          = env.SHOPIFY_STORE || process.env.SHOPIFY_STORE;
const AHREFS_KEY     = env.AHREFS_API_KEY || process.env.AHREFS_API_KEY;
const SCREENSHOTS_DIR = join(ROOT, 'data', 'competitor-intelligence', 'screenshots');
const BRIEFS_DIR      = join(ROOT, 'data', 'competitor-intelligence', 'briefs');
const SITEMAP_PATH    = join(ROOT, 'data', 'sitemap-index.json');

const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY });

// ── Ahrefs REST API v3 ─────────────────────────────────────────────────────────

async function ahrefsFetch(path) {
  if (!AHREFS_KEY) throw new Error('AHREFS_API_KEY not set in .env');
  const res = await fetch(`https://api.ahrefs.com/v3${path}`, {
    headers: { Authorization: `Bearer ${AHREFS_KEY}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Ahrefs API ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

async function getCompetitors() {
  const data = await ahrefsFetch('/management/project/competitors');
  return data.competitors || [];
}

async function getTopPages(domain) {
  const params = new URLSearchParams({ target: domain, limit: '200', mode: 'domain' });
  const data = await ahrefsFetch(`/site-explorer/top-pages?${params}`);
  return data.pages || [];
}

// ── Puppeteer screenshot ───────────────────────────────────────────────────────

async function takeScreenshot(url, outputPath) {
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.screenshot({ path: outputPath, fullPage: true });
    return outputPath;
  } catch (err) {
    console.warn(`  [screenshot] Failed for ${url}: ${err.message}`);
    return null;
  } finally {
    await browser.close();
  }
}

// ── Shopify ID resolution (sitemap never includes shopify_id, always fetched) ──

async function resolveShopifyId(slug, type) {
  if (type === 'product') {
    const products = await getProducts({ handle: slug });
    return products?.[0]?.id || null;
  }
  const custom = await getCustomCollections({ handle: slug });
  if (custom?.[0]?.id) return custom[0].id;
  const smart = await getSmartCollections({ handle: slug });
  return smart?.[0]?.id || null;
}

// ── Current page content snapshot ─────────────────────────────────────────────

async function fetchCurrentContent(shopify_id, type) {
  const resource = type === 'product' ? 'products' : 'custom_collections';
  const items = type === 'product'
    ? await getProducts({ ids: shopify_id })
    : await getCustomCollections({ ids: shopify_id });
  const item = items?.[0];

  const metafields = await getMetafields(resource, shopify_id);
  const meta_title = metafields.find(m => m.namespace === 'global' && m.key === 'title_tag')?.value || '';
  const meta_description = metafields.find(m => m.namespace === 'global' && m.key === 'description_tag')?.value || '';

  return {
    title: item?.title || '',
    meta_title,
    meta_description,
    body_html: item?.body_html || '',
    theme_sections: [], // Theme section snapshot omitted — populated on demand if needed
  };
}

// ── Claude vision analysis ─────────────────────────────────────────────────────

async function analyzeWithVision(screenshotPath, structureData, targetSlug) {
  if (!screenshotPath || !existsSync(screenshotPath)) {
    return { ...structureData, conversion_patterns: [], recommended_changes: [] };
  }

  const imageData = readFileSync(screenshotPath).toString('base64');
  const prompt = `You are analyzing a competitor product/collection page to identify patterns that drive conversions.

Target store slug: ${targetSlug}
Extracted structure: ${JSON.stringify(structureData, null, 2)}

Return ONLY valid JSON with this exact schema:
{
  "conversion_patterns": ["string — observation about what makes this page effective"],
  "recommended_changes": [
    {
      "type": "meta_title | meta_description | body_html | theme_section",
      "label": "string — short descriptive label",
      "proposed": "string — the actual proposed content",
      "rationale": "string — why this change would improve conversions"
    }
  ]
}`;

  const msg = await anthropic.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageData } },
        { type: 'text', text: prompt },
      ],
    }],
  });

  try {
    const text = msg.content.find(b => b.type === 'text')?.text || '{}';
    const json = JSON.parse(text.replace(/```json|```/g, '').trim());
    return { ...structureData, ...json };
  } catch {
    console.warn('  [vision] Failed to parse Claude response — no changes generated for this page');
    return { ...structureData, conversion_patterns: [], recommended_changes: [] };
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  mkdirSync(BRIEFS_DIR, { recursive: true });

  if (!existsSync(SITEMAP_PATH)) throw new Error('sitemap-index.json not found — run: npm run sitemap');
  const sitemap = JSON.parse(readFileSync(SITEMAP_PATH, 'utf8'));
  const sitemapPages = sitemap.pages.filter(p => p.type === 'product' || p.type === 'collection');
  console.log(`Loaded sitemap: ${sitemapPages.length} product/collection pages`);

  const competitors = await getCompetitors();
  console.log(`Found ${competitors.length} competitors in Ahrefs project`);

  // Accumulate results per store slug before writing briefs
  const briefMap = new Map(); // slug → { type, competitors[], allChanges[] }

  for (const competitor of competitors) {
    const domain = competitor.domain;
    if (!domain) continue;
    console.log(`\nProcessing: ${domain}`);

    let topPages = [];
    try {
      topPages = await getTopPages(domain);
    } catch (err) {
      console.warn(`  [ahrefs] ${err.message}`);
      continue;
    }

    // Filter client-side to product/collection URLs, sort by traffic_value desc, top 5
    const filtered = topPages
      .filter(p => /\/products\/|\/collections\//.test(p.url))
      .sort((a, b) => (b.traffic_value || 0) - (a.traffic_value || 0))
      .slice(0, 5);

    console.log(`  ${filtered.length} relevant pages (from ${topPages.length} total)`);

    for (const page of filtered) {
      const match = matchCompetitorUrl(page.url, sitemapPages);
      if (!match) { console.log(`  skip (no match): ${page.url}`); continue; }

      const { slug, type } = match;
      const slugTokens = slug.split('-').filter(t => t.length > 2);
      console.log(`  matched: ${page.url} → ${slug}`);

      if (!briefMap.has(slug)) {
        briefMap.set(slug, { slug, type, competitors: [], allChanges: [] });
      }
      const acc = briefMap.get(slug);

      // Scrape competitor page
      let structure = { h1: '', section_order: [], cta_text: '', description_words: 0, benefit_format: 'prose', keyword_in_h1: false, keyword_in_first_paragraph: false };
      try {
        const res = await fetch(page.url, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' } });
        if (res.ok) {
          structure = extractPageStructure(await res.text(), slugTokens);
        } else {
          console.warn(`  [scrape] HTTP ${res.status} — skipping`);
        }
      } catch (err) {
        console.warn(`  [scrape] ${err.message}`);
      }

      // Screenshot competitor
      const domainSlug = domain.replace(/\./g, '-');
      const screenshotFile = `${domainSlug}-${slug}.png`;
      const screenshotSaved = await takeScreenshot(page.url, join(SCREENSHOTS_DIR, screenshotFile));

      // Claude vision
      const analysis = await analyzeWithVision(screenshotSaved, structure, slug);
      const taggedChanges = (analysis.recommended_changes || []).map(c => ({
        ...c, fromTrafficValue: page.traffic_value || 0,
      }));

      acc.competitors.push({
        domain,
        url: page.url,
        traffic_value: page.traffic_value || 0,
        screenshot: screenshotSaved
          ? join('data', 'competitor-intelligence', 'screenshots', screenshotFile)
          : null,
        analysis: {
          h1: analysis.h1,
          section_order: analysis.section_order,
          cta_text: analysis.cta_text,
          description_words: analysis.description_words,
          keyword_in_h1: analysis.keyword_in_h1,
          keyword_in_first_paragraph: analysis.keyword_in_first_paragraph,
          benefit_format: analysis.benefit_format,
          conversion_patterns: analysis.conversion_patterns || [],
          recommended_changes: [],
        },
      });
      acc.allChanges.push(...taggedChanges);
    }
  }

  // Write briefs
  for (const [slug, acc] of briefMap) {
    if (!acc.competitors.length) continue;

    // Resolve shopify_id via Shopify API (sitemap never includes it)
    const shopify_id = await resolveShopifyId(slug, acc.type);
    console.log(`\n${slug}: shopify_id=${shopify_id}`);

    let current = { title: '', meta_title: '', meta_description: '', body_html: '', theme_sections: [] };
    if (shopify_id) {
      try { current = await fetchCurrentContent(shopify_id, acc.type); }
      catch (err) { console.warn(`  [shopify] ${err.message}`); }
    }

    // Screenshot store page
    const storeUrl = `https://${STORE}/${acc.type === 'product' ? 'products' : 'collections'}/${slug}`;
    const storeSaved = await takeScreenshot(storeUrl, join(SCREENSHOTS_DIR, `store-${slug}.png`));

    // Deduplicate and tag with display-only current values
    const proposed_changes = deduplicateChanges(acc.allChanges).map(c => {
      const currentVal = c.type === 'meta_title' ? current.meta_title
                       : c.type === 'meta_description' ? current.meta_description
                       : c.type === 'body_html' ? current.body_html
                       : undefined; // theme_section: no inline current
      return currentVal !== undefined ? { ...c, current: currentVal } : c;
    });

    const brief = {
      slug,
      page_type: acc.type,
      shopify_id,
      generated_at: new Date().toISOString(),
      status: 'pending',
      store_screenshot: storeSaved
        ? join('data', 'competitor-intelligence', 'screenshots', `store-${slug}.png`)
        : null,
      current,
      competitors: acc.competitors.sort((a, b) => b.traffic_value - a.traffic_value),
      proposed_changes,
    };

    writeFileSync(join(BRIEFS_DIR, `${slug}.json`), JSON.stringify(brief, null, 2));
    console.log(`  brief written: ${proposed_changes.length} proposed changes`);
  }

  console.log('\nCompetitor intelligence complete.');
}

main().catch(e => { console.error(e.message); process.exit(1); });
```

- [ ] **Step 2: Verify existing tests still pass**

```bash
node --test tests/agents/competitor-intelligence.test.js
```

Expected: 12 passing.

- [ ] **Step 3: Commit**

```bash
git add agents/competitor-intelligence/index.js
git commit -m "feat: competitor intelligence agent — Ahrefs REST + scrape + vision + brief"
```

---

## Task 6: Ahrefs reminder script + cron

**Files:**
- Create: `scripts/ahrefs-reminder.js`
- Modify: `scripts/setup-cron.sh`

- [ ] **Step 1: Create the reminder script**

```js
// scripts/ahrefs-reminder.js
/**
 * Ahrefs Upload Reminder
 * Sends Resend email 24h before rank tracker runs (Mon 07:00 UTC → fires Sun 07:00 UTC).
 * Usage: node scripts/ahrefs-reminder.js
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { notify } from '../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function loadEnv() {
  try {
    const lines = readFileSync(join(ROOT, '.env'), 'utf8').split('\n');
    const env = {};
    for (const l of lines) {
      const t = l.trim(); if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('='); if (i === -1) continue;
      env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
    return env;
  } catch { return {}; }
}

const env = loadEnv();
const DASHBOARD_URL = env.DASHBOARD_URL || process.env.DASHBOARD_URL || 'http://localhost:4242';
const AHREFS_DIR = join(ROOT, 'data', 'ahrefs');

function getLatestFile() {
  if (!existsSync(AHREFS_DIR)) return null;
  const files = readdirSync(AHREFS_DIR).filter(f => f.endsWith('.csv') || f.endsWith('.zip'));
  if (!files.length) return null;
  return files
    .map(f => ({ name: f, mtime: statSync(join(AHREFS_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0].name;
}

async function main() {
  const latest = getLatestFile();
  const currentFile = latest ? `Current file: ${latest}` : 'No file currently uploaded.';

  await notify({
    subject: 'Ahrefs CSV needed — rank tracker runs in 24 hours',
    body: `The rank tracker is scheduled to run in 24 hours (Monday 07:00 UTC).

${currentFile}

To upload a fresh Ahrefs export:
1. Ahrefs Site Explorer → Overview → Export CSV
2. Upload at: ${DASHBOARD_URL} (Optimize tab → Actions → Upload Ahrefs CSV)`,
    status: 'info',
  });

  console.log('Ahrefs reminder sent.');
}

main().catch(e => { console.error(e.message); process.exit(1); });
```

- [ ] **Step 2: Add cron entry to setup-cron.sh**

Find the section in `setup-cron.sh` where variables like `DAILY_RANK_ALERTER` are defined. Add:
```bash
AHREFS_REMINDER="0 7 * * 0 node $PROJECT_DIR/scripts/ahrefs-reminder.js >> $PROJECT_DIR/data/reports/scheduler/ahrefs-reminder.log 2>&1"
```

Add `$AHREFS_REMINDER` inside the `NEW_CRONTAB` heredoc block (alongside the other entries).

Add to the `echo "Installed:"` section:
```bash
echo "  Weekly  Sun 07:00 UTC — Ahrefs upload reminder"
```

- [ ] **Step 3: Verify script runs without error**

```bash
node scripts/ahrefs-reminder.js
```

Expected: `Ahrefs reminder sent.` (or `[notify] RESEND_API_KEY or NOTIFY_EMAIL not set, skipping.` then `Ahrefs reminder sent.`) — no crash either way.

- [ ] **Step 4: Commit**

```bash
git add scripts/ahrefs-reminder.js scripts/setup-cron.sh
git commit -m "feat: ahrefs-reminder script + cron — 24h before rank tracker"
```

---

## Task 7: Apply Agent — pure functions + orchestrator

**Files:**
- Create: `agents/apply-optimization/index.js`
- Create: `tests/agents/apply-optimization.test.js`

- [ ] **Step 1: Write failing tests**

```js
// tests/agents/apply-optimization.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterApprovedChanges, parseDoneLine } from '../../agents/apply-optimization/index.js';

test('filterApprovedChanges returns only approved changes', () => {
  const brief = {
    proposed_changes: [
      { id: 'change-001', type: 'meta_title', status: 'approved', proposed: 'New Title' },
      { id: 'change-002', type: 'body_html',  status: 'pending',  proposed: '<p>Body</p>' },
      { id: 'change-003', type: 'meta_description', status: 'rejected', proposed: 'Desc' },
    ],
  };
  const result = filterApprovedChanges(brief);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'change-001');
});

test('filterApprovedChanges returns empty array when none approved', () => {
  const brief = { proposed_changes: [{ id: 'c1', status: 'pending' }] };
  assert.deepEqual(filterApprovedChanges(brief), []);
});

test('parseDoneLine extracts counts from DONE JSON line', () => {
  const result = parseDoneLine('DONE {"applied":3,"failed":1}');
  assert.deepEqual(result, { applied: 3, failed: 1 });
});

test('parseDoneLine returns null for non-DONE lines', () => {
  assert.equal(parseDoneLine('Applying change-001...'), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --test tests/agents/apply-optimization.test.js
```

Expected: `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Create the apply agent**

```js
// agents/apply-optimization/index.js
/**
 * Apply Optimization Agent
 *
 * Reads a brief, applies all approved changes to Shopify,
 * updates statuses, and sends a Resend notification.
 *
 * Usage: node agents/apply-optimization/index.js <slug>
 *
 * stdout protocol: writes "DONE {applied:N,failed:N}" as the last line.
 * The dashboard /apply/:slug SSE endpoint reads this to emit the done event.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { updateProduct, updateCustomCollection, upsertMetafield } from '../../lib/shopify.js';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const BRIEFS_DIR = join(ROOT, 'data', 'competitor-intelligence', 'briefs');

function loadEnv() {
  try {
    const lines = readFileSync(join(ROOT, '.env'), 'utf8').split('\n');
    const env = {};
    for (const l of lines) {
      const t = l.trim(); if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('='); if (i === -1) continue;
      env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
    return env;
  } catch { return {}; }
}

const env = loadEnv();
const STORE   = env.SHOPIFY_STORE  || process.env.SHOPIFY_STORE;
const SECRET  = env.SHOPIFY_SECRET || process.env.SHOPIFY_SECRET;
const API_VER = '2025-01';

// ── Exported pure functions (tested) ──────────────────────────────────────────

export function filterApprovedChanges(brief) {
  return (brief.proposed_changes || []).filter(c => c.status === 'approved');
}

export function parseDoneLine(line) {
  if (!line.startsWith('DONE ')) return null;
  try { return JSON.parse(line.slice(5)); } catch { return null; }
}

// ── Theme API helpers ──────────────────────────────────────────────────────────

async function shopifyRaw(method, path, body = null) {
  const res = await fetch(`https://${STORE}/admin/api/${API_VER}${path}`, {
    method,
    headers: { 'X-Shopify-Access-Token': SECRET, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Shopify ${method} ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

async function getActiveThemeId() {
  const data = await shopifyRaw('GET', '/themes.json?role=main');
  return data.themes?.[0]?.id;
}

// ── Apply a single change ──────────────────────────────────────────────────────

async function applyChange(change, brief) {
  const { shopify_id, page_type } = brief;
  const resource = page_type === 'product' ? 'products' : 'custom_collections';

  switch (change.type) {
    case 'meta_title':
      await upsertMetafield(resource, shopify_id, 'global', 'title_tag', change.proposed);
      break;
    case 'meta_description':
      await upsertMetafield(resource, shopify_id, 'global', 'description_tag', change.proposed);
      break;
    case 'body_html':
      if (page_type === 'product') await updateProduct(shopify_id, { body_html: change.proposed });
      else await updateCustomCollection(shopify_id, { body_html: change.proposed });
      break;
    case 'theme_section': {
      const themeId = await getActiveThemeId();
      await shopifyRaw('PUT', `/themes/${themeId}/assets.json`, {
        asset: { key: change.section_key, value: JSON.stringify(change.proposed_content, null, 2) },
      });
      break;
    }
    default:
      throw new Error(`Unknown change type: ${change.type}`);
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const slug = process.argv[2];
  if (!slug) { console.error('Usage: node agents/apply-optimization/index.js <slug>'); process.exit(1); }

  const briefPath = join(BRIEFS_DIR, `${slug}.json`);
  if (!existsSync(briefPath)) throw new Error(`Brief not found: ${briefPath}`);

  const brief = JSON.parse(readFileSync(briefPath, 'utf8'));
  const approved = filterApprovedChanges(brief);

  if (!approved.length) {
    console.log('No approved changes to apply.');
    console.log('DONE {"applied":0,"failed":0}');
    return;
  }

  console.log(`Applying ${approved.length} approved changes for: ${slug}`);
  let applied = 0, failed = 0;

  for (const change of approved) {
    console.log(`  Applying ${change.id} (${change.type})...`);
    try {
      await applyChange(change, brief);
      change.status = 'applied';
      applied++;
      console.log(`  ✓ ${change.id} applied`);
    } catch (err) {
      console.log(`  ✗ ${change.id} failed: ${err.message}`);
      failed++;
    }
  }

  if (!brief.proposed_changes.some(c => c.status === 'approved')) brief.status = 'applied';
  writeFileSync(briefPath, JSON.stringify(brief, null, 2));

  await notify({
    subject: `Optimization applied: ${slug} — ${applied} applied, ${failed} failed`,
    body: `Slug: ${slug}\nApplied: ${applied}\nFailed: ${failed}`,
    status: failed > 0 ? 'error' : 'success',
  });

  console.log(`\nDone: ${applied} applied, ${failed} failed`);
  console.log(`DONE {"applied":${applied},"failed":${failed}}`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --test tests/agents/apply-optimization.test.js
```

Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add agents/apply-optimization/index.js tests/agents/apply-optimization.test.js
git commit -m "feat: apply-optimization agent — push approved brief changes to Shopify"
```

---

## Task 8: Dashboard — new endpoints + Manual Actions panel

**Files:**
- Modify: `agents/dashboard/index.js`

### 8a: Path constants, allowlist, and spawn import

- [ ] **Step 1: Add to the imports at the top of index.js**

Find the existing `import` block (around line 14–18). Add:
```js
import { spawn } from 'child_process';
```

- [ ] **Step 2: Add path constants and allowlist after the existing `const CALENDAR_PATH = ...` line**

Note: `AHREFS_DIR` already exists in the file (around line 262) — do NOT redeclare it, only add the two new constants below.

```js
const COMP_BRIEFS_DIR      = join(ROOT, 'data', 'competitor-intelligence', 'briefs');
const COMP_SCREENSHOTS_DIR = join(ROOT, 'data', 'competitor-intelligence', 'screenshots');

const RUN_AGENT_ALLOWLIST = new Set([
  'agents/rank-tracker/index.js',
  'agents/content-gap/index.js',
  'agents/gsc-query-miner/index.js',
  'agents/sitemap-indexer/index.js',
  'agents/insight-aggregator/index.js',
  'agents/meta-ab-tracker/index.js',
  'agents/cro-analyzer/index.js',
  'agents/competitor-intelligence/index.js',
  'scripts/create-meta-test.js',
]);
```

- [ ] **Step 3: Commit constants**

```bash
git add agents/dashboard/index.js
git commit -m "feat: dashboard — add path constants, allowlist, spawn import"
```

### 8b: Five new POST/GET endpoints

- [ ] **Step 4: Add the five new routes to the `http.createServer` callback**

In the request handler, add these five routes **before** the existing `if (req.method === 'POST' && req.url === '/dismiss-alert')` check:

**Route 1 — POST /run-agent:**
```js
if (req.method === 'POST' && req.url === '/run-agent') {
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', () => {
    let script, args = [];
    try { ({ script, args = [] } = JSON.parse(body)); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
      return;
    }
    if (!RUN_AGENT_ALLOWLIST.has(script)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Script not in allowlist' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    const child = spawn('node', [join(ROOT, script), ...args], { cwd: ROOT });
    const send = line => res.write(`data: ${line}\n\n`);
    child.stdout.on('data', d => String(d).split('\n').filter(Boolean).forEach(send));
    child.stderr.on('data', d => String(d).split('\n').filter(Boolean).forEach(l => send(`[stderr] ${l}`)));
    child.on('close', code => { res.write(`event: done\ndata: ${JSON.stringify({ code })}\n\n`); res.end(); });
  });
  return;
}
```

**Route 2 — POST /upload/ahrefs:**

Note: This uses a raw body + `X-Filename` header approach rather than multipart parsing (no multipart dep available). The client-side `uploadAhrefs()` function matches this convention.

```js
if (req.method === 'POST' && req.url === '/upload/ahrefs') {
  mkdirSync(AHREFS_DIR, { recursive: true });
  const chunks = [];
  req.on('data', d => chunks.push(d));
  req.on('end', () => {
    const rawName = req.headers['x-filename'] || 'ahrefs-upload.csv';
    const filename = rawName.replace(/[^a-zA-Z0-9._-]/g, '_'); // strip path traversal chars
    writeFileSync(join(AHREFS_DIR, filename), Buffer.concat(chunks));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, filename, saved_at: new Date().toISOString() }));
  });
  return;
}
```

**Route 3 — POST /brief/:slug/change/:id:**
```js
if (req.method === 'POST' && req.url.startsWith('/brief/')) {
  const parts = req.url.split('/'); // ['', 'brief', slug, 'change', id]
  const slug = parts[2], id = parts[4];
  if (!slug || !id) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Missing slug or id' })); return; }
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', () => {
    let status;
    try { ({ status } = JSON.parse(body)); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' })); return; }
    if (!['approved', 'rejected'].includes(status)) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'status must be approved or rejected' })); return; }
    const briefPath = join(COMP_BRIEFS_DIR, `${slug}.json`);
    if (!existsSync(briefPath)) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Brief not found' })); return; }
    const brief = JSON.parse(readFileSync(briefPath, 'utf8'));
    const change = brief.proposed_changes?.find(c => c.id === id);
    if (!change) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Change not found' })); return; }
    change.status = status;
    writeFileSync(briefPath, JSON.stringify(brief, null, 2));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, change }));
  });
  return;
}
```

**Route 4 — POST /apply/:slug:**
```js
if (req.method === 'POST' && req.url.startsWith('/apply/')) {
  const slug = req.url.slice('/apply/'.length);
  const briefPath = join(COMP_BRIEFS_DIR, `${slug}.json`);
  if (!existsSync(briefPath)) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Brief not found' })); return; }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  const child = spawn('node', [join(ROOT, 'agents', 'apply-optimization', 'index.js'), slug], { cwd: ROOT });
  child.stdout.on('data', d => {
    for (const line of String(d).split('\n').filter(Boolean)) {
      if (line.startsWith('DONE ')) {
        try { res.write(`event: done\ndata: ${JSON.stringify(JSON.parse(line.slice(5)))}\n\n`); }
        catch { res.write(`event: done\ndata: {}\n\n`); }
      } else {
        res.write(`data: ${line}\n\n`);
      }
    }
  });
  child.stderr.on('data', d => String(d).split('\n').filter(Boolean).forEach(l => res.write(`data: [err] ${l}\n\n`)));
  child.on('close', () => res.end());
  return;
}
```

**Route 5 — GET /screenshot:**
```js
if (req.method === 'GET' && req.url.startsWith('/screenshot?')) {
  const urlObj = new URL(req.url, 'http://localhost');
  const imgPath = urlObj.searchParams.get('path');
  const resolved = join(ROOT, imgPath || '');
  if (!resolved.startsWith(COMP_SCREENSHOTS_DIR) || !existsSync(resolved)) {
    res.writeHead(404); res.end(); return;
  }
  res.writeHead(200, { 'Content-Type': 'image/png' });
  res.end(readFileSync(resolved));
  return;
}
```

- [ ] **Step 5: Test the allowlist endpoint**

```bash
pkill -f "node agents/dashboard/index.js" || true
node agents/dashboard/index.js &
sleep 2
curl -s -X POST http://localhost:4242/run-agent \
  -H 'Content-Type: application/json' \
  -d '{"script":"agents/not-allowed.js"}'
```

Expected: `{"ok":false,"error":"Script not in allowlist"}`

- [ ] **Step 6: Commit endpoints**

```bash
git add agents/dashboard/index.js
git commit -m "feat: dashboard — /run-agent, /upload/ahrefs, /brief, /apply, /screenshot endpoints"
```

### 8c: Manual Actions panel HTML + CSS

- [ ] **Step 7: Add CSS for the actions panel and run log to the `<style>` block**

```css
.actions-panel { margin-top: 2rem; border: 1px solid var(--border); border-radius: 8px; }
.actions-panel summary { padding: 0.75rem 1rem; cursor: pointer; font-weight: 600; color: var(--muted); font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.05em; }
.actions-grid { display: flex; flex-wrap: wrap; gap: 0.5rem; padding: 1rem; }
.actions-grid button { padding: 0.4rem 0.85rem; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; cursor: pointer; font-size: 0.85rem; }
.actions-grid button:hover { background: var(--indigo); color: white; border-color: var(--indigo); }
.run-log { margin: 0 1rem 1rem; padding: 0.75rem; background: #0d0d0d; color: #7ee787; font-size: 0.78rem; border-radius: 6px; max-height: 200px; overflow-y: auto; white-space: pre-wrap; }
```

- [ ] **Step 8: Add JS helpers to the `<script>` block**

```js
function runAgent(script, args = []) {
  const logId = 'run-log-' + script.replace(/[^a-z0-9]/gi, '-');
  const logEl = document.getElementById(logId);
  if (!logEl) return;
  logEl.textContent = 'Running...\n';
  logEl.style.display = 'block';
  fetch('/run-agent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ script, args }),
  }).then(res => {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    function read() {
      reader.read().then(({ done, value }) => {
        if (done) return;
        for (const line of decoder.decode(value).split('\n')) {
          if (line.startsWith('data: ')) logEl.textContent += line.slice(6) + '\n';
        }
        logEl.scrollTop = logEl.scrollHeight;
        read();
      });
    }
    read();
  });
}

function promptAndRun(script, argLabel) {
  const val = prompt(argLabel);
  if (val) runAgent(script, [val]);
}

function uploadAhrefs() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.csv,.zip';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    const statusEl = document.getElementById('ahrefs-upload-status');
    if (statusEl) statusEl.textContent = 'Uploading...';
    const res = await fetch('/upload/ahrefs', {
      method: 'POST',
      headers: { 'X-Filename': file.name, 'Content-Type': 'application/octet-stream' },
      body: file,
    });
    const json = await res.json();
    if (statusEl) statusEl.textContent = json.ok ? `Uploaded: ${json.filename}` : `Error: ${json.error}`;
  };
  input.click();
}
```

- [ ] **Step 9: Add Actions `<details>` panel to SEO tab**

Inside `<div id="tab-seo" class="tab-panel ...">`, at the bottom before the closing `</div>`, add:

```html
<details class="actions-panel">
  <summary>Actions</summary>
  <div class="actions-grid">
    <button onclick="runAgent('agents/rank-tracker/index.js')">Run Rank Tracker</button>
    <button onclick="runAgent('agents/content-gap/index.js')">Run Content Gap</button>
    <button onclick="runAgent('agents/gsc-query-miner/index.js')">Run GSC Query Miner</button>
    <button onclick="runAgent('agents/sitemap-indexer/index.js')">Refresh Sitemap</button>
    <button onclick="runAgent('agents/insight-aggregator/index.js')">Run Insight Aggregator</button>
  </div>
  <pre id="run-log-agents-rank-tracker-index-js" class="run-log" style="display:none"></pre>
  <pre id="run-log-agents-content-gap-index-js" class="run-log" style="display:none"></pre>
  <pre id="run-log-agents-gsc-query-miner-index-js" class="run-log" style="display:none"></pre>
  <pre id="run-log-agents-sitemap-indexer-index-js" class="run-log" style="display:none"></pre>
  <pre id="run-log-agents-insight-aggregator-index-js" class="run-log" style="display:none"></pre>
</details>
```

- [ ] **Step 10: Add Actions panel to CRO tab**

Inside `<div id="tab-cro" ...>`, at the bottom:

```html
<details class="actions-panel">
  <summary>Actions</summary>
  <div class="actions-grid">
    <button onclick="promptAndRun('scripts/create-meta-test.js', 'Enter post slug:')">Create Meta A/B Test</button>
    <button onclick="runAgent('agents/meta-ab-tracker/index.js')">Run Meta A/B Tracker</button>
    <button onclick="runAgent('agents/cro-analyzer/index.js')">Run CRO Analyzer</button>
  </div>
  <pre id="run-log-scripts-create-meta-test-js" class="run-log" style="display:none"></pre>
  <pre id="run-log-agents-meta-ab-tracker-index-js" class="run-log" style="display:none"></pre>
  <pre id="run-log-agents-cro-analyzer-index-js" class="run-log" style="display:none"></pre>
</details>
```

- [ ] **Step 11: Verify in browser**

```bash
pkill -f "node agents/dashboard/index.js" || true
node agents/dashboard/index.js --open
```

Open SEO tab, scroll to bottom, expand "Actions", click "Refresh Sitemap". Verify log area appears with output.

- [ ] **Step 12: Commit actions panel**

```bash
git add agents/dashboard/index.js
git commit -m "feat: dashboard — Manual Actions panel on SEO and CRO tabs"
```

---

## Task 9: Optimize tab — scaffold, KPIs, kanban, detail view

**Files:**
- Modify: `agents/dashboard/index.js`

### 9a: Tab navigation + data loading

- [ ] **Step 1: Add Optimize tab pill to the tab navigation HTML**

Find the line:
```html
<button class="tab-pill" onclick="switchTab('ads',this)" id="pill-ads" style="display:none">Ads</button>
```

Add immediately after:
```html
<button class="tab-pill" onclick="switchTab('optimize',this)" id="pill-optimize">Optimize</button>
```

Add the tab panel alongside the other `<div id="tab-...">` panels:
```html
<div id="tab-optimize" class="tab-panel">
  <div class="empty-state">Loading optimization briefs...</div>
</div>
```

- [ ] **Step 2: Add brief + Ahrefs file loading to `aggregateData()`**

In the `aggregateData()` function, before the `return { ... }` statement, add:

```js
// Load competitor briefs
const briefs = [];
if (existsSync(COMP_BRIEFS_DIR)) {
  for (const f of readdirSync(COMP_BRIEFS_DIR).filter(f => f.endsWith('.json'))) {
    try { briefs.push(JSON.parse(readFileSync(join(COMP_BRIEFS_DIR, f), 'utf8'))); } catch {}
  }
}

// Latest Ahrefs file
let ahrefsFile = null;
if (existsSync(AHREFS_DIR)) {
  const aFiles = readdirSync(AHREFS_DIR).filter(f => f.endsWith('.csv') || f.endsWith('.zip'));
  if (aFiles.length) {
    ahrefsFile = aFiles
      .map(f => ({ name: f, mtime: statSync(join(AHREFS_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)[0];
  }
}
```

Add `briefs` and `ahrefsFile` to the return object.

### 9b: KPI functions + tab render

- [ ] **Step 3: Update `renderHeroKpis` to handle the optimize tab**

The current function (around line 756) uses a ternary chain. Replace the entire function with:

```js
function renderHeroKpis(d) {
  const kpis = activeTab === 'cro'      ? buildCroKpis(d)
             : activeTab === 'ads'      ? buildAdsKpis(d)
             : activeTab === 'optimize' ? buildOptimizeKpis(d)
             : buildSeoKpis(d);
  document.getElementById('hero-kpis').innerHTML = kpis.map(k =>
    '<div class="hero-kpi">' +
    '<div class="hero-kpi-value" style="color:' + k.color + '">' + k.value + '</div>' +
    '<div class="hero-kpi-label">' + k.label + '</div>' +
    '</div>'
  ).join('');
}
```

- [ ] **Step 4: Add `buildOptimizeKpis()` using the pure `computeOptimizeKpis` helper**

Note: `computeOptimizeKpis` lives in `brief-writer.js` (server-side). Client-side JS cannot import it. Inline the same logic as a client-side function:

```js
function buildOptimizeKpis(d) {
  const briefs = d.briefs || [];
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const pendingPages = briefs.filter(b =>
    (b.proposed_changes || []).some(c => c.status === 'pending')
  ).length;

  const approvedChanges = briefs
    .flatMap(b => b.proposed_changes || [])
    .filter(c => c.status === 'approved').length;

  const optimizedThisMonth = briefs.filter(b => {
    const changes = b.proposed_changes || [];
    return changes.some(c => c.status === 'applied')
      && !changes.some(c => c.status === 'approved')
      && new Date(b.generated_at) >= monthStart;
  }).length;

  const allTV = briefs.flatMap(b => (b.competitors || []).map(c => (c.traffic_value || 0) / 100));
  const avgTV = allTV.length ? Math.round(allTV.reduce((s, v) => s + v, 0) / allTV.length) : 0;

  return [
    { label: 'Pending Review',        value: pendingPages,          color: '#f59e0b' },
    { label: 'Changes Approved',      value: approvedChanges,       color: '#818cf8' },
    { label: 'Optimized This Month',  value: optimizedThisMonth,    color: '#10b981' },
    { label: 'Avg Traffic Value',     value: `$${avgTV.toLocaleString()}`, color: '#38bdf8' },
  ];
}
```

- [ ] **Step 5: Add `renderOptimizeTab()` and supporting functions to the `<script>` block**

```js
function renderOptimizeTab(d) {
  const briefs = d.briefs || [];

  const pending  = briefs.filter(b => (b.proposed_changes || []).some(c => c.status === 'pending'));
  const approved = briefs.filter(b => {
    const ch = b.proposed_changes || [];
    return !ch.some(c => c.status === 'pending') && ch.some(c => c.status === 'approved') && !ch.some(c => c.status === 'applied');
  });
  const applied  = briefs.filter(b => {
    const ch = b.proposed_changes || [];
    return ch.some(c => c.status === 'applied') && !ch.some(c => c.status === 'approved');
  });

  const ahrefsStatus = d.ahrefsFile
    ? esc(d.ahrefsFile.name) + ' — uploaded ' + new Date(d.ahrefsFile.mtime).toLocaleDateString()
    : 'No file uploaded';

  document.getElementById('tab-optimize').innerHTML = `
    <div class="kanban">
      <div class="kanban-col">
        <h3>Pending Review <span class="badge">${pending.length}</span></h3>
        ${pending.map(b => renderBriefCard(b)).join('') || '<div class="empty-state">No pending briefs</div>'}
      </div>
      <div class="kanban-col">
        <h3>Approved <span class="badge">${approved.length}</span></h3>
        ${approved.map(b => renderBriefCard(b)).join('') || '<div class="empty-state">None approved yet</div>'}
      </div>
      <div class="kanban-col">
        <h3>Applied <span class="badge">${applied.length}</span></h3>
        ${applied.map(b => renderBriefCard(b)).join('') || '<div class="empty-state">None applied yet</div>'}
      </div>
    </div>
    <details class="actions-panel">
      <summary>Actions</summary>
      <div class="actions-grid">
        <button onclick="runAgent('agents/competitor-intelligence/index.js')">Run Competitor Intelligence</button>
        <div class="upload-zone">
          <span id="ahrefs-upload-status">${ahrefsStatus}</span>
          <button onclick="uploadAhrefs()">Upload Ahrefs CSV</button>
        </div>
      </div>
      <pre id="run-log-agents-competitor-intelligence-index-js" class="run-log" style="display:none"></pre>
    </details>`;
}

function renderBriefCard(b) {
  const pendingCount  = (b.proposed_changes || []).filter(c => c.status === 'pending').length;
  const approvedCount = (b.proposed_changes || []).filter(c => c.status === 'approved').length;
  const topTV = b.competitors?.[0]?.traffic_value
    ? '$' + ((b.competitors[0].traffic_value) / 100).toLocaleString() : '—';
  return `
    <div class="brief-card" onclick="toggleBriefDetail('${esc(b.slug)}')">
      <div class="brief-card-title">${esc(b.slug)}</div>
      <div class="brief-card-meta">
        <span class="badge-type">${esc(b.page_type)}</span>
        <span>${pendingCount} pending · ${approvedCount} approved</span>
        <span>${topTV}</span>
      </div>
    </div>
    <div id="detail-${esc(b.slug)}" class="brief-detail" style="display:none">
      ${renderBriefDetail(b)}
    </div>`;
}

function toggleBriefDetail(slug) {
  const el = document.getElementById('detail-' + slug);
  if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

function renderBriefDetail(b) {
  const topComp = (b.competitors || []).sort((a, z) => z.traffic_value - a.traffic_value)[0];
  const pair = `
    <div class="screenshot-pair">
      <div>
        <div class="screenshot-label">Your Page</div>
        ${b.store_screenshot
          ? `<img src="/screenshot?path=${encodeURIComponent(b.store_screenshot)}" class="page-screenshot">`
          : '<div class="screenshot-missing">No screenshot</div>'}
      </div>
      <div>
        <div class="screenshot-label">Top Competitor${topComp ? ' (' + esc(topComp.domain) + ')' : ''}</div>
        ${topComp?.screenshot
          ? `<img src="/screenshot?path=${encodeURIComponent(topComp.screenshot)}" class="page-screenshot">`
          : '<div class="screenshot-missing">No screenshot</div>'}
      </div>
    </div>`;

  const changes = (b.proposed_changes || []).map(c => `
    <div class="change-card change-${esc(c.status)}">
      <div class="change-header">
        <span class="change-label">${esc(c.label)}</span>
        <span class="change-status-pill">${esc(c.status)}</span>
      </div>
      <div class="change-diff">
        ${c.type === 'body_html'
          ? `<iframe srcdoc="${esc(c.proposed || '')}" class="html-preview" sandbox=""></iframe>`
          : `<div class="diff-current">${esc(c.current || '—')}</div>
             <div class="diff-proposed">${esc(c.proposed || '')}</div>`}
      </div>
      <div class="change-rationale">${esc(c.rationale || '')}</div>
      ${c.status === 'pending' ? `
        <div class="change-actions">
          <button class="btn-approve" onclick="updateChange('${esc(b.slug)}','${esc(c.id)}','approved')">Approve</button>
          <button class="btn-reject"  onclick="updateChange('${esc(b.slug)}','${esc(c.id)}','rejected')">Reject</button>
        </div>` : ''}
    </div>`).join('');

  const hasApproved = (b.proposed_changes || []).some(c => c.status === 'approved');
  const applyBtn = hasApproved ? `
    <div class="apply-section">
      <button class="btn-apply" onclick="applyBrief('${esc(b.slug)}')">Apply Approved Changes</button>
      <pre id="apply-log-${esc(b.slug)}" class="run-log" style="display:none"></pre>
    </div>` : '';

  return pair + changes + applyBtn;
}

async function updateChange(slug, id, status) {
  await fetch(`/brief/${slug}/change/${id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  loadData(); // re-render with updated brief
}

async function applyBrief(slug) {
  const logEl = document.getElementById('apply-log-' + slug);
  if (logEl) { logEl.style.display = 'block'; logEl.textContent = ''; }
  const res = await fetch(`/apply/${slug}`, { method: 'POST' });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  function read() {
    reader.read().then(({ done, value }) => {
      if (done) { loadData(); return; }
      for (const line of decoder.decode(value).split('\n')) {
        if (line.startsWith('data: ') && logEl) {
          logEl.textContent += line.slice(6) + '\n';
          logEl.scrollTop = logEl.scrollHeight;
        }
      }
      read();
    });
  }
  read();
}
```

- [ ] **Step 6: Add CSS for Optimize tab to the `<style>` block**

```css
.kanban { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1.5rem; margin-bottom: 2rem; }
.kanban-col h3 { font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin-bottom: 1rem; }
.brief-card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 1rem; margin-bottom: 0.75rem; cursor: pointer; transition: border-color 0.15s; }
.brief-card:hover { border-color: var(--indigo); }
.brief-card-title { font-weight: 600; margin-bottom: 0.4rem; font-size: 0.9rem; }
.brief-card-meta { font-size: 0.78rem; color: var(--muted); display: flex; gap: 0.75rem; flex-wrap: wrap; }
.brief-detail { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 1.5rem; margin-bottom: 1rem; }
.screenshot-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 1.5rem; }
.screenshot-label { font-size: 0.78rem; color: var(--muted); margin-bottom: 0.4rem; }
.page-screenshot { width: 100%; border-radius: 6px; border: 1px solid var(--border); }
.screenshot-missing { height: 120px; display: flex; align-items: center; justify-content: center; color: var(--muted); font-size: 0.8rem; border: 1px dashed var(--border); border-radius: 6px; }
.change-card { border: 1px solid var(--border); border-radius: 6px; padding: 1rem; margin-bottom: 0.75rem; }
.change-card.change-approved { border-color: #2ea043; }
.change-card.change-rejected { opacity: 0.5; }
.change-header { display: flex; justify-content: space-between; margin-bottom: 0.5rem; }
.change-label { font-weight: 600; font-size: 0.9rem; }
.change-status-pill { font-size: 0.75rem; padding: 0.15rem 0.5rem; border-radius: 999px; background: var(--border); }
.diff-current { text-decoration: line-through; color: var(--muted); font-size: 0.82rem; }
.diff-proposed { color: #2ea043; font-size: 0.82rem; margin-top: 0.25rem; }
.html-preview { width: 100%; height: 200px; border: 1px solid var(--border); border-radius: 4px; }
.change-rationale { font-size: 0.78rem; color: var(--muted); margin-bottom: 0.5rem; }
.change-actions { display: flex; gap: 0.5rem; }
.btn-approve { background: #2ea043; color: white; border: none; padding: 0.3rem 0.75rem; border-radius: 4px; cursor: pointer; font-size: 0.82rem; }
.btn-reject { background: #da3633; color: white; border: none; padding: 0.3rem 0.75rem; border-radius: 4px; cursor: pointer; font-size: 0.82rem; }
.btn-apply { background: var(--indigo); color: white; border: none; padding: 0.5rem 1.25rem; border-radius: 6px; cursor: pointer; font-weight: 600; }
.apply-section { margin-top: 1rem; }
.badge-type { background: var(--indigo); color: white; font-size: 0.7rem; padding: 0.1rem 0.4rem; border-radius: 4px; }
.upload-zone { display: flex; align-items: center; gap: 0.75rem; font-size: 0.82rem; color: var(--muted); }
.empty-state { color: var(--muted); font-size: 0.85rem; padding: 1rem 0; }
```

- [ ] **Step 7: Wire `renderOptimizeTab` into `loadData()` and `switchTab()`**

In `loadData()`, after the line `renderRankAlertBanner(data.rankAlert);`, add:
```js
if (activeTab === 'optimize') renderOptimizeTab(data);
```

In `switchTab()`, after the line `if (data) renderHeroKpis(data);`, add:
```js
if (name === 'optimize' && data) renderOptimizeTab(data);
```

- [ ] **Step 8: Verify in browser**

```bash
pkill -f "node agents/dashboard/index.js" || true
node agents/dashboard/index.js --open
```

Click "Optimize" tab. Verify: hero KPIs update, three empty kanban columns render, Actions panel at bottom. No JS errors in console.

- [ ] **Step 9: Commit**

```bash
git add agents/dashboard/index.js
git commit -m "feat: dashboard — Optimize tab with kanban, detail view, KPIs, actions panel"
```

---

## Task 10: Full test suite verification + server deploy

- [ ] **Step 1: Run all tests**

```bash
npm test
```

Expected: 27 passing total — ahrefs-parser: 5, rank-alerter: 4, meta-ab-tracker: 3, competitor-intelligence: 12, apply-optimization: 4.

- [ ] **Step 2: Smoke-test agents**

```bash
node agents/apply-optimization/index.js 2>&1 | head -2
node scripts/ahrefs-reminder.js
```

Expected:
- apply agent: `Usage: node agents/apply-optimization/index.js <slug>` (exits with error, which is correct)
- reminder: `Ahrefs reminder sent.` or notify skip message — no crash

- [ ] **Step 3: Push and deploy**

```bash
git push origin main
```

On server:
```bash
cd ~/seo-claude
git pull
npm install  # picks up puppeteer
bash scripts/setup-cron.sh
pkill -f "node agents/dashboard/index.js" || true
nohup npm run dashboard > ~/dashboard.log 2>&1 &
tail -5 ~/dashboard.log
```

- [ ] **Step 4: Commit any post-deploy fixes**

```bash
git add <specific files>
git commit -m "fix: post-deploy corrections"
```
