# Featured Product Injector — Design Spec

**Date:** 2026-03-23

## Overview

Replace the mid-article dashed CTA section in blog posts with a richer featured product block that includes a real customer review quote (from Judge.me), product image, aggregate star rating, review count, price, and an Add to Cart button. The block is positioned above the site-wide average scroll depth so the majority of readers see it before dropping off.

## Problem Statement

The current mid-article CTA is a plain dashed-border section with a headline, one line of text, and a button. It links to a product but provides no social proof, no image, and no price signal — weak conversion levers. Replacing it with a review-forward product card gives readers concrete reasons to click before they leave.

## Layout

Layout B — review-forward horizontal card:

```
┌─────────────────────────────────────────────────────┐
│ [img] │ Featured Pick                               │
│       │ Coconut Oil Natural Deodorant               │
│       │ ┃ "Works all day without irritation..."     │
│       │ — Verified Buyer · ★★★★★ · 214 reviews     │
│       │ $18.99   [Add to Cart →]                   │
└─────────────────────────────────────────────────────┘
```

- `border: 2px solid #e5e7eb`, `border-radius: 14px`, `box-shadow: 0 1px 4px rgba(0,0,0,.06)`
- Review quote styled with `border-left: 3px solid #AEDEAC` (brand green), italic
- Button: `background: #1e1b4b` (navy), white text, "Add to Cart →"
- Product image: 130px wide, full card height, `object-fit: cover`. If the product has no image, omit the `<img>` element entirely.
- CSS class `rsc-featured-product` on the outer div for idempotency detection

## Architecture

### New files

**`lib/judgeme.js`** — Judge.me API client

Two exported functions:

**`fetchTopReview(productHandle, shopDomain, apiToken)`**
- Calls `GET https://judge.me/api/v1/reviews?api_token=TOKEN&shop_domain=DOMAIN&product_handle=HANDLE&per_page=10&rating[gte]=5`
- `shop_domain` must be the `.myshopify.com` domain (e.g. `realskincare.myshopify.com`), not the custom domain — this is what Judge.me's API requires
- Response shape: `{ reviews: [{ id, body, rating, reviewer: { name, verified_buyer } }, ...] }`
  - `body` is the review text (may contain HTML — strip tags using `body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()` before word count and truncation)
  - `verified_buyer` is a boolean
- Selects the first review where `body` (after stripping tags) contains 20+ words
- Truncates body to 200 characters, trimming to the last complete word
- Returns `{ quote: string, verified: boolean }` or `null` if no qualifying review found

**`fetchProductStats(productHandle, shopDomain, apiToken)`**
- Calls `GET https://judge.me/api/v1/products/-1?api_token=TOKEN&shop_domain=DOMAIN&handle=HANDLE`
- Note: `-1` is a Judge.me sentinel value meaning "look up by handle instead of by numeric product ID"
- Response shape: `{ product: { rating: number, reviews_count: number } }`
- Returns `{ rating: number, reviewCount: number }` or `null` on error

**`agents/featured-product-injector/index.js`** — main agent

Two modes, same core logic:

```
node agents/featured-product-injector/index.js --handle <slug>        # pipeline mode
node agents/featured-product-injector/index.js --top <n>              # retroactive mode
```

### Modified files

- `agents/dashboard/index.js` — add button, run-log `<pre>`, and allowlist entry
- `CLAUDE.md` — update pipeline order, add `JUDGEME_API_TOKEN` and `JUDGEME_SHOP_DOMAIN` env var docs

## Agent Logic

### Shared steps (both modes)

1. Load env: `JUDGEME_API_TOKEN`, `JUDGEME_SHOP_DOMAIN` (required — throw if missing)
2. Load Clarity scroll depth: read all files from `data/snapshots/clarity/` sorted by date, take the most recent 60, average their `scrollDepth` values. Fall back to 40 if no snapshots exist.
3. For each target handle, run the injection pipeline (see below).

### Pipeline mode (`--handle <slug>`)

