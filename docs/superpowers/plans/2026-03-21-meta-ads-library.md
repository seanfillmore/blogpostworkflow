# Meta Ads Library Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a competitor ad intelligence pipeline that discovers Meta ads by keyword, scores them for effectiveness, runs Claude analysis, displays them in the dashboard, and packages AI-generated creatives as downloadable ZIPs.

**Architecture:** Five components in sequence — a lib API client, a weekly collector agent, a weekly analyzer agent, four new dashboard endpoints + Ad Intelligence tab, and an on-demand creative packager agent. Data flows one-way: Meta API → raw snapshots → scored insights → dashboard → creative ZIPs.

**Tech Stack:** Node.js ESM, Meta Ads Library API (v21.0), `@anthropic-ai/sdk` (Claude opus-4-6), `@google/genai` (Gemini image generation), `archiver` npm package for ZIP creation, native `node:assert` for tests.

---

## File Map

**New files:**
```
lib/meta-ads-library.js                       — Meta Ads Library API client (pure + async)
agents/meta-ads-collector/index.js            — Weekly cron, fetches + saves raw snapshots
agents/meta-ads-analyzer/index.js             — Scores, filters, runs Claude analysis
agents/creative-packager/index.js             — Gemini creative gen + ZIP packaging
config/meta-ads.json                          — Keywords, page IDs, thresholds
tests/lib/meta-ads-library.test.js            — API client unit tests
tests/agents/meta-ads-collector.test.js       — Collector structural tests
tests/agents/meta-ads-analyzer.test.js        — Analyzer unit tests (scoring, prompts)
tests/agents/creative-packager.test.js        — Packager unit tests (placements, formatting)
tests/agents/dashboard-meta-ads.test.js       — Dashboard structural tests
```

**Modified files:**
```
agents/dashboard/index.js                     — 4 new API routes + Ad Intelligence tab UI
```

**New data directories (created at runtime, not committed):**
```
data/snapshots/meta-ads-library/
data/meta-ads-insights/
data/creative-packages/
data/creative-jobs/
```

**New npm dependency:** `archiver` (not currently installed — added in Task 8)

---

## Task 1: Create feature branch

**Files:** none

- [ ] **Step 1: Create and switch to branch**

```bash
git checkout -b feature/meta-ads-library
```

- [ ] **Step 2: Verify clean branch**

```bash
git status
```
Expected: `On branch feature/meta-ads-library, nothing to commit`

---

## Task 2: Config file

**Files:**
- Create: `config/meta-ads.json`

- [ ] **Step 1: Create config**

```json
{
  "searchCountry": "US",
  "searchKeywords": ["natural deodorant", "aluminum free deodorant", "natural skincare"],
  "trackedPageIds": [],
  "effectivenessMinDays": 14,
  "effectivenessMinVariations": 3
}
```

- [ ] **Step 2: Commit**

```bash
git add config/meta-ads.json
git commit -m "feat: add meta-ads config file"
```

---

## Task 3: Meta Ads Library API client

**Files:**
- Create: `lib/meta-ads-library.js`
- Create: `tests/lib/meta-ads-library.test.js`

The lib exports pure URL-building helpers (testable without network) and async search functions. Auth reads `META_APP_ACCESS_TOKEN` from `.env` at load time, same pattern as `lib/google-ads.js`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/lib/meta-ads-library.test.js
import { strict as assert } from 'node:assert';
import {
  buildAdArchiveUrl,
  slugifyPageName,
  extractNextCursor,
} from '../../lib/meta-ads-library.js';

// buildAdArchiveUrl — keyword search URL
{
  const url = buildAdArchiveUrl({
    searchTerms: 'natural deodorant',
    adReachedCountries: ['US'],
    after: null,
  });
  assert.ok(url.includes('ads_archive'), 'must target ads_archive endpoint');
  assert.ok(url.includes('search_terms=natural+deodorant') || url.includes('search_terms=natural%20deodorant'), 'must include search terms');
  assert.ok(url.includes('ad_reached_countries'), 'must include country filter');
  assert.ok(url.includes('ad_delivery_start_time'), 'must request start time field');
  assert.ok(url.includes('ad_snapshot_url'), 'must request snapshot URL field');
}

// buildAdArchiveUrl — page ID search URL
{
  const url = buildAdArchiveUrl({ searchPageIds: ['123456789'], adReachedCountries: ['US'], after: null });
  assert.ok(url.includes('search_page_ids=123456789'), 'must include page ID filter');
}

// buildAdArchiveUrl — pagination cursor
{
  const url = buildAdArchiveUrl({ searchTerms: 'test', adReachedCountries: ['US'], after: 'cursor123' });
  assert.ok(url.includes('after=cursor123'), 'must include cursor for pagination');
}

// buildAdArchiveUrl — requests plural field names (what Meta API expects)
{
  const url = buildAdArchiveUrl({ searchTerms: 'test', adReachedCountries: ['US'], after: null });
  assert.ok(url.includes('ad_creative_bodies'), 'must request plural bodies field');
  assert.ok(url.includes('ad_creative_link_titles'), 'must request plural titles field');
  assert.ok(url.includes('ad_delivery_start_time'), 'must request start time');
  assert.ok(url.includes('ad_delivery_stop_time'), 'must request stop time');
}

// normalizeAd — maps plural array fields to singular string fields in output
{
  const { normalizeAd } = await import('../../lib/meta-ads-library.js');
  const raw = {
    id: 'ad1', page_id: 'p1', page_name: 'Dove',
    ad_delivery_start_time: '2026-01-01', ad_delivery_stop_time: null,
    ad_creative_bodies: ['First body', 'Second body'],
    ad_creative_link_titles: ['First title'],
    ad_creative_link_descriptions: ['First desc'],
    ad_snapshot_url: 'https://meta.com/snapshot/1',
    publisher_platforms: ['instagram'],
  };
  const normalized = normalizeAd(raw);
  assert.equal(normalized.ad_creative_body, 'First body', 'must extract [0] from bodies array');
  assert.equal(normalized.ad_creative_link_title, 'First title', 'must extract [0] from titles array');
  assert.equal(normalized.ad_creative_link_description, 'First desc', 'must extract [0] from descriptions array');
  assert.equal(normalized.page_slug, 'dove', 'must slugify page name');
  // Confirm singular field names in output (not plural)
  assert.ok(!('ad_creative_bodies' in normalized), 'output must not contain plural bodies');
}

// normalizeAd — handles missing array fields gracefully
{
  const { normalizeAd } = await import('../../lib/meta-ads-library.js');
  const raw = { id: 'ad2', page_id: 'p2', page_name: 'Brand' };
  const normalized = normalizeAd(raw);
  assert.equal(normalized.ad_creative_body, '', 'missing bodies → empty string');
  assert.deepEqual(normalized.publisher_platforms, [], 'missing platforms → empty array');
}

// slugifyPageName
assert.equal(slugifyPageName("Dr. Squatch Men's Soap"), 'dr-squatch-mens-soap');
assert.equal(slugifyPageName('Nécessaire'), 'ncessaire');
assert.equal(slugifyPageName('Dove Men+Care'), 'dove-men-care');
assert.equal(slugifyPageName('  spaces  '), 'spaces');

// extractNextCursor — present
{
  const body = { paging: { cursors: { after: 'abc123' }, next: 'https://example.com' } };
  assert.equal(extractNextCursor(body), 'abc123');
}

// extractNextCursor — absent (no next page)
{
  const body = { paging: { cursors: { after: 'abc123' } } };
  assert.equal(extractNextCursor(body), null);
}

// extractNextCursor — no paging key
assert.equal(extractNextCursor({}), null);

