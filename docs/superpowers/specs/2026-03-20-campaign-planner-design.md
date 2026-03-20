# Campaign Planner System Design

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Date:** 2026-03-20
**Goal:** Build a three-agent system that analyzes all available data to propose fully-formed new Google Ads campaigns (including ad copy), creates approved campaigns via the Ads API, and monitors active campaigns against their projections in a continuous feedback loop.

All feature work must be done on a new branch. All code must be tested and verified locally before being pushed to the server.

---

## 1. Architecture & Data Flow

```
Weekly cron            campaign-analyzer  →  data/campaigns/<id>.json  (status: proposed)
Dashboard approval     POST /api/campaigns/:id/approve  →  status: approved (persisted to disk immediately)
Dashboard launch       POST /run-agent (SSE) → campaign-creator  →  status: active, writes campaign IDs
Daily cron             campaign-monitor   →  appends performance[], writes alerts[]
                            ↓
                       campaign-analyzer reads performance[] on next weekly run (feedback loop)
```

**Data sources for campaign-analyzer** (all are optional — agent degrades gracefully if a source is absent):
- `data/snapshots/google-ads/` — populated by existing `agents/google-ads-collector`. Each file is a daily snapshot produced by `lib/google-ads.js fetchDailySnapshot()`. Fields used by campaign-monitor: `campaigns[].id` (matches `googleAds.campaignId`), `campaigns[].spend`, `campaigns[].impressions`, `campaigns[].clicks`, `campaigns[].ctr`, `campaigns[].avgCpc`, `campaigns[].conversions`. If absent, analyzer notes the gap and proceeds without paid history.
- `data/snapshots/gsc/` — organic keywords, impressions, CTR by page
- `data/snapshots/ga4/` — CVR by landing page, revenue by channel
- `data/snapshots/shopify/` — product revenue, order counts, AOV
- `data/ahrefs/` — keyword explorer CSV exports (optional; analyzer notes if absent)
- `data/campaigns/` — past campaign `performance[]` arrays (feedback loop)

---

## 2. Campaign File Schema

**Location:** `data/campaigns/YYYY-MM-DD-<slug>.json`

**Status values:** `proposed → approved → active → paused → completed → dismissed`
(`created` is not a status — the creator sets `active` directly upon success.)

```json
{
  "id": "2026-03-20-natural-toothpaste-search",
  "status": "proposed",
  "createdAt": "2026-03-20T08:00:00.000Z",
  "proposal": {
    "campaignName": "RSC | Toothpaste | Search",
    "objective": "Drive purchases of coconut oil toothpaste",
    "landingPage": "/products/coconut-oil-toothpaste",
    "network": "Search",
    "suggestedBudget": 5.00,
    "approvedBudget": null,
    "mobileAdjustmentPct": 30,
    "adGroups": [
      {
        "name": "Natural Toothpaste",
        "keywords": [
          { "text": "natural toothpaste", "matchType": "EXACT" },
          { "text": "coconut oil toothpaste", "matchType": "EXACT" }
        ],
        "headlines": [
          "Natural Coconut Oil Toothpaste",
          "Only Clean Ingredients",
          "Fluoride-Free Formula"
        ],
        "descriptions": [
          "Made with organic coconut oil and no harsh chemicals. Clean teeth, clean ingredients.",
          "Fluoride-free toothpaste for a cleaner routine. 6 real ingredients you can pronounce."
        ]
      }
    ],
    "negativeKeywords": ["diy", "recipe", "homemade", "wholesale"]
  },
  "rationale": "GSC shows 420 impressions/mo for 'natural toothpaste' with 0 paid coverage...",
  "dataPoints": {
    "gscImpressions": 420,
    "gscCTR": 0.031,
    "ga4CVR": 0.022,
    "shopifyRevenue": 612.00,
    "competitorsCovering": ["hello", "dr. bronner's"]
  },
  "projections": {
    "ctr": 0.035,
    "cpc": 0.65,
    "cvr": 0.022,
    "dailyClicks": 8,
    "monthlyCost": 150,
    "monthlyConversions": 5,
    "monthlyRevenue": 180
  },
  "clarificationNeeded": null,
  "clarificationResponse": null,
  // clarificationNeeded type: string[] | null — array of question strings when set, null when none
  "googleAds": {
    "campaignResourceName": null,
    "campaignId": null,
    "budgetResourceName": null,
    "adGroupResourceNames": [],
    "createdAt": null
  },
  "performance": [],
  "alerts": []
}
```

