# Shared Keyword Intelligence Index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a unified keyword index from all Ahrefs uploads, briefs, and topical map data so every agent has access to cluster-wide keyword intelligence, and the content-researcher only requests Ahrefs uploads for niche-specific gaps.

**Architecture:** New `lib/keyword-index.js` module reads all local data sources (no API calls), builds a per-keyword + per-cluster index, writes it to `data/keyword-index.json`. A gap analysis function identifies what cluster data covers vs what's missing for a specific keyword. The content-researcher uses the index before checking for keyword-specific Ahrefs data, and the dashboard data-needed card shows gap-aware status.

**Tech Stack:** Node.js (ESM), existing CSV parsers from `agents/content-researcher/index.js` (extracted to shared module), existing `data/topical-map.json` and `data/briefs/*.json`.

---

## File Structure

| Action | File | Responsibility |
|---|---|---|
| Create | `lib/keyword-index.js` | Build, cache, query unified keyword index + gap analysis |
| Create | `lib/csv-parsers.js` | CSV parsing functions extracted from content-researcher (shared) |
| Create | `tests/lib/keyword-index.test.js` | Tests for index building, cluster assignment, gap analysis |
| Modify | `agents/content-researcher/index.js` | Use index for cluster data, import shared CSV parsers |
| Modify | `agents/content-refresher/index.js` | Load cluster keywords for refresh context |
| Modify | `agents/dashboard/lib/data-parsers.js` | Gap-aware `getPendingAhrefsData` using index |
| Modify | `agents/dashboard/public/js/dashboard.js` | Gap-aware data-needed card |
| Modify | `scheduler.js` | Add index rebuild step |
| Modify | `package.json` | Add npm script |
| Modify | `docs/signal-manifest.md` | Add keyword-index signal |

---

## Task 1: Extract CSV parsers into shared module

**Files:**
- Create: `lib/csv-parsers.js`

The content-researcher has `parseCSV`, `parseSerpCsv`, `parseKeywordsCsv`, `parseVolumeHistoryCsv` as private functions. The keyword-index needs these too. Extract them into a shared module.

- [ ] **Step 1: Create `lib/csv-parsers.js`**

```javascript
/**
 * Shared CSV parsers for Ahrefs data.
 * Extracted from agents/content-researcher/index.js.
 */

export function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map((h) => h.replace(/^"|"$/g, '').trim().toLowerCase());
  return lines.slice(1).map((line) => {
    const fields = [];
    let inQuote = false;
    let cur = '';
    for (const ch of line) {
      if (ch === '"') { inQuote = !inQuote; }
      else if (ch === ',' && !inQuote) { fields.push(cur.trim()); cur = ''; }
      else { cur += ch; }
    }
    fields.push(cur.trim());
    const row = {};
    headers.forEach((h, i) => { row[h] = fields[i]?.replace(/^"|"$/g, '') ?? ''; });
    return row;
  });
}

function num(v) { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return isNaN(n) ? null : n; }

function g(row, ...keys) {
  for (const k of keys) if (k in row && row[k] !== '') return row[k];
  return null;
}

export function parseSerpCsv(rows) {
  const overviewRow = rows.find((r) => !g(r, 'url'));
  const overview = overviewRow ? {
    volume: num(g(overviewRow, 'volume')),
    keyword_difficulty: num(g(overviewRow, 'difficulty')),
    traffic_potential: num(g(overviewRow, 'traffic potential')),
    global_volume: num(g(overviewRow, 'global volume')),
    cpc_cents: num(g(overviewRow, 'cpc')),
    parent_topic: g(overviewRow, 'parent topic'),
    search_intent: g(overviewRow, 'intents'),
  } : {};

  const skip = ['youtube.com', 'reddit.com', 'facebook.com', 'tiktok.com', 'instagram.com', 'amazon.com'];
  const serp = rows
    .filter((r) => g(r, 'url') && !skip.some((s) => (g(r, 'url') ?? '').includes(s)))
    .map((r) => ({
      position: num(g(r, 'position')),
      url: g(r, 'url'),
      title: g(r, 'title'),
      domain_rating: num(g(r, 'domain rating')),
      traffic: num(g(r, 'traffic')),
      keywords: num(g(r, 'keywords')),
      refdomains: num(g(r, 'referring domains')),
      type: g(r, 'type'),
    }))
    .slice(0, 10);

  return { overview, serp };
}

export function parseKeywordsCsv(rows) {
  return rows
    .map((r) => ({
      keyword: g(r, 'keyword'),
      volume: num(g(r, 'volume')),
      difficulty: num(g(r, 'difficulty')),
      traffic_potential: num(g(r, 'traffic potential')),
      cpc: num(g(r, 'cpc')),
    }))
    .filter((r) => r.keyword);
}

export function parseVolumeHistoryCsv(rows) {
  const recent = rows.slice(-24);
  const byMonth = {};
  for (const r of recent) {
    const date = g(r, 'date');
    const vol = num(g(r, 'volume', ' volume'));
    if (!date || vol === null) continue;
    const month = new Date(date).getMonth();
    byMonth[month] = vol;
  }
  return byMonth;
}
```

