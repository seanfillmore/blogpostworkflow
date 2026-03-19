# GA4 + GSC Dashboard Integration — Design Spec
**Date:** 2026-03-18
**Status:** Approved

---

## Overview

Add Google Analytics 4 and Google Search Console as daily data sources alongside the existing Clarity and Shopify collectors. Data feeds into the CRO tab (both sources), the SEO tab (GSC only), and the weekly CRO brief. Architecture mirrors the established collector pattern: daily agents save JSON snapshots, the dashboard reads from files, the CRO analyzer includes all available sources in its prompt.

---

## Architecture

### New Files

**`lib/ga4.js`**
GA4 Analytics Data API v1 client. Authenticates via the same OAuth2 refresh token pattern as `lib/gsc.js` — calls Google's token endpoint to exchange `GOOGLE_REFRESH_TOKEN` for a short-lived access token, then calls `https://analyticsdata.googleapis.com/v1beta/properties/${PROPERTY_ID}:runReport`. Exports `fetchGA4Snapshot()` which makes two report calls (one for session/conversion summary + traffic sources, one for top landing pages) and returns a normalized object.

Requires `GOOGLE_ANALYTICS_PROPERTY_ID` in `.env`.

**`agents/gsc-collector/index.js`**
Daily cron agent. Calls `lib/gsc.js` (already exists), saves snapshot to `data/snapshots/gsc/YYYY-MM-DD.json`. Supports `--date YYYY-MM-DD` CLI arg for backfill. Uses Pacific timezone for default date. Notifies on completion/failure via `lib/notify.js`.

**`agents/ga4-collector/index.js`**
Daily cron agent. Calls `lib/ga4.js`, saves snapshot to `data/snapshots/ga4/YYYY-MM-DD.json`. Same structure, same CLI args, same notify pattern as gsc-collector.

**`scripts/reauth-google.js`**
One-time OAuth helper. Opens a browser authorization URL with both `webmasters.readonly` and `analytics.readonly` scopes. Prints the new refresh token to stdout to replace the existing `GOOGLE_REFRESH_TOKEN` in `.env`. Only needs to be run once.

### Modified Files

**`agents/cro-analyzer/index.js`**
Load last 7 GSC and GA4 snapshots (same `loadRecentSnapshots()` pattern). Include them in the Claude user message when present — sections are conditionally appended so the analyzer degrades gracefully if only some sources have data. Update system prompt to mention GA4 and GSC as context sources.

**`agents/dashboard/index.js`**
- `parseCROData()`: add `gscAll` and `ga4All` arrays (up to 60 snapshots each, same pattern as `clarityAll`/`shopifyAll`)
- SEO tab: add GSC panel below existing content
- CRO tab: expand cards grid to 2×2 (Clarity, Shopify, GA4, GSC); update KPI strip to use GA4 native conversion rate and add bounce rate card; add `aggregateGSC()` and `aggregateGA4()` client-side helpers following the same pattern as existing aggregate functions

---

## Data Schemas

### GSC Snapshot (`data/snapshots/gsc/YYYY-MM-DD.json`)
```json
{
  "date": "2026-03-18",
  "summary": {
    "clicks": 142,
    "impressions": 892,
    "ctr": 0.159,
    "position": 7.3
  },
  "topQueries": [
    { "query": "natural deodorant", "clicks": 45, "impressions": 234, "ctr": 0.192, "position": 3.2 }
  ],
  "topPages": [
    { "page": "/blogs/news/best-natural-deodorant", "clicks": 23, "impressions": 112, "ctr": 0.205, "position": 5.1 }
  ]
}
```
- `topQueries`: top 10 by clicks, using `lib/gsc.js` `getTopKeywords()`
- `topPages`: top 10 by clicks, using `lib/gsc.js` `getTopPages()`
- Date range: single day being collected (consistent with other snapshot sources)

### GA4 Snapshot (`data/snapshots/ga4/YYYY-MM-DD.json`)
```json
{
  "date": "2026-03-18",
  "sessions": 143,
  "users": 112,
  "newUsers": 89,
  "bounceRate": 0.42,
  "avgSessionDuration": 145,
  "conversions": 8,
  "conversionRate": 0.056,
  "revenue": 387.42,
  "topSources": [
    { "source": "google", "medium": "organic", "sessions": 98, "conversions": 5, "revenue": 241.00 }
  ],
  "topLandingPages": [
    { "page": "/blogs/news/best-natural-deodorant", "sessions": 42, "conversions": 2, "revenue": 96.00 }
  ]
}
```
- `topSources`: top 5 by sessions, dimensions `sessionSource` + `sessionMedium`
- `topLandingPages`: top 5 by sessions, dimension `landingPage`
- Two `runReport` API calls total per collector run

---

## Dashboard Changes

