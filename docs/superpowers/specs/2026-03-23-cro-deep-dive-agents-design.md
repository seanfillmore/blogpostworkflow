# CRO Deep Dive Agents — Design Spec

**Date:** 2026-03-23

## Overview

Extend the CRO analysis system with three category-expert agents that produce per-page, data-driven action plans. Each action item in the CRO brief gets a "Deep Dive" button in the dashboard. Clicking it launches the appropriate category agent, which reads the actual page HTML and relevant data sources, then emails an HTML report with specific, researched recommendations.

## Problem Statement

The current CRO analyzer generates action items from aggregate metrics without reading actual page content. This produces generic suggestions (e.g. "add CTAs") that are already implemented, wasting review time and eroding trust in the tool. The system needs to read each page before making recommendations.

## Architecture

Four layers:

1. **CRO Analyzer** (small change) — embeds a `category` tag in each action item heading in the Markdown brief.
2. **Three deep-dive agents** — category experts that read page HTML + relevant data sources and produce a specific action plan.
3. **Dashboard routing** — parses `category` tags from the brief and renders a "Deep Dive" button per action item, routing to the correct agent.
4. **Email report** — each agent emails an HTML report with findings and a numbered action plan.

## CRO Brief Changes

### Category tag encoding

The brief uses Markdown headings. Each action item heading gets an inline HTML comment tag that the dashboard can parse via regex without breaking Markdown rendering:

```markdown
### 1. Reposition mid-content CTA above scroll drop-off point <!-- category:content-formatting page:can-you-use-coconut-oil-as-toothpaste -->
```

The dashboard parses `<!-- category:(\S+) page:(\S+) -->` from each heading line.

### Updated CRO analyzer prompt

The prompt is updated to append `<!-- category:<value> page:<handle> -->` after every action item heading, **before** any priority marker. The required output format is:

```
### 1. Action item title <!-- category:content-formatting page:article-handle --> — HIGH
```

This order (comment before `— PRIORITY`) is mandatory so the dashboard stripping regex works correctly. Valid category values: `content-formatting`, `seo-discovery`, `trust-conversion`. Items that don't clearly fit a category omit the tag (dashboard falls back to "Manual" badge).

## Agent CLI Interface

All three agents share the same argument contract:

```
node agents/cro-deep-dive-<type>/index.js \
  --handle <article-handle> \
  --item "<action item title string only>"
```

- `--handle` — the Shopify article handle (e.g. `can-you-use-coconut-oil-as-toothpaste`)
- `--item` — the action item title text (plain heading text only — no HTML comment, no `— HIGH/MED/LOW` suffix). Used to contextualize the report.

Dashboard passes `--handle` and `--item` as an array to `runAgent()`, which uses `spawn('node', [script, ...args])` — no shell interpolation. Special characters in `--item` are safe.

## Article Lookup Pattern

All agents locate the article by handle using this pattern:

```js
import { getBlogs, getArticles } from '../../lib/shopify.js';

const blogs   = await getBlogs();
const blog    = blogs.find(b => b.handle === 'news');
const articles = await getArticles(blog.id, { limit: 250 });
const article  = articles.find(a => a.handle === handle);
if (!article) throw new Error(`Article not found: ${handle}`);
```

The `rsc-cta-block` class is the confirmed CTA block class used by this site (injected by `agents/cro-cta-injector/index.js`). If zero `rsc-cta-block` elements are found in `body_html`, agents log a warning and skip CTA-position steps (do not abort entirely).

## Snapshot File Paths

All agents load the most recent file from each snapshot subdirectory:

```
data/snapshots/clarity/<YYYY-MM-DD>.json     ← site-wide aggregate only
data/snapshots/gsc/<YYYY-MM-DD>.json         ← site-wide aggregate only
data/snapshots/shopify/<YYYY-MM-DD>.json
```