- [ ] **Step 2: Update content-researcher to import from shared module**

In `agents/content-researcher/index.js`, replace the local `parseCSV`, `parseSerpCsv`, `parseKeywordsCsv`, `parseVolumeHistoryCsv`, `num`, and `g` functions (lines 155-243) with:

```javascript
import { parseCSV, parseSerpCsv, parseKeywordsCsv, parseVolumeHistoryCsv } from '../../lib/csv-parsers.js';
```

Keep the `loadAhrefsData` function which calls these parsers — it still works, just uses the imported versions.

- [ ] **Step 3: Run existing tests to verify nothing broke**

Run: `node --test tests/agents/product-optimizer-from-gsc.test.js tests/agents/collection-content-optimizer.test.js`
Expected: All pass (these don't test the researcher directly, but verify the project isn't broken).

- [ ] **Step 4: Commit**

```bash
git add lib/csv-parsers.js agents/content-researcher/index.js
git commit -m "refactor: extract CSV parsers into shared lib/csv-parsers.js"
```

---

## Task 2: Build the keyword index module — tests

**Files:**
- Create: `tests/lib/keyword-index.test.js`

- [ ] **Step 1: Write the test file**

```javascript
// tests/lib/keyword-index.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── Cluster assignment ───────────────────────────────────────────────────────

const KNOWN_CATEGORIES = ['soap', 'toothpaste', 'lotion', 'deodorant', 'lip balm', 'lip-balm', 'coconut oil', 'coconut-oil', 'shampoo', 'conditioner', 'sunscreen'];

function assignCluster(keyword, topicalMapClusters) {
  const slug = keyword.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  // 1. Check topical map articles by URL match
  for (const cluster of topicalMapClusters) {
    for (const article of cluster.articles || []) {
      if (article.url && article.url.includes(slug)) return cluster.tag;
    }
  }
  // 2. Check known product categories
  const kw = keyword.toLowerCase();
  for (const cat of KNOWN_CATEGORIES) {
    if (kw.includes(cat.replace('-', ' ')) || kw.includes(cat)) return cat.replace('-', ' ');
  }
  return 'unclustered';
}

test('assignCluster: matches known category', () => {
  assert.equal(assignCluster('best natural bar soap for men', []), 'soap');
});

test('assignCluster: matches topical map article URL', () => {
  const clusters = [{ tag: 'mof', articles: [{ url: 'https://example.com/blogs/news/coconut-oil-guide' }] }];
  assert.equal(assignCluster('coconut oil guide', clusters), 'mof');
});

test('assignCluster: falls back to unclustered', () => {
  assert.equal(assignCluster('random topic nobody covers', []), 'unclustered');
});

test('assignCluster: handles multi-word categories', () => {
  assert.equal(assignCluster('organic coconut oil for skin', []), 'coconut oil');
  assert.equal(assignCluster('best lip balm recipe', []), 'lip balm');
});

// ── Gap analysis ─────────────────────────────────────────────────────────────

function extractNicheWords(keyword, clusterKeywords) {
  const words = new Set(keyword.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  // Remove words that appear in >50% of cluster keywords (they're generic to the cluster)
  const wordCounts = {};
  for (const ck of clusterKeywords) {
    const ckWords = new Set(ck.toLowerCase().split(/\s+/));
    for (const w of words) {
      if (ckWords.has(w)) wordCounts[w] = (wordCounts[w] || 0) + 1;
    }
  }
  const threshold = Math.max(1, clusterKeywords.length * 0.5);
  return [...words].filter(w => (wordCounts[w] || 0) < threshold);
}

function analyzeGaps(keywordSlug, index) {
  const kw = index.keywords[keywordSlug];
  const clusterName = kw?.cluster || 'unclustered';
  const cluster = index.clusters[clusterName];
  if (!cluster) return { sufficient: false, needs_upload: true, has_cluster_data: false, missing: ['No cluster data available'] };

  const nicheWords = extractNicheWords(kw?.keyword || keywordSlug.replace(/-/g, ' '), cluster.keywords.map(k => (index.keywords[k]?.keyword || k).replace(/-/g, ' ')));
  const nicheTermCount = cluster.all_matching_terms.filter(t => nicheWords.some(nw => t.keyword.toLowerCase().includes(nw))).length;
  const hasOwnAhrefs = kw?.sources?.includes('ahrefs') || false;

  const sufficient = hasOwnAhrefs
    || (cluster.all_matching_terms.length >= 50 && cluster.common_competitors.length >= 5 && nicheTermCount >= 10);

  const missing = [];
  if (nicheTermCount < 10 && nicheWords.length > 0) missing.push(`${nicheWords.join('/')}-specific matching terms`);
  if (!hasOwnAhrefs && cluster.common_competitors.length < 5) missing.push('SERP competitor data');

  return {
    has_cluster_data: cluster.all_matching_terms.length > 0,
    cluster_terms: cluster.all_matching_terms.length,
    niche_terms: nicheTermCount,
    niche_words: nicheWords,
    cluster_serp: cluster.common_competitors.length > 0,
    has_own_ahrefs: hasOwnAhrefs,
    sufficient,
    needs_upload: !sufficient,
    missing,
  };
}

test('extractNicheWords: finds words unique to keyword not common in cluster', () => {
  const result = extractNicheWords('best soap for tattoos', ['natural bar soap', 'best natural soap', 'castile soap']);
  assert.ok(result.includes('tattoos'));
  assert.ok(!result.includes('soap')); // soap is in >50% of cluster keywords
  assert.ok(!result.includes('best')); // too short (<=3 chars filtered)
});

test('analyzeGaps: sufficient when own Ahrefs data exists', () => {
  const index = {
    keywords: { 'natural-bar-soap': { keyword: 'natural bar soap', cluster: 'soap', sources: ['ahrefs'] } },
    clusters: { soap: { keywords: ['natural-bar-soap'], all_matching_terms: [], common_competitors: [] } },
  };
  const result = analyzeGaps('natural-bar-soap', index);
  assert.equal(result.sufficient, true);
  assert.equal(result.needs_upload, false);
});

test('analyzeGaps: needs upload when cluster data lacks niche coverage', () => {
  const index = {
    keywords: {
      'natural-bar-soap': { keyword: 'natural bar soap', cluster: 'soap', sources: ['ahrefs'] },
      'best-soap-for-tattoos': { keyword: 'best soap for tattoos', cluster: 'soap', sources: [] },
    },
    clusters: {
      soap: {
        keywords: ['natural-bar-soap', 'best-soap-for-tattoos'],
        all_matching_terms: Array(60).fill({ keyword: 'organic soap bar', volume: 100 }),
        common_competitors: Array(6).fill({ domain: 'example.com', appearances: 2 }),
      },
    },
  };
  const result = analyzeGaps('best-soap-for-tattoos', index);
  assert.equal(result.has_cluster_data, true);
  assert.equal(result.sufficient, false); // 60 terms but 0 contain "tattoo"
  assert.ok(result.missing.some(m => m.includes('tattoo')));
});

test('analyzeGaps: sufficient when cluster has niche terms', () => {
  const tattooTerms = Array(15).fill({ keyword: 'tattoo aftercare soap', volume: 200 });
  const genericTerms = Array(50).fill({ keyword: 'organic bar soap', volume: 100 });
  const index = {
    keywords: {
      'natural-bar-soap': { keyword: 'natural bar soap', cluster: 'soap', sources: ['ahrefs'] },
      'best-soap-for-tattoos': { keyword: 'best soap for tattoos', cluster: 'soap', sources: [] },
    },
    clusters: {
      soap: {
        keywords: ['natural-bar-soap', 'best-soap-for-tattoos'],
        all_matching_terms: [...genericTerms, ...tattooTerms],
        common_competitors: Array(6).fill({ domain: 'example.com', appearances: 2 }),
      },
    },
  };
  const result = analyzeGaps('best-soap-for-tattoos', index);
  assert.equal(result.sufficient, true);
  assert.equal(result.niche_terms, 15);
});
```

