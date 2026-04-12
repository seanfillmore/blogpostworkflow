# Approve = Publish for Performance Queue Items — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the dashboard "Approve" button for performance queue items publish the refreshed HTML to Shopify immediately, instead of just marking the item as approved.

**Architecture:** The approve POST handler in `performance-queue.js` gains Shopify publish logic (look up article ID from post metadata, call `updateArticle`, copy refreshed HTML to canonical path, stamp as published). The frontend button text changes to "Approve & Publish" with a loading state.

**Tech Stack:** Node.js, Shopify Admin REST API via `lib/shopify.js`

---

### Task 1: Backend — Approve handler publishes to Shopify

**Files:**
- Modify: `agents/dashboard/routes/performance-queue.js:1-41`

- [ ] **Step 1: Add imports for Shopify API and filesystem operations**

At the top of `agents/dashboard/routes/performance-queue.js`, add the Shopify helpers and fs imports needed for publishing:

```js
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listQueueItems, writeItem } from '../../performance-engine/lib/queue.js';
import { getBlogs, updateArticle } from '../../../lib/shopify.js';
```

This replaces the existing imports on lines 1-4 (the `readFileSync`/`existsSync` from `node:fs` and `join` from `node:path` are already imported — add `writeFileSync`; add the Shopify imports as new).

Current imports to replace:

```js
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { listQueueItems, writeItem } from '../../performance-engine/lib/queue.js';
```

- [ ] **Step 2: Rewrite the approve handler to include publish logic**

Replace the approve route handler (lines 28-41) with:

```js
  {
    method: 'POST',
    match: (url) => /^\/api\/performance-queue\/[^/]+\/approve$/.test(url),
    async handler(req, res, ctx) {
      const slug = req.url.split('/')[3];
      const item = findItem(slug);
      if (!item) return notFound(res);

      // Look up Shopify article ID from post metadata
      const postMetaPath = join(ctx.ROOT, 'data', 'posts', `${slug}.json`);
      if (!existsSync(postMetaPath)) {
        return respondJson(res, { ok: false, error: `No post metadata found for "${slug}"` }, 400);
      }
      const postMeta = JSON.parse(readFileSync(postMetaPath, 'utf8'));
      if (!postMeta.shopify_article_id) {
        return respondJson(res, { ok: false, error: `No shopify_article_id in post metadata for "${slug}"` }, 400);
      }

      // Read refreshed HTML
      if (!existsSync(item.refreshed_html_path)) {
        return respondJson(res, { ok: false, error: `Refreshed HTML not found at ${item.refreshed_html_path}` }, 400);
      }
      const refreshedHtml = readFileSync(item.refreshed_html_path, 'utf8');

      // Publish to Shopify
      try {
        const blogs = await getBlogs();
        const blogId = blogs[0].id;
        await updateArticle(blogId, postMeta.shopify_article_id, { body_html: refreshedHtml });
      } catch (err) {
        return respondJson(res, { ok: false, error: `Shopify publish failed: ${err.message}` }, 502);
      }

      // Copy refreshed HTML over canonical local file
      const canonicalPath = join(ctx.ROOT, 'data', 'posts', `${slug}.html`);
      writeFileSync(canonicalPath, refreshedHtml);

      // Stamp item as published
      item.status = 'published';
      item.approved_at = new Date().toISOString();
      item.published_at = new Date().toISOString();
      writeItem(item);

      respondJson(res, { ok: true, published: true });
    },
  },
```

- [ ] **Step 3: Verify the server starts without errors**

Run: `node agents/dashboard/index.js &` (kill after verifying startup)

Expected: Server starts on configured port without import or syntax errors.

- [ ] **Step 4: Commit**

```bash
git add agents/dashboard/routes/performance-queue.js
git commit -m "feat: approve handler publishes queue items to Shopify"
```

---

### Task 2: Frontend — Button text and loading state

**Files:**
- Modify: `agents/dashboard/public/js/dashboard.js:486-511`

- [ ] **Step 1: Update button text in renderPerformanceQueueCard**

In `agents/dashboard/public/js/dashboard.js`, find the approve button rendering (line 487) and change the button text and add an ID for the loading state. Replace:

```js
          ? '<button class="btn-approve" onclick="approveQueueItem(\'' + esc(i.slug) + '\')"' + (i.status === 'approved' ? ' disabled' : '') + '>' + (i.status === 'approved' ? 'Approved' : 'Approve') + '</button>' +
```

With:

```js
          ? '<button id="approve-btn-' + esc(i.slug) + '" class="btn-approve" onclick="approveQueueItem(\'' + esc(i.slug) + '\')">' + 'Approve & Publish' + '</button>' +
```

Note: Removed the `approved` disabled state since approved items now become published and won't appear in the pending/approved branch at all.

- [ ] **Step 2: Update approveQueueItem function with loading state and error handling**

Replace the `approveQueueItem` function (lines 508-511) with:

```js
async function approveQueueItem(slug) {
  var btn = document.getElementById('approve-btn-' + slug);
  if (btn) { btn.disabled = true; btn.textContent = 'Publishing...'; }
  try {
    var res = await fetch('/api/performance-queue/' + encodeURIComponent(slug) + '/approve', { method: 'POST' });
    var data = await res.json();
    if (!res.ok || !data.ok) {
      alert('Publish failed: ' + (data.error || 'Unknown error'));
      if (btn) { btn.disabled = false; btn.textContent = 'Approve & Publish'; }
      return;
    }
    loadData();
  } catch (err) {
    alert('Publish failed: ' + err.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Approve & Publish'; }
  }
}
```

- [ ] **Step 3: Test in browser**

Open the dashboard, navigate to the Optimize tab, find a pending queue item. Verify:
- Button says "Approve & Publish" (not "Approve")
- Clicking it shows "Publishing..." while in flight
- On success, item disappears from the queue
- Check Shopify admin to confirm the article body_html was updated

- [ ] **Step 4: Commit**

```bash
git add agents/dashboard/public/js/dashboard.js
git commit -m "feat: approve button shows 'Approve & Publish' with loading state"
```