**Notes on schema fields:**
- `mobileAdjustmentPct`: positive integer (e.g. `30` = +30%). Creator converts to Google Ads API format: `1 + (mobileAdjustmentPct / 100)` → `1.3`. Negative values mean bid reduction.
- `adGroups[].headlines`: Claude writes all headlines during the proposal phase. Minimum 3, maximum 15. Creator validates presence before attempting RSA creation.
- `adGroups[].descriptions`: Claude writes all descriptions during the proposal phase. Minimum 2, maximum 4.
- Sitelinks, callouts, and structured snippets are **out of scope for v1**. Not included in schema or creator.
- `clarificationNeeded` is `string[] | null`. When set, the campaign appears **only** in the Clarifications Needed card — it is excluded from the Proposals card. The Proposals card filters to `status === 'proposed' && clarificationNeeded === null`.
- Re-analysis (`--campaign <id>`) only proceeds if `status === 'proposed'`. If status is anything else, the agent logs an error and exits 1 without modifying the file.

**Performance entry** (appended daily by campaign-monitor):
```json
{
  "date": "2026-03-21",
  "spend": 4.82,
  "impressions": 210,
  "clicks": 7,
  "ctr": 0.033,
  "avgCpc": 0.69,
  "conversions": 0,
  "cvr": 0,
  "cpa": null,
  "vsProjection": {
    "ctrDelta": -0.002,
    "cpcDelta": 0.04,
    "cvrDelta": -0.022
  }
}
```
- `cpa`: `spend / conversions` if conversions > 0, otherwise `null`.
- `vsProjection` deltas are **absolute differences** in the same units as the metric: `actual - projected`. Example: projected CTR 0.035, actual CTR 0.033 → `ctrDelta = -0.002` (not a percentage, not a ratio). Dashboard multiplies by 100 to display as percentage points.
```

**Alert entry** (written by campaign-monitor, deduplicated by `type`):
```json
{
  "type": "low_ctr",
  "firedAt": "2026-03-27T07:30:00.000Z",
  "message": "CTR 1.5% is 57% below projected 3.5% after 7 days — review ad copy",
  "resolved": false
}
```
Deduplication rule: only one alert per `type` may exist with `resolved: false`. If an alert of the same `type` already exists and is unresolved, the monitor skips writing a duplicate. A new alert of the same type may fire only after the previous one is marked `resolved: true`.

---

## 3. Agent: campaign-analyzer

**Location:** `agents/campaign-analyzer/index.js`
**Schedule:** Weekly, Sunday 6:00 AM PT (`0 6 * * 0` with `TZ=America/Los_Angeles`)
**Usage:**
```bash
node agents/campaign-analyzer/index.js            # normal weekly run
node agents/campaign-analyzer/index.js --dry-run  # prints proposals as JSON to stdout, writes nothing
node agents/campaign-analyzer/index.js --campaign <id>  # re-analyze one proposal using clarificationResponse
```

**`--dry-run` output format:** Prints each proposal as a JSON object to stdout, prefixed with `[DRY RUN] Proposal N:`, then exits 0 without writing any files or sending email.

### Responsibilities
1. Load all available data in parallel; log which sources are present/absent
2. Read all existing campaign files; extract active/proposed slugs and `performance[]` histories
3. Build Claude prompt (see below) requesting 1–3 new campaign proposals
4. For each proposal, Claude outputs full campaign structure including ad copy, projections, and rationale
5. If Claude cannot form a confident proposal (thin data, ambiguous priorities), it outputs `clarificationNeeded` with specific questions instead — no partial proposals
6. Save each complete proposal to `data/campaigns/YYYY-MM-DD-<slug>.json`
7. Send email listing new proposals and/or clarification requests via `lib/notify.js`

### Claude prompt structure
```
## Task
Identify 1–3 new Google Ads Search campaign opportunities for Real Skin Care (realskincare.com).
For each opportunity output a complete campaign proposal including:
- Campaign name, objective, landing page
- Ad groups with keywords (text + match type), headlines (3–15), descriptions (2–4)
- Negative keywords
- Projected CTR, CPC, CVR, monthly cost, conversions, revenue
- Rationale citing specific data points
- Suggested daily budget in USD

Do NOT propose campaigns already covered by these active/proposed campaigns: [list]

If you cannot form a confident proposal due to missing data, output clarificationNeeded
with a list of specific questions instead of a proposal.

