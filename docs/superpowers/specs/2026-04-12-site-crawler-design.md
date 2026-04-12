# Site Crawler Agent — DataForSEO On-Page API

**Date:** 2026-04-12
**Status:** Approved

## Problem

The technical-seo agent reads Ahrefs CSV exports that must be manually downloaded and dropped into `data/technical_seo/`. This is the last dependency on Ahrefs. DataForSEO's On-Page API can crawl the site and return the same issue data programmatically.

## Architecture

Two components:

1. **Site Crawler Agent** (`agents/site-crawler/index.js`) — handles the DataForSEO crawl lifecycle. Runs weekly via the scheduler.
2. **Technical-SEO agent changes** — new data loader reads crawl results instead of CSVs. All fix commands unchanged.

Plus additions to `lib/dataforseo.js` for the On-Page API methods.

## Site Crawler Agent

**File:** `agents/site-crawler/index.js`

### Crawl Lifecycle

1. **Submit** — POST `/on_page/task_post` with:
   - `target`: site domain from `config/site.json`
   - `max_crawl_pages`: 1000
   - `respect_sitemap`: true
   - `load_resources`: true (for image alt text checks)
   - `store_raw_html`: false
   - `enable_javascript`: false (Shopify pages are server-rendered)

2. **Poll** — GET `/on_page/summary/{task_id}` every 30 seconds until `crawl_status === 'finished'`. Timeout after 15 minutes.

3. **Fetch** — GET `/on_page/pages` with the task ID, paginating through all results (limit 1000 per request, offset pagination).

4. **Normalize** — Map per-page DataForSEO checks to issue categories matching the Ahrefs CSV structure:

   | DataForSEO field | Issue category | Ahrefs CSV equivalent |
   |---|---|---|
   | `status_code >= 400` | `error_404` | `Error-404_page` |
   | `meta.description` empty/null | `meta_missing` | `Warning-indexable-Meta_description_tag_missing_or_empty` |
   | `meta.description` length > 160 | `meta_too_long` | `Warning-indexable-Meta_description_too_long` |
   | `meta.description` length < 70 | `meta_too_short` | `Warning-indexable-Meta_description_too_short` |
   | `meta.title` length > 60 | `title_too_long` | `Warning-indexable-Title_too_long` |
   | `no_h1_tag: true` | `h1_missing` | `Warning-indexable-H1_tag_missing_or_empty` |
   | `no_image_alt: true` | `alt_missing` | `Warning-Missing_alt_text` |
   | `is_redirect: true` + redirect chain | `redirect_chain` | `Notice-Redirect_chain` |
   | `duplicate_description: true` | `duplicate_meta` | `Error-indexable-Multiple_meta_description_tags` |
   | `duplicate_title: true` | `duplicate_title` | `Error-indexable-Multiple_title_tags` |
   | `internal_links_count === 0` (indexable) | `orphan` | `Error-indexable-Orphan_page` |
   | `internal_links_count === 1` (indexable) | `single_link` | `Notice-indexable-Page_has_only_one_dofollow_incoming_internal_link` |
   | internal links pointing to 4xx pages | `links_to_404` | `Error-indexable-Page_has_links_to_broken_page` |
   | internal links pointing to 3xx pages | `links_to_redirect` | `Warning-indexable-Page_has_links_to_redirect` |

5. **Save** — Write `data/technical_seo/crawl-results.json`:
   ```json
   {
     "crawled_at": "2026-04-12T...",
     "task_id": "...",
     "pages_crawled": 160,
     "domain": "www.realskincare.com",
     "issues": {
       "error_404": [{ "url": "...", "title": "...", "status_code": 404, "inlinks": 3 }],
       "meta_missing": [{ "url": "...", "title": "..." }],
       "meta_too_long": [{ "url": "...", "title": "...", "meta_description_length": 180 }],
       ...
     }
   }
   ```

6. **Notify** — Send email summary via `lib/notify.js`: pages crawled, issue counts by severity.

### Cost

1,000 pages with resource loading at $0.000125/page = $0.125 per crawl. Weekly = ~$0.50/month.

## DataForSEO Client Additions

**File:** `lib/dataforseo.js`

Add three methods:

```
startCrawl(domain, options) → { taskId }
getCrawlSummary(taskId) → { status, pagesCrawled, pagesInQueue }
getCrawlPages(taskId, { offset, limit }) → [page objects]
```

## Technical-SEO Agent Changes

**File:** `agents/technical-seo/index.js`

### New data loader

Add `loadCrawlResults()` that reads `data/technical_seo/crawl-results.json` and returns the same shape as `loadAllCSVs()` — a map of issue category to array of row objects with the same field names the audit and fix commands expect (`url`, `title`, `meta_description_length`, `no._of_all_inlinks`, etc.).

### Audit command change

The `audit()` function currently calls `loadAllCSVs()`. Change to:

1. Check for `crawl-results.json` — if exists and less than 14 days old, use `loadCrawlResults()`
2. Fall back to `loadAllCSVs()` if no crawl results

### Fix commands

No changes. They operate on Shopify data, not on the audit data.

### Console output

Update references from "Ahrefs CSV" to "crawl data" in log messages.

## Scheduler Integration

Add the site-crawler agent to the weekly scheduler run, before the technical-seo audit:

```
Step N: site-crawler
  node agents/site-crawler/index.js
```

## Files Changed

| File | Change |
|------|--------|
| `agents/site-crawler/index.js` | New — crawl lifecycle agent |
| `lib/dataforseo.js` | Add `startCrawl`, `getCrawlSummary`, `getCrawlPages` |
| `agents/technical-seo/index.js` | Add `loadCrawlResults()`, update `audit()` to prefer crawl data |
| `scheduler.js` | Add site-crawler step |

## Not in scope

- Dashboard UI for crawl status (can be added later)
- Comparison between crawl runs (the technical-seo `compare` command handles this)
- Custom crawl configuration from the dashboard
