# GSC Query Miner Revival — Design

**Date:** 2026-07-27
**Status:** Approved, ready to plan

## Problem

`agents/gsc-query-miner` has never run on a schedule. It appears nowhere in
`scheduler.js` in the repo's entire history, and nowhere in the server crontab. The
report checked into `data/reports/gsc-query-miner/` is a tracked artifact, not evidence
of a run.

It also writes `data/reports/gsc-query-miner/untapped-candidates.json`, whose code
comment says it exists "for the next index build to ingest." Nothing ingests it.
`keyword-index-builder` reads only the prior index and the Amazon SQP dump. The file is
written and orphaned.

A live run on 2026-07-27 over a 90-day window found **50 impression leaks carrying
15,037 impressions and zero clicks**, led by `coconut lotion` (1,111 impressions,
position 30) and `coconut body lotion` (861, position 23) — commercial terms on the one
SKU with a paid engine behind it.

## Root cause: why the index cannot see impression leaks

`classifyValidationSource` in `lib/keyword-index/merge.js` admits a keyword on exactly
two conditions:

```js
if (amz && ((amz.clicks ?? 0) > 0 || (amz.purchases ?? 0) > 0)) return 'amazon';
if (!amz && ga && (ga.conversions ?? 0) > 0) return 'gsc_ga4';
return null;   // dropped
```

A keyword enters only if it has already converted — Amazon clicks/purchases, or GA4
conversions on its top-ranking page. This is a deliberate revenue-validation bar and it
is the correct default for "which queries should optimizers target."

Its structural consequence is that **an impression leak can never qualify**. Zero clicks
means no sessions from that query, which means no conversions attributable to it, which
means it is never admitted. The index is blind by construction to the exact opportunity
class the miner exists to find.

Measured against the live index: of the miner's 47 untapped candidates, **41 are absent
from the index**. The six present got in on a different signal — `coconut body lotion`
qualified because its top page (`/collections/coconut-oil-lotion`) converts on *other*
queries, not on its own merit.

This makes the untapped-candidates loop the **only** path by which a zero-click query
can reach the index. It is not redundant plumbing.

## Design

### 1. Schedule the miner

Weekly, Sundays, in `scheduler.js` immediately **before** the `keyword-index-builder`
step (currently line 233), so a fresh candidate file is on disk when the builder runs.
The builder self-paces to biweekly via `built_at`; the miner running weekly means a
candidate file is never more than 7 days old when the builder wakes.

Cost: one Anthropic call per week for the report narrative.

### 2. Builder ingests the candidates

A new input to `mergeSources`, alongside the existing Amazon and GSC maps:

```
gsc-query-miner (weekly, Sun)
  └─ untapped-candidates.json
       └─ keyword-index-builder → mergeSources({ amazon, gsc, ga4Map, clusters, untapped })
            └─ validation_source: 'gsc_untapped'
```

`classifyValidationSource` gains a third rule that fires **only when the existing two do
not**:

```js
if (amz && (clicks > 0 || purchases > 0)) return 'amazon';      // unchanged
if (!amz && ga && ga.conversions > 0)     return 'gsc_ga4';     // unchanged
if (untapped.has(key))                    return 'gsc_untapped'; // new
return null;
```

Ordering matters: no entry that qualifies today changes its source. `gsc_untapped` is
strictly additive, describing keywords that would otherwise have been dropped.

Candidates carry `keyword`, `impressions`, `position`, and `reason`
(`impression_leak` | `untapped_cluster`) from the miner. They join the index with their
GSC aggregate where one exists and `amazon: null`, `ga4: null`.

**Key normalization is not optional.** `mergeSources` keys on the output of
`normalize()` from `lib/keyword-index/normalize.js`, while the miner writes raw GSC
query text. The builder must normalize each candidate's `keyword` through the same
function when constructing the untapped set, or every lookup misses silently and the
feature reports success while admitting nothing.

### 3. The content gate

`unmappedIndexEntries` in `lib/keyword-index/consumer.js` skips entries whose
`validation_source` is `gsc_untapped`.

