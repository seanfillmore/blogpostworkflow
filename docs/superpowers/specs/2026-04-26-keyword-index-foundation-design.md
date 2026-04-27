# Keyword Index Foundation — Design

**Date:** 2026-04-26
**Status:** Spec — pending implementation plan

## Goal

Build a unified, biweekly-rebuilt `data/keyword-index.json` that serves as the single source of truth for **which queries the SEO fleet should target on the Real Skin Care Shopify website**. The index is anchored on Amazon-validated commercial intent: when Amazon BA/SQP shows that buyers click and convert on a query for our RSC ASINs, that query is a confirmed commercial target — and the index tells us our current SEO posture for it (do we rank? where? what CTR?). For queries with no Amazon signal, GSC + GA4 supply a website-side fallback so Shopify-only commercial queries are not invisible.

The end state of this spec produces the data foundation. Wiring optimizer agents to consume the new index is explicitly out of scope (see Non-goals) and will be addressed in follow-on specs.

## Success criterion

> "Every two weeks, I can open `data/keyword-index.json` and see — for every query that converts on Amazon for RSC, plus every Shopify-only converting query — the Amazon performance, our GSC posture, and the top non-RSC competitors. Optimizers reading this index have everything they need to decide where to focus."

In practice:

- The biweekly build produces an index where every entry has a `validation_source` field of either `amazon` (proven via BA/SQP) or `gsc_ga4` (proven via on-site conversion data).
- A separate `data/category-competitors.json` rolls up the dominant non-RSC competitor ASINs per cluster, weighted by query frequency × click share.
- A markdown build report at `data/reports/keyword-index/<date>.md` summarizes per-stage outcomes and anomalies.
- Existing keyword-research agent remains for ad-hoc discovery / cluster expansion but stops being the cron builder.

## Non-goals (v1)

- **Wiring optimizer agents to consume the new index.** A separate spec per consumer (or grouped) will follow once the foundation is in place. v1 produces the data; consumers come later.
- **Culina coverage.** Culina is filtered out at ingest. When Culina expands to its own site this work will be revisited as a multi-site problem; that is out of scope here.
- **Real-time / daily rebuilds.** Cadence is biweekly. We can revisit if signals end up too stale.
- **Statistical significance for thresholds.** v1 uses simple thresholds (purchases > 0, GA4 conversions > 0, GSC impressions > 100). Confidence-interval logic is later work.
- **Per-query click-stream attribution.** The GSC → GA4 join uses landing URL as the pivot; we do not attempt session-level query attribution.
- **Replacing DataForSEO discovery.** The existing keyword-research agent retains its discovery role for finding new candidate queries; this spec only handles the merge of *known* signals.

## Background — existing infrastructure being reused

- **GSC daily snapshots.** `data/snapshots/gsc/YYYY-MM-DD.json` are already collected daily by `agents/gsc-collector/`. The aggregator reads from these — no new collection.
- **GA4 daily snapshots.** `data/snapshots/ga4/YYYY-MM-DD.json` similarly already exist.
- **Amazon SP-API client.** `lib/amazon/sp-api-client.js` exists with LWA auth + request helper + Reports API helpers (request/poll/download). Brand Analytics Search Terms reports + Search Query Performance reports are already retrievable for RSC via the existing `scripts/amazon/explore-*.mjs` scripts.
- **DataForSEO client.** `lib/dataforseo.js` is already in use by the existing keyword-research agent.
- **Atomic-write pattern.** The change-log work (`lib/change-log/store.js`) established the project's atomic-JSON write pattern; this work reuses it.
- **`lib/notify.js` + daily-summary.** Existing deferred-digest pipeline. Build notifications flow through the same path.
- **`scheduler.js`.** Daily orchestrator. The new agent runs daily but self-paces to biweekly via its own `built_at` timestamp.

## Architecture

A single new agent + a small lib namespace.

### One agent

`agents/keyword-index-builder/index.js` — orchestrator. Runs 6 stages sequentially, writes outputs, emits a build report, notifies the deferred digest.

### Lib namespace

`lib/keyword-index/` — bounded units:

