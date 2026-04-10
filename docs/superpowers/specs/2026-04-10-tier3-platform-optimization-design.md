# Tier 3 — Platform-Level Optimization

**Date:** 2026-04-10
**Scope:** Roadmap items 3.1, 3.2, 3.3, 3.4
**Goal:** Add review monitoring, theme-level SEO auditing, static page optimization, and automated A/B testing for meta tags across all page types.

---

## 3.1 Review/UGC Integration

**What:** New `review-monitor` agent for daily review pulling from Judge.me, sentiment flagging in the morning digest, and review-aware product descriptions.

**Current state:** `lib/judgeme.js` has `fetchTopReview()` and `fetchProductStats()`. `product-schema --auto` already integrates AggregateRating. `featured-product-injector` uses review quotes. No agent monitors reviews or flags negatives.

### New agent: `review-monitor`

**Location:** `agents/review-monitor/index.js`

**CLI:**
```bash
node agents/review-monitor/index.js           # pull and report
node agents/review-monitor/index.js --days 1  # lookback window (default 1)
```

**Flow:**
1. Fetch all reviews from Judge.me via `fetchProductReviews()` pattern (lib already handles pagination)
2. Filter to reviews from the last N days (by `created_at` field)
3. For each new review: extract product handle, rating, reviewer name, body snippet
4. Classify: positive (4–5 stars), neutral (3 stars), negative (1–2 stars)
5. For negative reviews: extract key complaint themes using simple keyword matching (not Claude — too expensive for daily runs). Patterns: "thick", "greasy", "smell", "irritat", "burn", "broke out", "rash", "sticky"
6. Write `data/reports/reviews/latest.json`:

```json
{
  "generated_at": "2026-04-10T...",
  "period_days": 1,
  "new_reviews": [
    {
      "product_handle": "coconut-lotion",
      "product_title": "Coconut Lotion",
      "rating": 5,
      "reviewer": "Jane D.",
      "body": "Love this lotion! Not greasy at all...",
      "verified": true,
      "sentiment": "positive"
    }
  ],
  "summary": {
    "total_new": 3,
    "positive": 2,
    "neutral": 0,
    "negative": 1,
    "flagged_for_response": [
      {
        "product_handle": "coconut-soap",
        "rating": 2,
        "complaint": "Causes irritation on sensitive skin",
        "themes": ["irritat"]
      }
    ]
  },
  "product_sentiment": {
    "coconut-lotion": { "avg_rating": 4.8, "review_count": 12, "negative_themes": [] },
    "coconut-soap": { "avg_rating": 3.5, "review_count": 8, "negative_themes": ["irritat", "rash"] }
  }
}
```

### Wire into daily-summary

Add a "Reviews" section to `agents/daily-summary/index.js`:
- Read `data/reports/reviews/latest.json`
- If new positive reviews: "3 new reviews (2 positive, 1 negative)"
- If negative reviews flagged: highlight with product name and complaint snippet
- Remove `'meta a/b'` and `'meta-ab'` from `SILENT_ON_SUCCESS` — they should surface now with A/B test results

### Wire into product-optimizer

When `product-optimizer` rewrites a product description (in any mode), check `data/reports/reviews/latest.json` for the product. If `negative_themes` exist, add a line to the Claude prompt:

```
REVIEW FEEDBACK: Customers have mentioned concerns about: [themes].
Address these concerns naturally in the description (e.g., if "thick" → mention lightweight/fast-absorbing).
```

### Scheduler integration

Add to `scheduler.js` daily steps (after collectors, before calendar-runner):

```
Step 0: review-monitor (daily)
```

### Files

- Create: `agents/review-monitor/index.js`
- Modify: `agents/daily-summary/index.js` — add Reviews section
- Modify: `agents/product-optimizer/index.js` — add review sentiment to rewrite prompts
- Modify: `scheduler.js` — add daily review-monitor step
- Modify: `lib/judgeme.js` — add `fetchRecentReviews(days, shopDomain, apiToken)` that returns all reviews from the last N days across all products

---

## 3.2 Shopify Theme-Level SEO Audit

**What:** New `theme-seo-auditor` agent using Puppeteer + Lighthouse to audit one representative URL per template type.

**Current state:** Nothing exists. Puppeteer is already a project dependency (used by `competitor-intelligence`).

### New agent: `theme-seo-auditor`

**Location:** `agents/theme-seo-auditor/index.js`

**CLI:**
```bash
node agents/theme-seo-auditor/index.js            # run full audit
node agents/theme-seo-auditor/index.js --type product  # single template type
```

