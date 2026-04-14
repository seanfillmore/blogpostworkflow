# LLM Optimization Pack — Legacy Rebuilder, llms.txt, Specificity Audit

**Date:** 2026-04-14
**Status:** Approved

## Problem

Three gaps in our LLM citation visibility:

1. **80 of 146 blog posts lack FAQ schema** — these are legacy posts from before the current pipeline (answer-first + schema-injection) existed. They also predate other quality gates.
2. **No llms.txt file** — LLM crawlers look for `/llms.txt` to find curated content. We have none.
3. **Vague product descriptions** — marketing language like "premium quality" and "crafted with care" doesn't get cited by LLMs. Concrete claims do.

## Architecture

Three independent agents, all scheduled weekly on Sundays:

1. **`agents/legacy-rebuilder/index.js`** — identifies legacy posts, reruns them through the full content pipeline
2. **`agents/llms-txt-generator/index.js`** — builds a curated llms.txt file, deploys to Shopify
3. **`agents/specificity-audit/index.js`** — flags vague product copy, queues rewrites sourced from review text

Each feature is self-contained and can ship independently.

---

## Feature 1: Legacy Post Rebuilder

### Identification

A post is "legacy" if its HTML does not contain the string `FAQPage`. This is a proxy for "missing schema-injector output."

### CLI

```
node agents/legacy-rebuilder/index.js                    # list legacy posts (dry run)
node agents/legacy-rebuilder/index.js <slug> --apply     # rebuild one post
node agents/legacy-rebuilder/index.js --limit 3 --apply  # rebuild N posts
```

### Flow per post

1. Read existing post metadata: `target_keyword`, `shopify_article_id`, `shopify_blog_id`, original `published_at`
2. Save original `body_html` backup to `data/backups/legacy-rebuild/{slug}.{timestamp}.html`
3. Run content-researcher with the same target keyword to produce a fresh brief
4. Run blog-post-writer with the new brief
5. Run image-generator only if the original post has no image
6. Run answer-first-rewriter `<slug> --apply` (final intro check)
7. Run featured-product-injector `--handle <slug>`
8. Run schema-injector `--slug <slug> --apply` (adds FAQPage + HowTo where applicable)
9. Run editor `data/posts/{slug}/content.html` (quality gate)
10. If editor fails, abort rebuild and keep original post
11. Push to Shopify via `updateArticle(blogId, articleId, { body_html: newContent })` — preserves the URL and article_id
12. Stamp post metadata with `rebuilt_at: now`

### Safety

- Backup saved before any write
- Editorial gate must pass before publish
- Failed rebuilds leave original post untouched
- Weekly scheduler limited to 3 rebuilds to avoid overwhelming Google with simultaneous refresh signals

### Scheduler

Add to weekly Sunday run: `runStep('legacy-rebuilder', ... --limit 3 --apply)`

### Files

| File | Change |
|------|--------|
| `agents/legacy-rebuilder/index.js` | Create |
| `scheduler.js` | Add weekly step |

---

## Feature 2: llms.txt Generator

### Content selection

- **Blog posts** with ≥100 GSC impressions in the last 90 days (via `gsc.getPagePerformance`)
- **All active products** (via Shopify `getProducts()`)
- **Top 10 collections** by organic traffic (via DataForSEO `getRankedKeywords` aggregated by URL)

### File format

Standard llms.txt spec:

```
# Real Skin Care

> Natural coconut-based skincare and personal care products handcrafted with clean ingredients.

## Products

- [All Natural Coconut Oil Deodorant](https://www.realskincare.com/products/coconut-oil-deodorant): Aluminum-free deodorant made with organic virgin coconut oil.
- [Coconut Moisturizer](https://www.realskincare.com/products/coconut-moisturizer): Clean, non-toxic body lotion with six ingredients.

## Collections

- [Aluminum-Free Deodorant](https://www.realskincare.com/collections/aluminum-free-deodorant): Natural deodorants without aluminum.

## Blog Posts

- [Best Natural Deodorant for Women](https://www.realskincare.com/blogs/news/best-natural-deodorant-for-women): 2026 picks for clean, effective natural deodorants.
```

Descriptions pulled from each item's meta description (or first 160 chars of body if meta missing).

### Deployment

Shopify doesn't allow arbitrary root-level files. The agent:

1. Creates or updates a Shopify page with handle `llms-txt`, title "llms.txt", body_html wrapped in `<pre>` tags with the plain text
2. Creates a redirect: `/llms.txt` → `/pages/llms-txt`
3. Also saves to `data/reports/llms-txt/llms.txt` for reference

### CLI

```
node agents/llms-txt-generator/index.js              # generate + deploy
node agents/llms-txt-generator/index.js --dry-run    # generate only, no deploy
```

### Scheduler

Add to weekly Sunday run.

### Files

| File | Change |
|------|--------|
| `agents/llms-txt-generator/index.js` | Create |
| `scheduler.js` | Add weekly step |

---

## Feature 3: Specificity Audit

### Flagged vocabulary

Stored in `config/specificity-flags.json`:

```json
{
  "vague_phrases": [
    "premium", "luxurious", "crafted with", "high-quality", "quality ingredients",
    "carefully selected", "finest", "artisanal", "handcrafted with love",
    "revolutionary", "cutting-edge", "state-of-the-art", "best-in-class",
    "transforms your skin", "works wonders", "miraculous", "magical"
  ]
}
```

### Flow

1. Fetch all products via `getProducts()`
2. For each product, scan `body_html` for flagged phrases (case-insensitive, word boundaries)
3. If any flagged phrases found:
   a. Fetch reviews for that product via `fetchProductReviews(handle)` from `lib/judgeme.js`
   b. Extract concrete phrases from reviews (longer than 4 words, mentioning attributes or use cases)
   c. Send to Claude with current description + flagged phrases + review excerpts
   d. Claude returns rewritten `body_html` that preserves brand voice but replaces vague claims with specific ones sourced from reviews
4. Write queue item to `data/performance-queue/{handle}.json` with trigger `product-description-rewrite`
5. Dashboard approve flow pushes the new `body_html` via `updateProduct()`

### Queue item shape

```json
{
  "slug": "coconut-lotion",
  "title": "Product Rewrite: Coconut Moisturizer",
  "trigger": "product-description-rewrite",
  "resource_type": "product",
  "resource_id": 7691181686954,
  "current_body_html": "...",
  "proposed_body_html": "...",
  "flagged_phrases": ["premium", "crafted with"],
  "review_sample_count": 5,
  "signal_source": { "type": "specificity-audit", "reviews_analyzed": 5 },
  "summary": {
    "what_changed": "Replaced 'premium natural ingredients' with specific review quotes about how the lotion absorbs and lasts.",
    "why": "LLMs cite concrete claims; reviewers describe the product more specifically than marketing copy does.",
    "projected_impact": "Increases citation likelihood in ChatGPT/Perplexity responses to product queries."
  },
  "status": "pending"
}
```

### Dashboard integration

The performance queue approve handler already handles products. Add a case for `product-description-rewrite`:

```js
} else if (item.trigger === 'product-description-rewrite') {
  await updateProduct(item.resource_id, { body_html: item.proposed_body_html });
}
```

### CLI

```
node agents/specificity-audit/index.js              # audit + queue
node agents/specificity-audit/index.js --dry-run    # audit only, no queue
```

### Scheduler

Add to weekly Sunday run.

### Files

| File | Change |
|------|--------|
| `agents/specificity-audit/index.js` | Create |
| `config/specificity-flags.json` | Create |
| `agents/dashboard/routes/performance-queue.js` | Extend approve handler for `product-description-rewrite` trigger |
| `scheduler.js` | Add weekly step |

---

## Combined Scheduler Changes

Weekly Sunday run (add to existing):

```js
// Step 8c: legacy post rebuilder (rebuilds posts without FAQ schema)
runStep('legacy-rebuilder', `"${NODE}" agents/legacy-rebuilder/index.js --limit 3 --apply${dryFlag}`, { indent: '    ' });

// Step 8d: generate llms.txt
runStep('llms-txt', `"${NODE}" agents/llms-txt-generator/index.js`, { indent: '    ' });

// Step 8e: product description specificity audit
runStep('specificity-audit', `"${NODE}" agents/specificity-audit/index.js`, { indent: '    ' });
```

## Not in scope

- Auto-applying product description rewrites (manual approval via performance queue)
- FAQ schema on products or collections (blog only, via pipeline)
- llms-full.txt (the fuller variant of llms.txt with inline content — only the basic index for now)