- [ ] **Step 2: Run tests**

Run: `node --test tests/lib/keyword-index.test.js`
Expected: All 8 tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/lib/keyword-index.test.js
git commit -m "test: add keyword index cluster assignment and gap analysis tests"
```

---

## Task 3: Build `lib/keyword-index.js`

**Files:**
- Create: `lib/keyword-index.js`

- [ ] **Step 1: Write the module**

The module exports three functions:
- `loadKeywordIndex()` — builds/loads the cached index
- `analyzeGaps(keywordSlug, index)` — gap analysis for a specific keyword
- `rebuildIndex()` — force rebuild (for CLI and scheduler)

Implementation details:

1. **Reading Ahrefs data:** Iterate `data/ahrefs/*/` directories, use `parseCSV`, `parseSerpCsv`, `parseKeywordsCsv` from `lib/csv-parsers.js` to extract matching terms, SERP results, and overview metrics per keyword.

2. **Reading briefs:** Iterate `data/briefs/*.json`, extract `semantic_keywords`, `serp_overview`, `search_volume`, `keyword_difficulty`, `target_keyword`.

3. **Reading topical map:** Load `data/topical-map.json`, extract cluster tags and article URLs for cluster assignment.

4. **Reading GSC:** Load latest `data/snapshots/gsc/*.json` (most recent file by name), extract per-page metrics.

5. **Building per-keyword entries:** For each keyword found in Ahrefs or briefs, create an entry with merged data and assigned cluster.

6. **Building per-cluster aggregations:** For each cluster, merge all matching terms (deduplicated by keyword string), count SERP domain appearances across all keywords in the cluster, merge all semantic keywords.

7. **Caching:** Write to `data/keyword-index.json`. On subsequent calls, return cached if file is <24h old. In-memory cache for same-process reuse.

8. **CLI mode:** `node lib/keyword-index.js --rebuild` force rebuilds and prints summary.

Key functions:
- `assignCluster(keyword, topicalMapClusters)` — same logic as tests
- `extractNicheWords(keyword, clusterKeywords)` — same logic as tests
- `analyzeGaps(keywordSlug, index)` — same logic as tests
- `buildIndex()` — the main builder
- `loadKeywordIndex()` — lazy load with caching

The `common_competitors` aggregation: for each SERP result across all keywords in a cluster, count how many times each domain appears and compute average position.

```javascript
function buildCommonCompetitors(clusterKeywordEntries) {
  const domainStats = {};
  for (const entry of clusterKeywordEntries) {
    for (const s of (entry.serp || [])) {
      if (!s.url) continue;
      try {
        const domain = new URL(s.url).hostname.replace(/^www\./, '');
        if (!domainStats[domain]) domainStats[domain] = { appearances: 0, positions: [] };
        domainStats[domain].appearances++;
        if (s.position) domainStats[domain].positions.push(s.position);
      } catch { /* skip */ }
    }
  }
  return Object.entries(domainStats)
    .map(([domain, stats]) => ({
      domain,
      appearances: stats.appearances,
      avg_position: stats.positions.length ? Math.round(stats.positions.reduce((a, b) => a + b, 0) / stats.positions.length * 10) / 10 : null,
    }))
    .sort((a, b) => b.appearances - a.appearances)
    .slice(0, 20);
}
```

- [ ] **Step 2: Run tests**

Run: `node --test tests/lib/keyword-index.test.js`
Expected: All 8 tests pass.

- [ ] **Step 3: Test CLI mode**

Run: `node lib/keyword-index.js --rebuild`
Expected: Prints summary like "Built keyword index: 50 keywords, 13 clusters, written to data/keyword-index.json"

- [ ] **Step 4: Commit**

```bash
git add lib/keyword-index.js
git commit -m "feat: add lib/keyword-index.js — unified keyword intelligence from Ahrefs, briefs, topical map"
```

---

## Task 4: Wire index into content-researcher

**Files:**
- Modify: `agents/content-researcher/index.js`

- [ ] **Step 1: Import the index**

After existing imports, add:

```javascript
import { loadKeywordIndex, analyzeGaps } from '../../lib/keyword-index.js';
```

- [ ] **Step 2: Use index before checking for keyword-specific Ahrefs data**

Replace the Ahrefs data loading block (around line 639-664) with logic that:

1. Loads the keyword index
2. Runs gap analysis
3. If keyword has its own Ahrefs data → use it (existing behavior)
4. If no own data but cluster has sufficient data → use cluster data for matching terms and SERP
5. If no own data and cluster is insufficient → check `allowFallback`, show gap-specific error

```javascript
  // Load keyword index for cluster-wide intelligence
  const index = loadKeywordIndex();
  const gaps = analyzeGaps(slug, index);
  const clusterName = index.keywords[slug]?.cluster;
  const cluster = clusterName ? index.clusters[clusterName] : null;

  // Load keyword-specific Ahrefs data if available
  const ahrefsData = loadAhrefsData(keyword);
  if (ahrefsData) {
    console.log(`\n  Keyword: "${keyword}" (using Ahrefs data from data/ahrefs/${slug}/)`);
    if (ahrefsData.overview) Object.assign(kwData, {
      search_volume: kwData.search_volume ?? ahrefsData.overview.volume,
      keyword_difficulty: kwData.keyword_difficulty ?? ahrefsData.overview.keyword_difficulty,
      traffic_potential: kwData.traffic_potential ?? ahrefsData.overview.traffic_potential,
    });
  } else if (gaps.sufficient) {
    console.log(`\n  Keyword: "${keyword}" (using cluster "${clusterName}" data — ${gaps.cluster_terms} terms, ${gaps.niche_terms} niche)`);
  } else if (!allowFallback) {
    console.error(`\n  ✗ Insufficient data for "${keyword}"`);
    if (gaps.has_cluster_data) {
      console.error(`  Cluster "${clusterName}" has ${gaps.cluster_terms} terms but needs ${gaps.missing.join(', ')}`);
    }
    console.error(`\n  Upload Ahrefs data to data/ahrefs/${slug}/`);
    console.error('  Run with --allow-fallback to proceed with available data.\n');
    process.exit(1);
  } else {
    console.log(`\n  Keyword: "${keyword}" (⚠️ limited data — using fallbacks)`);
  }