**Important:** Clarity snapshots contain site-wide aggregate scroll depth only — no per-page breakdown. GSC snapshots contain site-wide top queries — no per-page query breakdown. Per-page data must be fetched at runtime from the Ahrefs GSC MCP tools.

Helper: load most recent file = `fs.readdirSync(dir).sort().at(-1)`.

## Agent 1: Content & Formatting (`agents/cro-deep-dive-content/index.js`)

**Domain:** CTA placement, image density, heading cadence, readability, paragraph length.

**Data sources:**
- Shopify article HTML (full `body_html` via `getArticles` + handle lookup)
- Most recent `data/snapshots/clarity/<date>.json` — **site-wide** avg scroll depth used as proxy for all pages
- Most recent `data/snapshots/gsc/<date>.json` — site-wide CTR (used for context only)

**Analysis steps:**
1. Parse all `rsc-cta-block` elements: compute each one's position as a percentage of total word count
2. Compare CTA positions against site-wide avg scroll depth (Clarity) — flag any CTA placed more than 10 percentage points below the scroll drop-off. Note in report that this is a site-wide proxy, not a page-specific figure.
3. Count images (`<img>` tags): compute image-per-1000-words ratio; flag any gap longer than 500 words with no image or CTA
4. Measure heading cadence: find the longest text-only run (in words) between consecutive H2/H3 tags
5. Paragraph length: flag paragraphs over 120 words
6. Identify the longest text block before the first CTA (word count)

**Output report sections:**
```
## Content & Formatting Deep Dive — [Article Title]
**Page:** https://www.realskincare.com/blogs/news/<handle>
**Action Item Analyzed:** <--item value>
**Data sources:** Shopify HTML, Clarity snapshot (site-wide), GSC snapshot

### What We Found
- CTA at 65% of content; site-wide avg scroll depth is 42% → likely invisible to majority of readers
- 847-word block between heading "Benefits" and next H2 with no image or CTA
- Paragraph at word 320–460 is 140 words (above 120-word threshold)
- ...

### Action Plan
1. Move mid-content CTA from after paragraph 8 (~65%) to after paragraph 4 (~38%)
2. Insert image after paragraph 6 (current 847-word visual gap starting at word 380)
3. Break paragraph at word 320 into two shorter paragraphs
4. ...
```

## Agent 2: SEO & Discovery (`agents/cro-deep-dive-seo/index.js`)

**Domain:** Meta title/description, keyword alignment, internal linking, content gaps vs competitors.

**Data sources:**
- Shopify article data — `title`, `summary_html` (meta description), `body_html`
- Ahrefs GSC MCP: `gsc-keywords` filtered by page URL — provides top queries, impressions, CTR, position **per page** at runtime
- Ahrefs `keywords-explorer-overview` — KD + volume for top queries
- Ahrefs `serp-overview` — who ranks in positions 1–10 for the top query (identifies competitors above this page)

**Analysis steps:**
1. Extract title, H1 (first `<h1>` in body_html), meta description (`summary_html`)
2. Call `gsc-keywords` with `where: {"field":"url","is":["eq","https://www.realskincare.com/blogs/news/<handle>"]}` and `limit: 5` to get top queries for this specific page. **Verified:** the `gsc-keywords` tool schema explicitly lists `url` as a supported filter dimension alongside `keyword`, `clicks`, `impressions`, `ctr`, `position`, and `top_url`.
3. Check if primary query appears in title, H1, and meta description
4. Check meta description character length (target 140–160 chars); flag if missing, too short, or too long
5. Count internal links in body pointing to `/collections/` or `/products/` paths
6. For top query: call `keywords-explorer-overview` to get KD + volume; call `serp-overview` to see who ranks in positions 1–10 and identify which competitor pages outrank this one

