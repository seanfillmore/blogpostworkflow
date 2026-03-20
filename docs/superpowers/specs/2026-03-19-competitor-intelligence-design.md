# Competitor Intelligence & Page Optimization Design

## Overview

This spec covers three interconnected features:

1. **Competitor Intelligence Agent** — identifies high-traffic competitor pages, scrapes their structure and screenshots them, and uses Claude vision to extract patterns worth replicating
2. **Optimize Tab** — a new dashboard tab housing the full review queue, per-change approval workflow, and apply pipeline
3. **Manual Actions Panel** — a cross-cutting dashboard enhancement that surfaces runnable commands on every tab so users can trigger agents without knowing CLI commands

---

## 1. Competitor Intelligence Agent

### Goal

Pull competitors' top product and collection pages by traffic value from Ahrefs, scrape their structure, capture screenshots, and use Claude vision to produce a structured optimization brief for each matching page on the store. Traffic value (USD cents from Ahrefs, display as dollars) serves as a conversion proxy — high traffic value = commercial intent.

### Implementation

**File:** `agents/competitor-intelligence/index.js`

**Run command:** `npm run competitor-intel`

**Pipeline steps:**

1. **Identify competitors** — `mcp__claude_ai_Ahrefs__management-project-competitors` to get configured competitors for the Ahrefs project
2. **Fetch top pages** — `mcp__claude_ai_Ahrefs__site-explorer-top-pages` for each competitor. Use the Ahrefs `doc` tool to confirm pagination parameters before implementing — the API is cursor or offset based and the page size should be set to maximum. Fetch all pages, then filter client-side to URLs containing `/products/` or `/collections/`. The Ahrefs endpoint does not support URL-pattern filtering; filtering is done after fetch.
3. **Rank by traffic value** — sort descending by `traffic_value` (raw USD cents), take top 5 pages per competitor
4. **Match to store pages** — load `data/sitemap-index.json`, extract all slugs. The sitemap index entries have the shape `{ url, slug, title, type, shopify_id }`. For each competitor page URL, extract the path segment after `/products/` or `/collections/` and compare against store slugs using the following priority: (a) exact slug match, (b) keyword overlap — tokenize both slugs on `-` and match if ≥2 tokens overlap. If no match by either method, skip the competitor page. The matched store slug and its `shopify_id` become the brief `slug` and `shopify_id`. If `shopify_id` is absent from the sitemap index entry, fetch it via `GET /products.json?handle=<slug>` or `GET /custom_collections.json?handle=<slug>` and use `products[0].id` or `custom_collections[0].id`.
5. **Fetch current store page content** — call Shopify Admin API to populate the brief's `current` object:
   - For products: `GET /products/<shopify_id>.json` → extract `title`, `body_html`; fetch `global.title_tag` and `global.description_tag` metafields via `GET /products/<shopify_id>/metafields.json`
   - For collections: `GET /custom_collections/<shopify_id>.json` or `GET /smart_collections/<shopify_id>.json` → extract `title`, `body_html`; fetch metafields similarly
   - For `theme_sections`: call `GET /admin/api/2025-01/themes.json?role=main` to get active theme ID, then `GET /admin/api/2025-01/themes/:id/assets.json` to list assets; filter to `sections/product-*.json` or `sections/collection-*.json`, fetch each with `?asset[key]=<key>`, store as `{ key, content }` array
6. **Scrape competitor page** — `fetch()` raw HTML with a browser-like User-Agent. On HTTP 403, rate-limit response (429), or Cloudflare challenge (detected by response body containing `cf-browser-verification`), log a warning and skip that page — do not throw. Extract from HTML:
   - H1, H2, H3 text content and document order
   - Section semantic labels: attempt to identify `<section>`, `<div>` blocks by class/id names containing keywords: `hero`, `benefit`, `ingredient`, `review`, `faq`, `feature`, `cta`
   - CTA button text: first `<button>` or `<a>` with class/text containing `cart`, `buy`, `shop`, `add`
   - Description word count: word count of the largest `<p>` block or `[class*="description"]` element
   - Benefit list format: `icon-bullets` if list items contain `<img>` or SVG, `bullets` if plain `<ul>/<li>`, `prose` otherwise
   - Keyword presence: check if page H1 and first `<p>` contain the matched store slug's tokens