```

- [ ] **Step 3: Use cluster matching terms and SERP when own data is missing**

After the Ahrefs loading block, update the SERP and matching terms fallback logic:

```javascript
  process.stdout.write('  Fetching SERP overview... ');
  let serpResults = ahrefsData?.serp?.filter((r) => r.url) ?? [];
  // Fall back to cluster SERP data if no own SERP
  if (serpResults.length === 0 && cluster?.common_competitors?.length > 0) {
    // Use the most detailed SERP from any keyword in the cluster
    for (const ckSlug of cluster.keywords) {
      const ckEntry = index.keywords[ckSlug];
      if (ckEntry?.serp?.length > serpResults.length) serpResults = ckEntry.serp;
    }
  }
  if (serpResults.length === 0) serpResults = await getSerpOverview(keyword);
  console.log(`${serpResults.length} results${!ahrefsData && serpResults.length > 0 ? ' (from cluster)' : ''}`);

  process.stdout.write('  Fetching related keywords... ');
  let relatedKeywords = ahrefsData?.matching_terms?.filter((k) => k.keyword) ?? [];
  // Merge cluster matching terms if own data is thin
  if (relatedKeywords.length < 20 && cluster?.all_matching_terms?.length > 0) {
    const existing = new Set(relatedKeywords.map(k => k.keyword));
    const clusterTerms = cluster.all_matching_terms.filter(k => !existing.has(k.keyword));
    relatedKeywords = [...relatedKeywords, ...clusterTerms];
    if (!ahrefsData) console.log(`${relatedKeywords.length} keywords (${clusterTerms.length} from cluster)`);
  }
  if (relatedKeywords.length === 0) relatedKeywords = await getRelatedKeywords(keyword);
