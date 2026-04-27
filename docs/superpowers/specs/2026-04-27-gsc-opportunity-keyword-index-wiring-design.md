# gsc-opportunity → Keyword-Index Wiring

**Date:** 2026-04-27
**Goal:** Annotate the daily GSC opportunity report with `validation_source` from `data/keyword-index.json`, re-rank the "unmapped" section to surface Amazon-validated content candidates first, and bias the calendar inbox push the same way.

## Current state

`agents/gsc-opportunity/index.js` produces three sections daily:
- **Low-CTR** — impressions ≥ 100, CTR ≤ 2%, sorted by impressions.
- **Page-2** — positions 11–20, sorted by impressions.
- **Unmapped** — high-impression queries no existing brief/post targets, sorted by impressions.

It builds an internal "keywords already covered" set from `data/briefs/*.json` and `data/posts/*/meta.json` (function `loadKeywordIndex` — name now misleading). The "unmapped" section is `lowCTR ∩ ¬covered`. Outputs:
- `data/reports/gsc-opportunity/YYYY-MM-DD.md` (human report)
- `data/reports/gsc-opportunity/latest.json` (machine consumers + digest)
- Top-15 unmapped → `data/calendar.json` ideas inbox (`source: 'gsc_opportunity'`)

## Semantic mismatch (why it matters)

The existing `loadKeywordIndex()` returns "queries we already cover." The new `data/keyword-index.json` contains "queries we should target," anchored on Amazon validation. These are different sets:
- A query can be in the new index but not yet covered (highest priority — Amazon validates demand AND we lack content).
- A query can be covered but not in the new index (we wrote about it but Amazon doesn't validate it commercially).

The wire-up keeps both, with clear naming.

## Changes

### 1. Rename in-agent function

`loadKeywordIndex()` → `loadCoveredKeywords()`. Returns the same Set; only the name changes. The `isMapped()` helper that consumes it stays as-is (substring matching remains the right behavior for "do we already cover this").

### 2. New shared lib: `lib/keyword-index/consumer.js`

Public API (TDD'd):

```js
// Load and cache data/keyword-index.json. Returns null if not built yet.
export function loadIndex(rootDir = ROOT): { keywords, ... } | null

// Find an entry by raw keyword string. Tries exact match first, then
// normalized-slug match, then case-insensitive. Returns the entry or null.
export function lookupByKeyword(index, keyword): IndexEntry | null

// Find an entry by GSC top_page URL. Returns the entry or null.
// (Used by meta-optimizer + others later.)
export function lookupByUrl(index, url): IndexEntry | null

// Returns 'amazon' | 'gsc_ga4' | null for an index entry (null if no entry).
export function validationTag(entry): 'amazon' | 'gsc_ga4' | null
```

Implementation notes:
- `loadIndex` reads `data/keyword-index.json` once per process, caches in module scope. Returns `null` (not throw) when the file doesn't exist — agents must degrade gracefully on first run before the builder has produced output.
- `lookupByKeyword` normalizes via the same slug rules as the builder (`lib/keyword-index/normalize.js`).
- All four helpers are pure and synchronous (the load is sync — file is small enough).

### 3. Report annotation + re-rank

Add a `Source` column to all three section tables. Symbols:
- `★` — entry has `validation_source === 'amazon'`
- `✓` — entry has `validation_source === 'gsc_ga4'`
- `—` — no index entry for this keyword

Tables become:

```
| Query | Impressions | Clicks | CTR | Position | Source |
```

Sort behavior:
- **Low-CTR**: unchanged (by impressions desc). Source is informational only.
- **Page-2**: unchanged (by impressions desc). Source is informational only.
- **Unmapped**: re-sort to `[★ rows by impressions desc, then ✓ and — rows by impressions desc]`. The ★ block becomes the top of the table.

### 4. Calendar inbox push

Currently pushes `unmapped.slice(0, 15)`. With the re-sorted `unmapped`, this naturally biases toward Amazon-validated. Add to each upserted item:

```js
{ ..., validation_source: tag }   // 'amazon' | 'gsc_ga4' | null
```

Downstream consumers (content-strategist next) read this to prioritize.

### 5. `latest.json` changes

Each row in `low_ctr`, `page_2`, `unmapped` arrays gains a `validation_source` field. Existing fields unchanged. Digest agent reads this to flag ★ count in the daily summary.

## Tests

**`tests/lib/keyword-index/consumer.test.js`** — pure unit tests for the four helpers:
- `loadIndex` returns null when file missing
- `loadIndex` parses valid JSON
- `lookupByKeyword` exact match
- `lookupByKeyword` normalized-slug match
- `lookupByKeyword` case-insensitive fallback
- `lookupByKeyword` miss returns null
- `lookupByUrl` matches `gsc.top_page`
- `lookupByUrl` miss returns null
- `validationTag` returns 'amazon', 'gsc_ga4', or null

**`tests/agents/gsc-opportunity.test.js`** (extend if exists, create if not) — structure tests:
- Renamed `loadCoveredKeywords` still returns covered-set behavior.
- New annotation pipeline: given a fixture index + fixture GSC rows, the resulting tables have correct Source column values.
- Unmapped re-rank: ★ rows precede non-★ rows in the unmapped output.
- Calendar inbox upserts include `validation_source`.

## Out of scope

- Cleaning up the substring `isMapped` matcher — it's a separate concern.
- Cluster-aware grouping in the report — wait for index v2 clustering.
- Dashboard surfacing of ★ counts — separate spec.
- Backfilling historical reports — only forward-going reports get the new schema.

## Risk + rollout

- Risk: low. Pure additive — agent still produces a valid report when the index file is missing (helpers return null, Source column shows `—` everywhere).
- Rollout: merge → next morning's 6:30 AM PT cron run produces the annotated report. No server-side migration.
- Verdict window: not applicable — read-only agent; nothing to attribute.