## Available Data
### Google Ads (last 60 days)
[summary of existing campaign performance, spend, ROAS, top keywords]

### Google Search Console
[top organic keywords by impressions, CTR, pages]

### Google Analytics 4
[CVR by landing page, revenue by channel, top converting pages]

### Shopify
[top products by revenue, AOV, order count]

### Ahrefs
[keyword opportunities if exports present; "No Ahrefs exports found" if absent]

### Past Campaign Outcomes
[performance[] summaries from completed/active campaigns]
```

### Re-analysis flow (`--campaign <id>`)
Reads the campaign file, builds a focused prompt (below), re-runs Claude, and overwrites `proposal`, `projections`, `rationale`, and `clarificationNeeded`. Preserves `clarificationResponse`. Sets `clarificationNeeded: null` if the new output is a full proposal.

**Re-analysis prompt structure:**
```
## Original Proposal
[full original rationale and dataPoints from the campaign file]

## Questions Asked
[clarificationNeeded array joined as numbered list]

## User's Answers
[clarificationResponse text]

## Task
Using the user's answers, produce a complete updated campaign proposal in the same JSON format as the normal analyzer output. If the answers are still insufficient, output clarificationNeeded with refined questions.
```

---

## 4. Agent: campaign-creator

**Location:** `agents/campaign-creator/index.js`
**Trigger:** Dashboard `POST /run-agent` SSE route with body `{ agent: 'agents/campaign-creator/index.js', args: ['--campaign', '<id>'] }`
**Usage:**
```bash
node agents/campaign-creator/index.js --campaign <id>
node agents/campaign-creator/index.js --campaign <id> --dry-run  # validates and prints plan, no API calls
```

**`--dry-run` output:** Prints each planned API operation (e.g. `[DRY RUN] Would create CampaignBudget: $5.00/day`) then exits 0.

### Validation (exits with error if any fail)
1. Campaign file exists
2. `status === 'approved'`
3. `approvedBudget` is a positive number
4. Each ad group has `headlines.length >= 3` and `descriptions.length >= 2`
5. Each ad group has `keywords.length >= 1`

### Creation sequence (via `lib/google-ads.js` mutate, `partialFailure: true`)
1. CampaignBudget — `approvedBudget` USD/day
2. Campaign — Search, Manual CPC, US-only, device bid adjustment from `mobileAdjustmentPct`
3. For each ad group: AdGroup → AdGroupAd (RSA) → AdGroupCriterion (keywords)
4. CampaignCriterion — negative keywords at campaign level

On partial failure: log the failed operations with error details, continue remaining operations.

### stdout protocol (for dashboard SSE)
```
Validating campaign file...
Creating campaign budget ($5.00/day)...
Creating campaign: RSC | Toothpaste | Search
Creating ad group: Natural Toothpaste
  Adding 2 keywords...
  Adding RSA...