- Reads `data/posts/<slug>.html`
- After injection, writes result back to `data/posts/<slug>.html`
- Does **not** update Shopify directly — the publisher agent pushes the updated local file to Shopify at publish time, so the injected block will reach Shopify when `publisher` runs

### Retroactive mode (`--top <n>`)

- Reads the most recent GSC snapshot (`data/snapshots/gsc/<date>.json`)
- GSC snapshot shape: `{ pages: [{ url, clicks, impressions }, ...] }`
- Filters to pages where `url` contains `/blogs/news/`, sorts by `clicks` descending, takes top N
- Derives handle from URL path: last segment of `/blogs/news/<handle>`
- Fetches each article's `body_html` from Shopify via `getArticles(blogId, { limit: 250 })`
- After injection, updates Shopify article `body_html` via `updateArticle(articleId, { body_html })`
- Creates `data/reports/featured-product/` via `mkdirSync({ recursive: true })` before writing
- Saves a report to `data/reports/featured-product/<date>.md` listing handles processed and outcomes

### Injection pipeline (per article)

**Step 1 — Idempotency check:** If `rsc-featured-product` class is already present in the HTML, log a skip message and return the HTML unchanged. This must be checked before any other mutation.

**Step 2 — Extract article content:** Apply `extractArticleContent(html)` — this function already exists across the deep-dive agents and follows this pattern:
```js
function extractArticleContent(html) {
  const start = html.indexOf('<article');
  const end = html.lastIndexOf('</article>');
  if (start !== -1 && end > start) {
    return html.slice(html.indexOf('>', start) + 1, end);
  }
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<meta[^>]*/gi, '')
    .replace(/<title[^>]*>[\s\S]*?<\/title>/gi, '');
}
```

**Step 3 — Identify primary product:** Scan `href` attributes for `/products/<handle>` paths. Count occurrences per handle. Use the handle with the most occurrences. If no product links found, log a warning and return the HTML unchanged (skip injection).

**Step 4 — Fetch product from Shopify:** Call `getProducts({ handle })`. If result is empty or undefined, log a warning and return unchanged. Extract:
- `product.title` — display name
- `product.images?.[0]?.src` — product image URL (may be undefined; handled in HTML block)
- `product.variants?.[0]?.price` — price string like `"18.99"` (may be undefined; omit price span if missing)

**Step 5 — Fetch review data from Judge.me:** Call `fetchTopReview()` and `fetchProductStats()` in parallel. Both may return `null` — treat as graceful degradation (see Fallback Behaviour).

**Step 6 — Remove existing mid-article CTA:** Strip the writer's dashed section:
```js
html = html.replace(/<section[^>]*border:1px dashed[^>]*>[\s\S]*?<\/section>/gi, '');
```

**Step 7 — Calculate target word position:**
- Strip HTML tags to get plain text: `html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()`
- Count words: `text.split(/\s+/).filter(Boolean).length`
- Target = `Math.floor(avgScrollDepth / 100 * totalWordCount * 0.9)` (10% buffer)

**Step 8 — Find insertion point:** Walk through `</p>` tags in order. For each, count the words in the plain text up to that position. Stop at the first `</p>` whose cumulative word count meets or exceeds the target. Insert the featured product block immediately after that `</p>`. If no `</p>` is found before the target, append the block before `</article>` (or at the end of content).

**Step 9 — Build and insert HTML block:** See HTML Block section below.

### Fallback behaviour

| Condition | Fallback |
|---|---|
| `rsc-featured-product` already present | Skip entirely, return HTML unchanged |
| No `/products/` links in article | Skip injection, log warning, continue to next article |
| `getProducts()` returns empty | Skip injection, log warning, continue |
| `product.images` empty or missing | Omit `<img>` element from block |
| `product.variants` empty or missing | Omit price `<span>` from block |
| Judge.me API error or missing token | Omit quote block and star/count line entirely; show product name + price + button only |
| `fetchTopReview()` returns null | Omit quote block and "Verified Buyer" line; keep stars + count from `fetchProductStats()` |
| `fetchProductStats()` returns null | Omit star rating and review count line |
| No Clarity snapshots | Use 40% scroll depth |
| No GSC snapshot (retroactive mode) | Throw error — cannot determine top posts |