7. **Screenshot store page** — Puppeteer full-page screenshot of the matched store page URL (constructed from `SHOPIFY_STORE` env var + `/products/<slug>` or `/collections/<slug>`), saved to `data/competitor-intelligence/screenshots/store-<slug>.png`. On Puppeteer navigation error or timeout, log a warning and continue without a store screenshot — set `store_screenshot: null` in the brief.
8. **Screenshot competitor page** — Puppeteer full-page screenshot of the competitor URL, saved to `data/competitor-intelligence/screenshots/<domain-slug>-<slug>.png` where `domain-slug` is the competitor domain with dots replaced by hyphens. On Puppeteer error or timeout, log a warning and set `screenshot: null` for that competitor entry — do not abort the brief.
9. **Claude vision analysis** — for each competitor page, send the competitor screenshot as an image attachment plus the extracted structure JSON as text to `claude-opus-4-6`. System prompt instructs it to return a JSON object with this exact schema:
   ```json
   {
     "h1": "string",
     "section_order": ["string"],
     "cta_text": "string",
     "description_words": 0,
     "keyword_in_h1": true,
     "keyword_in_first_paragraph": true,
     "benefit_format": "icon-bullets | bullets | prose",
     "conversion_patterns": ["string"],
     "recommended_changes": [
       {
         "type": "meta_title | meta_description | body_html | theme_section",
         "label": "string",
         "proposed": "string",
         "rationale": "string"
       }
     ]
   }
   ```
   The `conversion_patterns` array contains free-text observations about what makes the page effective. The `recommended_changes` array is the direct source for `proposed_changes` in the brief.
10. **Generate optimization brief** — merge results across all competitors for the store slug into one brief file (see Section 2). Deduplicate recommended changes by `type` — when multiple competitors suggest the same change type, take the recommendation from the competitor with the highest `traffic_value`. Write to `data/competitor-intelligence/briefs/<slug>.json`.

**Data directories:**
- `data/competitor-intelligence/screenshots/` — both competitor and store page screenshots
- `data/competitor-intelligence/briefs/` — per-page optimization briefs

---

## 2. Optimization Brief Format

**File:** `data/competitor-intelligence/briefs/<slug>.json`

All monetary values stored as raw USD cents (as returned by Ahrefs). Display layer divides by 100.

```json
{
  "slug": "natural-deodorant-for-women",
  "page_type": "product",
  "shopify_id": 123456789,
  "generated_at": "2026-03-19T15:00:00Z",
  "status": "pending",
  "store_screenshot": "data/competitor-intelligence/screenshots/store-natural-deodorant-for-women.png",

  "current": {
    "title": "...",
    "meta_title": "...",
    "meta_description": "...",
    "body_html": "...",
    "theme_sections": [
      {
        "key": "sections/product-faq.json",
        "content": {}
      }
    ]
  },

  "competitors": [
    {
      "domain": "example.com",
      "url": "https://example.com/products/example",
      "traffic_value": 420000,
      "screenshot": "data/competitor-intelligence/screenshots/example-com-natural-deodorant-for-women.png",
      "analysis": {
        "h1": "Best Natural Deodorant for Women",
        "section_order": ["hero", "benefits", "ingredients", "reviews", "faq"],
        "cta_text": "Add to Cart — Ships Free",
        "description_words": 320,
        "keyword_in_h1": true,
        "keyword_in_first_paragraph": true,
        "benefit_format": "icon-bullets",
        "conversion_patterns": [
          "Benefit bullets appear above the fold before any product description",
          "FAQ section targets 'sensitive skin' and 'how long does it last' queries"
        ],
        "recommended_changes": []
      }
    }
  ],

  "proposed_changes": [
    {
      "id": "change-001",
      "type": "meta_title",
      "label": "Meta title — keyword-lead formula",
      "current": "Natural Deodorant | Brand",
      "proposed": "Best Natural Deodorant for Women — Brand",
      "rationale": "3/3 top competitors lead with keyword + qualifier. Current title buries keyword.",
      "status": "pending"
    },
    {
      "id": "change-002",
      "type": "body_html",
      "label": "Product description rewrite",
      "current": "<p>Our natural deodorant...</p>",
      "proposed": "<h2>Why It Works</h2><ul><li>...</li></ul>",
      "rationale": "Competitors average 280 words with benefit bullets above the fold. Current: 80 words, no structure.",
      "status": "pending"
    },
    {
      "id": "change-003",
      "type": "theme_section",
      "label": "Add FAQ section",
      "section_key": "sections/product-faq.json",
      "proposed_content": {
        "type": "product-faq",
        "settings": {},
        "blocks": [
          {
            "type": "faq_item",
            "settings": {
              "question": "Does it work for sensitive skin?",
              "answer": "Yes — our formula is free from..."
            }
          }
        ]
      },
      "rationale": "2/3 competitors include FAQ targeting long-tail variants.",
      "status": "pending"
    }
  ]
}
```

