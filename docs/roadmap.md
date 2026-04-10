# SEO Engine Roadmap

**Last updated:** 2026-04-10
**Goal:** Drive organic traffic to realskincare.com by expanding SEO automation beyond blog posts to product pages, collection pages, and Shopify templates — using real GSC/GA4/Ahrefs data to prioritize every action.

**Guiding principle:** Every agent produces signals that other agents consume. No dead-end outputs. No blind decisions. Every change goes through the performance-queue approval workflow. Every result is monitored at 30/60/90 days.

---

## Current state (what's working)

The blog content pipeline is fully automated: GSC demand → calendar → research → write → edit → image → publish → monitor → refresh. 94 legacy posts triaged (21 winners locked, 25 rising, 22 flops queued for rewrite). Dashboard surfaces all signals on the Optimize tab. Performance engine runs nightly and queues rewrites for approval. Indexing checker/fixer monitors Google coverage. Morning digest emails a summary.

**Blog traffic:** 316K impressions/90d across 58 indexed blog pages.

**The gap:** Product pages (114 URLs, 32K impressions, 0.1% CTR) and collection pages (59 URLs, 101K impressions, 0.1% CTR) are getting significant Google impressions but almost no clicks. The system doesn't optimize them.

---

## Tier 1 — Collection + Product Page SEO (highest ROI)

**Why first:** 133K impressions of existing demand across 173 URLs that Google is already showing but users aren't clicking. No new content creation needed for product meta rewrites. Collection descriptions are short (300–500 words). This is the cheapest traffic available outside the blog.

### 1.1 Collection Page Content Engine

**Problem:** 59 collection pages averaging position 35 with 0.1% CTR. Most have only a title and a product grid — no body content for Google to rank.

**Build:**
- New agent: `collection-content-optimizer` — reads GSC performance per collection URL, identifies collections with high impressions but poor position/CTR, generates SEO-optimized descriptions (300–500 words) targeting the actual queries GSC shows for that page.
- Reads: `lib/gsc.js getPagePerformance()` + `getPageKeywords()` for each collection URL, `data/topical-map.json` for cluster context, `config/ingredients.json` for product accuracy.
- Writes: updated collection `body_html` via `lib/shopify.js updateSmartCollection()` / `updateCustomCollection()`, queued through `data/performance-queue/` for approval.
- Includes internal links to blog posts in the same topical cluster (the blog already ranks for these topics; passing link equity to the collection page reinforces both).
- Signal manifest: producer of collection-level content, consumed by `post-performance` (monitors position change), `internal-linker` (cross-links from new blog posts).

**Priority targets (from current GSC data):**

| Collection | Impressions | Position | CTR |
|---|---|---|---|
| best-non-toxic-body-lotion | 12,072 | 32 | 0.3% |
| non-toxic-body-lotion | 11,153 | 22 | 0.2% |
| organic-body-lotion | 10,510 | 30 | 0.2% |
| cinnamon-toothpaste | 6,801 | 28 | 0.0% |
| vegan-body-lotion | 5,719 | 27 | 0.1% |

**Success metric:** Top 10 collections move from avg position 30 → position 15 within 60 days.

### 1.2 Product Page Meta Optimization

**Problem:** 114 product pages averaging 0.1% CTR. Titles and meta descriptions are likely Shopify defaults that don't target the actual search queries driving impressions.

**Build:**
- Extend existing `product-optimizer` agent to run in an automated GSC-signal-driven loop (currently manual-only).
- New mode: `--from-gsc` — reads GSC page performance for all `/products/*` URLs, identifies products with ≥100 impressions and CTR <1%, rewrites title tag and meta description to target the top query for that page.
- Queues through `data/performance-queue/` for approval (same Approve/Feedback/Dismiss flow as blog rewrites).
- Does NOT touch product body content — only title + meta_description via Shopify metafields (`global.title_tag`, `global.description_tag`).

**Priority targets:**

| Product | Impressions | Position | CTR |
|---|---|---|---|
| coconut-lotion | 8,233 | 25 | 0.2% |
| coconut-oil-lip-balm | 4,965 | 23 | 0.1% |
| coconut-oil-toothpaste | 4,697 | 10 | 0.1% |
| coconut-oil-deodorant | 3,591 | 18 | 0.1% |
| coconut-soap | 3,232 | 18 | 0.0% |

