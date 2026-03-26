# Blog Sidebar & Newsletter Form — Design Spec

**Goal:** Add a sticky product sidebar and mid-post newsletter signup to all Real Skin Care blog posts by editing the Shopify theme's article section — no pipeline changes required.

**Architecture:** Modify `sections/main-article.liquid` in the live theme to convert the single-column article layout into a two-column layout. The sidebar is rendered server-side via Liquid using a curated Shopify collection. The newsletter form is injected client-side via JavaScript after the 2nd heading.

**Tech Stack:** Shopify Liquid, inline CSS (raw `<style>` tag in section body), vanilla JavaScript, Klaviyo embed, Shopify Admin API (theme asset read/write)

---

## 1. Layout

The `content` block in `sections/main-article.liquid` is wrapped in a flex container:

- **Left column** — article body (`flex: 1`, `min-width: 0`), contains `{{ article.content }}`
- **Right sidebar** — fixed 280px width, `position: sticky; top: 20px` so it tracks the reader as they scroll

All other blocks (title, hero image, breadcrumb, share, back to blog) are unchanged.

**Mobile breakpoint (≤768px):** flex direction switches to column; sidebar renders below the article content with `position: static` and full width.

**CSS injection:** Add a raw `<style>` tag directly in the section body (not inside the existing `{%- style -%}` Shopify tag). The `{%- style -%}` block is for section-scoped variables only; layout CSS goes in a plain `<style>` block placed immediately before the two-column wrapper div.

---

## 2. Product Sidebar

**Heading:** "Our Products"

**Data source:** A Shopify collection with handle `blog-sidebar`. Create this collection in the Shopify admin with **Manual** sort order so display priority is controlled by drag-and-drop. Initially populate with ~6 products (lotion, coconut cream, toothpaste, deodorant, bar soap, liquid soap). Adding or removing products from the collection instantly updates the sidebar on all posts.

**Graceful degradation:** Use the following Liquid guard before rendering the sidebar column. If the collection is missing or empty, the sidebar div is not rendered at all — no empty box.

```liquid
{% assign sidebar_collection = collections['blog-sidebar'] %}
{% if sidebar_collection != empty and sidebar_collection.products.size > 0 %}
  {% comment %}render sidebar{% endcomment %}
{% endif %}
```

**Product count limit:** Render at most 6 products (`for product in sidebar_collection.products limit: 6`). This caps mobile scroll length even if the collection grows.

**Per-product card layout (vertical list):**
- Product image: request a square crop via `product.featured_image | image_url: width: 280, height: 280, crop: 'center'`. Display at 100% sidebar width with `object-fit: cover` and a fixed aspect ratio container (1:1).
- Product title
- Price from `product.price_min | money`
- "Shop Now" button linking to `{{ product.url }}`

---

## 3. Newsletter Form

**Klaviyo form ID:** `Xr4S7X`

**Pre-implementation check:** Before deploying, verify that the Klaviyo Shopify app is configured to inject its script on all storefront pages (not limited to cart/product pages). In Klaviyo → Integrations → Shopify, confirm "Enable on all pages" is active. If not, add `<script async src="https://static.klaviyo.com/onsite/js/klaviyo.js?company_id=VcMJJb"></script>` to the section as a fallback.

**Placement:** After the 2nd `<h2>` or `<h3>` heading in the article body.

**Implementation:** A vanilla JavaScript snippet placed immediately after the article content `<div>` in the template (not in `<head>`). On `DOMContentLoaded` it:
1. Queries all `h2, h3` elements inside the article content container
2. Takes the element at index 1 (the 2nd heading)
3. Inserts a styled wrapper containing `<div class="klaviyo-form-Xr4S7X"></div>` immediately after it using `insertAdjacentElement('afterend', ...)`

**Fallback:** If fewer than 2 headings exist, append the form at the end of the article content container.

**Styling:** Full width of the content column, `margin: 32px 0`, subtle background or border to visually separate it from article text.

---

## 4. Implementation Approach

All changes are made to a single theme file: `sections/main-article.liquid`.

**Before starting:** Verify the live theme ID via the Shopify API (`GET /admin/api/2025-01/themes.json`, find the entry with `"role": "main"`). Do not rely on the hardcoded ID from brainstorming — use the API response at implementation time.

**Steps:**
1. Download current `sections/main-article.liquid` via Shopify Admin API
2. Create `<repo-root>/backup/` if it does not exist, then save the original to `<repo-root>/backup/main-article-YYYY-MM-DD.liquid` before making any edits
3. Edit the `content` block: wrap in two-column flex layout, add sidebar Liquid, add newsletter JS
4. Add layout CSS as a raw `<style>` block in the section body
5. Create the `blog-sidebar` collection in Shopify admin (handle must be exactly `blog-sidebar`, sort order: Manual), add products
6. Upload edited file to the live theme via Shopify Admin API
7. Verify on a live post (see acceptance criteria below)

**Rollback:** Re-upload the saved backup file (`backup/main-article-YYYY-MM-DD.liquid`) via Shopify Admin API. No other files need to be reverted.

---

## 5. Acceptance Criteria

Verify all of the following on a live published blog post before considering the deployment complete:

- [ ] Two-column layout renders correctly on desktop (article left, sidebar right)
- [ ] Sidebar shows products from the `blog-sidebar` collection with image, title, price, and "Shop Now" link
- [ ] "Shop Now" links navigate to the correct product pages
- [ ] Sidebar is sticky — it stays visible as the user scrolls through a long post
- [ ] Newsletter form appears after the 2nd heading in the article body
- [ ] Klaviyo form renders (not an empty box) — confirm the form is visible and functional
- [ ] On mobile (≤768px): sidebar stacks below article content, full width, no sticky behavior
- [ ] If `blog-sidebar` collection is empty or missing: no empty sidebar box appears

**Rollback trigger:** If any of the above checks fail and cannot be fixed within one edit cycle, re-upload the backup immediately.

---

## 6. Constraints & Non-Goals

- No pipeline agents are modified — this is a pure theme change
- The `blog-sidebar` collection is managed manually in Shopify admin, not by any agent
- No new npm dependencies
- The non-main theme (any theme with `role != 'main'`, verified via API) is not touched — changes go to the live theme only