**Dependencies:** `puppeteer`, `lighthouse` (npm packages — puppeteer already installed, lighthouse needs to be added)

**Flow:**

1. **Select representative URLs** — one per template type:
   - Homepage: `config.url`
   - Product: `config.url + '/products/' + firstProductWithImpressions.handle`
   - Collection: `config.url + '/collections/' + firstCollectionWithImpressions.handle`
   - Blog post: `config.url + '/blogs/news/' + firstPublishedArticle.handle`
   - Page: `config.url + '/pages/' + firstPage.handle`

2. **For each URL, launch Puppeteer and:**

   a. **DOM audit** (parse rendered HTML):
   - **H1 count:** Exactly 1 per page. Flag if 0 or >1.
   - **Heading hierarchy:** H2s follow H1, H3s follow H2, etc. Flag skipped levels.
   - **Canonical tag:** `<link rel="canonical">` present, href matches current URL (not a different page).
   - **Open Graph:** `og:title`, `og:description`, `og:image`, `og:url` all present.
   - **Twitter Card:** `twitter:card`, `twitter:title`, `twitter:description` present.
   - **Mobile viewport:** `<meta name="viewport">` with `width=device-width`.
   - **Structured data:** Count `<script type="application/ld+json">` blocks, validate JSON parses.
   - **Image alt text:** Count images, count images with non-empty `alt`. Report coverage %.

   b. **Lighthouse audit** (via `lighthouse` npm package with Puppeteer):
   - Categories: `performance`, `seo`, `accessibility`
   - Extract: overall scores, Core Web Vitals (LCP, CLS, TBT), specific audit failures
   - Use mobile emulation (Lighthouse default)

3. **Output:** Write two files:
   - `data/reports/theme-seo-audit/latest.json` — machine-readable results per template
   - `data/reports/theme-seo-audit/theme-seo-audit.md` — human-readable markdown report

### JSON output shape

```json
{
  "generated_at": "2026-04-10T...",
  "templates": {
    "homepage": {
      "url": "https://www.realskincare.com",
      "dom_audit": {
        "h1_count": 1,
        "heading_hierarchy_valid": true,
        "canonical_present": true,
        "canonical_correct": true,
        "og_tags": { "title": true, "description": true, "image": true, "url": true },
        "twitter_tags": { "card": true, "title": true, "description": true },
        "viewport_present": true,
        "structured_data_count": 2,
        "image_count": 15,
        "images_with_alt": 12,
        "alt_coverage": 0.8
      },
      "lighthouse": {
        "performance": 72,
        "seo": 91,
        "accessibility": 85,
        "lcp_ms": 2400,
        "cls": 0.05,
        "tbt_ms": 350,
        "failures": ["Links do not have descriptive text", "Image elements do not have [alt] attributes"]
      },
      "issues": [
        { "severity": "warning", "message": "3 images missing alt text (80% coverage)" },
        { "severity": "info", "message": "Performance score 72 — LCP 2.4s (target <2.5s)" }
      ]
    }
  },
  "summary": {
    "total_issues": 5,
    "critical": 0,
    "warning": 3,
    "info": 2
  }
}
```

### Scheduler integration

Monthly — 1st of the month:

```javascript
if (new Date().getDate() === 1) {
  // Step 10: monthly theme SEO audit
  const themeCmd = `"${NODE}" agents/theme-seo-auditor/index.js`;
  // ...
}
```

### Files

- Create: `agents/theme-seo-auditor/index.js`
- Modify: `scheduler.js` — add monthly theme audit step
- Modify: `package.json` — add `lighthouse` dependency + npm script

---

## 3.3 Shopify Page Optimization

**What:** Extend `product-optimizer` to handle `/pages/*` URLs with GSC-driven meta rewrites and FAQ content expansion.

**Current state:** `lib/shopify.js` has `getPages()`/`updatePage()`. `product-optimizer --from-gsc` handles products only.

### New `--pages-from-gsc` flag

```bash
node agents/product-optimizer/index.js --pages-from-gsc              # queue page meta rewrites
node agents/product-optimizer/index.js --pages-from-gsc --dry-run    # show candidates
```

**Flow:**
1. Fetch all pages via `getPages()`
2. Build URL → GSC map (same as `--from-gsc` but for `/pages/*` URLs)
3. Filter: ≥50 impressions, CTR < 2% (higher threshold than products since pages have brand queries)
4. For each page: call `gsc.getPageKeywords(url, 10, 90)`, call Claude for meta-only rewrite
5. Queue through performance-queue with trigger `page-meta-rewrite`
6. `--publish-approved` pushes via `upsertMetafield('pages', pageId, 'global', 'title_tag', ...)` + `upsertMetafield('pages', pageId, 'global', 'description_tag', ...)`

