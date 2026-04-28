# Ad Intelligence Tab — Design

**Date:** 2026-04-28
**Goal:** Activate the existing-but-disabled Ad Intelligence dashboard tab as a curated browse-and-pick gallery of competitor ads currently running on Meta. The user finds an ad worth adapting, clicks "Use as inspiration", and the Creatives tab opens with a new session pre-loaded with the competitor's ad image and a starter prompt — no auto-generation, no bulk packaging.

## Workflow

1. User opens the Ad Intelligence tab.
2. Sees a filterable grid of ad cards from tracked competitors (Native, Schmidt's, Piperwai, Captain Blankenship, Weleda — extensible via in-tab UI).
3. Each card shows the brand, an effectiveness score, longevity + variation metadata, the live ad preview, the ad copy, and the analyzer's extracted angle + reasoning.
4. User scans, picks one to adapt, clicks **Use as inspiration**.
5. The dashboard switches to the Creatives tab with a brand-new session pre-populated with: the competitor's ad creative as a reference image, and a templated starter prompt referencing the analyzer's angle/hook.
6. User adds RSC product reference images and edits the prompt before clicking generate.

## Card design

Adapted for the browse-and-pick decision — not an exact Meta Ad Library replica.

```
┌──────────────────────────────────────┐
│ Native                    Score: 42  │
│ Running 23d · 5 variations           │
│                                      │
│ ┌──────────────────────────────────┐ │
│ │  [creative preview iframe]       │ │
│ └──────────────────────────────────┘ │
│                                      │
│ "cleaner & stronger than before!     │
│  our award winning formula just got  │
│  an upgrade ⭐"                       │
│                                      │
│ ┌─ Why effective ────────────────┐   │
│ │ Angle: cleaner upgraded formula│   │
│ │ Repositions a reformulation as │   │
│ │ proof of innovation. Benefits- │   │
│ │ first hook, lifestyle imagery. │   │
│ └────────────────────────────────┘   │
│                                      │
│ [    Use as inspiration    ]         │
└──────────────────────────────────────┘
```

**Fields rendered (in order):**
- Brand name (top-left, bold)
- Effectiveness score (top-right) — the analyzer's existing `effectivenessScore`, rendered as `Score: N`
- Metadata line: `Running <longevityDays>d · <variationCount> variations`
- Creative preview — Meta's `adSnapshotUrl` rendered in a sandboxed iframe (existing pattern)
- Ad copy — `adCreativeBody` truncated to 200 chars with ellipsis
- "Why effective" panel — analyzer-extracted `angle` + `whyEffective`
- "Use as inspiration" CTA button (full-width)

**Fields removed from existing renderAdCard:**
- Platforms chips (FB/IG icons) — virtually always both, not informative for this decision

**Fields removed from Meta's actual library card style:**
- Library ID, "Active" badge, "..." menu, "Sponsored" label, "See ad details" link, site-URL footer, "Shop Now" CTA — all noise for the inspiration workflow.

## Tab layout

- **Filter chip row** at the top: `All · Piperwai · Native · Schmidt's · Captain Blankenship · Weleda · [+ Add competitor]`. Default selection: `All`.
- **Responsive grid** below: column min 320–360 px, cards sorted by `effectivenessScore` desc within the active filter.
- **Empty state** — three cases, distinct copy:
  - No competitors tracked yet (`trackedPageIds` empty): "No competitors tracked yet. Click [+ Add competitor] to start."
  - Tracked but no insights file yet (cron hasn't run, or Advanced Access pending): "Waiting for the first weekly scrape. Comes back online once Meta approves Advanced Access for the Ad Library API."
  - Insights present but zero ads passed the effectiveness filter: "Tracked competitors aren't running ads that meet the effectiveness threshold (≥ 14 days running, ≥ 3 variations) right now."

## Add / remove competitors

The `[+ Add competitor]` chip opens a small modal:

- **Add fields:** brand display name + Meta page ID (numeric, paste-from-Ad-Library-URL).
- **Existing list:** all currently-tracked competitors with an `×` remove button each.
- **Save:** posts to a new dashboard route `POST /api/meta-ads/competitors` that updates `config/meta-ads.json`'s `trackedPageIds` array and writes back. The next Sunday cron picks up the change and pulls that page's ads. (No "Refresh now" — the collector doesn't currently support single-page-ID invocation, and adding that flag isn't worth the extra surface area.)

The brand display name is what the dashboard shows in the filter chip and card header. Once the first scrape lands, the API's `pageName` is used in card data but the chip label stays as the user's input.

## Data pipeline

Reuses the existing two-agent pipeline:

1. **`meta-ads-collector`** — runs weekly Sundays. Iterates `config/meta-ads.json` `trackedPageIds`, calls `searchByPageId(pageId)` via `lib/meta-ads-library.js` for each. Writes raw snapshot to `data/snapshots/meta-ads-library/<date>.json`.
2. **`meta-ads-analyzer`** — runs after the collector. Reads the latest 4 weeks of snapshots, filters to ads with `longevityDays ≥ 14` AND `variationCount ≥ 3`, scores them, runs Claude analysis per qualifying ad. Output: `data/meta-ads-insights/<date>.json` and `latest.json`.
3. **`/api/meta-ads-insights`** — already wired; serves the latest insights JSON to the tab.

**Gated on Meta's Advanced Access approval.** The credentials are present (`META_APP_ACCESS_TOKEN`, `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`) but the app currently returns error subcode 2332004 ("App role required") on Ads Library API calls. Until approval lands, the cron jobs run but produce zero results, and the tab shows the empty state.

**Activation steps once approved:**
- Cron entries fire on Sunday and produce snapshots/insights.
- Tab automatically populates on the next dashboard load.
- No code change needed at activation time.

## "Use as inspiration" handoff

**Backend route:** new `POST /api/creatives/sessions/from-ad`

Request body:
```json
{ "adId": "<meta_ad_archive_id>" }
```

Server-side flow:
1. Look up ad in `data/meta-ads-insights/latest.json`.
2. Download `ad.adSnapshotUrl` (Meta's iframe-served preview) — server-side fetch with appropriate timeout. Save image bytes to `data/creatives/<sessionId>/refs/inspired-by-<adId>.<ext>`. (If the snapshot is a video, fall back to `ad.thumbnailUrl` if present, otherwise reject the request with a clear error.)
3. Create a new Creatives session via `createSession()` (existing helper), then mutate it before saving:
   - Add the downloaded image to `session.referenceImages`.
   - Set `session.prompt` to the templated starter (see below).
   - Set `session.inspiredBy = { adId, pageName, libraryId, capturedAt }`.
   - Mark `session.nameAutoGenerated = false` and set `session.name = "Inspired by <pageName> — <YYYY-MM-DD>"`.
4. Return `{ sessionId }` to the frontend.

**Frontend behavior on click:**
1. POST to the new route with the ad's id.
2. On success, call `switchTab('creatives', ...)` (the existing dashboard tab-switch helper).
3. Auto-select the newly-created session in the session dropdown.
4. **Do not auto-generate.** User adds product reference images and edits the prompt manually before clicking generate.

**Templated starter prompt:**
```
Adapt this style for Real Skin Care:
- Messaging angle: <angle>
- Hook: <hook>
- Why this works: <whyEffective>

Feature [PRODUCT] in [SCENE TYPE]. Match the visual aesthetic of the reference image, but use Real Skin Care's natural / clean visual identity.
```

`<angle>`, `<hook>`, `<whyEffective>` come from the analyzer output. `[PRODUCT]` and `[SCENE TYPE]` are placeholders the user fills in. If the analyzer didn't extract those fields, omit those lines rather than print empty bullets.

**Failure modes:**
- Ad lookup miss → 404 with `{ error: "Ad not found in latest insights" }`. Frontend shows a brief error and stays on the Ad Intelligence tab.
- `adSnapshotUrl` unfetchable / non-image → 502 with `{ error: "Could not fetch ad creative" }`. Same UX.
- Either error logs the ad ID + reason to `data/logs/creatives.log`.

## What's deleted / deprecated

- **`agents/competitor-ads/`** — fully delete. Redundant Firecrawl-based scraper from PR #173. Produces only text-pattern aggregates while the official meta-ads pipeline produces per-ad cards with creatives, which is what the tab actually needs.
- **`lib/firecrawl.js`** — fully delete. Was only used by `agents/competitor-ads/`.
- **`tests/agents/competitor-ads.test.js`** and **`tests/lib/firecrawl.test.js`** — delete with their consumers.
- **`data/reports/competitor-ads/`** — delete the directory. It exists on the server (the smoke run we did during PR #173 wrote `2026-04-28.json` + `latest.json`); the deploy step removes it.
- **"Generate Creative" / Package-for-All-Placements UI** — remove from the card. The `agents/creative-packager/` agent and `/api/generate-creative` route stay in the codebase as dormant infra, in case bulk-packaging becomes useful later. PR #172's Tavily grounding becomes dormant code with the rest of the packager. (Not deleted because the dormant infra still passes tests and adds zero runtime cost when nobody calls it.)
- **`disabled` class + opacity + `pointer-events:none`** on the tab pill in `index.html:24` — remove. Tab becomes clickable.

## File-level changes

**Modify:**
- `agents/dashboard/public/index.html` — drop the disabled styling on the tab pill.
- `agents/dashboard/public/js/dashboard.js`:
  - `renderAdCard(ad)` — drop platforms chips, rewire bottom button.
  - `renderAdIntelligenceTab()` — add filter chip row; sort by `effectivenessScore`; add `[+ Add competitor]` modal logic.
  - New `useAdAsInspiration(adId)` function — POSTs to the new route, switches tab, selects session.
  - Remove `openCreativeGenerator(adId, pageName)` and `generateCreative(adId, productImages)` and `pollCreativeJob(jobId)` — dead code once the button is gone.
- `agents/dashboard/routes/creatives.js` — add `POST /api/creatives/sessions/from-ad` handler.
- `agents/dashboard/routes/meta-ads.js` — add `POST /api/meta-ads/competitors` (add) and `DELETE /api/meta-ads/competitors/:pageId` (remove). Both mutate `config/meta-ads.json`.
- `scheduler.js` — add `meta-ads-collector` and `meta-ads-analyzer` to the Sunday block (Step 8d, between cannibalization-resolver and answer-first-rewriter).
- `agents/meta-ads-collector/index.js` — add a `--probe` flag that does a single 1-page-id call and reports `OK` or the exact error code (lets us quickly verify when Advanced Access flips).

**Delete:**
- `agents/competitor-ads/` (directory)
- `lib/firecrawl.js`
- `tests/agents/competitor-ads.test.js`
- `tests/lib/firecrawl.test.js`

## Tests

- **`tests/dashboard/creatives-from-ad.test.js`** — new. Unit-tests the `POST /api/creatives/sessions/from-ad` handler with fixtures: success path, ad-not-found, snapshot-unfetchable, video-fallback-to-thumbnail.
- **`tests/dashboard/meta-ads-competitors.test.js`** — new. Unit-tests add + remove handlers: writes to a temp `config/meta-ads.json` copy, asserts shape, rejects duplicate page IDs and malformed inputs.
- **`agents/meta-ads-collector/index.js`** `--probe` mode — covered by manual run, no automated test.
- **No JS tests in `agents/dashboard/public/`** — that file is browser code with no test runner; visual changes (filter chips, button rename) verified by manual smoke-test on the dashboard.

## Risk + rollout

- **Risk: low.** Tab can't show real data until Meta approves Advanced Access — the empty-state is already handled. All other work (filter chips, "Use as inspiration" handoff, add/remove competitors UI) is independent of approval status and can be tested with fixture data.
- **Rollout:** merge → deploy → tab is live in empty-state mode. When Advanced Access lands, the next Sunday cron populates data automatically; no further code change.
- **Verdict window:** N/A — this isn't an outcome-attribution feature.

## Out of scope

- Bulk creative packaging (deliberately deferred per user direction).
- Auto-generating creatives from the inspiration handoff (user wants manual control).
- Discovery of new competitors via keyword search (the curated page-ID list is sufficient; can revisit if needed).
- Any changes to the Creatives tab beyond accepting a pre-populated session — the user explicitly likes the Creatives tab as-is.
- Per-ad approve/reject UI inside Ad Intelligence — out of scope; the tab is read-only browsing, the Creatives tab is where work happens.
