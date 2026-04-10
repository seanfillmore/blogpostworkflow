# Tier 2 — Structural SEO + Signal Loops

**Date:** 2026-04-10
**Scope:** Roadmap items 2.1, 2.2, 2.3, 2.4
**Goal:** Improve system intelligence by automating schema injection, closing collection gaps, resolving cannibalization, and feeding GA4 conversion data back into content strategy.

---

## 2.1 Product Schema at Scale

**What:** Make `product-schema` fully automatic — filter by GSC impressions, integrate Judge.me reviews into JSON-LD, run weekly in the scheduler.

**Current state:** `agents/product-schema/index.js` injects Product + CollectionPage JSON-LD into `body_html`. Manual only, processes all products/collections, no review data.

### New `--auto` mode

```bash
node agents/product-schema/index.js --auto --apply   # GSC-filtered + Judge.me reviews
node agents/product-schema/index.js --apply            # all products (existing, unchanged)
```

When `--auto`:
1. Fetch GSC data via `gsc.getQuickWinPages(500, 90)` + `gsc.getTopPages(500, 90)`
2. Build a Set of product/collection URLs with ≥50 impressions
3. Only process those products/collections (skip the rest)
4. For each product, call `fetchProductStats(handle, shopDomain, apiToken)` from `lib/judgeme.js`
5. If review data exists (reviewCount > 0), add `aggregateRating` to the Product schema:

```json
{
  "@type": "AggregateRating",
  "ratingValue": "4.8",
  "reviewCount": 12,
  "bestRating": "5",
  "worstRating": "1"
}
```

6. Inject schema as before (idempotent via `<!-- schema-injector -->` markers)

### Judge.me integration details

- Read `JUDGEME_API_TOKEN` from `.env` (already documented in CLAUDE.md)
- Shop domain from `SHOPIFY_STORE` env var
- `fetchProductStats()` returns `{ rating, reviewCount }` or `null`
- If `null` (no reviews or API error), inject Product schema without `aggregateRating` — don't skip the product

### Scheduler integration

Add to `scheduler.js` as a weekly job (Sundays only):

```javascript
// Step 6: weekly product schema injection (Sundays only)
if (new Date().getDay() === 0) {
  const schemaCmd = `"${NODE}" agents/product-schema/index.js --auto --apply`;
  // ...
}
```

### Files modified

- `agents/product-schema/index.js` — add `--auto` mode, Judge.me integration
- `scheduler.js` — add weekly schema step

---

## 2.2 Collection Keyword Gap Detector

**What:** Wire `collection-creator` to read the GSC opportunity report, queue proposed collections for approval, and auto-trigger cross-linking after creation.

**Current state:** `agents/collection-creator/index.js` scans GSC directly for commercial-intent keywords, uses Claude to evaluate, creates collections immediately with `--apply`.

### New `--from-opportunities` mode

```bash
node agents/collection-creator/index.js --from-opportunities          # dry run
node agents/collection-creator/index.js --from-opportunities --queue  # write to performance queue
node agents/collection-creator/index.js --publish-approved             # create approved collections
```

When `--from-opportunities`:
1. Read `data/reports/gsc-opportunity/latest.json` (sections: `low_ctr`, `page_2`, `unmapped`)
2. Flatten all keywords from all sections
3. Filter to commercial-intent keywords using existing `hasCollectionIntent()` function (line 147)
4. Cross-reference against existing collection handles — exclude keywords that already match a collection
5. Deduplicate by handle similarity (avoid creating "coconut-lotion" when "coconut-oil-body-lotion" exists)
6. Send top candidates to Claude for evaluation (existing `evaluateAndPlanCollections()` flow)
7. Write each proposed collection as a queue item to `data/performance-queue/`

### Queue item shape

```json
{
  "slug": "organic-coconut-lotion",
  "title": "New Collection: Organic Coconut Lotion",
  "trigger": "collection-gap",
  "signal_source": {
    "type": "gsc-collection-gap",
    "keyword": "organic coconut lotion",
    "impressions": 2500,
    "position": 15,
    "source_section": "page_2"
  },
  "proposed_collection": {
    "title": "Organic Coconut Lotion",
    "handle": "organic-coconut-lotion",
    "body_html": "<p>...</p>",
    "seo_title": "Organic Coconut Lotion | Real Skin Care",
    "seo_description": "Shop our collection of organic coconut lotions..."
  },
  "summary": {
    "what_changed": "Proposed new collection targeting 'organic coconut lotion' (2,500 impressions, position #15).",
    "why": "GSC shows commercial-intent demand with no matching collection page.",
    "projected_impact": "New collection page could capture clicks currently going to blog posts."
  },
  "resource_type": "new-collection",
  "status": "pending",
  "created_at": "2026-04-10T..."
}
```