- `amazon-ba.js` — fetch + parse Brand Analytics Search Terms reports for the RSC marketplace.
- `amazon-sqp.js` — fetch + parse Search Query Performance reports per RSC ASIN.
- `asin-classifier.js` — classify an ASIN as RSC vs Culina via the CLAUDE.md rule (title contains `culina`/`cast iron` → Culina). Used to filter at the request layer so Culina ASINs are never queried.
- `gsc-aggregator.js` — read 8 weeks of `data/snapshots/gsc/` and aggregate per-query (sum impressions/clicks, mean position, top page).
- `ga4-aggregator.js` — read 8 weeks of `data/snapshots/ga4/` and produce per-page metrics for joining to GSC by landing URL.
- `dataforseo-enricher.js` — fill in market data (volume / difficulty / CPC / traffic potential) for keywords that pass the enrichment threshold.
- `merge.js` — the union/qualification logic that produces final entries.
- `competitors.js` — roll up Amazon competitor data per cluster.
- `normalize.js` — canonical keyword key (lowercase, trim, collapse whitespace) — needed because GSC and Amazon produce subtly different keyword text for the same query.

### Outputs

- `data/keyword-index.json` — the main index. **Replaces** the current anemic file. Tracked in git (the existing one already is).
- `data/category-competitors.json` — per-cluster Amazon competitor roll-up. New file. Tracked in git.
- `data/reports/keyword-index/YYYY-MM-DD.md` — build report listing per-stage outcomes, keyword counts, anomalies. Tracked in git.

### Cadence implementation

`scheduler.js` runs daily and invokes the agent every day. The agent reads its own `built_at` from the existing `data/keyword-index.json` and exits early with a log line if < 14 days old. A `--force` flag bypasses the check for ad-hoc rebuilds. Same self-pacing pattern that several existing agents use; avoids needing a new "biweekly" block in the scheduler.

### Existing keyword-research agent

`agents/keyword-research/index.js` is retained but **stops running on the cron**. It remains useful for ad-hoc discovery / cluster expansion (i.e., finding new candidate queries via DataForSEO that we might want to seed into the index). The Sunday cron entry that currently calls it should be removed as part of the implementation plan.

## Schema

Three concepts: the index file, per-keyword entries, and the category-competitors roll-up.

### `data/keyword-index.json` — top-level

```js
{
  built_at: "2026-04-26T15:00:00Z",
  window_days: 56,
  total_keywords: 247,
  by_validation_source: { amazon: 198, gsc_ga4: 49 },
  cluster_count: 8,
  keywords: {
    "natural-deodorant-for-women": { /* entry, see below */ },
    ...
  }
}
```

### Per-keyword entry

```js
{
  keyword: "natural deodorant for women",
  slug: "natural-deodorant-for-women",     // canonical key (output of normalize.js)
  cluster: "deodorant",                     // cluster from existing topical map / keyword-research output
  validation_source: "amazon",              // | "gsc_ga4" — which pathway qualified this entry

  // Amazon side — present iff BA/SQP had data on RSC ASINs for this query.
  amazon: {
    search_frequency_rank: 12345,           // BA — lower is better
    impressions: 8200,                      // SQP — sum across RSC ASINs
    clicks: 480,
    add_to_cart: 96,
    purchases: 142,
    cvr: 0.296,                             // purchases / clicks
    asins: [                                // RSC ASINs that received traffic for this query
      { asin: "B0...", clicks: 220, purchases: 78 }
    ],
    competitors: [                          // non-RSC ASINs ranked by BA
      {
        asin: "B0...",
        brand: "Native",
        click_share: 0.18,
        conversion_share: 0.21
      }
    ]
  } | null,

  // GSC side — present iff there is any visibility for this query in the window.
  gsc: {
    impressions: 2400,
    clicks: 96,
    ctr: 0.04,
    position: 14.2,                         // mean across the window
    top_page: "/products/natural-deodorant-women",
    pages: [                                // up to N pages that ranked for this query
      { url, impressions, clicks, position }
    ]
  } | null,

  // GA4 side — joined to GSC by landing URL; sums across the window.
  ga4: {
    sessions: 480,
    conversions: 28,
    page_revenue: 1240.00
  } | null,

  // Market data — populated by DataForSEO enrichment for entries that pass the threshold.
  market: {
    volume: 1100,
    keyword_difficulty: 12,
    cpc: 1.4,
    traffic_potential: 4200,
    enriched_at: "2026-04-26T15:00:00Z"
  } | null
}
```