console.log('✓ meta-ads-library unit tests pass');
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --test tests/lib/meta-ads-library.test.js
```
Expected: `Error: Cannot find module` or assertion failures

- [ ] **Step 3: Implement `lib/meta-ads-library.js`**

```js
/**
 * Meta Ads Library API client
 *
 * Auth: META_APP_ACCESS_TOKEN=APP_ID|APP_SECRET in .env
 * No OAuth flow required — app access token works for the Ads Library API.
 *
 * Exports:
 *   searchByKeyword(term, country)  → Ad[]
 *   searchByPageId(pageId)          → Ad[]
 *   buildAdArchiveUrl(params)       — pure, testable
 *   slugifyPageName(name)           — pure, testable
 *   extractNextCursor(body)         — pure, testable
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
const ACCESS_TOKEN = env.META_APP_ACCESS_TOKEN || process.env.META_APP_ACCESS_TOKEN || '';

const AD_FIELDS = [
  'id',
  'page_id',
  'page_name',
  'ad_delivery_start_time',
  'ad_delivery_stop_time',
  'ad_creative_bodies',
  'ad_creative_link_titles',
  'ad_creative_link_descriptions',
  'ad_snapshot_url',
  'publisher_platforms',
].join(',');

const BASE_URL = 'https://graph.facebook.com/v21.0/ads_archive';

// ── Pure helpers ───────────────────────────────────────────────────────────────

export function slugifyPageName(name) {
  return (name || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function buildAdArchiveUrl({ searchTerms, searchPageIds, adReachedCountries, after }) {
  const params = new URLSearchParams();
  params.set('access_token', ACCESS_TOKEN);
  params.set('fields', AD_FIELDS);
  params.set('ad_reached_countries', JSON.stringify(adReachedCountries || ['US']));
  params.set('ad_active_status', 'ALL');
  if (searchTerms) params.set('search_terms', searchTerms);
  if (searchPageIds) params.set('search_page_ids', searchPageIds.join(','));
  if (after) params.set('after', after);
  params.set('limit', '100');
  return `${BASE_URL}?${params.toString()}`;
}

export function extractNextCursor(body) {
  if (!body?.paging?.next) return null;
  return body?.paging?.cursors?.after || null;
}

// Normalize ad fields — Meta returns arrays for creative fields
export function normalizeAd(raw) {
  return {
    id: raw.id,
    page_id: raw.page_id,
    page_name: raw.page_name || '',
    page_slug: slugifyPageName(raw.page_name || ''),
    ad_delivery_start_time: raw.ad_delivery_start_time || null,
    ad_delivery_stop_time: raw.ad_delivery_stop_time || null,
    ad_creative_body: (raw.ad_creative_bodies || [])[0] || '',
    ad_creative_link_title: (raw.ad_creative_link_titles || [])[0] || '',
    ad_creative_link_description: (raw.ad_creative_link_descriptions || [])[0] || '',
    ad_snapshot_url: raw.ad_snapshot_url || '',
    publisher_platforms: raw.publisher_platforms || [],
  };
}

// ── Async API calls ────────────────────────────────────────────────────────────

async function fetchAllPages(firstUrl) {
  if (!ACCESS_TOKEN) throw new Error('META_APP_ACCESS_TOKEN not set in .env');
  const ads = [];
  let url = firstUrl;
  while (url) {
    const res = await fetch(url);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Meta Ads Library API error ${res.status}: ${text}`);
    }
    const body = await res.json();
    if (body.error) throw new Error(`Meta Ads Library API error: ${body.error.message}`);
    for (const raw of (body.data || [])) ads.push(normalizeAd(raw));
    const cursor = extractNextCursor(body);
    url = cursor ? buildAdArchiveUrl({ after: cursor }) : null;
    // Safety: stop at 500 ads per search to avoid runaway pagination
    if (ads.length >= 500) break;
  }
  return ads;
}

export async function searchByKeyword(term, country = 'US') {
  const url = buildAdArchiveUrl({ searchTerms: term, adReachedCountries: [country], after: null });
  return fetchAllPages(url);
}

export async function searchByPageId(pageId) {
  const url = buildAdArchiveUrl({ searchPageIds: [pageId], adReachedCountries: ['US'], after: null });
  return fetchAllPages(url);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --test tests/lib/meta-ads-library.test.js
```
Expected: `✓ meta-ads-library unit tests pass`

- [ ] **Step 5: Commit**

```bash
git add lib/meta-ads-library.js tests/lib/meta-ads-library.test.js
git commit -m "feat: add Meta Ads Library API client"
```

---

## Task 4: Collector agent

**Files:**
- Create: `agents/meta-ads-collector/index.js`
- Create: `tests/agents/meta-ads-collector.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// tests/agents/meta-ads-collector.test.js
import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';

// File existence
assert.ok(existsSync('agents/meta-ads-collector/index.js'), 'agent file missing');

// Structural checks
const src = readFileSync('agents/meta-ads-collector/index.js', 'utf8');
assert.ok(src.includes('meta-ads-library'), 'must import meta-ads-library');
assert.ok(src.includes('config/meta-ads.json') || src.includes("'meta-ads'"), 'must load meta-ads config');
assert.ok(src.includes('searchByKeyword'), 'must call searchByKeyword');
assert.ok(src.includes('searchByPageId'), 'must call searchByPageId');
assert.ok(src.includes('snapshots/meta-ads-library'), 'must write to correct snapshot dir');
assert.ok(src.includes('notify'), 'must call notify');
assert.ok(src.includes('--date'), 'must support --date arg for smoke-testing specific dates');

console.log('✓ meta-ads-collector structural tests pass');
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --test tests/agents/meta-ads-collector.test.js
```
Expected: `agent file missing`

- [ ] **Step 3: Implement collector**

```js
// agents/meta-ads-collector/index.js
/**
 * Meta Ads Collector
 *
 * Fetches active ads from Meta Ads Library for configured keywords and page IDs.
 * Saves a raw snapshot to data/snapshots/meta-ads-library/YYYY-MM-DD.json.
 *
 * Usage:
 *   node agents/meta-ads-collector/index.js
 *   node agents/meta-ads-collector/index.js --date 2026-03-18
 */

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchByKeyword, searchByPageId } from '../../lib/meta-ads-library.js';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SNAPSHOTS_DIR = join(ROOT, 'data', 'snapshots', 'meta-ads-library');

function loadConfig() {
  return JSON.parse(readFileSync(join(ROOT, 'config', 'meta-ads.json'), 'utf8'));
}

function todayPT() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

async function main() {
  const dateArg = process.argv.find(a => a.startsWith('--date='))?.split('=')[1]
    ?? (process.argv.includes('--date') ? process.argv[process.argv.indexOf('--date') + 1] : null);
  const date = dateArg || todayPT();

  console.log('Meta Ads Collector\n');
  console.log(`  Date: ${date}`);

  const cfg = loadConfig();
  const { searchCountry = 'US', searchKeywords = [], trackedPageIds = [] } = cfg;

  const allAds = [];
  const seen = new Set();

  function addAds(ads) {
    for (const ad of ads) {
      if (!seen.has(ad.id)) { seen.add(ad.id); allAds.push(ad); }
    }
  }

  for (const term of searchKeywords) {
    process.stdout.write(`  Searching: "${term}"... `);
    const ads = await searchByKeyword(term, searchCountry);
    addAds(ads);
    console.log(`${ads.length} ads`);
  }

  for (const pageId of trackedPageIds) {
    process.stdout.write(`  Page ID: ${pageId}... `);
    const ads = await searchByPageId(pageId);
    addAds(ads);
    console.log(`${ads.length} ads`);
  }

  console.log(`  Total unique ads: ${allAds.length}`);

  mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  const outPath = join(SNAPSHOTS_DIR, `${date}.json`);
  writeFileSync(outPath, JSON.stringify({ date, ads: allAds }, null, 2));
  console.log(`  Saved: ${outPath}`);
}

main()
  .then(async () => {
    await notify({ subject: 'Meta Ads Collector completed', body: 'Snapshot saved', status: 'success' }).catch(() => {});
  })
  .catch(async err => {
    await notify({ subject: 'Meta Ads Collector failed', body: err.message, status: 'error' }).catch(() => {});
    console.error('Error:', err.message);
    process.exit(1);
  });
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --test tests/agents/meta-ads-collector.test.js
```
Expected: `✓ meta-ads-collector structural tests pass`

- [ ] **Step 5: Commit**

```bash
git add agents/meta-ads-collector/index.js tests/agents/meta-ads-collector.test.js
git commit -m "feat: add meta-ads-collector agent"
```

---

## Task 5: Analyzer — pure exports

**Files:**
- Create: `agents/meta-ads-analyzer/index.js` (pure exports only in this task)
- Create: `tests/agents/meta-ads-analyzer.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// tests/agents/meta-ads-analyzer.test.js
import { strict as assert } from 'node:assert';
import {
  computeLongevityDays,
  computeEffectivenessScore,
  meetsFilter,
  buildPass1Prompt,
  buildPass2Prompt,
  parsePass1Response,
  parsePass2Response,
} from '../../agents/meta-ads-analyzer/index.js';