```

- [ ] **Step 4: Add cluster context to brief metadata**

When writing the brief JSON, add a `data_sources` field:

```javascript
  // In the brief object construction, add:
  data_sources: {
    own_ahrefs: !!ahrefsData,
    cluster: clusterName || null,
    cluster_terms: cluster?.all_matching_terms?.length || 0,
    niche_terms: gaps.niche_terms || 0,
    gaps: gaps.missing || [],
  },
```

- [ ] **Step 5: Run tests**

Run: `node --check agents/content-researcher/index.js`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add agents/content-researcher/index.js
git commit -m "feat(content-researcher): use keyword index for cluster data, gap-aware Ahrefs gating"
```

---

## Task 5: Wire index into content-refresher

**Files:**
- Modify: `agents/content-refresher/index.js`

- [ ] **Step 1: Import and load index**

Add import at top:
```javascript
import { loadKeywordIndex } from '../../lib/keyword-index.js';
```

- [ ] **Step 2: Add cluster keyword context to refresh prompt**

In the `refreshContent` function, after the `relatedStr` line (around line 172), add:

```javascript
  // Load cluster keyword context from the shared index
  let clusterContext = '';
  try {
    const index = loadKeywordIndex();
    const kwSlug = (slug || '').replace(/-refreshed$/, '');
    const kwEntry = index.keywords[kwSlug];
    const clusterName = kwEntry?.cluster;
    const cluster = clusterName ? index.clusters[clusterName] : null;
    if (cluster && cluster.all_semantic_keywords?.length > 0) {
      const topTerms = cluster.all_semantic_keywords.slice(0, 30).join(', ');
      clusterContext = `\nCLUSTER KEYWORD INTELLIGENCE (from sibling research in the "${clusterName}" cluster):\nTop terms across the cluster: ${topTerms}\n`;
    }
  } catch { /* index not available — proceed without */ }
```