**Change types:**
- `meta_title` — pushed via `global.title_tag` metafield on the product/collection resource
- `meta_description` — pushed via `global.description_tag` metafield
- `body_html` — pushed via Admin API `PUT /products/:id` or `PUT /custom_collections/:id`
- `theme_section` — pushed via Theme API; `section_key` is the asset key (e.g. `sections/product-faq.json`), `proposed_content` is the full section JSON as Shopify expects it

**`current.theme_sections`** — array of section assets currently present in the active theme that are relevant to the page type. Populated by reading Theme API assets matching `sections/product-*.json` or `sections/collection-*.json`. Each entry: `{ key: "sections/product-faq.json", content: { ...raw section JSON... } }`. Used by the apply agent to snapshot state before overwriting.

**`proposed_changes[].current`** — snapshot of the current value at brief generation time, for display in the diff UI. Read-only; not updated by the apply agent. The apply agent refreshes the top-level `current` object (the live Shopify snapshot) immediately before writing each change — these are two separate fields serving different purposes. For `theme_section` changes, `proposed_changes[].current` is omitted (the top-level `current.theme_sections` array serves as the snapshot for that type).

**Per-change status values:** `pending` / `approved` / `rejected` / `applied`

**Page-level status values:** `pending` / `in-review` / `applied` (page moves to `applied` when all approved changes have `status: "applied"`)

---

## 3. Apply Agent

### Goal

Push approved changes from a brief to Shopify. Only runs when explicitly triggered from the dashboard for a specific slug. Never runs automatically.

### Implementation

**File:** `agents/apply-optimization/index.js`

**Invoked by:** Dashboard `POST /apply/:slug` endpoint, which spawns the agent via `spawn()` (not `spawnSync`) and streams stdout back to the client via Server-Sent Events (SSE).

**Idempotency:** On startup, the agent re-reads the brief file and filters to changes with `status: "approved"`. If none are found (e.g. a duplicate trigger fired after a first run already set them to `applied`), the agent exits cleanly with a log message — no Shopify API calls made.

**Per change type:**

| Type | API Used | Field |
|---|---|---|
| `meta_title` | Admin API metafields | `global.title_tag` on products or collections resource |
| `meta_description` | Admin API metafields | `global.description_tag` on products or collections resource |
| `body_html` | `PUT /products/:id` or `PUT /custom_collections/:id` | `body_html` |
| `theme_section` | Theme API `PUT /themes/:id/assets.json` | Full section JSON at `section_key` |

**Safety rules:**
- Only processes changes with `status: "approved"`
- Before writing any change, reads current value from Shopify and stores it in `current.<field>` in the brief JSON (overwrites the snapshot taken at brief generation time with the live value — guards against drift)
- Updates each change's `status` to `applied` in the brief JSON after each successful API call
- If any single change fails, logs the error and continues with remaining approved changes — partial apply is acceptable; failed changes remain `approved` for retry
- After all changes processed, updates page-level `status` to `applied` if all approved changes are now `applied`
- On final stdout line before exit, writes a structured JSON summary: `DONE {"applied":N,"failed":N}`. The dashboard `/apply/:slug` endpoint reads stdout line by line; when it detects a line starting with `DONE `, it parses the JSON and emits it as the SSE `done` event. All other stdout lines are emitted as `data:` events verbatim.
- Sends Resend notification on completion (success or partial): page name, how many applied, how many failed, link to brief file

**Theme API usage:**
- Active theme ID: `GET /admin/api/2025-01/themes.json?role=main` → use `themes[0].id`
- Read section: `GET /admin/api/2025-01/themes/:id/assets.json?asset[key]=<section_key>`
- Write section: `PUT /admin/api/2025-01/themes/:id/assets.json` with body `{ asset: { key: "<section_key>", value: JSON.stringify(proposed_content) } }`

---

## 4. Optimize Tab

### Goal

A dedicated dashboard tab for the full competitor intelligence and page optimization workflow. Surfaces pending reviews, approval queue, and completed optimizations.

### Tab Structure

**Tab label:** Optimize (added alongside SEO, CRO, Ads)

**Hero KPIs** (tab-contextual, same pattern as existing tabs):
- Pages pending review — count of briefs with `status: "pending"` and ≥1 `pending` change
- Changes approved — count of changes across all briefs with `status: "approved"`
- Pages optimized this month — count of briefs where all approved changes have `status: "applied"` and `generated_at` is within the current calendar month
- Avg traffic value — average `traffic_value` across all competitor entries in all briefs, divided by 100 (display as USD)