### SEO Tab — New GSC Panel

Added below existing content. Contains:
- Summary row: total clicks, impressions, avg CTR, avg position — each with delta vs prior day
- Top queries table: query · clicks · impressions · CTR · position (top 10)
- Top pages table: page · clicks · CTR (top 10)

Reads from `gscAll[0]` (latest snapshot) for display, `gscAll[1]` for deltas.

### CRO Tab — KPI Strip Updates

Replace cross-source Conversion Rate (Shopify orders ÷ Clarity sessions) with GA4 native `conversionRate` — more accurate, single-source. Add Bounce Rate card from GA4. Strip expands from 6 to 7 cards:

| Card | Source | Delta direction |
|---|---|---|
| Conversion Rate | GA4 | Higher is better |
| Bounce Rate | GA4 | Lower is better |
| Avg Order Value | Shopify | Higher is better |
| Real Sessions | Clarity | Higher is better |
| Script Errors | Clarity | Lower is better |
| Scroll Depth | Clarity | Higher is better |
| Cart Abandon | Shopify | Lower is better |

### CRO Tab — Cards Grid

Expands from 2-column to 2×2:

```
┌─────────────┬─────────────┐
│   Clarity   │   Shopify   │
├─────────────┼─────────────┤
│    GA4      │    GSC      │
└─────────────┴─────────────┘
```

**GA4 card:** sessions, users, bounce rate, avg session duration, conversion rate, revenue table; top landing pages by revenue list.

**GSC card:** clicks, impressions, CTR, avg position summary; top queries by clicks list.

The existing date filter (Today / Yesterday / Last 7 Days / Last 30 Days) applies to all four cards uniformly. `aggregateGA4()` and `aggregateGSC()` helpers follow the same sum/average pattern as the existing `aggregateClarity()` and `aggregateShopify()`.

**Empty states:** If no GA4 or GSC snapshots exist, the card shows the same "No data collected yet — run [agent] to get started" message pattern used by Clarity and Shopify cards.

---

## CRO Analyzer Updates

`agents/cro-analyzer/index.js` changes:

1. Load last 7 snapshots from `data/snapshots/gsc/` and `data/snapshots/ga4/` using existing `loadRecentSnapshots()` helper
2. Conditionally append to user message:
   ```
   GSC (Google Search Console — 7 days): [JSON]
   GA4 (Google Analytics 4 — 7 days): [JSON]
   ```
   Sections only included when snapshots exist — analyzer still runs with partial data
3. System prompt updated to mention organic search quality (GSC) and traffic source attribution (GA4) as additional CRO signals

Output format unchanged: prioritized action items with HIGH/MED/LOW, data evidence, recommended action.

---

## Auth & Credentials

### New `.env` Entry
```
GOOGLE_ANALYTICS_PROPERTY_ID=358754048
```

### Re-authorization (one-time)
The existing `GOOGLE_REFRESH_TOKEN` was granted with `webmasters.readonly` scope only. GA4 requires `analytics.readonly` to be added.

`scripts/reauth-google.js` handles this:
- Constructs an OAuth2 authorization URL with both scopes
- Prints the URL to stdout — user visits it in a browser, approves, pastes back the code
- Exchanges code for tokens, prints the new `GOOGLE_REFRESH_TOKEN` to replace in `.env`

Once updated, both `lib/gsc.js` and `lib/ga4.js` use the same token transparently.

---

## Cron Schedule

New entries added to system crontab via `scripts/setup-cron.sh`:

| Agent | Schedule | Time (PT) |
|---|---|---|
| `gsc-collector` | Daily | 06:15 |
| `ga4-collector` | Daily | 06:20 |

CRO analyzer (already scheduled Monday 07:45) automatically picks up the new sources.

---

## Files Changed or Created

| File | Action |
|---|---|
| `lib/ga4.js` | Create |
| `agents/gsc-collector/index.js` | Create |
| `agents/ga4-collector/index.js` | Create |
| `scripts/reauth-google.js` | Create |
| `agents/cro-analyzer/index.js` | Modify — add GSC + GA4 snapshot loading and prompt inclusion |
| `agents/dashboard/index.js` | Modify — parseCROData(), SEO tab GSC panel, CRO tab 2×2 grid, KPI strip |
| `scripts/setup-cron.sh` | Modify — add gsc-collector and ga4-collector cron entries |
| `.env` | Modify — add GOOGLE_ANALYTICS_PROPERTY_ID, update GOOGLE_REFRESH_TOKEN after reauth |

---

## Out of Scope

- GA4 audience or segment analysis
- GSC crawl errors or index coverage (handled by technical SEO agent)
- Historical backfill beyond what the collector CLI `--date` arg supports
- Real-time GA4 data (all data is snapshot-based, refreshed daily)