### `--publish-approved` mode

1. Read approved `collection-gap` queue items
2. Create collection in Shopify via `createCustomCollection()`
3. Set SEO metafields via `upsertMetafield()`
4. Run `collection-linker` for the new collection handle (via `execSync`)
5. Mark queue item `status: 'published'`

### Scheduler integration

Add to `scheduler.js` as weekly (Sundays, after schema):

```javascript
// Step 7: weekly collection gap detector + publish approved
const gapCmd = `"${NODE}" agents/collection-creator/index.js --from-opportunities --queue`;
const gapPublishCmd = `"${NODE}" agents/collection-creator/index.js --publish-approved`;
```

### Files modified

- `agents/collection-creator/index.js` — add `--from-opportunities`, `--queue`, `--publish-approved` modes
- `scheduler.js` — add weekly collection gap step

---

## 2.3 Cannibalization Detection → Auto-Resolution

**What:** Automate `cannibalization-resolver` as a weekly cron, extend detection beyond blog-only URLs, add a dashboard card for conflicts.

**Current state:** `agents/cannibalization-resolver/index.js` detects blog-vs-blog cannibalization using GSC data, resolves HIGH-confidence cases. Manual only.

### Extended detection

Currently (line 122–152) filters to `/blogs/` URLs only. Extend to include `/products/` and `/collections/` URLs in detection, with intent-based resolution:

| Conflict type | Resolution |
|---|---|
| Blog vs Blog | Existing: REDIRECT / CONSOLIDATE / MONITOR (Claude triage) |
| Blog vs Collection (commercial query) | Recommend: add canonical from blog → collection, or strengthen collection content |
| Blog vs Product (commercial query) | Recommend: add canonical from blog → product |
| Collection vs Product | Recommend: MONITOR (both are commercial, different granularity) |

**Key constraint:** Only blog-vs-blog conflicts get auto-resolved with `--apply`. Cross-type conflicts are surfaced as recommendations in the report and dashboard but NOT auto-resolved (different resolution strategies, higher risk).

### New `--report-json` flag

Add a flag that writes `data/reports/cannibalization/latest.json`:

```json
{
  "generated_at": "2026-04-10T...",
  "conflict_count": 5,
  "auto_resolved": 2,
  "recommended": 3,
  "conflicts": [
    {
      "query": "coconut oil toothpaste",
      "total_impressions": 3500,
      "urls": [
        { "url": "https://.../blogs/news/coconut-toothpaste", "position": 6, "impressions": 2100, "type": "blog" },
        { "url": "https://.../products/coconut-oil-toothpaste", "position": 10, "impressions": 1400, "type": "product" }
      ],
      "resolution": "recommend-canonical-to-product",
      "confidence": "HIGH",
      "auto_applied": false
    }
  ]
}
```

### Dashboard card

Add `renderCannibalizationCard(d)` to the Optimize tab in `dashboard.js`. Reads `d.cannibalization` (loaded from `latest.json` in the data-loader). Shows:
- Conflict count badge
- List of top conflicts with query, competing URLs, positions, recommended resolution
- Simple display only — no approve/dismiss buttons (resolutions are recommendations)

### Scheduler integration

Add to `scheduler.js` as weekly (Sundays, after rank-tracker):

```javascript
// Step 8: weekly cannibalization detection
const cannCmd = `"${NODE}" agents/cannibalization-resolver/index.js --apply --report-json`;
```

### Files modified

- `agents/cannibalization-resolver/index.js` — extend detection to all URL types, add `--report-json`
- `agents/dashboard/public/js/dashboard.js` — add `renderCannibalizationCard()`
- `agents/dashboard/lib/data-loader.js` — load `cannibalization/latest.json`
- `scheduler.js` — add weekly cannibalization step

---

## 2.4 GA4 → Content Strategy Feedback Loop

**What:** New `ga4-content-analyzer` agent that classifies pages by traffic/conversion patterns, feeding signals into `content-strategist` for calendar weighting and `cro-cta-injector` for dynamic CTA targeting.

### New agent: `ga4-content-analyzer`

**Location:** `agents/ga4-content-analyzer/index.js`

**CLI:**
```bash
node agents/ga4-content-analyzer/index.js            # analyze and write report
node agents/ga4-content-analyzer/index.js --days 30  # lookback window (default 30)
```

**Flow:**
1. Read GA4 snapshots from `data/snapshots/ga4/` for the last N days
2. Aggregate per-page: total sessions, total conversions, total revenue
3. Classify each page:
   - `high-traffic-low-conversion`: ≥100 sessions/period, 0 conversions
   - `low-traffic-high-conversion`: <50 sessions/period, ≥1 conversion
   - `balanced`: everything else
