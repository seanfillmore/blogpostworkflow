# gsc-query-miner → Keyword-Index Wiring (bidirectional)

**Date:** 2026-04-27
**Goal:** Tag the four miner outputs (impression leaks, near-misses, cannibalization, topic clusters) with `validation_source` from the keyword-index, and write an "untapped candidates" file the index builder can consume on its next run.

## Current state

`agents/gsc-query-miner/index.js`:
- Pulls 5000 top GSC queries + query+page rows.
- Computes: `findImpressionLeaks`, `findNearMisses`, `findCannibalization`, `buildTopicClusters`.
- Calls Claude to generate the analysis paragraph.
- Writes `data/reports/gsc-query-miner/gsc-query-mining-report.md`.

## Read-side wire-up

### 1. Annotate queries

After computing the four lists, walk each query in each list and stamp `validation_source` via `validationTag(lookupByKeyword(idx, query.keyword))`. The formatters (`formatLeaks`, `formatNearMisses`, `formatClusters`) get a `Source` column with ★ / ✓ / —.

### 2. Bias the Claude analysis prompt

Add a new line to `generateAnalysis`'s prompt summary:

```
N of these queries are Amazon-validated (marked ★) and N are GSC+GA4-validated (✓). Prioritize ★ queries first when recommending actions — Amazon validation is the strongest commercial signal we have.
```

## Write-side wire-up

### 3. Write `untapped-candidates.json` for the keyword-index builder

After miner analysis, derive the untapped-candidates set:
- Top 50 impression leaks (impressions ≥ minImpr × 2, clicks = 0) that are NOT already in `data/keyword-index.json`.
- Untapped topic clusters where the cluster has aggregate impressions > 200 and no ranking page (position > 30).

Write to `data/reports/gsc-query-miner/untapped-candidates.json`:

```json
{
  "generated_at": "...",
  "source": "gsc-query-miner",
  "candidates": [
    { "keyword": "...", "impressions": 850, "position": 42.3, "reason": "impression_leak" },
    { "keyword": "...", "impressions": 1200, "position": 35.0, "reason": "untapped_cluster" }
  ]
}
```

The keyword-index-builder is NOT modified in this PR. A separate follow-up PR will read this file and seed the next index build. (Keeps each PR scoped.)

## Out of scope

- Modifying the keyword-index-builder to consume `untapped-candidates.json` — separate spec, prerequisite is verifying this PR's output shape with real data.
- Cannibalization auto-resolver tie-in — handled by the dedicated `cannibalization-resolver` agent.

## Tests

`tests/agents/gsc-query-miner.test.js` — new file:
- `tagQueries(queries, idx)` annotates each query with validation_source.
- `buildUntappedCandidates(leaks, clusters, idx)` returns expected shape and excludes already-indexed queries.

Gate `main()` behind `import.meta.url`.

## Risk + rollout

- Risk: low. Read-side is annotation-only; write-side adds a file no other agent currently consumes.
- Rollout: merge → next 8 AM PT cron pass produces tagged report + the untapped JSON.