Two notes:

1. **`amazon` and `gsc` are independently nullable.** Amazon-validated entries usually have GSC data too — the two are not mutually exclusive, just qualifying-source distinct. `gsc_ga4`-validated entries always have null `amazon` (that is the definition).
2. **`market` is nullable.** DataForSEO is paid per call, so we only enrich entries that pass a threshold (Amazon `purchases > 0` OR GSC `impressions > 100`) to bound spend.

### `data/category-competitors.json`

```js
{
  built_at: "2026-04-26T15:00:00Z",
  window_days: 56,
  clusters: {
    "deodorant": {
      total_purchases: 8400,                // RSC purchases summed across cluster keywords
      keyword_count: 12,                     // keywords in this cluster with Amazon data
      competitors: [
        {
          asin: "B0...",
          brand: "Native",
          weighted_click_share: 0.18,        // weighted by query purchases × click share
          weighted_conversion_share: 0.21,
          appears_in_keywords: 11
        }
      ]
    }
  }
}
```

Qualitatively different from Ahrefs/DataForSEO competitor data: those tell you "who else *ranks* for keywords you target" (SEO competitors). This tells you "who Amazon shoppers *actually choose* over you for converting queries" (commercial competitors).

## Build flow

A single agent run, with a self-pace check at the front, six numbered stages, and an atomic write step at the back.

1. **Self-pace check.** Read existing `keyword-index.json` `built_at`. If < 14 days old, log and exit 0. `--force` bypasses.
2. **Stage 1: Amazon ingest.** Pull BA Search Terms (8-week window) + SQP per RSC ASIN. Filter Culina at the request layer (only request RSC ASINs after `asin-classifier.js` filters the catalog). Output: `{ keyword → amazon signals + competitors }`.
3. **Stage 2: GSC ingest.** Read 56 days of `data/snapshots/gsc/*.json`. Per-query aggregation: sum impressions/clicks, mean position, top page (the URL with most clicks for this query in the window).
4. **Stage 3: GA4 join.** Read 56 days of `data/snapshots/ga4/*.json`. For each GSC query's `top_page`, sum sessions/conversions/page_revenue. Attach to the GSC map as `ga4` sub-object.
5. **Stage 4: Merge.** Union the keyword keys from Amazon and GSC (canonicalized via `normalize.js`). For each keyword:
   - **Amazon-qualified** (validation_source = `amazon`) if `amazon.purchases > 0 OR amazon.clicks > 0`.
   - **GSC-qualified** (validation_source = `gsc_ga4`) if no Amazon signal AND `ga4.conversions > 0`.
   - Otherwise, drop. (No qualifying signal.)
6. **Stage 5: DataForSEO enrich.** For entries passing the enrichment threshold (Amazon `purchases > 0` OR GSC `impressions > 100`), fetch `volume / keyword_difficulty / cpc / traffic_potential` via DataForSEO. Skip on rate-limit or budget cap.
7. **Stage 6: Competitor roll-up.** Per cluster, aggregate non-RSC competitor ASINs across all cluster keywords. For each (cluster, competitor ASIN) pair:
   - `weighted_click_share = Σ over cluster keywords of (RSC purchases for keyword × competitor's click_share for keyword) / Σ (RSC purchases for keyword)`
   - `weighted_conversion_share` is the same formula with `conversion_share` instead of `click_share`.
   - The intent: a competitor showing up in many high-revenue keywords with high click share should outrank one showing up in low-revenue keywords. Top N (default 10) per cluster.
8. **Write outputs atomically.** `data/keyword-index.json`, `data/category-competitors.json`, `data/reports/keyword-index/<date>.md`. Use temp-then-rename so a mid-build failure cannot corrupt previous outputs. Notify via deferred digest.

## Error handling

