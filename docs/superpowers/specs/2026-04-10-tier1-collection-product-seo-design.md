# Tier 1 — Collection + Product Page SEO

**Date:** 2026-04-10
**Scope:** Roadmap items 1.1, 1.2, 1.3
**Goal:** Capture clicks from 133K impressions across 173 product/collection URLs that Google shows but users don't click.

---

## 1.3 Cross-Linking Cron

**What:** Add `collection-linker --top-targets --apply` to the daily scheduler so link equity flows from blog posts to collection pages every day, not just after new publishes.

**Current state:** `collection-linker` already runs in `calendar-runner`'s post-publish steps (line 562). It does NOT run independently in `scheduler.js`.

**Change:** Add a Step 4 to `scheduler.js` after link repair:

```javascript
// Step 4: run collection linker to inject links from blog posts to top collection/product targets
const collLinkCmd = `"${NODE}" agents/collection-linker/index.js --top-targets --apply${dryFlag}`;
log(`  ${collLinkCmd}`);
try {
  execSync(collLinkCmd, { stdio: 'inherit', cwd: __dirname });
  log('  ✓ collection-linker complete');
} catch (e) {
  log(`  ✗ collection-linker failed (exit ${e.status})`);
}
```

**Files modified:** `scheduler.js` only.

**No queue needed.** The collection-linker already operates conservatively (scores links 1–10, only injects high-confidence anchors). It's been running manually with `--apply` and the results have been good.

---

## 1.2 Product Meta `--from-gsc` Mode

**What:** Add a `--from-gsc` flag to `product-optimizer` that rewrites only title + meta_description for product pages with high impressions and low CTR, queuing changes for approval instead of applying directly.

**Current state:** `product-optimizer` rewrites body + title + meta for products and collections, applying directly with `--apply`. No queue integration.

### New CLI flag

```bash
node agents/product-optimizer/index.js --from-gsc              # queue product meta rewrites
node agents/product-optimizer/index.js --from-gsc --dry-run    # show candidates without queuing
node agents/product-optimizer/index.js --from-gsc --limit 5    # cap at 5 products
```

### Selection criteria (--from-gsc mode)

- Products only (no collections — that's 1.1's job)
- ≥100 impressions in the last 90 days
- CTR < 1%
- Not already in the active performance queue (`activeSlugs()`)
- Not in `EXCLUDED_HANDLES`
- Sorted by impressions descending

### Claude prompt (meta-only)

A slimmed-down prompt that generates only:
```json
{
  "seo_title": "...",
  "seo_description": "..."
}
```

No `body_html` rewrite. The prompt receives:
- Current product title
- Current meta title/description (if any — fetched via Shopify metafields or theme defaults)
- Top 5 GSC queries for this URL (from `gsc.getPageKeywords()`)
- GSC position, impressions, CTR

### Queue integration

Each rewrite produces a queue item in `data/performance-queue/{handle}.json`:

```json
{
  "slug": "coconut-lotion",
  "title": "Coconut Lotion — Meta Rewrite",
  "trigger": "product-meta-rewrite",
  "signal_source": {
    "type": "gsc-product-meta",
    "impressions": 8233,
    "position": 25,
    "ctr": 0.002,
    "top_queries": ["coconut lotion", "coconut body lotion", "natural coconut lotion"]
  },
  "proposed_meta": {
    "seo_title": "Organic Coconut Lotion | Real Skincare",
    "seo_description": "Lightweight coconut body lotion made with organic virgin coconut oil. Absorbs fast, no greasy residue. Free of parabens and synthetic fragrance.",
    "original_title": "Coconut Lotion",
    "original_description": null
  },
  "resource_type": "product",
  "resource_id": 123456789,
  "summary": {
    "what_changed": "Rewrote title from 'Coconut Lotion' to 'Organic Coconut Lotion | Real Skincare'. Added meta description targeting 'coconut lotion' (8,233 impressions, 0.2% CTR).",
    "why": "Page ranks #25 for 'coconut lotion' with 8K+ impressions but only 0.2% CTR. Current title is the generic Shopify product name with no SEO targeting.",
    "projected_impact": "CTR improvement from 0.2% to 1%+ would add ~65 clicks/month from existing impressions."
  },
  "status": "pending",
  "created_at": "2026-04-10T...",
  "updated_at": "2026-04-10T..."
}
```