**Success metric:** Top 10 products CTR improves from 0.1% → 1%+ within 30 days of meta rewrite.

### 1.3 Product/Collection → Blog Cross-Linking (daily cron)

**Problem:** Blog posts have 316K impressions worth of link equity. Collection pages have 101K impressions but rank poorly. The link equity doesn't flow between them because `collection-linker` isn't running automatically.

**Build:**
- Add `collection-linker` to the daily cron (after `calendar-runner` finishes any new publishes).
- `collection-linker` already scores links by position tier × volume and injects them into blog post HTML. Just needs to be automated.
- Also run after every new blog post publish (wire into `calendar-runner`'s post-publish steps, which already run `internal-linker`).

**Success metric:** Average inbound links to top 20 collections increases from current count to 3+ each within 30 days.

---

## Tier 2 — Structural SEO + Signal Loops (medium ROI)

**Why second:** These improve the system's intelligence and close gaps where data is collected but not acted on. Each one makes Tier 1's work more effective.

### 2.1 Product Schema at Scale

**Problem:** `product-schema` injects JSON-LD (Product, price, availability, reviews) but only runs manually. Rich snippets in search results dramatically improve CTR for product pages. Only a few products currently have schema.

**Build:**
- Run `product-schema` against all products that appear in GSC with ≥50 impressions.
- Add to the daily cron as a weekly job (schema doesn't change often).
- Integrate Judge.me review data (`lib/judgeme.js`) into the schema — review count + average rating in the JSON-LD.

**Success metric:** Rich snippets appearing in Google for top 10 products within 14 days.

### 2.2 Collection Keyword Gap Detector

**Problem:** GSC shows queries with commercial intent (e.g., "buy organic coconut oil lotion") that don't have a matching collection page. `collection-creator` exists but isn't fed by GSC signals.

**Build:**
- New signal: scan `gsc-opportunity/latest.json` for queries containing commercial-intent modifiers ("best", "buy", "shop", "top", "organic", "natural") where no collection page currently targets that keyword.
- Feed matches into `collection-creator` which already handles: create Shopify collection → add matching products → generate description.
- Queue new collections through performance-queue for approval before creation.

**Success metric:** 5+ new keyword-targeted collections created from real GSC demand signals within 30 days.

### 2.3 Cannibalization Detection → Auto-Resolution

**Problem:** With 58 blog posts + 59 collections + 114 products, keyword overlap is guaranteed. A blog post and a collection page competing for the same query splits ranking power. `cannibalization-resolver` exists but isn't automated.

**Build:**
- Run `cannibalization-resolver` after every rank-tracker snapshot (weekly).
- When two URLs from the site rank for the same query: determine which is the better target (commercial intent → collection/product, informational → blog), then add a canonical hint or consolidate content.
- Surface conflicts on the dashboard Optimize tab as a new "Cannibalization" card.

**Success metric:** Zero same-site keyword conflicts in the top 50 positions within 60 days.

### 2.4 GA4 → Content Strategy Feedback Loop

**Problem:** GA4 collects daily sessions, conversions, and revenue per page but no agent reads it. A blog post with 5,000 sessions and zero conversions needs CRO work (better CTAs, product links). A blog post with 50 sessions but 3 conversions is a signal to write MORE content in that cluster.

**Build:**
- New signal file: `data/reports/ga4-content-feedback/latest.json` — produced by a new `ga4-content-analyzer` agent that runs weekly.
- Classifies each page as: high-traffic-low-conversion (CRO candidate), low-traffic-high-conversion (cluster expansion candidate), or balanced.
- Feed into `content-strategist` so calendar priorities factor in revenue potential, not just impressions.
- Feed into `cro-cta-injector` so high-traffic-low-conversion posts get stronger CTAs automatically.

**Success metric:** Content calendar prioritization shifts toward revenue-driving clusters. Blog-attributed conversions increase 20% within 90 days.

---

## Tier 3 — Platform-Level Optimization (structural)

**Why third:** These are platform improvements that compound over time but require more infrastructure. Each one makes everything else work better.

### 3.1 Review/UGC Integration

**Problem:** `lib/judgeme.js` wraps the Judge.me API but no agent uses it. Customer reviews are social proof that improves both conversion (trust signals on product pages) and SEO (review schema in search results).

**Build:**
- New agent: `review-monitor` — daily pull of new reviews from Judge.me API.
- Feed review counts and average ratings into `product-schema` (for JSON-LD AggregateRating).
- Feed review sentiment into `product-optimizer` — products with negative reviews about a specific feature (e.g., "too thick") get description copy that addresses the concern proactively.
- Surface new reviews in the morning digest (positive → celebrate, negative → flag for response).

**Success metric:** All products with ≥5 reviews have AggregateRating in JSON-LD. Negative review response time <24 hours.

### 3.2 Shopify Theme-Level SEO Audit

**Problem:** No agent audits the Shopify theme's HTML structure. Common theme-level SEO issues: wrong heading hierarchy on collection/product templates, missing or incorrect Open Graph tags, broken canonical tags on paginated collection pages, render-blocking resources, missing alt text on theme images.

**Build:**
- New agent: `theme-seo-auditor` — crawls 1 representative URL per template type (homepage, product, collection, blog post, page) and audits: heading hierarchy, canonical tags, OG/Twitter cards, structured data, mobile viewport, page speed signals.
- Outputs a report with specific Liquid template file + line number recommendations.
- Runs monthly (theme changes are infrequent).

**Success metric:** Zero theme-level SEO issues flagged by Google Search Console "Enhancements" tab.

### 3.3 Shopify Page Optimization

**Problem:** 14 static pages (/pages/*) have 1,971 impressions but aren't optimized. Pages like "About Us" (435 impr), "FAQs" (334 impr), and "Shipping Policy" (146 impr) are ranking opportunities for long-tail brand and informational queries.

**Build:**
- Extend `product-optimizer` to also handle Shopify pages (the Shopify API is the same — `getPages()`, `updatePage()`).
- Optimize title tags and meta descriptions for the queries GSC shows for these pages.
- Expand FAQ page content to target question-based queries (these trigger featured snippets).

**Success metric:** FAQ page earns a featured snippet for at least 1 query within 60 days.

### 3.4 Automated A/B Testing for Meta Tags

**Problem:** `meta-ab-tracker` exists and collects A/B test results, but there's no automated test creation loop. When the meta-optimizer rewrites a title, there's no way to know if the new title actually performs better without running a controlled test.

**Build:**
- After any meta rewrite (blog, product, or collection), automatically create a 14-day A/B window: track CTR for the first 7 days with the old title (baseline), then 7 days with the new title.
- `meta-ab-tracker` already collects the data. Add a comparison agent that reads the results and either confirms the change or rolls back.
- Surfaces results on the dashboard: "Title rewrite for coconut-lotion: CTR 0.2% → 1.4% (+600%). Keeping new title."

**Success metric:** Every meta rewrite has a measurable outcome within 14 days. Rollback rate <20%.

---

## Implementation order

| Phase | Items | Timeline | Dependencies |
|---|---|---|---|
| **Now** | 1.1 Collection content + 1.2 Product meta + 1.3 Cross-linking cron | 1–2 weeks | None — all agents exist, need GSC wiring + crons |
| **Week 3–4** | 2.1 Product schema + 2.2 Collection keyword gap + 2.3 Cannibalization | 2 weeks | Tier 1 in production so we can measure before/after |
| **Week 5–6** | 2.4 GA4 feedback loop | 1 week | GA4 collector running (already is) |
| **Month 2** | 3.1 Review integration + 3.2 Theme audit | 2 weeks | Judge.me API access confirmed |
| **Month 2–3** | 3.3 Page optimization + 3.4 A/B testing | 2 weeks | Tier 2 data flowing |

## How to use this roadmap

1. **Starting a new instance:** Read this file first. It tells you what exists, what's next, and why.
2. **Before building anything:** Check `docs/signal-manifest.md` for the current signal flow. Every new agent must update the manifest.
3. **Before modifying post metadata:** Query Shopify first to verify the real state. See the lesson from the `shopify_status` incident on 2026-04-09.
4. **Daily pipeline schedule** is documented in the crontab on the server (`crontab -l` on `root@137.184.119.230`). Every new cron must be added there AND documented here.
5. **Approval workflow:** All content changes go through `data/performance-queue/`. No auto-publishing without human approval on the Optimize tab.
