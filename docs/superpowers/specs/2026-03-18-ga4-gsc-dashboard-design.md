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
GA4 Analytics Data API v1 client. Authenticates via the same OAuth2 refresh token pattern as `lib/gsc.js` — calls Google's token endpoint to exchange `GOOGLE_REFRESH_TOKEN` for a short-lived access token, then calls `https://analyticsdata.googleapis.com/v1beta/properties/${PROPERTY_ID}:runReport`. Exports `fetchGA4Snapshot(date)` which makes two report calls (one for session/conversion summary + traffic sources, one for top landing pages) and returns a normalized object. Uses `GOOGLE_ANALYTICS_PROPERTY_ID` from `.env`.

**`agents/gsc-collector/index.js`**
Daily cron agent. Calls `lib/gsc.js` via new single-day query methods (see below). Default date: 3 days ago in Pacific time — use `new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' })` to get the PT-localised date 3 days prior in a single expression. This accounts for GSC's ~3-day data lag. Supports `--date YYYY-MM-DD` CLI arg for backfill (the `date` field in the snapshot represents the data date, not the collection date). Saves to `data/snapshots/gsc/YYYY-MM-DD.json`. Notifies via `lib/notify.js`.

**`agents/ga4-collector/index.js`**
Daily cron agent. Calls `lib/ga4.js`. Default date: today in Pacific time (`new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' })`). Supports `--date YYYY-MM-DD` for backfill. Saves to `data/snapshots/ga4/YYYY-MM-DD.json`. Same notify pattern.

**`scripts/reauth-google.js`**
One-time OAuth helper. Uses the **localhost redirect server pattern** matching existing `scripts/gsc-auth.js` (port 3458 callback, no manual code-pasting). Requests both `webmasters.readonly` and `analytics.readonly` scopes. Prints the new `GOOGLE_REFRESH_TOKEN` to stdout for the user to update in `.env`. Only needs to be run once.

### Modified Files

**`lib/gsc.js`**
Add two single-day query methods used by `gsc-collector`:
- `getKeywordsForDate(date, limit = 10)` — queries GSC for `[date, date]` date range, returns top queries sorted by clicks. Remaps the `keyword` field from the raw API response to `query` to match the snapshot schema.
- `getPagesForDate(date, limit = 10)` — same but for pages dimension.

**`scripts/gsc-auth.js`**
Update hardcoded scope from `webmasters.readonly` to include both `webmasters.readonly` and `analytics.readonly`, so re-running this script in the future does not silently downgrade the token to GSC-only scope.

**`agents/cro-analyzer/index.js`**
Load last 7 GSC and GA4 snapshots using the existing `loadRecentSnapshots()` helper. Update the early-exit guard: currently exits when both Clarity and Shopify have no data — change to exit only when **all four sources** have no data, so the analyzer can run if only GA4 or GSC snapshots exist. Include GSC and GA4 sections in the user message when snapshots are present. Update system prompt to mention organic search quality (GSC) and traffic source attribution (GA4).

**`agents/dashboard/index.js`**
- `parseCROData()`: add `gscAll` and `ga4All` arrays (up to 60 snapshots each)
- SEO tab: add GSC panel below existing Keyword Rankings and Posts sections
- CRO tab: expand cards grid to 2×2; update KPI strip; add `aggregateGSC()` and `aggregateGA4()` client-side helpers

**Note on template literal escaping:** All client-side JS in `dashboard/index.js` lives inside a Node.js template literal (`const HTML = \`...\``). Backticks and `\n` escape sequences inside the `<script>` block must be escaped as `\`` and `\\n` respectively, or the server will crash with a syntax error.

---

## Data Schemas

### GSC Snapshot (`data/snapshots/gsc/YYYY-MM-DD.json`)

The filename date is the **data date** (3 days prior to collection, matching when GSC data is complete).