**Output report sections:**
```
## SEO & Discovery Deep Dive — [Article Title]
**Page:** https://www.realskincare.com/blogs/news/<handle>
**Action Item Analyzed:** <--item value>
**Data sources:** Shopify, Ahrefs GSC, Ahrefs Keywords Explorer

### What We Found
- Title tag is 78 chars; primary query "fluoride free toothpaste" not in first 60 chars
- Meta description is 312 chars (truncated in SERP at 160)
- Top GSC query: "best fluoride free toothpaste" — 1,100 impressions/day, rank #6, CTR 2.1%
- 2 internal links to collections; competitors average 5+
- Competitor "healthline.com" ranks #3 for same query — targets featured snippet with a direct answer paragraph

### Action Plan
1. Rewrite title tag: "Best Fluoride-Free Toothpaste 2026 | Real Skin Care" (52 chars, keyword-first)
2. Rewrite meta description: [specific suggested copy, ≤160 chars]
3. Add internal links to 3 additional collections: [list]
4. Add a direct-answer paragraph targeting featured snippet for "best fluoride free toothpaste"
5. ...
```

## Agent 3: Trust & Conversion (`agents/cro-deep-dive-trust/index.js`)

**Domain:** Above-the-fold value prop, social proof, product link framing, CTA copy specificity, urgency/specificity signals.

**Data sources:**
- Shopify article `body_html`
- Shopify product/collection metafields for products linked from the article — attempt to read review data using common app namespaces: `judgeme` (key `product_widget`), `yotpo` (key `main_widget`), `okendo` (key `reviews_widget`). If no review metafields are found for a given product, skip and note "review data unavailable" in the report. Do not block analysis.
- Ahrefs GSC MCP: `gsc-keywords` filtered by page URL — CTR per page at runtime
- Most recent `data/snapshots/shopify/<date>.json` — order/conversion context (best-effort; skip fields if absent from snapshot)

**Analysis steps:**
1. Extract the first 200 words of body text (above-the-fold proxy) — assess value proposition clarity
2. Scan body for social proof signals: star ratings in text, review counts, testimonial quotes, certification mentions
3. Check all `<a>` tags pointing to `/collections/` or `/products/` — extract anchor text; flag generic text ("click here", "shop now" without product name). For each linked product/collection, extract the handle from the href path, then look up the ID and metafields using this pattern:
   - Products: `const [p] = await getProducts({ handle }); const mf = await getMetafields('products', p.id);`
   - Collections: `const [c] = await getCustomCollections({ handle }); const mf = await getMetafields('custom_collections', c.id);`
   - `getProducts` and `getCustomCollections` both accept a params object that is passed as query string params to Shopify REST — `{handle: 'foo'}` filters to that handle.
   - `getMetafields(resource, resourceId)` constructs `/${resource}/${resourceId}/metafields.json` — the resource string for custom collections is `'custom_collections'`.
4. Audit CTA copy inside `rsc-cta-block` elements — flag any using generic "Shop Now" without a product-specific noun
5. Count specific claims (percentages, ingredient names, timeframes) vs sentences containing only vague adjectives ("effective", "natural", "clean", "gentle")
6. Check if the first `<p>` block contains at least one specific, concrete benefit statement

**Output report sections:**
```
## Trust & Conversion Deep Dive — [Article Title]
**Page:** https://www.realskincare.com/blogs/news/<handle>
**Action Item Analyzed:** <--item value>
**Data sources:** Shopify HTML, Shopify product data, Ahrefs GSC

### What We Found
- Above-the-fold (first 200 words) contains no specific product claim or quantified benefit
- All 3 CTAs use generic "Shop Now" copy
- No social proof referenced anywhere in article
- Linked collection "vegan-toothpaste" — product data shows 47 reviews (4.8★) but this is not mentioned
- 6 of 9 benefit sentences use only vague adjectives with no specific claim

### Action Plan
1. Add a specific benefit claim to opening paragraph: e.g. "lauric acid kills 99% of S. mutans bacteria in lab studies"
2. Rename all CTA button text to match the target collection: "Try Our Vegan Toothpaste →"
3. Add social proof callout near primary CTA: "Rated 4.8★ by 47 customers"
4. Rewrite 3 vague sentences with specific ingredient or study references
5. ...
```