### New `--expand-faq` flag

```bash
node agents/product-optimizer/index.js --expand-faq              # queue FAQ expansion
node agents/product-optimizer/index.js --expand-faq --dry-run    # show candidates
```

**Flow:**
1. Find the FAQ page (handle `faq` or `faqs` or title containing "FAQ")
2. Get GSC queries for that page via `gsc.getPageKeywords(url, 50, 90)`
3. Filter to question-based queries (starts with who/what/where/when/why/how, or contains "?")
4. Send to Claude: existing FAQ body + new questions → expanded FAQ body with new Q&A sections
5. Add `FAQPage` JSON-LD schema to the body
6. Queue through performance-queue with trigger `faq-expansion`
7. `--publish-approved` pushes body_html + meta via `updatePage()` + `upsertMetafield()`

### Queue item shapes

Page meta rewrite:
```json
{
  "slug": "about-us",
  "title": "About Us — Meta Rewrite",
  "trigger": "page-meta-rewrite",
  "resource_type": "page",
  "resource_id": 12345,
  "proposed_meta": { "seo_title": "...", "seo_description": "...", "original_title": "...", "original_description": null },
  "signal_source": { "type": "gsc-page-meta", "impressions": 435, "position": 15, "ctr": 0.005 },
  "summary": { "what_changed": "...", "why": "...", "projected_impact": "..." },
  "status": "pending"
}
```

FAQ expansion:
```json
{
  "slug": "faq",
  "title": "FAQ Page — Content Expansion",
  "trigger": "faq-expansion",
  "resource_type": "page",
  "resource_id": 12345,
  "proposed_html_path": "data/page-content/faq.html",
  "proposed_meta": { "seo_title": "...", "seo_description": "..." },
  "signal_source": { "type": "gsc-faq-expansion", "question_queries": ["how to use coconut oil...", "..."] },
  "summary": { "what_changed": "...", "why": "...", "projected_impact": "..." },
  "status": "pending"
}
```

### Scheduler integration

Add `--pages-from-gsc` to weekly Sunday jobs (after product meta):

```
Step 4c: product-optimizer --pages-from-gsc
Step 4d: product-optimizer --publish-approved  (already handles page triggers)
```

### Files

- Modify: `agents/product-optimizer/index.js` — add `--pages-from-gsc`, `--expand-faq` modes, update `--publish-approved` to handle page triggers
- Modify: `scheduler.js` — add pages step

---

## 3.4 Automated A/B Testing for Meta Tags

**What:** Auto-trigger A/B tests when meta rewrites publish, extend to products/collections/pages, add dashboard card.

**Current state:** `scripts/create-meta-test.js` creates blog-only tests. `agents/meta-ab-tracker/index.js` tracks and concludes them (reverts losers). Both work but are manual/blog-only.

### New shared module: `lib/meta-test.js`

Extract test creation logic from `scripts/create-meta-test.js` into a reusable module:

```javascript
/**
 * createMetaTest({ slug, url, resourceType, resourceId, originalTitle, newTitle, blogId })
 *
 * Creates a meta A/B test file at data/meta-tests/{slug}.json.
 * Computes baseline CTR from GSC snapshots (28-day lookback).
 * Does NOT apply the new title to Shopify (caller already did that).
 *
 * resourceType: 'article' | 'product' | 'collection' | 'page'
 */
```

The test file shape (extends existing):
```json
{
  "slug": "coconut-lotion",
  "url": "https://www.realskincare.com/products/coconut-lotion",
  "resourceType": "product",
  "resourceId": 12345,
  "blogId": null,
  "startDate": "2026-04-10",
  "concludeDate": "2026-04-24",
  "variantA": "Coconut Lotion",
  "variantB": "Organic Coconut Lotion | Real Skin Care",
  "baselineCTR": 0.002,
  "status": "active"
}
```

### Wire auto-trigger into publish flows

When `publishApprovedProducts()` in `product-optimizer` pushes a `product-meta-rewrite` item to Shopify, call:

```javascript
import { createMetaTest } from '../../lib/meta-test.js';
await createMetaTest({
  slug: item.slug,
  url: `${config.url}/products/${item.slug}`,
  resourceType: 'product',
  resourceId: item.resource_id,
  originalTitle: item.proposed_meta.original_title,
  newTitle: item.proposed_meta.seo_title,
});
```

