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
Clarity API client. Wraps the `project-live-insights` endpoint authenticated via `MICROSOFT_CLARITY_TOKEN`. Returns a normalized object with all available metrics. Mirrors the structure of `lib/shopify.js`.

### 2. `agents/clarity-collector/index.js`
Daily cron agent. Calls `lib/clarity.js`, saves snapshot to `data/snapshots/clarity/YYYY-MM-DD.json`. Exits early (no snapshot written) if the API returns no session data, to prevent empty files from polluting trend comparisons (same guard used in rank-tracker).

### 3. `agents/shopify-collector/index.js`
Daily cron agent. Calls Shopify REST API for orders and abandoned checkouts. Saves snapshot to `data/snapshots/shopify/YYYY-MM-DD.json`. Adds `getOrders(dateFrom, dateTo)` and `getAbandonedCheckouts(dateFrom, dateTo)` to `lib/shopify.js`.

### 4. `agents/cro-analyzer/index.js`
Weekly cron agent (or run on demand). Reads the last 7 Clarity snapshots and last 7 Shopify snapshots, sends them to Claude with a CRO analysis prompt, and saves the brief to `data/reports/cro/YYYY-MM-DD-cro-brief.md`. Identifies week-over-week changes, flags regressions, and outputs 3–7 prioritized action items with supporting data.

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

### CRO Brief (`data/reports/cro/YYYY-MM-DD-cro-brief.md`)
Markdown file. Sections: summary paragraph, numbered action items (each with priority level HIGH/MED/LOW and supporting data), and a raw data appendix.

---

## Dashboard CRO Tab Layout

**Tab navigation:** Two tabs at top — SEO (existing content) and CRO (new). Clicking a tab shows/hides the relevant content sections; URL hash updated for bookmarking (`#seo`, `#cro`).

**CRO tab structure (top to bottom):**

1. **KPI strip** — 6 metric cards with delta vs prior day:
   - Conversion Rate (`orders ÷ real sessions`)
   - Average Order Value
   - Real Sessions (with bot count as subtext)
   - Script Error % (red background if > 5%)
   - Scroll Depth
   - Cart Abandonment Rate

2. **Two-column section:**
   - Left: **Clarity card** — session table, device split, top pages list
   - Right: **Shopify card** — revenue/orders/abandoned carts table, top products list

3. **AI CRO Brief** — amber card, shows most recent brief. Three-column grid of prioritized action items. Shows generation date and next scheduled run.

**Empty states:** If no snapshots exist yet, each section shows a "No data collected yet — run the collector to get started" message rather than crashing.

---

## Cron Schedule

| Agent | Frequency | Command |
|---|---|---|
| `clarity-collector` | Daily | `node agents/clarity-collector/index.js` |
| `shopify-collector` | Daily | `node agents/shopify-collector/index.js` |
| `cro-analyzer` | Weekly (Monday) | `node agents/cro-analyzer/index.js` |

Both collectors added to the existing server crontab alongside rank-tracker.

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
| `scheduler.js` | Add new agents to daily/weekly schedule |

---

## Out of Scope

- GSC and GA4 integration (future iteration)
- Heatmap or session recording embeds
- Real-time data (all data is snapshot-based, refreshed daily)
- Shopify traffic source attribution (requires Analytics API, plan-dependent)