This is the single chokepoint where "an indexed keyword with no page" becomes "brief a
new post" — it is the only index function `content-strategist` uses for candidate
discovery. Every other consumer reads `lookupByKeyword`, `entriesForCluster`,
`clusterMatesFor`, or `topAmazonValidatedForAds`, none of which are touched.

Effect:

| Consumer | Acts on `gsc_untapped` |
|---|---|
| `meta-optimizer` | yes |
| `collection-linker` / `collection-content-optimizer` | yes |
| `refresh-runner` | yes |
| `apply-optimization`, `product-optimizer` | yes |
| `content-strategist` | **no** |

This respects the `Tracking → CRO → Offer/AOV → Traffic` gate: we harvest clicks from
impressions already earned and ship zero new pages. Reversible — deleting the skip opens
the tap when the Traffic phase starts.

Rationale beyond the phase gate: these keywords have not cleared the index's own revenue
bar. Letting unvalidated demand commission new content is how the toothpaste cluster
reached 32 pages and $0.

### 4. Two defects fixed in passing

**Display cap leaking into a data feed.** `findImpressionLeaks` applies `.slice(0, 50)`
internally, and `buildUntappedCandidates` derives from that already-truncated array. A
cap intended to keep a markdown table readable is silently bounding a machine-readable
feed. The report keeps its 50-row table; the JSON path gets the full leak set.

**Staleness.** The builder ignores `untapped-candidates.json` older than 21 days and
logs that it did. Without this, a miner that dies keeps injecting months-old demand into
every subsequent build — the exact failure mode that left this agent dormant since March
undetected.

## Error handling

- Missing `untapped-candidates.json` → builder proceeds with zero untapped keywords and
  logs it. Never fatal: the file is an enhancement, not a required input, matching how
  the BA dump is treated.
- Malformed JSON → same path as missing, with a warning. One agent's bad write must not
  break the index build.
- Miner failure → `notify` with `status: 'error'`, bypassing digest deferral. The next
  build falls back to the previous candidate file until it ages past 21 days.

## Testing

Unit, following existing patterns in `tests/lib/keyword-index/`:

- `classifyValidationSource` returns `gsc_untapped` for an untapped key with no Amazon
  and no GA4 conversions.
- `classifyValidationSource` still returns `amazon` / `gsc_ga4` when those rules fire on
  a key that is *also* in the untapped set — proving precedence and that no existing
  entry is reclassified.
- `mergeSources` admits untapped keys and stamps them, with `amazon: null` / `ga4: null`.
- `unmappedIndexEntries` excludes `gsc_untapped` while still returning `amazon` and
  `gsc_ga4` entries — the gate, asserted directly.
- Builder ignores a candidate file older than 21 days, and reads one inside the window.
- `buildUntappedCandidates` returns more than 50 candidates when the leak set exceeds 50.

Integration: one live `keyword-index-builder` run on the server after deploy, asserting
`by_validation_source.gsc_untapped > 0` and that `amazon` / `gsc_ga4` counts are
unchanged from the prior build.

## Out of scope

- The layer-2 funnel join (persona × awareness × demand × page × revenue).
- People Also Ask capture in `getSerpResults`.
- The 5,000-row GSC fetch cap in `lib/gsc.js`, which the live run hit exactly and which
  may be truncating the query set.
- **Lotion collection cannibalization** — `coconut lotion`'s 743 impressions are split
  across 8 URLs including 3 competing collections, with the PDP holding the best position
  (25) and the largest share (404). Consolidating toward the PDP is likely worth more
  revenue than this agent. Tracked separately for a subsequent session.

## Success criteria

1. `gsc-query-miner` runs weekly on the server without manual invocation.
2. A subsequent `keyword-index-builder` run reports a non-zero `gsc_untapped` count, with
   `amazon` and `gsc_ga4` counts unchanged.
3. `content-strategist`'s next brief generation contains no topic sourced from a
   `gsc_untapped` keyword.
4. At least one `gsc_untapped` keyword is picked up by `meta-optimizer` or
   `collection-linker` — proving the harvest path is live, not just the ingest path.