```json
{
  "date": "2026-03-15",
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
- `topQueries`: top 10 by clicks, via new `getKeywordsForDate()`. Note: `lib/gsc.js` raw response uses field name `keyword` — collector remaps this to `query` before saving.
- `topPages`: top 10 by clicks, via new `getPagesForDate()`
- `summary.ctr` and `summary.position` are weighted averages from the GSC API (the API computes these correctly server-side for a single-day query)

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

The SEO tab currently contains: Keyword Rankings section (370 keywords with rank data) and Posts section (pipeline). The GSC panel is added **below** these two sections.

Contains:
- Summary row: total clicks, impressions, avg CTR, avg position — each with delta vs prior day's snapshot
- Top queries table: query · clicks · impressions · CTR · position (top 10)
- Top pages table: page · clicks · impressions · CTR · position (top 10)

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

**GA4 card:** sessions, users, bounce rate, avg session duration, conversion rate, revenue; top landing pages by revenue list.

**GSC card:** clicks, impressions, CTR, avg position summary; top queries by clicks list.

The existing date filter (Today / Yesterday / Last 7 Days / Last 30 Days) applies to all four cards uniformly.

**`aggregateGA4(snaps)` semantics:**
- Sum: `sessions`, `users`, `newUsers`, `conversions`, `revenue`
- Weighted average (by sessions): `bounceRate`, `avgSessionDuration` — use only snapshots where `sessions > 0` as weights to avoid zero-session days distorting the average (same guard as `aggregateClarity()`)
- Derived: `conversionRate = conversions / sessions`
- `topSources` / `topLandingPages`: aggregate by summing sessions, conversions, revenue per key; re-sort by sessions

**`aggregateGSC(snaps)` semantics:**
- Sum: `clicks`, `impressions`
- Weighted average by impressions: `position` and `ctr` (simple arithmetic mean produces meaningless results — must weight by impressions)
- `topQueries` / `topPages`: aggregate by summing clicks, impressions per key; re-derive CTR and position as weighted averages; re-sort by clicks

**Empty states:** If no GA4 or GSC snapshots exist, the card shows "No data collected yet — run [agent] to get started."

---

## CRO Analyzer Updates

`agents/cro-analyzer/index.js` changes:

1. Load last 7 snapshots from `data/snapshots/gsc/` and `data/snapshots/ga4/` using existing `loadRecentSnapshots()` helper
2. Update early-exit guard: change from "exit if Clarity AND Shopify are empty" to "exit if ALL FOUR sources are empty"
3. Conditionally append to user message when snapshots present:
   ```
   GSC (Google Search Console — 7 days): [JSON]
   GA4 (Google Analytics 4 — 7 days): [JSON]
   ```
4. System prompt updated to mention organic search quality (GSC) and traffic source attribution (GA4) as additional CRO signals

Output format unchanged: prioritized action items with HIGH/MED/LOW, data evidence, recommended action.

---

## Auth & Credentials

### New `.env` Entry
```
GOOGLE_ANALYTICS_PROPERTY_ID=358754048
```

### Re-authorization (one-time)
The existing `GOOGLE_REFRESH_TOKEN` was granted with `webmasters.readonly` scope only. GA4 requires `analytics.readonly` added.

`scripts/reauth-google.js` uses the **same localhost redirect server pattern as `gsc-auth.js`** (port 3458): starts a local HTTP server, opens the browser authorization URL, captures the OAuth callback automatically, exchanges the code for tokens, prints the new `GOOGLE_REFRESH_TOKEN` to replace in `.env`. No manual code-pasting.

`scripts/gsc-auth.js` is also updated to include both scopes so any future re-run doesn't silently downgrade the token.

---

## Cron Schedule

New entries in `scripts/setup-cron.sh`. Cron times are in UTC (server runs UTC):

| Agent | Cron expression | Equivalent PT |
|---|---|---|
| `gsc-collector` | `15 13 * * *` | ~06:15 PDT / 05:15 PST |
| `ga4-collector` | `20 13 * * *` | ~06:20 PDT / 05:20 PST |

CRO analyzer (already `45 14 * * 1`) automatically picks up the new sources.

---

## Files Changed or Created

| File | Action |
|---|---|
| `lib/ga4.js` | Create |
| `lib/gsc.js` | Modify — add `getKeywordsForDate()` and `getPagesForDate()` single-day methods |
| `agents/gsc-collector/index.js` | Create |
| `agents/ga4-collector/index.js` | Create |
| `scripts/reauth-google.js` | Create |
| `scripts/gsc-auth.js` | Modify — add `analytics.readonly` to scopes |
| `agents/cro-analyzer/index.js` | Modify — GSC + GA4 snapshot loading, updated early-exit guard, updated prompt |
| `agents/dashboard/index.js` | Modify — parseCROData(), SEO tab GSC panel, CRO tab 2×2 grid, KPI strip |
| `scripts/setup-cron.sh` | Modify — add gsc-collector and ga4-collector cron entries |
| `.env` | Modify — add GOOGLE_ANALYTICS_PROPERTY_ID, update GOOGLE_REFRESH_TOKEN after reauth |

---

## Out of Scope

- GA4 audience or segment analysis
- GSC crawl errors or index coverage (handled by technical SEO agent)
- Historical backfill beyond what the collector CLI `--date` arg supports
- Real-time GA4 data (all data is snapshot-based, refreshed daily)