Same pattern for:
- `collection-content-optimizer --publish-approved` (collection content triggers)
- `product-optimizer --publish-approved` (page meta triggers)
- `collection-creator --publish-approved` (new collection triggers)

### Extend `meta-ab-tracker` for all resource types

Currently `revertMetafield()` only handles articles (blog posts). Extend to:
- Articles: existing `blogs/{blogId}/articles/{articleId}/metafields.json` flow
- Products: `upsertMetafield('products', resourceId, 'global', 'title_tag', variantA)`
- Collections: detect custom vs smart, use appropriate resource type
- Pages: `upsertMetafield('pages', resourceId, 'global', 'title_tag', variantA)`

Import `upsertMetafield` from `lib/shopify.js` instead of raw fetch calls.

### Dashboard card

Add `renderMetaTestCard(d)` to the Optimize tab:
- Active tests: slug, variant A vs B, days remaining, current CTR delta
- Concluded tests (last 30 days): slug, winner, CTR change
- Win rate: "B won X of Y tests (Z%)"

Add meta test data to `data-loader.js`:
- Read all `data/meta-tests/*.json` files
- Pass as `metaTests` to the dashboard

### Files

- Create: `lib/meta-test.js` — shared test creation module
- Modify: `agents/meta-ab-tracker/index.js` — extend revert to all resource types via `upsertMetafield`
- Modify: `agents/product-optimizer/index.js` — call `createMetaTest()` after publish-approved
- Modify: `agents/collection-content-optimizer/index.js` — call `createMetaTest()` after publish-approved
- Modify: `agents/collection-creator/index.js` — call `createMetaTest()` after publish-approved
- Modify: `agents/dashboard/public/js/dashboard.js` — add `renderMetaTestCard()`
- Modify: `agents/dashboard/lib/data-loader.js` — load meta test data
- Modify: `scripts/create-meta-test.js` — refactor to use `lib/meta-test.js` (keep CLI interface)

---

## Scheduler: Updated Full Schedule

```
Daily (every day):
  Step 0: review-monitor
  Step 1: calendar-runner --publish-due
  Step 2: calendar-runner --run
  Step 3: link repair
  Step 4a: product-optimizer --publish-approved
  Step 4b: collection-content-optimizer --publish-approved
  Step 4c: product-optimizer --pages-from-gsc --publish-approved  [NEW]
  Step 5: collection-linker --top-targets --apply

Weekly (Sundays):
  Step 6: product-schema --auto --apply
  Step 7a: collection-creator --from-opportunities --queue
  Step 7b: collection-creator --publish-approved
  Step 8: cannibalization-resolver --apply --report-json
  Step 9: ga4-content-analyzer
  Step 9b: meta-ab-tracker  [NEW — moved from standalone to scheduler]

Monthly (1st of month):
  Step 10: theme-seo-auditor  [NEW]
```

---

## Signal Manifest Updates

| Signal | Writer | Consumers |
|---|---|---|
| `data/reports/reviews/latest.json` | `review-monitor` | `daily-summary`, `product-optimizer` (sentiment context) |
| `data/reports/theme-seo-audit/latest.json` | `theme-seo-auditor` | dashboard (future), manual review |
| `data/meta-tests/*.json` | `lib/meta-test.js` (called by publish flows) | `meta-ab-tracker`, dashboard Optimize tab |
| `data/performance-queue/<slug>.json` (trigger: `page-meta-rewrite`) | `product-optimizer --pages-from-gsc` | dashboard, `product-optimizer --publish-approved` |
| `data/performance-queue/<slug>.json` (trigger: `faq-expansion`) | `product-optimizer --expand-faq` | dashboard, `product-optimizer --publish-approved` |

---

## What's NOT in scope

- Review response automation (replying to negative reviews via Judge.me API) — flagging only
- Liquid template editing (theme audit produces recommendations, not auto-fixes)
- Page speed optimization (Lighthouse reports scores, but fixing performance requires theme changes)
- Multi-variant A/B tests (only A vs B, not A/B/C)

---

## Success metrics (from roadmap)

| Item | Metric | Target | Timeline |
|---|---|---|---|
| 3.1 | Products with ≥5 reviews have AggregateRating | All | Immediate (Tier 2 already does this) |
| 3.1 | Negative review response time | <24 hours | Ongoing |
| 3.2 | Theme-level SEO issues in GSC Enhancements | Zero | 60 days |
| 3.3 | FAQ page featured snippet | ≥1 query | 60 days |
| 3.4 | Meta rewrites with measurable outcome | Every rewrite | 14 days per test |
| 3.4 | Rollback rate | <20% | Ongoing |