## Dashboard Integration

### Brief parsing

The existing `renderCroBrief()` function is updated to:

1. Regex-match `<!-- category:(\S+) page:(\S+) -->` from each action item heading line to extract category and page handle.
2. **Strip the HTML comment and the priority suffix from the heading text before extracting the item title.** Apply in order: (a) remove `<!--.*?-->`, (b) remove `[ ]*—[ ]*(HIGH|MED|LOW)[ ]*$` (use `[ ]` not `\s` — `\s` is a recognized JS escape and will be processed by Node.js in the template literal), (c) remove the leading `### N. ` prefix, (d) `.trim()`. Example: `"### 1. Reposition mid-content CTA <!-- category:content-formatting page:foo --> — HIGH"` → `itemTitle = "Reposition mid-content CTA"`.
3. Render a "Deep Dive" button (blue) for matched items; render the existing "Manual" badge (amber) for unmatched items.

### Deep Dive button handler

```js
function runDeepDive(category, handle, itemTitle) {
  var agentMap = {
    'content-formatting': 'agents/cro-deep-dive-content/index.js',
    'seo-discovery':      'agents/cro-deep-dive-seo/index.js',
    'trust-conversion':   'agents/cro-deep-dive-trust/index.js',
  };
  var agent = agentMap[category];
  if (!agent) return;
  runAgent(agent, ['--handle', handle, '--item', itemTitle]);
}
```

`itemTitle` is the stripped plain-text heading (no HTML comment, no priority suffix).

### Run-log elements

Three `<pre>` elements must be added inside the `#tab-cro` panel, following the existing `style="display:none"` convention (not a CSS class):

```html
<pre id="run-log-agents-cro-deep-dive-content-index-js" style="display:none" class="run-log"></pre>
<pre id="run-log-agents-cro-deep-dive-seo-index-js" style="display:none" class="run-log"></pre>
<pre id="run-log-agents-cro-deep-dive-trust-index-js" style="display:none" class="run-log"></pre>
```

The existing `runAgent()` function derives the element ID from the agent path automatically, so no further changes are needed to the runner.

## Email Report

Each agent calls `notify()` at completion:
- `subject`: `"CRO Deep Dive [Content|SEO|Trust]: <handle>"`
- `body`: the full report text (plain text or simple HTML)
- `status`: `"success"` or `"error"`

Reports are also written to `data/reports/cro/deep-dive/YYYY-MM-DD-<category>-<handle>.md`.

## File Structure

```
agents/
  cro-deep-dive-content/index.js   (new)
  cro-deep-dive-seo/index.js        (new)
  cro-deep-dive-trust/index.js      (new)
agents/cro-analyzer/index.js        (modified — add category+page tags to action item headings)
agents/dashboard/index.js           (modified — Deep Dive buttons, routing, 3 run-log pre elements, RUN_AGENT_ALLOWLIST)
data/reports/cro/deep-dive/         (new directory, created by agents at runtime)
```

## Dashboard Allowlist

The three new agents must be added to `RUN_AGENT_ALLOWLIST` in `agents/dashboard/index.js` or they will return HTTP 403 when called:

```js
'agents/cro-deep-dive-content/index.js',
'agents/cro-deep-dive-seo/index.js',
'agents/cro-deep-dive-trust/index.js',
```

## Out of Scope

- Technical agent (page speed, Core Web Vitals) — requires Shopify theme access, deferred
- Automated application of recommendations — reports are advisory; changes made manually or via existing agents
- Scheduling / recurring deep dives — on-demand only for now
- Per-page Clarity scroll depth — Clarity API does not expose per-page data in current integration; site-wide proxy used