- **Per-stage isolation.** Stage 1 failure → log, continue with GSC-only build, mark report "degraded — Amazon data unavailable". Stage 2 failure → no fallback; abort the build (keep the previous index intact). DataForSEO failure during Stage 5 → silent skip; affected entries get `market: null`.
- **Atomic outputs.** Write to `<file>.tmp-<pid>-<ts>` then `rename` to final path. The previous index stays valid through any mid-build failure.
- **Notify status escalation.** Errors from Amazon (Stage 1) or GSC (Stage 2) → `notify({ status: 'error' })` so they bypass the deferred digest and email immediately. Anomaly-only outcomes (e.g., total keyword count drops by 50%+ from the prior build) → warning in the digest, build still completes.
- **Build report.** Markdown listing per-stage success/failure, keyword counts at each stage, anomalies, the entries that just qualified or just dropped since the prior build. Surfaced in the dashboard's reports tab.

## Testing

- **Unit tests per `lib/keyword-index/*` module** against fixture inputs:
  - `normalize.test.js` — case / whitespace / punctuation edge cases.
  - `asin-classifier.test.js` — `culina`, `cast iron`, generic RSC, ambiguous title.
  - `gsc-aggregator.test.js` — fixture snapshots covering the date range; verify aggregation math.
  - `ga4-aggregator.test.js` — same shape against fixture snapshots; verify URL-join logic.
  - `merge.test.js` — every combination of source presence/absence: Amazon-only, GSC-only, both, neither (drop).
  - `competitors.test.js` — weighted roll-up math.
  - `amazon-ba.test.js` + `amazon-sqp.test.js` — parsing fixture report files (sanitized real responses).
- **Integration test** — build a complete small index from canned fixtures (BA + SQP + GSC + GA4 + DataForSEO mock) and assert both output files conform to schema and counts add up.
- **Fixtures** live under `tests/fixtures/keyword-index/`. Real BA/SQP responses are sanitized (ASINs anonymized, brands replaced) and saved as fixtures from existing `scripts/amazon/explore-*.mjs` runs.
- **No live API calls in tests.** Amazon, GSC, GA4, DataForSEO clients are all replaced with fixtures in unit tests; the integration test uses local files only.

## Risks and open questions

- **Amazon report job latency.** SQP reports are async — request, poll, download. The biweekly cadence absorbs this, but the agent must handle the case where a report job times out (Stage 1 partial-failure path).
- **GSC keyword vs Amazon keyword text mismatch.** `normalize.js` handles common cases (case, whitespace) but query text from the two sources may differ in non-trivial ways (apostrophes, plurals, brand spellings). Risk: same logical keyword appears as two entries. Mitigation: build report flags suspiciously similar pairs (Levenshtein < 3) so we can iterate `normalize.js` on observed cases.
- **DataForSEO budget.** Even with the enrichment threshold, ~200 entries × biweekly = ~5K calls/year. Need to confirm this fits the existing DataForSEO subscription's call budget. If not: lower threshold or add caching by keyword.
- **Sparse Amazon data on low-volume queries.** A keyword with 1 purchase in the window passes `purchases > 0` but is high-noise. v1 accepts the noise; v2 may add a minimum `purchases ≥ 3` or similar.
- **Cluster assignment for new entries.** New keywords arriving via Amazon may not match any existing cluster. The merge step needs a fallback (assign to the closest cluster by topical-map similarity, or to a new `unclustered` bucket flagged in the build report). Decision deferred to the implementation plan.
- **GA4 attribution lag.** GA4 data is typically T-2 to T-3 days. Stage 3 should read from snapshots ≥ 3 days old to avoid attributing to a partial-day's data; the 56-day window absorbs this naturally.

## References

- Existing builder (to be retired from cron): `agents/keyword-research/index.js`
- Existing snapshots: `data/snapshots/{gsc,ga4}/YYYY-MM-DD.json`
- Existing Amazon client: `lib/amazon/sp-api-client.js`
- Existing Amazon exploration scripts: `scripts/amazon/explore-{brand-analytics,search-query-performance-rsc,sales-traffic}.mjs`
- Existing DataForSEO client: `lib/dataforseo.js`
- Atomic-write pattern: `lib/change-log/store.js` (from the change-log + outcome-attribution work, 2026-04-25)
- Notification pipeline: `lib/notify.js` + `agents/daily-summary/`
- ASIN brand classification rule: `CLAUDE.md` § Brand Context