// computeLongevityDays — still running ad
{
  const ad = { ad_delivery_start_time: '2026-02-19', ad_delivery_stop_time: null };
  const days = computeLongevityDays(ad, '2026-03-21');
  assert.equal(days, 30, 'should be 30 days running');
}

// computeLongevityDays — stopped ad returns 0
{
  const ad = { ad_delivery_start_time: '2026-02-01', ad_delivery_stop_time: '2026-03-01' };
  assert.equal(computeLongevityDays(ad, '2026-03-21'), 0, 'stopped ad = 0 longevity');
}

// computeLongevityDays — cap at 60
{
  const ad = { ad_delivery_start_time: '2025-01-01', ad_delivery_stop_time: null };
  assert.equal(computeLongevityDays(ad, '2026-03-21'), 60, 'capped at 60');
}

// computeLongevityDays — cap at 60 (ad running for 90 days)
{
  const ad = { ad_delivery_start_time: '2025-12-21', ad_delivery_stop_time: null };
  assert.equal(computeLongevityDays(ad, '2026-03-21'), 60, 'must cap at 60 days');
}

// computeLongevityDays — null start_time
{
  const ad = { ad_delivery_start_time: null, ad_delivery_stop_time: null };
  assert.equal(computeLongevityDays(ad, '2026-03-21'), 0);
}

// computeEffectivenessScore
assert.equal(computeEffectivenessScore(30, 4), 38, '30 + (4 × 2) = 38');
assert.equal(computeEffectivenessScore(0, 5), 10, '0 + (5 × 2) = 10');
assert.equal(computeEffectivenessScore(60, 0), 60, 'longevity only');

// meetsFilter
assert.equal(meetsFilter(20, 1, 14, 3), true, 'longevity threshold met');
assert.equal(meetsFilter(5, 4, 14, 3), true, 'variation threshold met');
assert.equal(meetsFilter(10, 2, 14, 3), false, 'neither threshold met');
assert.equal(meetsFilter(14, 3, 14, 3), true, 'exactly at both thresholds');

// buildPass1Prompt — contains required fields
{
  const prompt = buildPass1Prompt('123', 'Dove', [
    { id: 'a1', body: 'natural deodorant', title: 'Shop now', description: 'Free of aluminum' },
  ]);
  assert.ok(typeof prompt === 'string');
  assert.ok(prompt.includes('Dove'), 'must include brand name');
  assert.ok(prompt.includes('natural deodorant'), 'must include ad body');
  assert.ok(prompt.includes('themes'), 'must instruct to return themes');
}

// buildPass2Prompt — contains required fields
{
  const ad = {
    pageName: 'Dove',
    adCreativeBody: 'Stay fresh naturally',
    adCreativeLinkTitle: 'Shop Now',
    adCreativeLinkDescription: 'Aluminum-free',
    longevityDays: 30,
    variationCount: 4,
    publisherPlatforms: ['instagram', 'facebook'],
  };
  const prompt = buildPass2Prompt(ad);
  assert.ok(prompt.includes('Dove'));
  assert.ok(prompt.includes('30'));
  assert.ok(prompt.includes('instagram'));
  assert.ok(prompt.includes('headline'), 'must instruct to return headline');
  assert.ok(prompt.includes('messagingAngle'), 'must instruct to return messagingAngle');
}

// parsePass1Response — valid JSON
{
  const raw = JSON.stringify({ themes: [{ theme: 'deodorant', adIds: ['a1', 'a2'] }] });
  const result = parsePass1Response(raw);
  assert.deepEqual(result.themes[0].adIds, ['a1', 'a2']);
}

// parsePass1Response — strips markdown fences
{
  const raw = '```json\n{"themes":[{"theme":"soap","adIds":["b1"]}]}\n```';
  const result = parsePass1Response(raw);
  assert.equal(result.themes[0].theme, 'soap');
}

// parsePass2Response — valid JSON
{
  const raw = JSON.stringify({
    headline: 'Why this works', messagingAngle: 'Social proof',
    whyEffective: 'Because...', targetAudience: 'Women 25-45',
    keyTechniques: ['urgency'], copyInsights: 'Strong CTA',
  });
  const result = parsePass2Response(raw);
  assert.equal(result.headline, 'Why this works');
}