**Actions panel** (collapsible, at bottom of tab — see Section 5):
- Run Competitor Intelligence
- Upload Ahrefs CSV (file picker with current file status)

**Main content — kanban columns:**

| Column | Definition |
|---|---|
| Pending | Briefs with ≥1 change with `status: "pending"` |
| Approved | Briefs where all changes are `approved` or `rejected` (none `pending`), at least one is `approved`, and none yet `applied` |
| Applied | Briefs where all approved changes have `status: "applied"` |

Briefs where every change is `rejected` (zero approved) are excluded from all columns — they are considered dismissed and not shown in the kanban.

Each card shows: page title, page type badge (`product` / `collection`), count of proposed changes by status, top competitor traffic value in USD.

### Detail View

Clicking a card expands inline below it.

**Header — two columns:**
- Left: store page screenshot (`store_screenshot` path from brief)
- Right: highest-traffic competitor screenshot (competitor with max `traffic_value`)

**Changes list:**
One card per entry in `proposed_changes`:
- Type label + change ID
- For `meta_title`, `meta_description`: plain text diff (current struck through, proposed in green)
- For `body_html`: rendered HTML preview of proposed value in a sandboxed `<iframe srcdoc>`
- For `theme_section`: JSON diff of `proposed_content` vs current section content
- Rationale text
- Approve button (green) / Reject button (red) — both POST to `/brief/:slug/change/:id`

**Footer:**
- "Apply Approved Changes" button — visible only when ≥1 change has `status: "approved"`
- On click: POSTs to `/apply/:slug`, response is SSE stream; dashboard renders each SSE line as a log entry in an inline log viewer below the button
- SSE stream ends with a `done` event containing `{ applied: N, failed: N }`

### Dashboard Server Endpoints (new)

**`POST /brief/:slug/change/:id`**
- Request body: `{ "status": "approved" | "rejected" }`
- Reads brief from `data/competitor-intelligence/briefs/<slug>.json`, finds change by `id`, sets `status`
- Response: `{ "ok": true, "change": { ...updated change object... } }`
- Error: `{ "ok": false, "error": "..." }` with HTTP 404 if slug/id not found

**`POST /apply/:slug`**
- No request body
- Spawns `agents/apply-optimization/index.js <slug>` via `spawn()`
- Response: SSE stream (`Content-Type: text/event-stream`). Each stdout line from the agent is emitted as `data: <line>\n\n`. On process exit: `event: done\ndata: {"applied":N,"failed":N}\n\n`
- If brief not found: returns HTTP 404 JSON before opening SSE

**`POST /upload/ahrefs`**
- Request: `multipart/form-data` with a single file field named `file`
- Saves to `data/ahrefs/<original-filename>` (no path traversal: strip directory components from filename). Silently overwrites if a file with the same name already exists.
- Response: `{ "ok": true, "filename": "...", "saved_at": "ISO8601" }`
- Error: `{ "ok": false, "error": "..." }`

**`POST /run-agent`** (see Section 5)

---

## 5. Manual Actions Panel

### Goal

Every dashboard tab gets a collapsible "Actions" section that surfaces all runnable commands relevant to that tab. Eliminates the need to know CLI commands.

### Implementation

Rendered at the bottom of each tab panel as a `<details>` element (collapsed by default). Each action is a button that POSTs to `/run-agent`. The response streams stdout back via SSE into an inline log viewer that appears below the button on first output.

**`POST /run-agent`**
- Request body: `{ "script": "string", "args": ["string"] }` where `script` is the relative path from `ROOT` to the entry point (e.g. `"agents/rank-tracker/index.js"`)
- Valid scripts are whitelisted server-side — the endpoint maintains a static allowlist of permitted script paths; requests with a `script` not on the allowlist return HTTP 403
- Spawns script via `spawn('node', [script, ...args], { cwd: ROOT })`
- Response: SSE stream. Each stdout/stderr line emitted as `data: <line>\n\n`. On exit: `event: done\ndata: {"code": 0}\n\n`
- Non-zero exit code is surfaced in the `done` event `code` field; dashboard renders log in red

**Per-tab actions and their scripts:**

**SEO tab:**
| Label | Script |
|---|---|
| Run Rank Tracker | `agents/rank-tracker/index.js` |
| Run Content Gap Analysis | `agents/content-gap/index.js` |
| Run GSC Query Miner | `agents/gsc-query-miner/index.js` |
| Refresh Sitemap Index | `agents/sitemap-indexer/index.js` |
| Run Insight Aggregator | `agents/insight-aggregator/index.js` |

