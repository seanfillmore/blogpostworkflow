# Meta Ads Library — Phase 1 Design

**Date:** 2026-03-21
**Status:** Approved
**Scope:** Competitor ad discovery, effectiveness scoring, Claude analysis, dashboard display, and creative packaging. Phase 1 only — no campaign creation or automated publishing.

---

## 1. Architecture

Five components with a unidirectional data flow:

```
lib/meta-ads-library.js          API client (keyword search + page ID search)
agents/meta-ads-collector/       Weekly cron — fetches raw ads, saves snapshots
agents/meta-ads-analyzer/        Runs after collector — scores, filters, runs Claude analysis
agents/creative-packager/        On-demand (dashboard-triggered) — Gemini generation + ZIP
dashboard (Ad Intelligence tab)  Displays insights, triggers creative generation, download link
```

Data flow:
```
Meta Ads Library API
  → data/snapshots/meta-ads-library/YYYY-MM-DD.json   (raw snapshots)
  → data/meta-ads-insights/YYYY-MM-DD.json            (scored + analyzed)
  → data/creative-packages/<page_name>-<date>.zip     (on-demand output)
```

Mirrors the existing Google Ads collector → analyzer → dashboard pattern. Raw snapshots are kept separate from analysis so Claude can re-analyze without re-fetching from Meta.

---

## 2. API Client — `lib/meta-ads-library.js`

Wraps the Meta Ads Library API (`GET https://graph.facebook.com/v21.0/ads_archive`).

**Auth:** App access token stored as `META_APP_ACCESS_TOKEN=APP_ID|APP_SECRET` in `.env`. No OAuth flow required for the Ads Library API.

**Two search modes:**
- `searchByKeyword(term, country='US')` — returns all active ads matching a search term
- `searchByPageId(pageId)` — returns all active ads for a specific advertiser page

**Fields fetched per ad:**
- `id`, `page_id`, `page_name`
- `ad_delivery_start_time`, `ad_delivery_stop_time` (null = still running)
- `ad_creative_body`, `ad_creative_link_title`, `ad_creative_link_description`
- `ad_snapshot_url` — Meta's rendered ad viewer URL
- `publisher_platforms` — where the ad runs (facebook, instagram, audience_network, messenger)
- `impressions`, `spend` — range buckets (Meta does not expose exact values)

**Pagination:** Handled automatically via cursor — fetches all pages before returning.

---

## 3. Collector Agent — `agents/meta-ads-collector/index.js`

Runs weekly on Monday morning (Pacific time) via cron.

**Inputs:** `config/meta-ads.json`

**Process:**
1. Load keywords and tracked page IDs from config
2. Search Meta Ads Library for each keyword (US only)
3. Search for each tracked page ID
4. Deduplicate ads by `id`
5. Save combined raw results to `data/snapshots/meta-ads-library/YYYY-MM-DD.json`
6. Send completion notification via `lib/notify.js`

**Config file** (`config/meta-ads.json`):
```json
{
  "searchKeywords": ["natural deodorant", "aluminum free deodorant", "natural skincare"],
  "trackedPageIds": [],
  "effectivenessMinDays": 14,
  "effectivenessMinVariations": 3
}
```

Keywords and tracked page IDs are editable without touching agent code. `trackedPageIds` starts empty and is populated manually as notable competitors are identified.

---

## 4. Analyzer Agent — `agents/meta-ads-analyzer/index.js`

Runs weekly on Monday morning, 10 minutes after the collector.

**Inputs:** Last 4 weeks of snapshots from `data/snapshots/meta-ads-library/`

**Effectiveness scoring:**

Two signals per ad:

| Signal | Logic | Weight |
|--------|-------|--------|
| Longevity | Days since `ad_delivery_start_time`, only if `ad_delivery_stop_time` is null. Capped at 60 days. | 1× days |
| Variation count | Number of ads from same `page_id` with same primary product/theme. | 2× count |

```
effectivenessScore = longevityDays + (variationCount × 2)
```

**Filter:** Only ads meeting at least one threshold pass to Claude analysis:
- Longevity ≥ 14 days, OR
- Variation count ≥ 3

