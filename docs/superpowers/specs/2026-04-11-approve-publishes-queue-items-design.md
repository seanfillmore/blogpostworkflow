# Approve = Publish for Performance Queue Items

**Date:** 2026-04-11
**Status:** Approved

## Problem

The Performance Queue "Approve" button only marks items as approved in the local JSON file. There is no mechanism in the dashboard to actually push the refreshed HTML to Shopify. Users expect clicking "Approve" to apply the change.

## Design

### Approve handler becomes approve + publish

When POST `/api/performance-queue/{slug}/approve` is called:

1. Load the queue item by slug (existing)
2. Read `data/posts/{slug}.json` to get `shopify_article_id`
3. Read the refreshed HTML from `item.refreshed_html_path`
4. Look up the blog ID via `getBlogs()` (first blog)
5. Call `updateArticle(blogId, articleId, { body_html })` to push to Shopify
6. Copy refreshed HTML over `data/posts/{slug}.html` to keep local canonical in sync
7. Stamp item: `status: 'published'`, `published_at: now`, `approved_at: now`
8. Return `{ ok: true, published: true }`

On failure (missing post metadata, missing article ID, Shopify API error):
- Item stays at current status (not stamped as published)
- Return `{ ok: false, error: '<message>' }`
- No partial state — either fully published or unchanged

### Frontend changes

- Button text: "Approve" becomes **"Approve & Publish"**
- Loading state: button shows **"Publishing..."** and is disabled while request is in flight
- On success: `loadData()` refreshes the list (published items already filtered out)
- On failure: `alert()` with the error message; item remains in queue for retry

### Rollback

No changes needed. The existing `/api/performance-queue/{slug}/rollback` endpoint restores from `backup_html_path` and sets status to `dismissed`.

## Files changed

| File | Change |
|------|--------|
| `agents/dashboard/routes/performance-queue.js` | Approve handler gains publish logic (Shopify API call, local file copy, status stamping) |
| `agents/dashboard/public/js/dashboard.js` | Button text "Approve & Publish", loading state, error alert |

## Dependencies

- `lib/shopify.js` — `updateArticle()`, `getBlogs()`
- `data/posts/{slug}.json` — must exist with `shopify_article_id` field
- `item.refreshed_html_path` — must exist on disk

## Not in scope

- Batch approve/publish all items at once
- Draft/preview on Shopify before publish (Preview button already shows refreshed HTML locally)
- Changes to the rollback flow