4. Map pages to clusters using `data/topical-map.json` (match by URL)
5. Compute per-cluster: total sessions, total conversions, conversion rate, dominant classification
6. Write `data/reports/ga4-content-feedback/latest.json`:

```json
{
  "generated_at": "2026-04-10T...",
  "period_days": 30,
  "pages": [
    {
      "url": "https://.../blogs/news/coconut-oil-guide",
      "sessions": 850,
      "conversions": 0,
      "revenue": 0,
      "classification": "high-traffic-low-conversion",
      "cluster": "coconut-oil"
    }
  ],
  "clusters": [
    {
      "cluster": "coconut-oil",
      "total_sessions": 2400,
      "total_conversions": 3,
      "conversion_rate": 0.00125,
      "dominant_class": "high-traffic-low-conversion",
      "expansion_signal": false,
      "cro_signal": true
    }
  ],
  "cro_candidates": ["coconut-oil-guide", "best-coconut-oil-body-lotion"],
  "expansion_candidates": ["cinnamon-toothpaste-benefits"]
}
```

### Wire into `content-strategist`

Modify `loadClusterPerformance()` in `agents/content-strategist/index.js` (line 85):
- Read `data/reports/ga4-content-feedback/latest.json` if it exists
- For clusters with `expansion_signal: true` (high-conversion): add +2 to cluster weight
- For clusters with `cro_signal: true` (high-traffic, low-conversion): no weight change, but flag in output so the calendar shows these clusters need CRO, not more content

### Wire into `cro-cta-injector`

Modify `agents/cro-cta-injector/index.js`:
- Add `--from-ga4` mode that reads `ga4-content-feedback/latest.json` instead of the hardcoded `TARGETS` array
- For each `cro_candidates` slug: look up the blog post in Shopify, find the best matching collection (by topical map cluster → collection handle), build CTA, inject
- Keep existing hardcoded mode as fallback (no `--from-ga4` flag = existing behavior)

### Scheduler integration

Add to `scheduler.js` as weekly:

```javascript
// Step 9: weekly GA4 content analysis
const ga4Cmd = `"${NODE}" agents/ga4-content-analyzer/index.js`;
```

### Files created

- `agents/ga4-content-analyzer/index.js` — new agent

### Files modified

- `agents/content-strategist/index.js` — read GA4 feedback for cluster weighting
- `agents/cro-cta-injector/index.js` — add `--from-ga4` mode
- `scheduler.js` — add weekly GA4 analysis step

---

## Scheduler: Final Weekly Schedule

All Tier 2 weekly jobs run on Sundays. The scheduler already runs daily at 8 AM. The new weekly steps are added after the existing daily steps:

```
Daily (every day):
  Step 1: calendar-runner --publish-due
  Step 2: calendar-runner --run
  Step 3: link repair
  Step 4a: product-optimizer --publish-approved
  Step 4b: collection-content-optimizer --publish-approved
  Step 5: collection-linker --top-targets --apply

Weekly (Sundays only):
  Step 6: product-schema --auto --apply
  Step 7a: collection-creator --from-opportunities --queue
  Step 7b: collection-creator --publish-approved
  Step 8: cannibalization-resolver --apply --report-json
  Step 9: ga4-content-analyzer
```

---

## Signal Manifest Updates

| Signal | Writer | Consumers |
|---|---|---|
| `data/reports/cannibalization/latest.json` | `cannibalization-resolver` | dashboard Optimize tab |
| `data/reports/ga4-content-feedback/latest.json` | `ga4-content-analyzer` | `content-strategist`, `cro-cta-injector --from-ga4` |
| `data/performance-queue/<handle>.json` (trigger: `collection-gap`) | `collection-creator --from-opportunities` | dashboard, `collection-creator --publish-approved` |

Existing signal consumers to update:
- `config/ingredients.json` consumers: add `collection-creator` (for collection descriptions)
- `data/topical-map.json` consumers: add `ga4-content-analyzer` (for cluster mapping)

---

## What's NOT in scope

- Theme-level SEO audit (Tier 3 item 3.2)
- A/B testing for meta tags (Tier 3 item 3.4)
- Review sentiment analysis for product descriptions (Tier 3 item 3.1)
- Auto-publishing cannibalization resolutions for cross-type conflicts (blog vs product/collection) — these surface as recommendations only
- GA4 revenue attribution at the keyword level (GA4 doesn't provide this granularity)

---

## Success metrics (from roadmap)

| Item | Metric | Target | Timeline |
|---|---|---|---|
| 2.1 | Rich snippets in Google for top 10 products | Appearing | 14 days |
| 2.2 | New keyword-targeted collections from GSC signals | 5+ | 30 days |
| 2.3 | Same-site keyword conflicts in top 50 | Zero | 60 days |
| 2.4 | Blog-attributed conversions | +20% | 90 days |
