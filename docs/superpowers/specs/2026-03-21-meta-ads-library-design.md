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
  → data/creative-packages/<slug>-<date>.zip          (on-demand output)
  → data/creative-jobs/<jobId>.json                   (job state for dashboard polling)
```

Mirrors the existing Google Ads collector → analyzer → dashboard pattern. Raw snapshots are kept separate from analysis so Claude can re-analyze without re-fetching from Meta.

---

## 2. API Client — `lib/meta-ads-library.js`

Wraps the Meta Ads Library API (`GET https://graph.facebook.com/v21.0/ads_archive`).

**Auth:** App access token stored as `META_APP_ACCESS_TOKEN=APP_ID|APP_SECRET` in `.env`. No OAuth flow required for the Ads Library API.

**Two search modes:**
- `searchByKeyword(term, country)` — returns all active ads matching a search term in the given country
- `searchByPageId(pageId)` — returns all active ads for a specific advertiser page

**Fields fetched per ad:**
- `id`, `page_id`, `page_name`
- `ad_delivery_start_time`, `ad_delivery_stop_time` (null = still running)
- `ad_creative_body`, `ad_creative_link_title`, `ad_creative_link_description`
- `ad_snapshot_url` — Meta's rendered ad viewer URL
- `publisher_platforms` — where the ad runs (facebook, instagram, audience_network, messenger)

Note: `impressions` and `spend` are intentionally not fetched. Meta returns these as range objects only (`{ lower_bound, upper_bound }`) and they are not used in effectiveness scoring.

**Pagination:** Handled automatically via cursor — fetches all pages before returning.

---

## 3. Collector Agent — `agents/meta-ads-collector/index.js`

**Cron:** `0 6 * * 1` (Monday 6:00 AM Pacific)

**Process:**
1. Load `config/meta-ads.json`
2. Search Meta Ads Library for each keyword (country from config)
3. Search for each tracked page ID
4. Deduplicate ads by `id`
5. Save combined raw results to `data/snapshots/meta-ads-library/YYYY-MM-DD.json`
6. Call `lib/notify.js` on completion and on error

**Known limitation:** The analyzer cron fires 10 minutes after the collector (`10 6 * * 1`). This assumes the collector completes within 10 minutes. For typical result volumes this is safe, but if the collector runs long it will process the prior week's snapshot. This is acceptable for Phase 1.

**Config file schema** (`config/meta-ads.json`):
```json
{
  "searchCountry": "US",
  "searchKeywords": ["natural deodorant", "aluminum free deodorant", "natural skincare"],
  "trackedPageIds": [],
  "effectivenessMinDays": 14,
  "effectivenessMinVariations": 3
}
```

| Field | Type | Description |
|-------|------|-------------|
| `searchCountry` | string | ISO country code for ad reach filter (default `"US"`) |
| `searchKeywords` | string[] | Terms to search in the Ads Library |
| `trackedPageIds` | string[] | Known competitor Facebook page IDs; starts empty, populated manually |
| `effectivenessMinDays` | number | Longevity threshold to qualify for Claude analysis |
| `effectivenessMinVariations` | number | Variation count threshold to qualify for Claude analysis |

---

## 4. Analyzer Agent — `agents/meta-ads-analyzer/index.js`

**Cron:** `10 6 * * 1` (Monday 6:10 AM Pacific)

**Inputs:** Last 4 weeks of snapshots from `data/snapshots/meta-ads-library/`

### Claude Pass 1 — Variation Grouping (per brand)

For each `page_id` with 2+ ads, a single Claude call categorizes that brand's ads by product/theme to count meaningful variations and prevent unrelated products inflating scores.

**Input to Claude (Pass 1):**
```json
{
  "pageId": "string",
  "pageName": "string",
  "ads": [
    { "id": "string", "body": "string", "title": "string", "description": "string" }
  ]
}
```

**Output from Claude (Pass 1):**
```json
{
  "themes": [
    {
      "theme": "string — short product/angle label, e.g. 'natural deodorant stick'",
      "adIds": ["string"]
    }
  ]
}
```

**Variation count is brand-level:** `variationCount` = size of the largest theme group for that brand. This score is then applied uniformly to all ads from that brand — the signal is that the brand overall has found a winning formula, not that any single ad has many variations.

### Effectiveness Scoring