### Star rendering

`fetchProductStats()` returns `rating` as a decimal (e.g. `4.8`). Render stars using `Math.round(rating)` filled stars. A rating of 4.8 rounds to 5 → `★★★★★`. A rating of 4.2 rounds to 4 → `★★★★☆`. No half-stars.

```js
function renderStars(rating) {
  const filled = Math.round(rating);
  return '★'.repeat(filled) + '☆'.repeat(5 - filled);
}
```

## HTML Block

```html
<div class="rsc-featured-product" style="border:2px solid #e5e7eb;border-radius:14px;overflow:hidden;margin:28px 0;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.06)">
  <div style="display:flex;gap:0">
    <!-- img element only present when product.images[0] exists -->
    <img src="{{IMAGE_URL}}" style="width:130px;object-fit:cover;flex-shrink:0" alt="{{PRODUCT_TITLE}}">
    <div style="padding:16px 18px;flex:1">
      <div style="font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:#6b7280;font-family:sans-serif;margin-bottom:4px">Featured Pick</div>
      <div style="font-size:15px;font-weight:800;color:#111;font-family:sans-serif;margin-bottom:6px;line-height:1.3">{{PRODUCT_TITLE}}</div>
      <!-- quote block only present when fetchTopReview() returns non-null -->
      <div style="font-size:13px;color:#374151;font-family:sans-serif;font-style:italic;line-height:1.5;margin-bottom:10px;padding-left:10px;border-left:3px solid #AEDEAC">&ldquo;{{REVIEW_QUOTE}}&rdquo;</div>
      <!-- stars line only present when fetchProductStats() returns non-null -->
      <div style="font-size:11px;color:#6b7280;font-family:sans-serif;margin-bottom:12px">&#8212; Verified Buyer &nbsp;&middot;&nbsp; <span style="color:#f59e0b">{{STARS}}</span> &nbsp;&middot;&nbsp; {{REVIEW_COUNT}} reviews</div>
      <div style="display:flex;align-items:center;gap:10px;font-family:sans-serif">
        <!-- price span only present when product.variants[0] exists -->
        <span style="font-size:18px;font-weight:800;color:#111">${{PRICE}}</span>
        <a href="https://www.realskincare.com/products/{{PRODUCT_HANDLE}}" style="background:#1e1b4b;color:#fff;padding:8px 18px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:700">Add to Cart &#x2192;</a>
      </div>
    </div>
  </div>
</div>
```

Note: the product URL is hardcoded to `realskincare.com` — this agent is site-specific by design. The store domain matches `SHOPIFY_STORE_URL` in `.env`.

## Dashboard Integration

### Button (in CRO tab actions group)

```html
<button onclick="runAgent('agents/featured-product-injector/index.js', ['--top', '3'])"
  data-tip="Inject featured product sections into the 3 highest-traffic blog posts">
  Inject Featured Products
</button>
```

### Run-log element (inside `#tab-cro`)

```html
<pre id="run-log-agents-featured-product-injector-index-js" style="display:none" class="run-log"></pre>
```

The ID follows the existing convention: agent path with `/` and `.` replaced by `-`. The existing `runAgent()` infrastructure derives the element ID from the agent path automatically — no custom wiring needed.

### Allowlist entry

```js
'agents/featured-product-injector/index.js',
```

## Environment Variables

Add to `.env`:

```
JUDGEME_API_TOKEN=<your Judge.me private API token>
JUDGEME_SHOP_DOMAIN=realskincare.myshopify.com
```

`JUDGEME_SHOP_DOMAIN` must be the `.myshopify.com` domain. Judge.me's API requires this format for the `shop_domain` parameter on all endpoints — the custom domain (`realskincare.com`) will not work.

## Updated Pipeline

```
content-researcher → blog-post-writer → featured-product-injector → editor → image-generator → (manual review) → publisher
```

## Out of Scope

- Per-page scroll depth (Clarity only exposes site-wide aggregate)
- A/B testing different product selections
- Automatic re-injection when review data changes
- Showing multiple products per post
- Half-star rendering