Then inject `${clusterContext}` into the prompt after `${relatedStr}` and before the USER CONCERNS section.

- [ ] **Step 3: Commit**

```bash
git add agents/content-refresher/index.js
git commit -m "feat(content-refresher): add cluster keyword context from shared index to refresh prompts"
```

---

## Task 6: Gap-aware dashboard data-needed card

**Files:**
- Modify: `agents/dashboard/lib/data-parsers.js`
- Modify: `agents/dashboard/public/js/dashboard.js`

- [ ] **Step 1: Update `getPendingAhrefsData` to use gap analysis**

In `agents/dashboard/lib/data-parsers.js`, replace the `getPendingAhrefsData` function with a version that loads the keyword index and runs gap analysis:

```javascript
export function getPendingAhrefsData(calItems) {
  const pending = [];
  const rejections = loadRejections();

  // Load keyword index for gap-aware checking
  let index = null;
  try {
    const indexPath = join(ROOT, 'data', 'keyword-index.json');
    if (existsSync(indexPath)) index = JSON.parse(readFileSync(indexPath, 'utf8'));
  } catch { /* proceed without index */ }

  for (const item of calItems) {
    const slug     = item.slug;
    const hasBrief = existsSync(join(BRIEFS_DIR, `${slug}.json`));
    const hasPost  = existsSync(join(POSTS_DIR,  `${slug}.html`));
    if (hasBrief || hasPost) continue;
    if (isRejectedKw(item.keyword, rejections)) continue;

    const status = checkAhrefsData(item.keyword);

    // If own data is ready, skip
    if (status.ready) continue;

    // Check if cluster data is sufficient via the index
    if (index) {
      const kwSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, '');
      const kwEntry = index.keywords[kwSlug];
      const clusterName = kwEntry?.cluster;
      const cluster = clusterName ? index.clusters[clusterName] : null;
      if (cluster && cluster.all_matching_terms?.length >= 50 && cluster.common_competitors?.length >= 5) {
        // Check niche coverage
        const kw = item.keyword.toLowerCase();
        const clusterKws = cluster.keywords.map(k => (index.keywords[k]?.keyword || k).replace(/-/g, ' '));
        const words = kw.split(/\s+/).filter(w => w.length > 3);
        const threshold = Math.max(1, clusterKws.length * 0.5);
        const nicheWords = words.filter(w => {
          const count = clusterKws.filter(ck => ck.includes(w)).length;
          return count < threshold;
        });
        const nicheTermCount = cluster.all_matching_terms.filter(t =>
          nicheWords.some(nw => t.keyword.toLowerCase().includes(nw))
        ).length;
        if (nicheTermCount >= 10) continue; // Sufficient cluster + niche data
      }
    }

    const missing = [];
    if (!status.hasSerp)     missing.push('SERP Overview (required)');
    if (!status.hasKeywords) missing.push('Matching Terms (required)');
    if (!status.hasHistory)  missing.push('Volume History (optional)');

    // Add cluster info if available
    let clusterInfo = null;
    if (index) {
      const kwSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, '');
      const kwEntry = index.keywords[kwSlug];
      const clusterName = kwEntry?.cluster;
      const cluster = clusterName ? index.clusters[clusterName] : null;
      if (cluster && cluster.all_matching_terms?.length > 0) {
        clusterInfo = {
          name: clusterName,
          terms: cluster.all_matching_terms.length,
          serps: cluster.common_competitors.length,
        };
      }
    }

    pending.push({
      keyword:     item.keyword,
      slug,
      publishDate: item.publishDate.toISOString(),
      dir:         status.dir,
      missingFiles: missing,
      hasSerp:     status.hasSerp,
      hasKeywords: status.hasKeywords,
      hasHistory:  status.hasHistory,
      clusterInfo,
    });
  }
  return pending;
}
```