**Variation grouping:** Ads are grouped by `page_id`. Within each brand, a lightweight Claude pass categorizes ads by product/theme before counting variations — prevents unrelated products from inflating scores.

**Claude analysis output per qualifying ad:**
```json
{
  "headline": "Why this ad is working",
  "messagingAngle": "e.g. Ingredient transparency",
  "whyEffective": "2-3 sentence explanation citing specific copy and signals",
  "targetAudience": "Who this ad is clearly aimed at",
  "keyTechniques": ["technique 1", "technique 2"],
  "copyInsights": "What makes the specific copy work"
}
```

**Output:** `data/meta-ads-insights/YYYY-MM-DD.json` — all scored and analyzed ads for that run, sorted by `effectivenessScore` descending.

---

## 5. Dashboard — Ad Intelligence Tab

**Display:** Grid of competitor brand cards, capped at 12 to avoid overwhelming the interface. Sorted by highest `effectivenessScore`.

Each card shows:
- Brand name + active duration in search results
- Top-scoring ad: creative via `ad_snapshot_url`, copy, platform badges (Instagram / Facebook)
- Longevity badge (e.g. "Running 34 days") + variation count badge (e.g. "4 variations")
- Claude's analysis (expanded below the ad)
- **"Generate Creative"** button

**Server endpoints:**
- `GET /api/meta-ads-insights` — returns latest insights file
- `POST /api/generate-creative` — accepts `{ adId, productImages[] }`, triggers creative packager, returns job ID
- `GET /api/creative-packages/:jobId` — returns status and download URL when ready

---

## 6. Creative Packager — `agents/creative-packager/index.js`

Triggered on-demand from the dashboard. Accepts an ad ID and selected product image filenames.

**Steps:**

1. **Style extraction** — Claude analyzes the competitor ad and writes a Gemini image prompt: mood, color palette, composition, lighting, background, how the product is featured

2. **Creative generation** — Gemini (`gemini-2.0-flash-preview-image-generation`) generates one image per required placement size, using selected product images from `data/product-images/` as reference — same pattern as the existing `image-generator` agent

3. **Copy generation** — Claude writes 3 copy variations in the same messaging angle as the competitor ad but for Real Skin Care: headline, primary text, CTA. Tailored to each placement type

4. **Placement specs** — derived from the ad's `publisher_platforms` field:

| Platform | Placement | Sizes |
|----------|-----------|-------|
| Instagram | Feed | 1080×1080, 1080×1350 |
| Instagram | Stories / Reels | 1080×1920 |
| Facebook | Feed | 1200×628, 1080×1080 |
| Facebook | Stories | 1080×1920 |

5. **ZIP packaging** — saved to `data/creative-packages/<page_name>-<date>.zip`:
   ```
   images/                  generated images named by size (e.g. instagram-feed-1080x1080.webp)
   copy.txt                 3 copy variations: headline + body + CTA
   specs.txt                placement requirements, image sizes, character limits
   analysis.txt             Claude's explanation of why the original ad worked
   ```

6. **Download link** — appears on the ad card in the dashboard once packaging is complete

---

## 7. Auth & Environment

**New `.env` key:**
```
META_APP_ACCESS_TOKEN=APP_ID|APP_SECRET
```

No new packages required — `@google/genai` already installed, `GEMINI_API_KEY` already in `.env`.

**Cron additions:** Two new weekly entries in the scheduler — collector at 6:00 AM PT Monday, analyzer at 6:10 AM PT Monday.

---

## 8. Out of Scope (Phase 1)

- Auto-saving discovered competitor page IDs to `trackedPageIds` (manual for now)
- Video ad support (image/text ads only)
- Phase 2 campaign creation from generated creatives
- Automated publishing of generated creatives to Meta

---

## 9. File & Directory Summary

**New files:**
```
lib/meta-ads-library.js
agents/meta-ads-collector/index.js
agents/meta-ads-analyzer/index.js
agents/creative-packager/index.js
config/meta-ads.json
```

**New data directories:**
```
data/snapshots/meta-ads-library/
data/meta-ads-insights/
data/creative-packages/
```

**Modified files:**
```
dashboard/index.js (or server) — new API endpoints + Ad Intelligence tab
config/ — meta-ads.json added
.env — META_APP_ACCESS_TOKEN added
```