**CRO tab:**
| Label | Script | Args |
|---|---|---|
| Create Meta A/B Test | `scripts/create-meta-test.js` | `[slug]` (user-provided via inline input) |
| Run Meta A/B Tracker | `agents/meta-ab-tracker/index.js` | none |
| Run CRO Analyzer | `agents/cro-analyzer/index.js` | none |

**Optimize tab:**
| Label | Script |
|---|---|
| Run Competitor Intelligence | `agents/competitor-intelligence/index.js` |

**Ads tab:** Populated when Ads agents are added.

### Input handling

Actions that require arguments show an inline `<input type="text" placeholder="slug">` when the button is clicked. A confirm button submits. The original button is disabled while a run is in progress (SSE stream open).

---

## 6. Ahrefs Upload & Reminder

### Goal

Allow manual Ahrefs CSV uploads from the dashboard browser UI, eliminating the need to SCP or git-push files to the server. Send a Resend email reminder 24 hours before the rank tracker runs, as it is the primary agent that depends on a freshly-uploaded Ahrefs file.

### File Upload

**Dashboard endpoint:** `POST /upload/ahrefs` (defined in Section 4)

**UI location:** Optimize tab Actions panel (collapsible section)

**UI elements:**
- Status line: "Current file: `<filename>` — uploaded `<date>`" (reads most recently modified file in `data/ahrefs/`; shows "No file uploaded" if directory is empty)
- File picker input (`accept=".csv,.zip"`)
- Upload button → POST → replaces status line with "Uploaded: `<filename>`"

### Reminder Notification

**File:** `scripts/ahrefs-reminder.js`

**Scope:** One reminder, scoped to the rank tracker. If additional Ahrefs-dependent agents are added in future, add additional reminder cron entries at that time.

**Email content (via `lib/notify.js`):**
- Subject: `Ahrefs CSV needed — rank tracker runs in 24 hours`
- Body: name of file needed (`Overview` export from Ahrefs Site Explorer), where to upload it (dashboard URL from `DASHBOARD_URL` env var, fallback to `http://localhost:4242`), scheduled run time
- Status: `info`

**Cron entry** (added to `scripts/setup-cron.sh`):
```
# Sunday 07:00 UTC — Ahrefs upload reminder (24h before Mon rank tracker at 07:00 UTC)
0 7 * * 0 node $PROJECT_DIR/scripts/ahrefs-reminder.js >> $PROJECT_DIR/data/reports/scheduler/ahrefs-reminder.log 2>&1
```

---

## 7. Data Directories

New directories to create (via `.gitkeep`):

```
data/competitor-intelligence/
data/competitor-intelligence/screenshots/
data/competitor-intelligence/briefs/
data/ahrefs/
```

Note: `data/ahrefs/` may already exist — add `.gitkeep` only if absent.

---

## Implementation Order

1. **Manual Actions panel** — `/run-agent` endpoint with allowlist, per-tab `<details>` panels, SSE log viewer, inline arg input
2. **Ahrefs file upload** — `POST /upload/ahrefs` endpoint + upload UI in Optimize tab Actions panel
3. **Ahrefs reminder script** — `scripts/ahrefs-reminder.js` + cron entry
4. **Optimize tab scaffold** — tab shell, KPI hero, kanban columns (reads existing briefs; no briefs yet so columns empty)
5. **Competitor Intelligence Agent** — Ahrefs fetch → client-side filter → slug match → scrape → screenshots → Claude vision → brief write
6. **Optimize tab detail view** — expand on click, screenshot pair, change cards, approve/reject endpoints
7. **Apply Agent** — `agents/apply-optimization/index.js`, SSE-streaming `POST /apply/:slug` endpoint

---

## Portability Notes

- All file paths derived from `ROOT = join(__dirname, '../../')` — no hardcoded `/root/seo-claude`
- `DASHBOARD_URL` env var used for reminder email link; defaults to `http://localhost:4242`
- Ahrefs project ID and competitor list managed via Ahrefs MCP project settings — no hardcoded competitor domains
- Brief format is versioned implicitly by `generated_at` — future schema changes append fields, never remove
- Theme API calls use `role=main` to always target the live theme — no hardcoded theme IDs
- `/run-agent` allowlist is defined as a `Set` constant in `agents/dashboard/index.js` — adding a new agent requires only adding its path to the set