### Publishing approved items

Add a `--publish-approved` flag to `product-optimizer`:

```bash
node agents/product-optimizer/index.js --publish-approved
```

This reads all queue items where `trigger === 'product-meta-rewrite'` and `status === 'approved'`, pushes `seo_title` and `seo_description` to Shopify via `upsertMetafield()`, then sets `status: 'published'`.

Add this to `scheduler.js` to run daily (after the main optimizer, before collection-linker).

### Dashboard rendering

The existing `renderPerformanceQueueCard` function renders any queue item generically using `summary.what_changed`, `summary.why`, `summary.projected_impact`. No dashboard changes needed — the card will render the product meta items correctly as-is. The Preview button won't apply (no HTML to preview), but the Approve/Feedback flow works unchanged.

### Files modified

- `agents/product-optimizer/index.js` — add `--from-gsc` mode and `--publish-approved` mode
- `scheduler.js` — add `--publish-approved` step

---

## 1.1 Collection Content Optimizer (new agent)

**What:** New agent that generates 300–500 word SEO descriptions for collection pages, targeting the actual GSC queries driving impressions to each URL, with internal links to related blog posts.

### Agent location

`agents/collection-content-optimizer/index.js`

### CLI

```bash
node agents/collection-content-optimizer/index.js                           # dry run, show candidates
node agents/collection-content-optimizer/index.js --queue                   # write to performance queue
node agents/collection-content-optimizer/index.js --limit 3                 # top 3 only
node agents/collection-content-optimizer/index.js --handle "vegan-body-lotion"  # single collection
node agents/collection-content-optimizer/index.js --publish-approved        # push approved items to Shopify
```

### Selection criteria

1. Fetch all collections from Shopify (custom + smart)
2. Exclude handles in `EXCLUDED_HANDLES` (same set as `product-optimizer`)
3. For each collection URL, call `gsc.getPagePerformance()` to get impressions, position, CTR
4. Filter: ≥500 impressions AND (position > 10 OR CTR < 0.5%)
5. Exclude collections already in active performance queue
6. Sort by impressions descending
7. Take top N (default 5, configurable via `--limit`)

### Claude prompt

For each target collection, build a prompt with:

**Inputs:**
- Collection title and handle
- Current `body_html` (often empty or very short)
- Top 10 GSC queries for this URL (from `gsc.getPageKeywords()`)
- GSC metrics: position, impressions, CTR
- Related blog posts from `data/topical-map.json` (matched by cluster)
- Relevant ingredients from `config/ingredients.json` (matched by collection handle/title keywords)

**Prompt asks Claude to:**
1. Write a 300–500 word collection description in HTML
2. Open with the primary GSC query naturally in the first sentence
3. Cover what the collection is, who it's for, key differentiators
4. Include 2–3 internal links to related blog posts (using real URLs from the topical map)
5. Reference specific ingredients from `config/ingredients.json` for accuracy
6. Write an SEO title (50–60 chars) and meta description (140–155 chars)
7. Follow the brand voice and AI-detection-avoidance guidelines (same as `product-optimizer`)

**Output format:**
```json
{
  "body_html": "<p>...</p>",
  "seo_title": "...",
  "seo_description": "..."
}
```

### Queue integration

Same pattern as 1.2. Each rewrite produces a queue item:

```json
{
  "slug": "best-non-toxic-body-lotion",
  "title": "Best Non-Toxic Body Lotion — Collection Content",
  "trigger": "collection-content",
  "signal_source": {
    "type": "gsc-collection-content",
    "impressions": 12072,
    "position": 32,
    "ctr": 0.003,
    "top_queries": ["best non toxic body lotion", "non toxic lotion", "safe body lotion"]
  },
  "proposed_html_path": "data/collection-content/best-non-toxic-body-lotion.html",
  "proposed_meta": {
    "seo_title": "Best Non-Toxic Body Lotion | Real Skincare",
    "seo_description": "Shop our collection of non-toxic body lotions made with organic ingredients. No parabens, no synthetic fragrance. Safe for sensitive skin.",
    "original_title": "Best Non-Toxic Body Lotion",
    "original_description": null
  },
  "backup_html": "",
  "resource_type": "collection",
  "resource_id": 987654321,
  "collection_type": "smart",
  "summary": {
    "what_changed": "Added 400-word SEO description with internal links to 'best non-toxic body lotion' and 'organic body lotion benefits' blog posts. Wrote new meta description targeting 'non toxic body lotion'.",
    "why": "Collection has 12K impressions at position #32 with 0.3% CTR. Page has only a title and product grid — no body content for Google to rank.",
    "projected_impact": "Moving from position 32 to top 15 could increase clicks from ~36/quarter to 300+/quarter."
  },
  "status": "pending",
  "created_at": "2026-04-10T...",
  "updated_at": "2026-04-10T..."
}
```

The generated HTML is saved to `data/collection-content/{handle}.html` for preview. The queue item's `proposed_html_path` points to this file so the dashboard's Preview button works.

### Publishing approved items

`--publish-approved` reads approved `collection-content` queue items and:
1. Reads the HTML from `proposed_html_path`
2. Calls `updateCustomCollection()` or `updateSmartCollection()` with `{ body_html }` based on `collection_type`
3. Calls `upsertMetafield()` for `seo_title` and `seo_description`
4. Sets `status: 'published'` and `published_at` timestamp

### Scheduler integration

Add to `scheduler.js`:
```
Step 4a: node agents/product-optimizer/index.js --publish-approved
Step 4b: node agents/collection-content-optimizer/index.js --publish-approved
Step 5:  node agents/collection-linker/index.js --top-targets --apply
```

Order matters: publish new collection content first (4a, 4b), then run cross-linker (5) so new descriptions can receive links.

### Files created

- `agents/collection-content-optimizer/index.js` — the new agent

### Files modified

- `scheduler.js` — add publish-approved step and collection-linker step
- `agents/product-optimizer/index.js` — add `--from-gsc` and `--publish-approved` modes
- `docs/signal-manifest.md` — add new signal entries for collection-content and product-meta-rewrite triggers

### Data directories

- `data/collection-content/` — generated HTML files for preview
- `data/performance-queue/` — queue items (already exists)

---

## Shared: Queue Schema Extensions

Both 1.1 and 1.2 extend the performance queue with new fields not present in the blog-rewrite items:

| Field | Purpose | Used by |
|---|---|---|
| `resource_type` | `"product"` or `"collection"` | 1.1, 1.2 |
| `resource_id` | Shopify numeric ID | 1.1, 1.2 |
| `collection_type` | `"smart"` or `"custom"` (collections only) | 1.1 |
| `proposed_meta` | `{ seo_title, seo_description, original_title, original_description }` | 1.1, 1.2 |
| `proposed_html_path` | Path to generated HTML file | 1.1 |

The existing fields (`slug`, `title`, `trigger`, `signal_source`, `summary`, `status`, timestamps) remain unchanged. The `writeItem()` function in `agents/performance-engine/lib/queue.js` is schema-agnostic (writes whatever object it receives), so no changes needed there.

The dashboard's `renderPerformanceQueueCard` uses `summary.*` fields which both new trigger types provide, so cards will render correctly without dashboard code changes.

---

## What's NOT in scope

- Collection feedback loop (re-running Claude with user feedback) — the existing performance-engine feedback mechanism works for blog posts because it re-runs `content-refresher`. For collections, feedback would need to re-run the collection optimizer. This can be added later but is not needed for initial launch.
- Body content rewrites for products — 1.2 is meta-only. Full product description rewrites remain in the existing `product-optimizer --apply` manual flow.
- New dashboard UI — the existing queue cards, Approve/Feedback/Preview flow, and Optimize tab work as-is.
- A/B testing of meta changes — that's roadmap item 3.4.

---

## Success metrics (from roadmap)

| Item | Metric | Target | Timeline |
|---|---|---|---|
| 1.1 | Top 10 collections avg position | 30 → 15 | 60 days |
| 1.2 | Top 10 products CTR | 0.1% → 1%+ | 30 days |
| 1.3 | Avg inbound links to top 20 collections | Current → 3+ each | 30 days |
