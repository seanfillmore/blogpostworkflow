# content-researcher → Keyword-Index Wiring

**Date:** 2026-04-27
**Goal:** Enrich every brief with cluster-mate keywords + cluster-level competitors from the keyword-index, and stamp the brief with the keyword's `validation_source` for downstream consumers.

## Current state

`agents/content-researcher/index.js` `researchKeyword(keyword)`:
1. Skips if brief already exists or duplicate post detected.
2. Live DataForSEO: SERP, related keywords, keyword overview.
3. Falls back to Claude for related keywords when DataForSEO returns none.
4. Scrapes top 3 organic results' headings.
5. Loads internal-link candidates from sitemap + blog index.
6. Optional GSC keyword performance fetch.
7. `generateBrief` builds the JSON brief via Claude.

## Changes

### 1. Index lookup + enrichment

After live `fetchRelatedKeywords`, call `lookupByKeyword(idx, keyword)`. If found:
- Pull cluster-mate keywords via `entriesForCluster(idx, entry, { limit: 8 })`. Merge into `relatedKeywords` (dedup by lowercased keyword text).
- Pull category-level competitors via `loadCategoryCompetitors(ROOT)[entry.cluster]?.slice(0, 5)`.

If the keyword has no entry but it normalizes to a known cluster (via the `clusterForCollection` heuristic — or a simpler one inline), still pull cluster-mates + competitors for that cluster.

### 2. Brief stamping

`generateBrief` accepts a new `indexContext` parameter. The function passes through to the brief's metadata block:

```js
brief.index_validation = {
  validation_source: 'amazon' | 'gsc_ga4' | null,
  cluster: 'deodorant' | null,
  amazon_purchases: 100 | null,
  conversion_share: 0.12 | null,
};
```

### 3. Prompt grounding

Inside the `generateBrief` Claude call, when `indexContext` has a non-null `validation_source`, inject one extra context line: `Validation: ★ Amazon-validated (X.X% conversion share)` or `Validation: ✓ GSC+GA4-validated (X conversions)`. When competitors are present, list the top 3 as a "competitors dominating this category" block.

### 4. Out of scope

- Replacing the live DataForSEO related-keywords call with index data — DataForSEO is the up-to-date source; the index is biweekly.
- Skipping the SERP scrape when the index has competitor data — they're complementary (one is keyword-specific, one is cluster-wide).

## Tests

`tests/agents/content-researcher.test.js` — new file with structure tests for the small extracted helpers:
- `mergeRelatedKeywords(live, clusterMates)` — dedup case-insensitively, preserve order, count limit.
- `buildResearchIndexContext(idx, keyword, ROOT)` — returns the bundle, returns null when index missing.

## Risk + rollout

- Risk: very low. Pure additive — fall-through behavior unchanged when no index entry exists.
- Rollout: merge → next researcher run produces enriched briefs.
