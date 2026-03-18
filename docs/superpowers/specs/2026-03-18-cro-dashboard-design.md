# CRO Dashboard — Design Spec
**Date:** 2026-03-18
**Status:** Approved

---

## Overview

A data collection and trend analysis system that gathers CRO signals from Microsoft Clarity and Shopify, stores daily snapshots, generates weekly AI-written briefs, and surfaces everything in a new CRO tab on the existing SEO dashboard.

The architecture mirrors the existing rank-tracker pattern: scheduled collectors pull data and save JSON snapshots, an analyzer reads snapshots and writes a report, and the dashboard reads from files — no live API calls at render time.

GSC and GA4 are explicitly out of scope for this iteration but the design is built to accommodate them as future collector agents.

---

## Architecture

Four new components:

### 1. `lib/clarity.js`
Clarity API client. Wraps the `project-live-insights` endpoint authenticated via `MICROSOFT_CLARITY_TOKEN`. Makes a GET request to `https://www.clarity.ms/export-data/api/v1/project-live-insights` with `Authorization: Bearer <token>`. Parses the raw API response (an array of `{ metricName, information }` objects) and returns a normalized object.

**Raw API → normalized field mapping (confirmed against live API):**
| Raw `metricName` | Normalized field |
|---|---|
| `Traffic.totalSessionCount` | `sessions.total` |
| `Traffic.totalBotSessionCount` | `sessions.bots` |
| `Traffic.distinctUserCount` | `sessions.distinctUsers` |
| `Traffic.pagesPerSessionPercentage` | `sessions.pagesPerSession` |
| `EngagementTime.totalTime` | `engagement.totalTime` |
| `EngagementTime.activeTime` | `engagement.activeTime` |
| `ScrollDepth.averageScrollDepth` | `behavior.scrollDepth` |
| `RageClickCount.sessionsWithMetricPercentage` | `behavior.rageClickPct` |
| `DeadClickCount.sessionsWithMetricPercentage` | `behavior.deadClickPct` |
| `ScriptErrorCount.sessionsWithMetricPercentage` | `behavior.scriptErrorPct` |
| `QuickbackClick.sessionsWithMetricPercentage` | `behavior.quickbackPct` |
| `ExcessiveScroll.sessionsWithMetricPercentage` | `behavior.excessiveScrollPct` |
| `Device[].name + sessionsCount` | `devices[]` |
| `Country[].name + sessionsCount` | `countries[]` |
| `PageTitle[].name + sessionsCount` | `topPages[]` |

Derived field: `sessions.real = sessions.total - sessions.bots`.

### 2. `agents/clarity-collector/index.js`
Daily cron agent. Calls `lib/clarity.js`, saves snapshot to `data/snapshots/clarity/YYYY-MM-DD.json`. Exits early (no snapshot written) if `sessions.total === 0`, to prevent empty files from polluting trend comparisons.

### 3. `agents/shopify-collector/index.js`
Daily cron agent. Adds two new functions to `lib/shopify.js`:

- **`getOrders(dateFrom, dateTo)`** — fetches `/admin/api/2025-01/orders.json?status=any&created_at_min=<dateFrom>&created_at_max=<dateTo>&limit=250` with pagination. Returns order count, total revenue (sum of `total_price`), and AOV.

- **`getAbandonedCheckouts(dateFrom, dateTo)`** — fetches `/admin/api/2025-01/checkouts.json?created_at_min=<dateFrom>&created_at_max=<dateTo>&limit=250` with pagination. Returns count of incomplete checkouts.

**`topProducts` derivation:** There is no Shopify endpoint for top products by revenue. The collector fetches all orders for the date range, iterates each order's `line_items`, and aggregates revenue and order count per product title client-side. Sorted descending by revenue, top 5 stored.

**`cartAbandonmentRate` formula:** `abandonedCheckouts.count / (abandonedCheckouts.count + orders.count)`. Represents the proportion of checkout-intending sessions that did not complete. Stored as a decimal (e.g. `0.68`).

Saves snapshot to `data/snapshots/shopify/YYYY-MM-DD.json`.

**Note:** `data/snapshots/` is a new directory distinct from the existing `data/rank-snapshots/`. They must not be conflated — the dashboard uses separate directory constants for each.

### 4. `agents/cro-analyzer/index.js`
Weekly cron agent (Mondays) or run on demand. Reads the last 7 Clarity snapshots and last 7 Shopify snapshots from their respective directories, sends them to Claude for CRO analysis, saves the brief to `data/reports/cro/YYYY-MM-DD-cro-brief.md`.

**Claude API details:**
- Model: `claude-opus-4-6` (same model used by blog-post-writer and other analysis agents)
- Pattern: use the Anthropic SDK directly (`import Anthropic from '@anthropic-ai/sdk'`), same pattern as `agents/blog-post-writer/index.js`
- Prompt structure: system prompt establishes CRO analyst role; user message contains 7 days of both snapshots serialized as JSON, plus instructions to output 3–7 prioritized action items with HIGH/MED/LOW priority, data evidence, and specific recommended action
- Token budget: 7 days × 2 sources × ~1KB per snapshot ≈ ~15KB input, well within context limits

