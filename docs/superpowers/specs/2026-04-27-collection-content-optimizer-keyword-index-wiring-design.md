# collection-content-optimizer → Keyword-Index Wiring

**Date:** 2026-04-27
**Goal:** Map each candidate collection to a keyword-index cluster, prefer collections whose cluster has Amazon-validated demand, and ground Claude's 300–500 word descriptions in cluster-mate keywords + category-level competitors.

## Current state

`agents/collection-content-optimizer/index.js`:
- Fetches custom + smart Shopify collections.
- Filters out housekeeping handles + ones flagged by title patterns.
- Calls `gsc.getPagePerformance` per URL.
- `selectCollectionCandidates` keeps only collections with `impressions ≥ 500` AND (position > 10 OR ctr < 0.005), not already in the queue. Sorts by impressions desc, slices top N.
- Per candidate: pulls top GSC queries, finds related blog posts (via topical-map) and matching ingredients (via ingredients.json), then `generateCollectionContent` calls Claude.
- With `--queue`, writes a `data/performance-queue/<handle>.json` item for human approval.

After agents #1 + #2 merged, `lib/keyword-index/consumer.js` exposes `loadIndex`, `lookupByKeyword`, `lookupByUrl`, `validationTag`, and `clusterMatesFor`.

## Changes

### 1. New consumer helpers

Add to `lib/keyword-index/consumer.js`:

```js
// Returns up to `limit` entries from `index.keywords` where cluster matches,
// sorted by amazon.purchases desc, then gsc.impressions desc.
export function entriesForCluster(index, cluster, { limit = 8 } = {})

// Reads data/category-competitors.json, returns the per-cluster competitor
// roll-up { [cluster]: [{ domain, appearances, avg_position }, ...] }.
// Returns {} when the file is missing.
export function loadCategoryCompetitors(rootDir)
```

Both pure, both TDD'd.

### 2. New per-agent helper: cluster-for-collection mapper

`agents/collection-content-optimizer/lib/cluster-mapper.js`:

```js
// Given a collection (with handle + title) and a keyword-index, return the
// best-matching cluster slug or null. Heuristic: tokenize handle + title,
// count matches against each cluster's keyword strings, pick the cluster
// with the most matches (≥2 token hits required).
export function clusterForCollection(collection, index)
```

TDD'd. The threshold (≥2 token hits) prevents random single-word matches like "soap" mapping a "soap-dish" collection to the soap cluster.

### 3. Sort change

After `selectCollectionCandidates`, re-sort with cluster-validation as the primary key:

```js
const ranked = candidates.map((c) => ({
  ...c,
  cluster: clusterForCollection(c, idx),
})).sort((a, b) => {
  const av = clusterIsAmazonValidated(idx, a.cluster) ? 0 : 1;
  const bv = clusterIsAmazonValidated(idx, b.cluster) ? 0 : 1;
  if (av !== bv) return av - bv;
  return b.gsc.impressions - a.gsc.impressions;
});
```

`clusterIsAmazonValidated` is a small inline predicate: `entriesForCluster(idx, cluster).some((e) => e.validation_source === 'amazon')`.

We do NOT hard-filter out non-validated clusters. The index is comprehensive but young; gating on Amazon validation might starve the queue. Bias instead.

### 4. Prompt grounding

In `generateCollectionContent`, add two new prompt sections (only when populated):

```
CLUSTER-MATE QUERIES (other terms this collection should surface for):
- aluminum free deodorant
- natural roll-on deodorant
- ...

COMPETITORS DOMINATING THIS CLUSTER:
- drbronner.com (avg position 3 across 4 cluster queries)
- ...
```

Cluster-mates from `entriesForCluster(idx, cluster, { limit: 8 })`. Competitors from `loadCategoryCompetitors(ROOT)[cluster]?.slice(0, 3)`.

When `idx` is null OR the candidate has no mapped cluster, both sections are omitted — the prompt is byte-identical to today's.

### 5. Queue item gets `validation_source`

The queue item written for human review gets `validation_source: clusterIsAmazonValidated(...) ? 'amazon' : null`. The dashboard "approve" UI can highlight ★ items as higher-priority.

### 6. Out of scope

- Cluster v2 (similarity-based) — separate spec, would replace the heuristic mapper.
- Replacing `findRelatedBlogPosts` with index-driven internal-link suggestions.
- Live-fetching DataForSEO competitors when `category-competitors.json` is missing.

### 7. Risk + rollout

- Risk: low. Sort change can shuffle the daily candidate list; queue items are still human-approval gated.
- Rollout: merge → next 8 AM PT cron pass produces grounded queue items with cluster-aware ordering.
- Verdict window: queue items already feed change-log when applied; the new `validation_source` field rides the same rails.

## Tests

**`tests/lib/keyword-index/consumer.test.js`** — extend with `entriesForCluster` and `loadCategoryCompetitors`.

**`tests/agents/collection-content-optimizer.test.js`** — new file with structure tests for `clusterForCollection` and a sort-ordering test for the candidate re-ranking helper.

The agent's `main()` is gated behind `import.meta.url` so the test can import from `agents/collection-content-optimizer/index.js`.
