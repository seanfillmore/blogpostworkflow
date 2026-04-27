# meta-optimizer → Keyword-Index Wiring

**Date:** 2026-04-27
**Goal:** Ground meta-optimizer's title/meta rewrites in the keyword-index by (a) prioritizing Amazon-validated candidates within the daily processing limit, and (b) passing cluster-mate keywords + validation tag to Claude as additional rewrite context.

## Current state

`agents/meta-optimizer/index.js` flow:
1. Read `data/reports/gsc-opportunity/latest.json` for low-CTR queries (already rejection-filtered). Falls back to live GSC if missing.
2. Map each query to a page URL via `getQuickWinPages` (returns `keyword → top page URL`).
3. Filter to blog posts, look up Shopify article, skip legacy-locked.
4. Call `rewriteMeta(currentTitle, currentMeta, keyword, position, impressions, ctr)` — Claude returns `{ title, meta_description }`.
5. With `--apply`: update Shopify, write A/B baseline to `data/reports/meta-ab/meta-ab-tracker.json` (change-log + 28-day attribution + auto-revert already wired).
6. Stale-years mode (`--refresh-stale-years`) is orthogonal — deterministic regex pass, no LLM.

After agent #1 merged, `latest.json` rows already include a `validation_source` field. Meta-optimizer doesn't yet use it.

## Changes

### 1. Sort the candidate list ★-first before applying `--limit`

Replace the current "process in array order until `processed >= limitArg`" loop with:

```js
const sortedCandidates = sortByValidation(lowCtrPages);
```

`sortByValidation` is a new pure helper in `agents/meta-optimizer/lib/sort.js`:
- Amazon-validated rows first, sorted by impressions desc.
- Then GSC-only and untagged rows, also by impressions desc.
- Stable sort within each band.

Rationale: the daily `--limit` (default 25) should land on the queries Amazon validates as commercially worth winning, not just the highest-impression ones.

This works whether the rows came from `latest.json` (which has `validation_source`) or from the live-GSC fallback (which does not — those rows simply land in the un-validated band).

### 2. Look up index entry per candidate, build prompt context

Inside the candidate loop, after we have the `keyword`:

```js
const idx = loadIndex(ROOT);  // hoisted before loop, called once
const indexEntry = lookupByKeyword(idx, keyword);
const clusterMates = clusterMatesFor(idx, indexEntry, { limit: 6, excludeSelf: true });
```

`clusterMatesFor` is a new helper added to `lib/keyword-index/consumer.js`:

```js
// Return up to `limit` other entries in the same cluster, sorted by
// (amazon.purchases ?? 0) desc, then (gsc.impressions ?? 0) desc.
// Returns [] when index is null, entry is null, or cluster is 'unclustered'.
export function clusterMatesFor(index, entry, { limit = 6, excludeSelf = true } = {})
```

Reasoning for `excludeSelf`: the prompt already includes the target keyword separately; including it in the cluster list would be noise.

### 3. Extend `rewriteMeta` to accept optional grounding context

New signature:

```js
async function rewriteMeta(currentTitle, currentMeta, keyword, position, impressions, ctr, ground)
```

`ground` is `{ validationTag, conversionShare, clusterMateKeywords }` or `null`. When present, the Claude prompt gets two extra lines (only the ones that apply):

```
This query is Amazon-validated (★ — verified commercial demand).
Cluster-mates this page should also surface for: <kw1>, <kw2>, ...
```

`ground` is plumbed in only when `indexEntry` is non-null. The prompt change is additive — when `ground` is null, the prompt is byte-identical to today's.

### 4. Stamp `validation_source` into the A/B tracker baseline

When `--apply` writes to `data/reports/meta-ab/meta-ab-tracker.json`, include `validation_source: indexEntry?.validation_source ?? null` on each new entry. Improves outcome-attribution analysis later (which validation tier produced the strongest CTR lifts).

### 5. Stale-years mode untouched

`--refresh-stale-years` is orthogonal regex work and does not need keyword-index grounding. Skip.

## New helper: `clusterMatesFor`

Goes into `lib/keyword-index/consumer.js` (the consumer-side module created in agent #1's PR).

```js
export function clusterMatesFor(index, entry, { limit = 6, excludeSelf = true } = {}) {
  if (!index?.keywords || !entry?.cluster || entry.cluster === 'unclustered') return [];
  const mates = [];
  for (const e of Object.values(index.keywords)) {
    if (!e || e.cluster !== entry.cluster) continue;
    if (excludeSelf && e.slug === entry.slug) continue;
    mates.push(e);
  }
  mates.sort((a, b) => {
    const ap = (a.amazon?.purchases ?? 0) - (b.amazon?.purchases ?? 0);
    if (ap !== 0) return -ap;
    const gi = (a.gsc?.impressions ?? 0) - (b.gsc?.impressions ?? 0);
    return -gi;
  });
  return mates.slice(0, limit);
}
```

## Tests

**`tests/lib/keyword-index/consumer.test.js`** — extend with `clusterMatesFor` cases:
- Returns [] when index is null.
- Returns [] when entry is null.
- Returns [] when entry.cluster is 'unclustered'.
- Excludes self when excludeSelf is true.
- Includes self when excludeSelf is false.
- Sorts by amazon.purchases desc, then gsc.impressions desc.
- Respects limit.

**`tests/agents/meta-optimizer.test.js`** — new file with structure tests for the pure helpers:
- `sortByValidation` orders amazon → others, by impressions desc within band.
- `sortByValidation` is stable.
- `buildPromptGrounding` (extracted helper, see below) returns null when no index entry, populated object when entry exists.

To make the agent testable, extract two pure helpers:
- `sortByValidation(rows)` — into `agents/meta-optimizer/lib/sort.js`.
- `buildPromptGrounding(indexEntry, clusterMates)` — into `agents/meta-optimizer/lib/grounding.js`. Returns `{ validationTag, conversionShare, clusterMateKeywords }` or `null` when entry is null.

The agent imports both. `rewriteMeta` consumes the grounding object.

Add the same `import.meta.url`-gated `main()` invocation pattern as gsc-opportunity so the test file can `import` from `agents/meta-optimizer/index.js` without firing live API calls.

## Out of scope

- Replacing `getQuickWinPages` with the index's `gsc.top_page` field — index is biweekly; live data is fresher.
- Cluster-aware grouping of the daily processing list — wait for index v2 clustering.
- Grounding the stale-years pass.
- New CLI flags or new modes.

## Risk + rollout

- Risk: low. All grounding is additive to the prompt; sort changes the order of processing within an existing limit but doesn't touch what gets written to Shopify (each rewrite is its own decision).
- Rollout: merge → next 8 AM PT cron run produces grounded rewrites.
- Verdict window: change-log + meta-ab-tracker already wired; stamping `validation_source` on the baseline gives us per-tier attribution by the next 28-day window.