- [ ] **Step 2: Update dashboard card to show cluster status**

In `agents/dashboard/public/js/dashboard.js`, update the `renderDataNeeded` function's item rendering to show cluster info when available:

```javascript
    var clusterNote = item.clusterInfo
      ? '<div style="font-size:0.72rem;color:#059669">✓ ' + item.clusterInfo.name + ' cluster (' + item.clusterInfo.terms + ' terms) — needs niche data</div>'
      : '';

    return '<div style="border-bottom:1px solid var(--border);padding:8px 2px;display:flex;align-items:center;gap:0.5rem">' +
        '<div style="flex:1">' +
          '<div style="font-weight:500;font-size:0.85rem">' + esc(item.keyword) + '</div>' +
          clusterNote +
        '</div>' +
        '<div style="display:flex;gap:3px;margin-right:0.5rem">' + fileTags + '</div>' +
        '<span style="font-size:0.75rem;color:var(--muted);white-space:nowrap">' + fmtDate(item.publishDate) + '</span>' +
        '<button id="kw-zip-btn-' + esc(item.slug) + '" class="upload-btn" onclick="uploadKeywordZip(' + JSON.stringify(item.slug).replace(/"/g, '&quot;') + ',' + JSON.stringify(item.keyword).replace(/"/g, '&quot;') + ')">&#8593; Upload</button>' +
    '</div>';
```