### 5. Dashboard CRO Tab
New tab added to `agents/dashboard/index.js`. Tab navigation introduced at the top of the page (SEO | CRO). CRO tab reads from snapshot directories and the most recent CRO brief. No live API calls.

---

## Data Schemas

### Clarity Snapshot (`data/snapshots/clarity/YYYY-MM-DD.json`)
```json
{
  "date": "2026-03-18",
  "sessions": {
    "total": 43,
    "bots": 32,
    "real": 11,
    "distinctUsers": 73,
    "pagesPerSession": 1.13
  },
  "engagement": {
    "totalTime": 111,
    "activeTime": 70
  },
  "behavior": {
    "scrollDepth": 44.29,
    "rageClickPct": 0,
    "deadClickPct": 0,
    "scriptErrorPct": 16.28,
    "quickbackPct": 0,
    "excessiveScrollPct": 0
  },
  "devices": [
    { "name": "PC", "sessions": 28 },
    { "name": "Mobile", "sessions": 15 }
  ],
  "countries": [
    { "name": "United States", "sessions": 29 }
  ],
  "topPages": [
    { "title": "Homepage", "sessions": 8 }
  ]
}
```

### Shopify Snapshot (`data/snapshots/shopify/YYYY-MM-DD.json`)
```json
{
  "date": "2026-03-18",
  "orders": {
    "count": 26,
    "revenue": 1240.00,
    "aov": 47.69
  },
  "abandonedCheckouts": {
    "count": 58
  },
  "cartAbandonmentRate": 0.69,
  "topProducts": [
    { "title": "Coconut Oil Toothpaste", "revenue": 480, "orders": 12 }
  ]
}
```

`cartAbandonmentRate` = `abandonedCheckouts.count / (abandonedCheckouts.count + orders.count)` = 58 / (58 + 26) ≈ 0.69.

### CRO Brief (`data/reports/cro/YYYY-MM-DD-cro-brief.md`)
Markdown file. Sections: summary paragraph, numbered action items (each with priority level HIGH/MED/LOW and supporting data), raw data appendix.

---

## Dashboard CRO Tab Layout

**Tab navigation:** Two tabs at top — SEO (existing content) and CRO (new). Clicking a tab shows/hides the relevant content sections.

**CRO tab structure (top to bottom):**

1. **KPI strip** — 6 metric cards with delta vs prior day:
   - Conversion Rate (`orders ÷ real sessions`, requires both sources present for same date)
   - Average Order Value
   - Real Sessions (with bot count as subtext)
   - Script Error % (red background if > 5%)
   - Scroll Depth
   - Cart Abandonment Rate

2. **Two-column section:**
   - Left: **Clarity card** — session table, device split, top pages list
   - Right: **Shopify card** — revenue/orders/abandoned carts table, top products list

3. **AI CRO Brief** — amber card showing most recent brief content. Three-column grid of prioritized action items. Shows generation date. "Next run" displays the hardcoded string "Every Monday" (not dynamically computed).

**Empty states:**
- If no snapshots exist for either source: show "No data collected yet — run the collector to get started" in place of that section.
- If only one source has data for the latest date (partial data): render that source's card normally; show "—" for any cross-source metrics (e.g. Conversion Rate). Do not crash or hide the whole tab.
- If no CRO brief exists yet: show "No brief generated yet — run cro-analyzer to generate your first brief."

---

## Cron Schedule

New entries added to the system crontab (`crontab -e` on the server), following the pattern of existing agent cron entries:

| Agent | Frequency |
|---|---|
| `clarity-collector` | Daily |
| `shopify-collector` | Daily |
| `cro-analyzer` | Weekly (Monday) |

---

## Notifications

Both collector agents and the CRO analyzer use `lib/notify.js` (already wired on all agents) to send completion/failure emails.

---

## Future Extensions

- **GSC collector:** `agents/gsc-collector/index.js` → `data/snapshots/gsc/YYYY-MM-DD.json`
- **GA4 collector:** `agents/ga4-collector/index.js` → `data/snapshots/ga4/YYYY-MM-DD.json`
- The CRO analyzer prompt is updated to include these sources when snapshots exist; no structural changes needed.

---

## Files Changed or Created

| File | Action |
|---|---|
| `lib/clarity.js` | Create |
| `lib/shopify.js` | Add `getOrders()`, `getAbandonedCheckouts()` |
| `agents/clarity-collector/index.js` | Create |
| `agents/shopify-collector/index.js` | Create |
| `agents/cro-analyzer/index.js` | Create |
| `agents/dashboard/index.js` | Add tab nav, CRO tab rendering |
| System crontab (server) | Add 3 new cron entries |

---

## Out of Scope

- GSC and GA4 integration (future iteration)
- Heatmap or session recording embeds
- Real-time data (all data is snapshot-based, refreshed daily)
- Shopify traffic source attribution (requires Analytics API, plan-dependent)
