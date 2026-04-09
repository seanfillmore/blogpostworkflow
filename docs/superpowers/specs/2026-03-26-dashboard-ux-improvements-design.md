# Dashboard UX Improvements — Design Spec

**Date:** 2026-03-26
**File:** `agents/dashboard/index.js`

## Overview

Three UX improvements to the SEO dashboard: scrollable kanban columns in the Content Pipeline, richer table controls (pagination, sort, filter, search) in Keyword Rankings, and paginated Posts table with an image lightbox.

---

## 1. Content Pipeline — Scrollable Kanban Columns

**Current behavior:** Each column shows up to 20 items via `slice(0, 20)` with a "+N more" text indicator at the bottom.

**New behavior:**
- Remove the `slice(0, 20)` cap — render all items in every column.
- Each `.kanban-items` container gets `max-height: ~220px` and `overflow-y: auto` so approximately 10 items are visible before scrolling.
- A subtle scrollbar is always visible (or styled with thin scrollbar CSS) to signal that the column is scrollable.
- Column item count in the header is unchanged.
- No pagination — the full list is always in the DOM, just scrolled.

---

## 2. Keyword Rankings — 10-row pagination, sort, filter, search

**Current behavior:** 20 rows per page, Prev/Next pagination, no sorting, no filtering, no search.

**New behavior:**

### Page size
- Reduce `RANK_PAGE_SIZE` from 20 to 10.

### Search bar
- A text input above the table labeled "Search keywords…".
- Filters the full `r.items` array by keyword substring (case-insensitive) before pagination is applied.
- Typing resets `rankPage` to 0 so results start at page 1.

### Column sort
- Clicking a column header cycles: ascending → descending → unsorted.
- An arrow indicator (↑ / ↓) appears in the active header.
- Sortable columns: Keyword (alpha), Position (numeric, nulls last), Change (numeric), Volume (numeric), Tier (by tier rank: page1 → quickWins → needsWork → notRanking).
- Sort state stored in `rankSort = { col: null, dir: null }`.
- Sort is applied after search filter, before pagination.

### Column filter dropdowns
- A small ▾ icon beside each column header label opens an inline dropdown with discrete filter values.
- Clicking outside or selecting a value closes the dropdown.
- Active filter values per column:
  - **Keyword**: no dropdown (search bar covers this)
  - **Position**: All / Top 3 (1–3) / Top 10 (1–10) / Top 20 (1–20) / 20+ / Not ranking
  - **Change**: All / Improved / Declined / No change / New
  - **Volume**: All / High (≥1000) / Med (100–999) / Low (<100)
  - **Tier**: All / Page 1 / Quick Win / Needs Work / Not Ranking
- Active filters stored in `rankFilters = { position: 'all', change: 'all', volume: 'all', tier: 'all' }`.
- Active non-default filters shown as dismissible chips above the table (clicking × resets that filter).
- All filters are applied after search, before sort, before pagination.

### State variables (browser-side globals)
```js
let rankPage = 0;
let rankSearch = '';
let rankSort = { col: null, dir: null };  // dir: 'asc' | 'desc' | null
let rankFilters = { position: 'all', change: 'all', volume: 'all', tier: 'all' };
const RANK_PAGE_SIZE = 10;
```

---

## 3. Posts — 10-row pagination + image lightbox

### Pagination
- Add `let postsPage = 0` and `const POSTS_PAGE_SIZE = 10`.
- Slice `d.posts` by page in `renderPosts`, add identical Prev/Next pagination bar below the table.
- Pagination resets to page 0 when `renderPosts` is called on data refresh.

### Image column — lightbox
- The dashboard HTTP server gets a new route: `GET /images/:slug` — reads `data/images/<slug>.webp` (or `.png` if `.webp` absent) and streams it with appropriate `Content-Type`.
- In the Posts table, `imgHtml` becomes a clickable link when an image exists:
  ```
  <a href="#" onclick="openImageModal('/images/<slug>')" ...>🖼</a>
  ```
- `openImageModal(src)` injects a lightbox overlay into the DOM:
  - Full-screen semi-transparent dark backdrop (`position:fixed`, `z-index:9999`)
  - Centered `<img>` with `max-width:90vw; max-height:90vh`
  - Click backdrop or press Escape closes and removes the overlay
- No external libraries — pure inline DOM manipulation.

---

## Implementation scope

All changes are in `agents/dashboard/index.js`:
- New HTTP route handler for `/images/:slug` (server-side, ~10 lines)
- CSS additions for scrollable kanban columns and lightbox overlay
- Updated `renderPipeline`, `renderRankings`, `renderPosts` browser-side functions

No new files required.

---

## Edge cases

- **Keyword Rankings search + filter + sort interaction:** search is applied first (reduces item pool), then filters, then sort, then pagination. Changing any of these resets `rankPage = 0`.
- **Rankings filter dropdown z-index:** dropdown must appear above table rows. Use `position:absolute; z-index:100`.
- **Image not found:** if neither `.webp` nor `.png` exists for a slug, the server returns 404. The lightbox `<img>` would show a broken image — acceptable since `hasImage` is only `true` when the file exists at the time of the data load.
- **Escape sequences in template literal:** all new browser JS strings must use `\\n` not `\n` per the dashboard code review checklist. Regex patterns must not use `\s`, `\t`, etc. — use `[ ]` or explicit character classes.