console.log('✓ meta-ads-analyzer unit tests pass');
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --test tests/agents/meta-ads-analyzer.test.js
```
Expected: `Error: Cannot find module` or assertion failures

- [ ] **Step 3: Implement pure exports in analyzer**

```js
// agents/meta-ads-analyzer/index.js
/**
 * Meta Ads Analyzer
 *
 * Reads last 4 weeks of meta-ads-library snapshots, scores ads for effectiveness,
 * runs Claude analysis on qualifying ads, writes data/meta-ads-insights/YYYY-MM-DD.json.
 *
 * Usage:
 *   node agents/meta-ads-analyzer/index.js
 *   node agents/meta-ads-analyzer/index.js --dry-run
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ── Pure exports ───────────────────────────────────────────────────────────────

export function computeLongevityDays(ad, snapshotDate) {
  if (!ad.ad_delivery_start_time) return 0;
  if (ad.ad_delivery_stop_time) return 0; // stopped ad
  const start = new Date(ad.ad_delivery_start_time);
  const snap  = new Date(snapshotDate);
  const days  = Math.floor((snap - start) / 86400000);
  return Math.min(Math.max(days, 0), 60);
}

export function computeEffectivenessScore(longevityDays, variationCount) {
  return longevityDays + (variationCount * 2);
}

export function meetsFilter(longevityDays, variationCount, minDays, minVariations) {
  return longevityDays >= minDays || variationCount >= minVariations;
}

export function buildPass1Prompt(pageId, pageName, ads) {
  return `You are categorizing ads from a single brand by product/theme to identify creative variations.

Brand: ${pageName} (page ID: ${pageId})
Ads (${ads.length} total):
${JSON.stringify(ads, null, 2)}

Group these ads by product/theme. Each group should represent the same product being advertised with different copy angles. Do not group unrelated products together.

Return ONLY valid JSON (no markdown):
{
  "themes": [
    { "theme": "short product/angle label e.g. natural deodorant stick", "adIds": ["id1", "id2"] }
  ]
}`;
}

export function buildPass2Prompt(ad) {
  return `You are a paid advertising analyst. Analyze this Meta ad and explain why it is effective.

Brand: ${ad.pageName}
Body: ${ad.adCreativeBody || '(none)'}
Title: ${ad.adCreativeLinkTitle || '(none)'}
Description: ${ad.adCreativeLinkDescription || '(none)'}
Running for: ${ad.longevityDays} days (still active)
Creative variations from this brand: ${ad.variationCount}
Platforms: ${(ad.publisherPlatforms || []).join(', ')}

Return ONLY valid JSON (no markdown):
{
  "headline": "one-line summary of why this ad is working",
  "messagingAngle": "e.g. Ingredient transparency, Social proof, Problem/solution",
  "whyEffective": "2-3 sentences citing specific copy choices and the longevity/variation signals",
  "targetAudience": "who this ad is clearly aimed at",
  "keyTechniques": ["technique 1", "technique 2"],
  "copyInsights": "what makes the specific copy work: word choices, structure, CTA"
}`;
}

export function parsePass1Response(raw) {
  const cleaned = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
  return JSON.parse(cleaned);
}

export function parsePass2Response(raw) {
  const cleaned = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
  return JSON.parse(cleaned);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --test tests/agents/meta-ads-analyzer.test.js
```
Expected: `✓ meta-ads-analyzer unit tests pass`

- [ ] **Step 5: Commit**

```bash
git add agents/meta-ads-analyzer/index.js tests/agents/meta-ads-analyzer.test.js
git commit -m "feat: add meta-ads-analyzer pure exports and tests"
```

---

## Task 6: Analyzer — main() function

**Files:**
- Modify: `agents/meta-ads-analyzer/index.js` (append main logic)

- [ ] **Step 1: Append the main function to the analyzer**

The analyzer supports `--dry-run` (prints qualifying ads without calling Claude — used for smoke testing in Task 12). This flag is parsed in the main function below.

Add this after the pure exports in `agents/meta-ads-analyzer/index.js`:

```js
// ── Data loading ───────────────────────────────────────────────────────────────

function loadEnv() {
  try {
    const lines = readFileSync(join(ROOT, '.env'), 'utf8').split('\n');
    const e = {};
    for (const l of lines) {
      const t = l.trim(); if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('='); if (i === -1) continue;
      e[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
    return e;
  } catch { return {}; }
}

function loadRecentSnapshots(dir, weeks = 4) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort().reverse()
    .slice(0, weeks * 7) // up to weeks × 7 files (daily would be overkill; keep last N)
    .map(f => { try { return JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { return null; } })
    .filter(Boolean);
}

function deduplicateAds(snapshots) {
  const seen = new Set();
  const ads = [];
  for (const snap of snapshots) {
    for (const ad of (snap.ads || [])) {
      if (!seen.has(ad.id)) { seen.add(ad.id); ads.push({ ...ad, _snapshotDate: snap.date }); }
    }
  }
  return ads;
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const isDryRun = process.argv.includes('--dry-run');
  console.log('Meta Ads Analyzer' + (isDryRun ? ' (dry run)' : '') + '\n');

  const env = loadEnv();
  const apiKey = env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Missing ANTHROPIC_API_KEY');

  const cfg = JSON.parse(readFileSync(join(ROOT, 'config', 'meta-ads.json'), 'utf8'));
  const { effectivenessMinDays = 14, effectivenessMinVariations = 3 } = cfg;

  const snapsDir = join(ROOT, 'data', 'snapshots', 'meta-ads-library');
  const snapshots = loadRecentSnapshots(snapsDir, 4);
  if (!snapshots.length) {
    console.log('No snapshots found — run meta-ads-collector first.');
    return;
  }

  const allAds = deduplicateAds(snapshots);
  console.log(`  Loaded ${allAds.length} unique ads from ${snapshots.length} snapshots`);

  // Group ads by page_id
  const byPage = new Map();
  for (const ad of allAds) {
    if (!byPage.has(ad.page_id)) byPage.set(ad.page_id, []);
    byPage.get(ad.page_id).push(ad);
  }

  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });

  // Pass 1 — variation grouping per brand
  // variationCountByPage: Map<pageId, number> — brand-level count, looked up per ad during scoring
  // Rules:
  //   - Brand with exactly 1 ad: skip Pass 1, variationCount = 1
  //   - Brand with 2+ ads, Claude succeeds: variationCount = max theme group size
  //   - Brand with 2+ ads, Claude fails: variationCount = total ad count for that brand (fallback)
  const variationCountByPage = new Map();
  for (const [pageId, ads] of byPage) {
    if (ads.length < 2) { variationCountByPage.set(pageId, 1); continue; }
    try {
      const prompt = buildPass1Prompt(pageId, ads[0].page_name, ads.map(a => ({
        id: a.id, body: a.ad_creative_body, title: a.ad_creative_link_title, description: a.ad_creative_link_description,
      })));
      const response = await client.messages.create({
        model: 'claude-opus-4-6', max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      });
      const result = parsePass1Response(response.content[0].text);
      const maxThemeSize = Math.max(...(result.themes || []).map(t => t.adIds?.length || 0), 1);
      variationCountByPage.set(pageId, maxThemeSize);
    } catch (e) {
      console.warn(`  [pass1] ${ads[0].page_name}: ${e.message} — falling back to total ad count (${ads.length})`);
      variationCountByPage.set(pageId, ads.length); // fallback: total ads for this brand
    }
  }
  // After Pass 1: variationCountByPage is fully populated.
  // Each ad is scored using its brand's count: variationCount = variationCountByPage.get(ad.page_id)

  // Score and filter
  const today = snapshots[0].date;
  const scoredAds = allAds.map(ad => {
    const longevityDays = computeLongevityDays(ad, today);
    const variationCount = variationCountByPage.get(ad.page_id) || 1;
    const effectivenessScore = computeEffectivenessScore(longevityDays, variationCount);
    return { ...ad, longevityDays, variationCount, effectivenessScore };
  }).filter(ad => meetsFilter(ad.longevityDays, ad.variationCount, effectivenessMinDays, effectivenessMinVariations));

  console.log(`  Qualifying ads: ${scoredAds.length}`);

  if (isDryRun) {
    scoredAds.slice(0, 5).forEach(a => console.log(`  [dry-run] ${a.page_name} score=${a.effectivenessScore}`));
    return;
  }

  // Pass 2 — Claude analysis per qualifying ad
  const analyzedAds = [];
  for (const ad of scoredAds) {
    try {
      const prompt = buildPass2Prompt({
        pageName: ad.page_name,
        adCreativeBody: ad.ad_creative_body,
        adCreativeLinkTitle: ad.ad_creative_link_title,
        adCreativeLinkDescription: ad.ad_creative_link_description,
        longevityDays: ad.longevityDays,
        variationCount: ad.variationCount,
        publisherPlatforms: ad.publisher_platforms,
      });
      const response = await client.messages.create({
        model: 'claude-opus-4-6', max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      });
      const analysis = parsePass2Response(response.content[0].text);
      analyzedAds.push({
        id: ad.id, pageId: ad.page_id, pageName: ad.page_name, pageSlug: ad.page_slug,
        adCreativeBody: ad.ad_creative_body, adCreativeLinkTitle: ad.ad_creative_link_title,
        adSnapshotUrl: ad.ad_snapshot_url, publisherPlatforms: ad.publisher_platforms,
        longevityDays: ad.longevityDays, variationCount: ad.variationCount,
        effectivenessScore: ad.effectivenessScore, analysis,
      });
    } catch (e) {
      console.warn(`  [pass2] ${ad.page_name} (${ad.id}): ${e.message}`);
      analyzedAds.push({
        id: ad.id, pageId: ad.page_id, pageName: ad.page_name, pageSlug: ad.page_slug,
        adCreativeBody: ad.ad_creative_body, adCreativeLinkTitle: ad.ad_creative_link_title,
        adSnapshotUrl: ad.ad_snapshot_url, publisherPlatforms: ad.publisher_platforms,
        longevityDays: ad.longevityDays, variationCount: ad.variationCount,
        effectivenessScore: ad.effectivenessScore, analysis: null,
      });
    }
  }

  analyzedAds.sort((a, b) => b.effectivenessScore - a.effectivenessScore);

  const outDir = join(ROOT, 'data', 'meta-ads-insights');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${today}.json`);
  writeFileSync(outPath, JSON.stringify({ date: today, ads: analyzedAds }, null, 2));
  console.log(`  Saved: ${outPath} (${analyzedAds.length} ads)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { notify } = await import('../../lib/notify.js');
  main()
    .then(() => notify({ subject: 'Meta Ads Analyzer completed', body: 'Insights saved', status: 'success' }).catch(() => {}))
    .catch(async err => {
      await notify({ subject: 'Meta Ads Analyzer failed', body: err.message, status: 'error' }).catch(() => {});
      console.error('Error:', err.message);
      process.exit(1);
    });
}
```

- [ ] **Step 2: Verify existing tests still pass**

```bash
node --test tests/agents/meta-ads-analyzer.test.js
```
Expected: `✓ meta-ads-analyzer unit tests pass`

- [ ] **Step 3: Commit**

```bash
git add agents/meta-ads-analyzer/index.js
git commit -m "feat: add meta-ads-analyzer main() with two-pass Claude analysis"
```

---

## Task 7: Creative packager — pure exports

**Files:**
- Create: `agents/creative-packager/index.js` (pure exports only)
- Create: `tests/agents/creative-packager.test.js`

- [ ] **Step 1: Write failing tests**

```js
// tests/agents/creative-packager.test.js
import { strict as assert } from 'node:assert';
import {
  placementSizes,
  formatCopyFile,
  formatSpecsFile,
  buildStylePrompt,
} from '../../agents/creative-packager/index.js';

// placementSizes — instagram only
{
  const sizes = placementSizes(['instagram']);
  const keys = sizes.map(s => s.name);
  assert.ok(keys.includes('instagram-feed-1080x1080'), 'must include instagram feed square');
  assert.ok(keys.includes('instagram-feed-1080x1350'), 'must include instagram feed portrait');
  assert.ok(keys.includes('instagram-stories-1080x1920'), 'must include instagram stories');
  assert.ok(!keys.some(k => k.startsWith('facebook')), 'must not include facebook if not in platforms');
}

// placementSizes — facebook only
{
  const sizes = placementSizes(['facebook']);
  const keys = sizes.map(s => s.name);
  assert.ok(keys.includes('facebook-feed-1200x628'), 'must include facebook feed landscape');
  assert.ok(keys.includes('facebook-feed-1080x1080'), 'must include facebook feed square');
  assert.ok(keys.includes('facebook-stories-1080x1920'), 'must include facebook stories');
  assert.ok(!keys.some(k => k.startsWith('instagram')), 'must not include instagram');
}

// placementSizes — both platforms
{
  const sizes = placementSizes(['facebook', 'instagram']);
  const keys = sizes.map(s => s.name);
  assert.ok(keys.some(k => k.startsWith('facebook')));
  assert.ok(keys.some(k => k.startsWith('instagram')));
}

// placementSizes — unknown platform (graceful empty)
{
  const sizes = placementSizes(['audience_network']);
  assert.ok(Array.isArray(sizes));
}

// placementSizes — each size has width and height
{
  for (const s of placementSizes(['instagram', 'facebook'])) {
    assert.ok(typeof s.width === 'number', `${s.name} missing width`);
    assert.ok(typeof s.height === 'number', `${s.name} missing height`);
  }
}

// formatCopyFile
{
  const variations = [
    { headline: 'H1', body: 'B1', cta: 'CTA1', placement: 'instagram-feed' },
    { headline: 'H2', body: 'B2', cta: 'CTA2', placement: 'facebook-feed' },
  ];
  const text = formatCopyFile(variations);
  assert.ok(text.includes('H1'));
  assert.ok(text.includes('B2'));
  assert.ok(text.includes('Variation'));
}

// formatSpecsFile
{
  const sizes = placementSizes(['instagram']);
  const text = formatSpecsFile(sizes);
  assert.ok(text.includes('1080'));
  assert.ok(text.includes('instagram'));
  assert.ok(text.includes('px') || text.includes('×') || text.includes('x'));
}

// buildStylePrompt — contains key instructions
{
  const ad = {
    adCreativeBody: 'Stay fresh all day',
    adCreativeLinkTitle: 'Shop now',
    analysis: { messagingAngle: 'Social proof', whyEffective: 'Because...' },
  };
  const prompt = buildStylePrompt(ad);
  assert.ok(prompt.includes('Stay fresh all day'));
  assert.ok(prompt.includes('Gemini'));
  assert.ok(prompt.includes('mood') || prompt.includes('color') || prompt.includes('style'));
}

console.log('✓ creative-packager unit tests pass');
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --test tests/agents/creative-packager.test.js
```
Expected: assertion failures

- [ ] **Step 3: Implement pure exports**

```js
// agents/creative-packager/index.js
/**
 * Creative Packager
 *
 * Triggered on-demand by dashboard POST /api/generate-creative.
 * Reads job spec, generates Gemini creatives, writes ZIP to data/creative-packages/.
 *
 * Usage:
 *   node agents/creative-packager/index.js --job-id <jobId>
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, createReadStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ── Pure exports ───────────────────────────────────────────────────────────────

const PLACEMENT_MAP = {
  instagram: [
    { name: 'instagram-feed-1080x1080',    width: 1080, height: 1080, label: 'Instagram Feed (Square)' },
    { name: 'instagram-feed-1080x1350',    width: 1080, height: 1350, label: 'Instagram Feed (Portrait)' },
    { name: 'instagram-stories-1080x1920', width: 1080, height: 1920, label: 'Instagram Stories / Reels' },
  ],
  facebook: [
    { name: 'facebook-feed-1200x628',    width: 1200, height: 628,  label: 'Facebook Feed (Landscape)' },
    { name: 'facebook-feed-1080x1080',   width: 1080, height: 1080, label: 'Facebook Feed (Square)' },
    { name: 'facebook-stories-1080x1920', width: 1080, height: 1920, label: 'Facebook Stories' },
  ],
};

export function placementSizes(publisherPlatforms) {
  const sizes = [];
  for (const platform of publisherPlatforms) {
    if (PLACEMENT_MAP[platform]) sizes.push(...PLACEMENT_MAP[platform]);
  }
  return sizes;
}

export function formatCopyFile(variations) {
  const lines = ['META AD COPY VARIATIONS', '========================', ''];
  variations.forEach((v, i) => {
    lines.push(`Variation ${i + 1} — ${v.placement || 'General'}`);
    lines.push(`Headline: ${v.headline}`);
    lines.push(`Body: ${v.body}`);
    lines.push(`CTA: ${v.cta}`);
    lines.push('');
  });
  return lines.join('\n');
}

export function formatSpecsFile(sizes) {
  const lines = ['AD PLACEMENT SPECIFICATIONS', '==========================', ''];
  for (const s of sizes) {
    lines.push(`${s.label}`);
    lines.push(`  Size: ${s.width} × ${s.height} px`);
    lines.push(`  File: ${s.name}.webp`);
    lines.push(`  Headline limit: 40 characters`);
    lines.push(`  Body limit: 125 characters`);
    lines.push('');
  }
  return lines.join('\n');
}

export function buildStylePrompt(ad) {
  return `You are a creative director preparing a brief for Gemini image generation.

Analyze this Meta ad and write a detailed image generation prompt that captures its visual style for a new ad creative.

Ad copy:
- Body: ${ad.adCreativeBody || '(none)'}
- Title: ${ad.adCreativeLinkTitle || '(none)'}
- Messaging angle: ${ad.analysis?.messagingAngle || 'unknown'}
- Why effective: ${ad.analysis?.whyEffective || 'unknown'}

Write a Gemini image generation prompt that:
1. Describes the mood and aesthetic (e.g., "clean, minimal, bright natural light")
2. Describes the color palette
3. Describes the composition and how the product should be featured
4. Describes the background and setting
5. Describes the lighting style
6. Specifies NOT to include any text, logos, or labels in the generated image

Return only the image prompt as plain text — no JSON, no explanation.`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --test tests/agents/creative-packager.test.js
```
Expected: `✓ creative-packager unit tests pass`

- [ ] **Step 5: Commit**

```bash
git add agents/creative-packager/index.js tests/agents/creative-packager.test.js
git commit -m "feat: add creative-packager pure exports and tests"
```

---

## Task 8: Creative packager — main() function

**Files:**
- Modify: `agents/creative-packager/index.js` (append main logic)

`archiver` is not currently installed (confirmed). The spec incorrectly stated "No new npm packages required" — this plan overrides that. Install it now before writing the main function.

- [ ] **Step 1: Install archiver**

```bash
npm install archiver
```

Expected: `added 1 package` (or similar). Verify:

```bash
node -e "import('archiver').then(() => console.log('✓ archiver installed')).catch(e => console.error(e))"
```

- [ ] **Step 2: Append main function to `agents/creative-packager/index.js`**

```js
// ── Job file helpers ───────────────────────────────────────────────────────────

function loadEnv() {
  try {
    const lines = readFileSync(join(ROOT, '.env'), 'utf8').split('\n');
    const e = {};
    for (const l of lines) {
      const t = l.trim(); if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('='); if (i === -1) continue;
      e[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
    return e;
  } catch { return {}; }
}

function writeJobStatus(jobPath, updates) {
  const current = existsSync(jobPath)
    ? JSON.parse(readFileSync(jobPath, 'utf8')) : {};
  writeFileSync(jobPath, JSON.stringify({ ...current, ...updates }, null, 2));
}

async function generateImage(gemini, prompt, productImagePaths) {
  const { createPartFromUri, createUserContent } = await import('@google/genai');
  const contents = [];

  // Add product reference images
  for (const imgPath of productImagePaths) {
    const imageData = readFileSync(imgPath).toString('base64');
    const ext = imgPath.endsWith('.png') ? 'image/png' : 'image/webp';
    contents.push({ inlineData: { data: imageData, mimeType: ext } });
  }
  contents.push({ text: prompt });

  const response = await gemini.models.generateContent({
    model: 'gemini-2.0-flash-preview-image-generation',
    contents: [{ role: 'user', parts: contents }],
    generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
  });

  const imgPart = response.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
  if (!imgPart) throw new Error('Gemini returned no image');
  return Buffer.from(imgPart.inlineData.data, 'base64');
}

async function createZip(zipPath, files) {
  const { default: archiver } = await import('archiver');
  const { createWriteStream } = await import('node:fs');
  return new Promise((resolve, reject) => {
    const output = createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    for (const { name, content } of files) archive.append(content, { name });
    archive.finalize();
  });
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const jobIdArg = process.argv.includes('--job-id')
    ? process.argv[process.argv.indexOf('--job-id') + 1] : null;
  if (!jobIdArg) throw new Error('--job-id required');

  const JOBS_DIR = join(ROOT, 'data', 'creative-jobs');
  const jobPath = join(JOBS_DIR, `${jobIdArg}.json`);
  if (!existsSync(jobPath)) throw new Error(`Job file not found: ${jobPath}`);

  const job = JSON.parse(readFileSync(jobPath, 'utf8'));
  const { adId, productImages = [] } = job;

  writeJobStatus(jobPath, { status: 'running' });

  const env = loadEnv();
  const apiKey = env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
  const geminiKey = env.GEMINI_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Missing ANTHROPIC_API_KEY');
  if (!geminiKey) throw new Error('Missing GEMINI_API_KEY');

  // Find the ad in the latest insights file
  const insightsDir = join(ROOT, 'data', 'meta-ads-insights');
  const insightFiles = readdirSync(insightsDir)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse();
  if (!insightFiles.length) throw new Error('No insights files found');
  const insights = JSON.parse(readFileSync(join(insightsDir, insightFiles[0]), 'utf8'));
  const ad = insights.ads.find(a => a.id === adId);
  if (!ad) throw new Error(`Ad ${adId} not found in latest insights`);

  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const { GoogleGenAI } = await import('@google/genai');
  const { default: sharp } = await import('sharp');
  const client = new Anthropic({ apiKey });
  const gemini = new GoogleGenAI({ apiKey: geminiKey });

  // Step 1: Style extraction
  process.stdout.write('  Extracting style... ');
  const styleResponse = await client.messages.create({
    model: 'claude-opus-4-6', max_tokens: 512,
    messages: [{ role: 'user', content: buildStylePrompt(ad) }],
  });
  const stylePrompt = styleResponse.content[0].text.trim();
  console.log('done');

  // Step 2: Generate images per placement size
  const sizes = placementSizes(ad.publisherPlatforms || ['instagram', 'facebook']);
  const PRODUCT_IMAGES_DIR = join(ROOT, 'data', 'product-images');
  const productImagePaths = productImages
    .map(f => join(PRODUCT_IMAGES_DIR, f))
    .filter(p => existsSync(p));

  const generatedImages = [];
  for (const size of sizes) {
    process.stdout.write(`  Generating ${size.name}... `);
    let imgBuffer = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const raw = await generateImage(gemini, `${stylePrompt}\n\nGenerate as ${size.width}x${size.height} pixel image. No text, logos, or labels.`, productImagePaths);
        imgBuffer = await sharp(raw).resize(size.width, size.height, { fit: 'cover' }).webp({ quality: 85 }).toBuffer();
        break;
      } catch (e) {
        if (attempt === 1) throw new Error(`Gemini failed for ${size.name}: ${e.message}`);
        console.warn(`  retry...`);
      }
    }
    generatedImages.push({ size, buffer: imgBuffer });
    console.log('done');
  }

  // Step 3: Copy generation
  process.stdout.write('  Generating copy... ');
  const copyResponse = await client.messages.create({
    model: 'claude-opus-4-6', max_tokens: 1024,
    messages: [{
      role: 'user', content: `Write 3 ad copy variations for Real Skin Care (realskincare.com) inspired by this competitor ad.

Competitor messaging angle: ${ad.analysis?.messagingAngle || 'unknown'}
Why the competitor's ad works: ${ad.analysis?.copyInsights || 'unknown'}
Competitor body copy: ${ad.adCreativeBody || '(none)'}

Our brand makes natural skincare products. Match the messaging angle but make it authentic to Real Skin Care.

Return ONLY valid JSON (no markdown):
[
  { "headline": "max 40 chars", "body": "max 125 chars", "cta": "2-4 words", "placement": "general" },
  { "headline": "...", "body": "...", "cta": "...", "placement": "instagram-feed" },
  { "headline": "...", "body": "...", "cta": "...", "placement": "facebook-feed" }
]`
    }],
  });
  const copyVariations = JSON.parse(copyResponse.content[0].text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim());
  console.log('done');

  // Step 4 + 5: Package ZIP
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const zipName = `${ad.pageSlug}-${today}.zip`;
  const PACKAGES_DIR = join(ROOT, 'data', 'creative-packages');
  mkdirSync(PACKAGES_DIR, { recursive: true });
  const zipPath = join(PACKAGES_DIR, zipName);

  const zipFiles = [
    { name: 'copy.txt', content: formatCopyFile(copyVariations) },
    { name: 'specs.txt', content: formatSpecsFile(sizes) },
    { name: 'analysis.txt', content: ad.analysis ? JSON.stringify(ad.analysis, null, 2) : '(no analysis available)' },
  ];
  for (const { size, buffer } of generatedImages) {
    zipFiles.push({ name: `images/${size.name}.webp`, content: buffer });
  }

  process.stdout.write('  Packaging ZIP... ');
  await createZip(zipPath, zipFiles);
  console.log(`done → ${zipName}`);

  // Step 6: Update job complete
  writeJobStatus(jobPath, { status: 'complete', downloadUrl: `/api/creative-packages/download/${jobIdArg}`, zipPath });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { notify } = await import('../../lib/notify.js');
  const { readdirSync } = await import('node:fs');
  const JOBS_DIR = join(ROOT, 'data', 'creative-jobs');
  const jobIdArg = process.argv.includes('--job-id')
    ? process.argv[process.argv.indexOf('--job-id') + 1] : null;
  const jobPath = jobIdArg ? join(JOBS_DIR, `${jobIdArg}.json`) : null;

  try {
    await main();
  } catch (err) {
    console.error('Error:', err.message);
    if (jobPath && existsSync(jobPath)) {
      writeJobStatus(jobPath, { status: 'error', error: err.message });
    }
    await notify({ subject: 'Creative Packager failed', body: err.message, status: 'error' }).catch(() => {});
    process.exit(1);
  }
}
```

- [ ] **Step 2: Verify tests still pass**

```bash
node --test tests/agents/creative-packager.test.js
```
Expected: `✓ creative-packager unit tests pass`

- [ ] **Step 3: Commit**

```bash
git add agents/creative-packager/index.js
git commit -m "feat: add creative-packager main() with Gemini generation and ZIP packaging"
```

---

## Task 9: Dashboard — API endpoints

**Files:**
- Modify: `agents/dashboard/index.js`

Add the four new endpoints and job cleanup. The dashboard routes are a chain of `if` blocks before the final HTML fallback — add new routes in the same pattern, just before the final `res.writeHead(200, ...)` / `res.end(HTML)` block at the end.

- [ ] **Step 1: Write the failing test**

```js
// tests/agents/dashboard-meta-ads.test.js
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

const src = readFileSync('agents/dashboard/index.js', 'utf8');

// New constants
assert.ok(src.includes('META_ADS_INSIGHTS_DIR'), 'must define insights dir constant');
assert.ok(src.includes('CREATIVE_JOBS_DIR'), 'must define jobs dir constant');
assert.ok(src.includes('CREATIVE_PACKAGES_DIR'), 'must define packages dir constant');

// Job cleanup on startup
assert.ok(src.includes('creative-jobs') && src.includes('7 * 86400'), 'must clean up old job files on startup');

// API routes
assert.ok(src.includes('/api/meta-ads-insights'), 'must have meta-ads-insights endpoint');
assert.ok(src.includes('/api/generate-creative'), 'must have generate-creative endpoint');
assert.ok(src.includes('/api/creative-packages/'), 'must have creative-packages status endpoint');
assert.ok(src.includes('download'), 'must have download endpoint');
assert.ok(src.includes('application/zip'), 'must serve ZIP files');

// Tab
assert.ok(src.includes("switchTab('ad-intelligence'"), 'must have ad-intelligence tab button');
assert.ok(src.includes('tab-ad-intelligence'), 'must have tab panel');
assert.ok(src.includes('renderAdIntelligenceTab'), 'must have renderAdIntelligenceTab function');

console.log('✓ dashboard meta-ads tests pass');
```

- [ ] **Step 2: Run to verify it fails**

```bash
node --test tests/agents/dashboard-meta-ads.test.js
```
Expected: assertion failures

- [ ] **Step 3: Add constants at the top of the constants block in `agents/dashboard/index.js`**

Find the block near line 70 where `COMP_BRIEFS_DIR` etc. are defined, and add after it:

```js
const META_ADS_INSIGHTS_DIR = join(ROOT, 'data', 'meta-ads-insights');
const CREATIVE_JOBS_DIR      = join(ROOT, 'data', 'creative-jobs');
const CREATIVE_PACKAGES_DIR  = join(ROOT, 'data', 'creative-packages');
const PRODUCT_IMAGES_DIR_MA  = join(ROOT, 'data', 'product-images');
```

- [ ] **Step 4: Add job cleanup on server startup**

Find the `server.listen(PORT, BIND, () => {` block near the bottom and add cleanup just before it:

```js
// Clean up creative job files older than 7 days
if (existsSync(CREATIVE_JOBS_DIR)) {
  const cutoff = Date.now() - 7 * 86400 * 1000;
  for (const f of readdirSync(CREATIVE_JOBS_DIR).filter(f => f.endsWith('.json'))) {
    try {
      const job = JSON.parse(readFileSync(join(CREATIVE_JOBS_DIR, f), 'utf8'));
      if (new Date(job.createdAt).getTime() < cutoff) {
        import('node:fs').then(({ unlinkSync }) => unlinkSync(join(CREATIVE_JOBS_DIR, f))).catch(() => {});
      }
    } catch {}
  }
}
```

- [ ] **Step 5: Add four API routes**

Find the final `res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(HTML);` and add all four routes just before it:

```js
// GET /api/meta-ads-insights
if (req.method === 'GET' && req.url === '/api/meta-ads-insights') {
  if (!checkAuth(req, res)) return;
  if (!existsSync(META_ADS_INSIGHTS_DIR)) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ date: null, ads: [] })); return; }
  const files = readdirSync(META_ADS_INSIGHTS_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse();
  if (!files.length) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ date: null, ads: [] })); return; }
  try {
    const data = readFileSync(join(META_ADS_INSIGHTS_DIR, files[0]), 'utf8');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(data);
  } catch { res.writeHead(500); res.end('{}'); }
  return;
}

// POST /api/generate-creative
if (req.method === 'POST' && req.url === '/api/generate-creative') {
  if (!checkAuth(req, res)) return;
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', () => {
    try {
      const { adId, productImages = [] } = JSON.parse(body);
      if (!adId) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'adId required' })); return; }
      if (productImages.length > 3) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'max 3 product images' })); return; }
      for (const f of productImages) {
        if (!existsSync(join(PRODUCT_IMAGES_DIR_MA, f))) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: `Product image not found: ${f}` })); return; }
      }
      // Find pageId for the adId from latest insights
      let pageId = 'unknown';
      if (existsSync(META_ADS_INSIGHTS_DIR)) {
        const iFiles = readdirSync(META_ADS_INSIGHTS_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse();
        if (iFiles.length) {
          try {
            const ins = JSON.parse(readFileSync(join(META_ADS_INSIGHTS_DIR, iFiles[0]), 'utf8'));
            pageId = ins.ads.find(a => a.id === adId)?.pageId || 'unknown';
          } catch {}
        }
      }
      const jobId = `${pageId}-${Date.now()}`;
      mkdirSync(CREATIVE_JOBS_DIR, { recursive: true });
      writeFileSync(join(CREATIVE_JOBS_DIR, `${jobId}.json`), JSON.stringify({ status: 'pending', adId, productImages, createdAt: new Date().toISOString() }, null, 2));
      spawn('node', ['agents/creative-packager/index.js', '--job-id', jobId], { detached: true, stdio: 'ignore' }).unref();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jobId }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
  return;
}

// GET /api/creative-packages/download/:jobId  ← MUST be registered before /:jobId
// (otherwise "download" would be matched as the jobId parameter)
if (req.method === 'GET' && req.url.startsWith('/api/creative-packages/download/')) {
  if (!checkAuth(req, res)) return;
  const jobId = req.url.slice('/api/creative-packages/download/'.length);
  const jobPath = join(CREATIVE_JOBS_DIR, `${jobId}.json`);
  if (!existsSync(jobPath)) { res.writeHead(404); res.end('Not found'); return; }
  try {
    const job = JSON.parse(readFileSync(jobPath, 'utf8'));
    const zipPath = job.zipPath;
    if (!zipPath || !existsSync(zipPath)) { res.writeHead(404); res.end('ZIP not found'); return; }
    const zipName = basename(zipPath);
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${zipName}"` });
    import('node:fs').then(({ createReadStream }) => createReadStream(zipPath).pipe(res));
  } catch { res.writeHead(500); res.end('Error'); }
  return;
}

// GET /api/creative-packages/:jobId  (status polling)
if (req.method === 'GET' && /^\/api\/creative-packages\/[^/]+$/.test(req.url)) {
  if (!checkAuth(req, res)) return;
  const jobId = req.url.split('/').pop();
  const jobPath = join(CREATIVE_JOBS_DIR, `${jobId}.json`);
  if (!existsSync(jobPath)) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'error', error: 'Job not found', downloadUrl: null }));
    return;
  }
  try {
    const job = JSON.parse(readFileSync(jobPath, 'utf8'));
    const age = Date.now() - new Date(job.createdAt).getTime();
    if (age > 10 * 60 * 1000 && job.status !== 'complete') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', error: 'Job timed out', downloadUrl: null }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: job.status, downloadUrl: job.downloadUrl || null, error: job.error || null }));
  } catch { res.writeHead(500); res.end('{}'); }
  return;
}
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
node --test tests/agents/dashboard-meta-ads.test.js
```
Expected: `✓ dashboard meta-ads tests pass`

- [ ] **Step 7: Commit**

```bash
git add agents/dashboard/index.js tests/agents/dashboard-meta-ads.test.js
git commit -m "feat: add meta-ads dashboard API endpoints and job cleanup"
```

---

## Task 10: Dashboard — Ad Intelligence tab UI

**Files:**
- Modify: `agents/dashboard/index.js`

The dashboard HTML is a large template literal string. Add a new tab pill and tab panel following the exact same pattern as existing tabs.

- [ ] **Step 1: Add the tab pill**

Find the tab pills section (around line 811):
```js
<button class="tab-pill" onclick="switchTab('ads',this)" id="pill-ads" style="display:none">Ads</button>
```

Add after it:
```js
<button class="tab-pill" onclick="switchTab('ad-intelligence',this)" id="pill-ad-intelligence">Ad Intelligence</button>
```

- [ ] **Step 2: Add the tab panel to the HTML string**

Find where other tab panels are defined (search for `id="tab-ads"`) and add a new panel alongside them:

```html
<div id="tab-ad-intelligence" class="tab-panel" style="display:none">
  <div id="ad-intelligence-content">
    <p class="muted" style="padding:2rem">Loading ad intelligence data…</p>
  </div>
</div>
```

- [ ] **Step 3: Add `renderAdIntelligenceTab` JavaScript function**

Find the existing JS functions in the HTML `<script>` block (around the `renderAdsTab` function area) and add:

```js
async function renderAdIntelligenceTab() {
  const el = document.getElementById('ad-intelligence-content');
  el.innerHTML = '<p class="muted" style="padding:2rem">Loading…</p>';
  try {
    const res = await fetch('/api/meta-ads-insights', { credentials: 'same-origin' });
    const data = await res.json();
    if (!data.ads || data.ads.length === 0) {
      el.innerHTML = '<p class="muted" style="padding:2rem">No ad intelligence data yet. Run the meta-ads-collector and meta-ads-analyzer agents first.</p>';
      return;
    }
    const ads = data.ads.slice(0, 12);
    el.innerHTML = `
      <div style="padding:1.5rem">
        <h2 style="margin:0 0 0.25rem">Ad Intelligence</h2>
        <p class="muted" style="margin:0 0 1.5rem">Competitor ads from Meta Ads Library · Last updated ${data.date || 'unknown'}</p>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:1.25rem">
          ${ads.map(ad => renderAdCard(ad)).join('')}
        </div>
      </div>`;
  } catch (e) {
    el.innerHTML = `<p class="muted" style="padding:2rem">Error loading data: ${esc(e.message)}</p>`;
  }
}

function renderAdCard(ad) {
  const platforms = (ad.publisherPlatforms || []).map(p =>
    `<span style="background:#e8f4fd;color:#1a6fa8;padding:2px 7px;border-radius:3px;font-size:11px;font-weight:600;text-transform:uppercase">${esc(p)}</span>`
  ).join(' ');
  const analysisHtml = ad.analysis ? `
    <div style="background:#f8f9fa;border-radius:6px;padding:0.75rem;margin-top:0.75rem;font-size:13px">
      <div style="font-weight:600;margin-bottom:0.25rem">${esc(ad.analysis.headline || '')}</div>
      <div class="muted">${esc(ad.analysis.whyEffective || '')}</div>
      ${ad.analysis.messagingAngle ? `<div style="margin-top:0.5rem"><span style="font-weight:600">Angle:</span> ${esc(ad.analysis.messagingAngle)}</div>` : ''}
    </div>` : '';
  return `
    <div style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;display:flex;flex-direction:column">
      <div style="padding:0.875rem 1rem 0.75rem;border-bottom:1px solid #f3f4f6">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:0.35rem">
          <span style="font-weight:700;font-size:14px">${esc(ad.pageName)}</span>
          <span style="font-size:11px;color:#6b7280;white-space:nowrap;margin-left:0.5rem">Score: ${ad.effectivenessScore}</span>
        </div>
        <div style="display:flex;gap:0.5rem;flex-wrap:wrap;align-items:center">
          ${platforms}
          <span style="font-size:11px;color:#6b7280">Running ${ad.longevityDays}d</span>
          <span style="font-size:11px;color:#6b7280">${ad.variationCount} variations</span>
        </div>
      </div>
      ${ad.adSnapshotUrl ? `<iframe src="${esc(ad.adSnapshotUrl)}" style="width:100%;height:280px;border:none" loading="lazy" sandbox="allow-scripts allow-same-origin"></iframe>` : ''}
      <div style="padding:0.75rem 1rem;font-size:13px;flex:1">
        ${ad.adCreativeBody ? `<div style="margin-bottom:0.5rem">${esc(ad.adCreativeBody.slice(0, 200))}${ad.adCreativeBody.length > 200 ? '…' : ''}</div>` : ''}
        ${analysisHtml}
      </div>
      <div style="padding:0.75rem 1rem;border-top:1px solid #f3f4f6">
        <button onclick="openCreativeGenerator('${esc(ad.id)}','${esc(ad.pageName)}')" style="width:100%;padding:0.5rem;background:#1a6fa8;color:#fff;border:none;border-radius:5px;font-size:13px;font-weight:600;cursor:pointer">Generate Creative</button>
      </div>
    </div>`;
}

function openCreativeGenerator(adId, pageName) {
  const name = prompt(`Generate creative for "${pageName}".\n\nEnter product image filenames (comma-separated, from data/product-images/) or leave blank for lifestyle-only:\nExample: deodorant-stick.webp,deodorant-lifestyle.webp`);
  // name=null means user cancelled; name='' means they left it blank (lifestyle-only) — both are valid
  if (name === null) return; // user cancelled the prompt
  const productImages = name ? name.split(',').map(s => s.trim()).filter(Boolean) : [];
  // productImages may be empty — that's valid (lifestyle-only prompt, no product reference)
  generateCreative(adId, productImages);
}

async function generateCreative(adId, productImages) {
  try {
    const res = await fetch('/api/generate-creative', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adId, productImages }),
    });
    if (!res.ok) { const e = await res.json(); alert('Error: ' + (e.error || res.status)); return; }
    const { jobId } = await res.json();
    alert('Creative generation started! Job ID: ' + jobId + '\n\nThe download link will appear here when ready. Check back in ~2 minutes.');
    pollCreativeJob(jobId);
  } catch (e) { alert('Error: ' + e.message); }
}

async function pollCreativeJob(jobId, attempts = 0) {
  if (attempts > 30) { alert('Creative generation timed out. Check the dashboard for errors.'); return; }
  await new Promise(r => setTimeout(r, 5000));
  try {
    const res = await fetch('/api/creative-packages/' + encodeURIComponent(jobId), { credentials: 'same-origin' });
    const job = await res.json();
    if (job.status === 'complete') {
      if (confirm('Creative package ready! Download now?')) window.location.href = '/api/creative-packages/download/' + encodeURIComponent(jobId);
    } else if (job.status === 'error') {
      alert('Creative generation failed: ' + (job.error || 'unknown error'));
    } else {
      pollCreativeJob(jobId, attempts + 1);
    }
  } catch { pollCreativeJob(jobId, attempts + 1); }
}
```

- [ ] **Step 4: Wire up tab load in `switchTab`**

Find the `switchTab` function (around line 964) and add a call to load the tab data when it's activated. The existing pattern shows tabs calling their render function when switched to. Find the switch statement or if-chain and add:

```js
if (name === 'ad-intelligence') renderAdIntelligenceTab();
```

- [ ] **Step 5: Run all dashboard tests**

```bash
node --test tests/agents/dashboard-meta-ads.test.js && node --test tests/agents/dashboard-ads.test.js
```
Expected: both pass

- [ ] **Step 6: Commit**

```bash
git add agents/dashboard/index.js
git commit -m "feat: add Ad Intelligence tab to dashboard"
```

---

## Task 11: Cron entries

**Files:** system crontab

- [ ] **Step 1: Add the two cron entries**

```bash
(crontab -l; echo '0 6 * * 1 cd "/Users/seanfillmore/Code/Claude" && /usr/local/bin/node agents/meta-ads-collector/index.js >> data/reports/scheduler/meta-ads-collector.log 2>&1') | crontab -
(crontab -l; echo '10 6 * * 1 cd "/Users/seanfillmore/Code/Claude" && /usr/local/bin/node agents/meta-ads-analyzer/index.js >> data/reports/scheduler/meta-ads-analyzer.log 2>&1') | crontab -
```

- [ ] **Step 2: Verify they were added**

```bash
crontab -l | grep meta-ads
```
Expected: two lines with `meta-ads-collector` and `meta-ads-analyzer`

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "docs: note cron entries added for meta-ads collector and analyzer"
```

---

## Task 12: Full test suite + add META_APP_ACCESS_TOKEN to .env

**Files:** `.env`

- [ ] **Step 1: Add the env key to .env**

Open `.env` and add:
```
META_APP_ACCESS_TOKEN=YOUR_APP_ID|YOUR_APP_SECRET
```
Replace with real values from the Meta for Developers app dashboard. The format is literally `APP_ID|APP_SECRET` as a single string.

- [ ] **Step 2: Run the full test suite**

```bash
npm test
```
Expected: all tests pass including the new ones:
- `tests/lib/meta-ads-library.test.js`
- `tests/agents/meta-ads-collector.test.js`
- `tests/agents/meta-ads-analyzer.test.js`
- `tests/agents/creative-packager.test.js`
- `tests/agents/dashboard-meta-ads.test.js`

- [ ] **Step 3: Smoke-test the collector (dry run — checks API auth)**

```bash
node agents/meta-ads-collector/index.js --date 2026-03-21
```
Expected: connects to Meta API, fetches ads, saves snapshot to `data/snapshots/meta-ads-library/2026-03-21.json`

- [ ] **Step 4: Smoke-test the analyzer (dry run)**

```bash
node agents/meta-ads-analyzer/index.js --dry-run
```
Expected: reads snapshot, prints qualifying ads, exits without calling Claude

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat: complete Meta Ads Library Phase 1 implementation"
```

---

## Task 13: Merge to main

- [ ] **Step 1: Run full test suite one final time**

```bash
npm test
```
Expected: all tests pass

- [ ] **Step 2: Merge**

```bash
git checkout main && git merge feature/meta-ads-library
```

- [ ] **Step 3: Verify on main**

```bash
npm test
```
Expected: all tests pass