- [ ] **Step 3: Run syntax checks**

Run: `node --check agents/dashboard/lib/data-parsers.js && node --check agents/dashboard/public/js/dashboard.js`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add agents/dashboard/lib/data-parsers.js agents/dashboard/public/js/dashboard.js
git commit -m "feat(dashboard): gap-aware data-needed card using keyword index"
```

---

## Task 7: Scheduler + npm scripts + signal manifest

**Files:**
- Modify: `scheduler.js`
- Modify: `package.json`
- Modify: `docs/signal-manifest.md`

- [ ] **Step 1: Add index rebuild as first scheduler step**

Before the existing Step 0 (review-monitor), add:

```javascript
// Step -1: rebuild keyword index (used by researcher and other agents)
runStep('keyword-index', `"${NODE}" lib/keyword-index.js --rebuild`);
```

- [ ] **Step 2: Add npm script**

In `package.json` scripts section:

```json
    "keyword-index": "node lib/keyword-index.js --rebuild",
```

- [ ] **Step 3: Update signal manifest**

Add to the signals table:

```markdown
| `data/keyword-index.json` | `lib/keyword-index.js` (scheduler daily rebuild) | `content-researcher`, `content-refresher`, `editor`, `dashboard data-parsers` | healthy |
```

- [ ] **Step 4: Commit**

```bash
git add scheduler.js package.json docs/signal-manifest.md
git commit -m "feat: add keyword index rebuild to scheduler, npm script, signal manifest"
```

---

## Task 8: Integration smoke test

- [ ] **Step 1: Run all tests**

Run: `node --test tests/lib/keyword-index.test.js`
Expected: All 8 tests pass.

- [ ] **Step 2: Rebuild index and verify output**

Run: `node lib/keyword-index.js --rebuild`
Expected: Prints summary, creates `data/keyword-index.json`.

- [ ] **Step 3: Syntax check all modified files**

Run: `node --check lib/keyword-index.js && node --check lib/csv-parsers.js && node --check agents/content-researcher/index.js && node --check agents/content-refresher/index.js && node --check agents/dashboard/lib/data-parsers.js && node --check agents/dashboard/public/js/dashboard.js && node --check scheduler.js && echo "All OK"`
Expected: "All OK"

- [ ] **Step 4: Verify index content**

Run: `node -e "const idx = JSON.parse(require('fs').readFileSync('data/keyword-index.json','utf8')); console.log('Keywords:', Object.keys(idx.keywords).length); console.log('Clusters:', Object.keys(idx.clusters).length); for (const [name, c] of Object.entries(idx.clusters).slice(0,3)) console.log('  ' + name + ':', c.keywords.length, 'keywords,', c.all_matching_terms.length, 'terms');"`
Expected: Shows keyword and cluster counts with matching term counts.

- [ ] **Step 5: Commit if any fixes needed**

```bash
git add -A && git commit -m "fix: smoke test fixes for keyword index"
```