| Signal | Logic | Weight |
|--------|-------|--------|
| Longevity | `snapshotDate - ad_delivery_start_time` in days, **only if `ad_delivery_stop_time` is null** (ad still running). If `ad_delivery_stop_time` is not null, `longevityDays = 0`. Capped at 60 days. | 1× days |
| Variation count | Brand-level: size of largest theme group from Pass 1 | 2× count |

```
effectivenessScore = longevityDays + (variationCount × 2)
```

**Filter:** Only ads meeting at least one threshold pass to Pass 2:
- `longevityDays ≥ effectivenessMinDays` (from config), OR
- `variationCount ≥ effectivenessMinVariations` (from config)

### Claude Pass 2 — Ad Analysis (per qualifying ad)

**Input to Claude (Pass 2):**
```json
{
  "pageName": "string",
  "adCreativeBody": "string",
  "adCreativeLinkTitle": "string",
  "adCreativeLinkDescription": "string",
  "longevityDays": "number",
  "variationCount": "number",
  "publisherPlatforms": ["string"]
}
```

**Output schema — `AdAnalysis`:**
```json
{
  "headline": "string — one-line summary of why this ad is working",
  "messagingAngle": "string — e.g. Ingredient transparency, Social proof, Problem/solution",
  "whyEffective": "string — 2-3 sentences citing specific copy choices and longevity/variation signals",
  "targetAudience": "string — who this ad is clearly aimed at",
  "keyTechniques": ["string"],
  "copyInsights": "string — what makes the specific copy work: word choices, structure, CTA"
}
```

`AdAnalysis` is the shared contract between the analyzer (writes it), the dashboard (displays it), and the creative packager (includes it in `analysis.txt`).

**Pass 2 failure handling:** If Claude analysis fails for a specific ad (API error or malformed JSON response), that ad is included in the output file with `analysis: null`. The dashboard card renderer handles null analysis gracefully (shows the creative and scores, omits the analysis section). The agent-level `lib/notify.js` error call fires only if the overall run fails; per-ad failures are logged but do not abort the run.

**Output file:** `data/meta-ads-insights/YYYY-MM-DD.json`
```json
{
  "date": "YYYY-MM-DD",
  "ads": [
    {
      "id": "string",
      "pageId": "string",
      "pageName": "string",
      "pageSlug": "string — slugified page_name for use in filenames",
      "adCreativeBody": "string",
      "adCreativeLinkTitle": "string",
      "adSnapshotUrl": "string",
      "publisherPlatforms": ["string"],
      "longevityDays": "number",
      "variationCount": "number",
      "effectivenessScore": "number",
      "analysis": "AdAnalysis | null"
    }
  ]
}
```

Sorted by `effectivenessScore` descending. Calls `lib/notify.js` on completion and on error.

---

## 5. Dashboard — Ad Intelligence Tab

**Display:** Grid of competitor brand cards, maximum 12. If fewer qualifying brands exist, render all available. Sorted by `effectivenessScore` descending. Reads from the latest `data/meta-ads-insights/YYYY-MM-DD.json`.

Each card shows:
- Brand name + `longevityDays` ("Running 34 days") + `variationCount` ("4 variations")
- Top-scoring ad: `ad_snapshot_url` embedded, copy, platform badges
- `AdAnalysis.headline` and `AdAnalysis.whyEffective` (if `analysis` is not null)
- **"Generate Creative"** button — opens a product image selector panel showing filenames from `data/product-images/`

**Job file cleanup:** On server startup, delete `data/creative-jobs/` files older than 7 days.

**Server endpoints:**

`GET /api/meta-ads-insights`
→ Returns the latest insights JSON file contents

`POST /api/generate-creative`
Request: `{ "adId": "string", "productImages": ["filename.webp", ...] }`
- `productImages` is an array of filenames from `data/product-images/` (max 3)
- Empty array is valid — packager generates a lifestyle-only prompt without a product reference
- Returns `400` if any filename is not found in `data/product-images/`
- Job ID is generated as `${pageId}-${Date.now()}` — guaranteed unique per request
- Creates `data/creative-jobs/<jobId>.json` with `{ status: "pending", adId, productImages, createdAt }`
- Spawns creative packager as detached child process: `spawn('node', ['agents/creative-packager/index.js', '--job-id', jobId], { detached: true, stdio: 'ignore' }).unref()`
- Returns `{ "jobId": "string" }`