Adding 4 negative keywords...
DONE {"campaignId":"12345678","status":"active"}
```

On error: `ERROR <message>` as final line.

After success: write `googleAds` block and set `status: 'active'` in the campaign file. Send email via `lib/notify.js`.

---

## 5. Agent: campaign-monitor

**Location:** `agents/campaign-monitor/index.js`
**Schedule:** Daily, 7:30 AM PT — after google-ads-collector (`30 7 * * *` with `TZ=America/Los_Angeles`)
**Usage:** `node agents/campaign-monitor/index.js`

### Responsibilities
1. Load all campaign files with `status: 'active'`
2. Load the latest Google Ads snapshot from `data/snapshots/google-ads/`
3. For each active campaign, find matching metrics by `googleAds.campaignId`
4. Compute variance from projections; append a performance entry to `performance[]`
5. Evaluate alert conditions; write new alerts to `alerts[]` (deduplicated by `type`)
6. If any new alerts: send batched email and mark for dashboard display
7. Write updated campaign file

### Alert conditions

| Condition | Type | Threshold |
|---|---|---|
| CTR < 50% of projected after 7 days data | `low_ctr` | Days with data ≥ 7 AND avg CTR < projections.ctr × 0.5 |
| CPC > 150% of projected after 7 days data | `high_cpc` | Days with data ≥ 7 AND avg CPC > projections.cpc × 1.5 |
| CVR < 50% of projected after 14 days data | `low_cvr` | Days with data ≥ 14 AND avg CVR < projections.cvr × 0.5 |
| CPA > 200% of projected after 14 days with ≥ 1 conversion | `high_cpa` | Days with data ≥ 14 AND totalConversions > 0 AND projections.cvr > 0 AND (totalSpend / totalConversions) > (projections.cpc / projections.cvr) × 2.0. Skip entirely if totalConversions = 0 or projections.cvr = 0. |
| Cumulative conversions ≥ 15 | `troas_ready` | Sum of performance[].conversions ≥ 15 |
| Daily spend ≥ 95% of approvedBudget for 7 consecutive days | `budget_maxed` | Last 7 entries all have spend ≥ approvedBudget × 0.95 |

---

## 6. Dashboard Changes

### New API routes
- `POST /api/campaigns/:id/approve` — validates body `{ approvedBudget: Number }`, writes to campaign file (status → `approved`), responds `{ ok: true }`
- `POST /api/campaigns/:id/dismiss` — sets `status: 'dismissed'`, responds `{ ok: true }`
- `POST /api/campaigns/:id/clarify` — saves `{ clarificationResponse: String }` to file, spawns `campaign-analyzer --campaign <id>` as child process (non-blocking), responds `{ ok: true }`. Dashboard polls `GET /api/campaigns/:id` to detect when `clarificationNeeded` clears.
- `POST /api/campaigns/:id/alerts/:type/resolve` — finds the first entry in `alerts[]` where `type === :type && resolved === false`, sets `resolved: true`, writes file, responds `{ ok: true }`. If none found, responds `{ ok: true }` (idempotent). Deduplication ensures at most one unresolved alert per type exists.
- `GET /api/campaigns` — reads all files in `data/campaigns/`, returns array sorted by `createdAt` desc
- `GET /api/campaigns/:id` — reads and returns a single campaign file

### Campaign Proposals card (new, top of Ads tab)

Renders campaigns with `status: proposed | approved`. Each shows:
- Campaign name and objective
- Suggested budget (editable `<input type="number">`, pre-filled from `suggestedBudget`)
- Projected: monthly revenue, monthly conversions
- Rationale (first 120 chars, expandable)
- Status badge
- **"Approve"** button: validates budget input > 0, POSTs to `/api/campaigns/:id/approve` with `approvedBudget`, updates button to show "Confirm & Launch"
- **"Confirm & Launch"** button (shown after approve): triggers SSE via existing `/run-agent` mechanism with `agents/campaign-creator/index.js --campaign <id>`. Shows live log output.
- **"Dismiss"** button: POSTs to `/api/campaigns/:id/dismiss`

### Clarifications Needed card (new, below proposals)

Renders campaigns with `clarificationNeeded !== null`. Shows each question as a list item with a shared `<textarea>` per campaign. "Submit" POSTs to `/api/campaigns/:id/clarify` and shows a spinner while re-analysis runs.

### Active Campaigns card (new, below existing campaign overview)

Renders campaigns with `status: active`. Each shows:
- Campaign name + days since `googleAds.createdAt`
- Daily spend vs. `approvedBudget` (progress bar)
- CTR, CPC, CVR vs. projections (green if within 20%, red if >20% below)
- Open alerts (unresolved) as inline badges
- "Mark Resolved" button per alert: POSTs to `POST /api/campaigns/:id/alerts/:type/resolve`

---

## 7. File Structure

New files:
```
agents/campaign-analyzer/index.js
agents/campaign-creator/index.js
agents/campaign-monitor/index.js
data/campaigns/.gitkeep
test/fixtures/campaigns/sample-proposed.json   ← tracked test fixture, not gitignored
```

Modified files:
```
agents/dashboard/index.js   — new cards, new API routes
scripts/setup-cron.sh       — add analyzer (weekly) and monitor (daily) entries
.gitignore                  — add data/campaigns/*.json (test/fixtures/ is NOT gitignored)
```

---

## 8. Testing Checklist

- [ ] `campaign-analyzer --dry-run` prints valid proposal JSON, writes nothing
- [ ] Campaign file written with all required fields including ad copy
- [ ] `campaign-creator --dry-run --campaign <id>` prints all planned API operations
- [ ] Creator validation rejects files missing ad copy before any API calls
- [ ] Dashboard proposal card renders; budget editable; Approve persists to disk
- [ ] Confirm & Launch triggers SSE and shows live log
- [ ] Monitor reads snapshot, computes variance, appends performance entry
- [ ] Each alert condition fires correctly with synthetic test data
- [ ] Alert deduplication prevents duplicate `type` entries
- [ ] All three agents run without error on local server before deployment