`GET /api/creative-packages/:jobId`
→ Reads `data/creative-jobs/<jobId>.json`
→ If job file does not exist or `createdAt` is older than 10 minutes and status is not `"complete"`, return `{ "status": "error", "error": "Job timed out or not found", "downloadUrl": null }`
→ Otherwise returns `{ "status": "pending" | "running" | "complete" | "error", "downloadUrl": "string | null", "error": "string | null" }`

`GET /api/creative-packages/download/:jobId`
→ Reads job file, resolves ZIP path, streams the file as `application/zip` with `Content-Disposition: attachment`

---

## 6. Creative Packager — `agents/creative-packager/index.js`

**Invocation:** `node agents/creative-packager/index.js --job-id <jobId>`

Reads job spec from `data/creative-jobs/<jobId>.json`. The entire agent body is wrapped in a top-level `try/catch` with a `finally` block that guarantees the job file is always written with either `"complete"` or `"error"` status before the process exits — preventing zombie jobs.

Updates job status to `"running"` on start.

**Steps:**

1. **Style extraction** — Claude analyzes the competitor ad (body, title, description, `AdAnalysis`) and returns a Gemini image prompt describing mood, color palette, composition, lighting, background, and how the product is featured

2. **Creative generation** — Gemini (`gemini-2.0-flash-preview-image-generation`) generates one image per required placement size, passing the selected product images from `data/product-images/` as reference (same pattern as `agents/image-generator/`). If `productImages` was empty, generates a lifestyle scene without product reference.
   - On Gemini failure: retry once, then throw (caught by top-level handler, job set to `"error"`)

3. **Copy generation** — Claude writes 3 copy variations in the same messaging angle as the competitor ad but for Real Skin Care: headline, primary text, CTA, tailored per placement type

4. **Placement specs** — derived from the ad's `publisher_platforms`:

| Platform | Placement | Sizes |
|----------|-----------|-------|
| instagram | Feed | 1080×1080, 1080×1350 |
| instagram | Stories / Reels | 1080×1920 |
| facebook | Feed | 1200×628, 1080×1080 |
| facebook | Stories | 1080×1920 |

5. **ZIP packaging** — ZIP filename uses `pageSlug` (pre-slugified in the insights file) to avoid filesystem issues with brand names containing spaces or special characters. Saved to `data/creative-packages/<pageSlug>-<date>.zip`:
   ```
   images/              generated images named by size (e.g. instagram-feed-1080x1080.webp)
   copy.txt             3 copy variations: headline + body + CTA
   specs.txt            placement requirements, image sizes, character limits
   analysis.txt         AdAnalysis for the original competitor ad
   ```

6. **Job completion** — updates `data/creative-jobs/<jobId>.json` to `{ status: "complete", downloadUrl: "/api/creative-packages/download/<jobId>" }`

**Error handling:** Top-level `try/catch/finally` guarantees that on any unhandled error, the job file is updated to `{ status: "error", error: err.message }` before exit. Only errors are notified via `lib/notify.js` — success is silent (this is an interactive on-demand action the user triggered from the dashboard, not a scheduled agent).

---

## 7. Auth & Environment

**New `.env` key:**
```
META_APP_ACCESS_TOKEN=APP_ID|APP_SECRET
```

No new npm packages required — `@google/genai` already installed, `GEMINI_API_KEY` already in `.env`.

**New cron entries:**
```
0 6 * * 1    node agents/meta-ads-collector/index.js
10 6 * * 1   node agents/meta-ads-analyzer/index.js
```

---

## 8. Out of Scope (Phase 1)

- Auto-saving discovered competitor page IDs to `trackedPageIds` (manual for now)
- Video ad support (image/text ads only in Phase 1)
- Phase 2 campaign creation from generated creatives
- Automated publishing of generated creatives to Meta
- `impressions` and `spend` data (Meta range objects, not used in scoring)
- Job file retention beyond 7-day server-startup cleanup

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
data/creative-jobs/
```

**Modified files:**
```
dashboard server   — new API endpoints + Ad Intelligence tab + job cleanup on startup
.env               — META_APP_ACCESS_TOKEN added
cron scheduler     — two new weekly entries
```
