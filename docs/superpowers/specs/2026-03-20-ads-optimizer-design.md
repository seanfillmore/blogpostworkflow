# Google Ads Optimizer Design — Real Skin Care
**Date:** 2026-03-20
**Branch:** feature/google-ads-campaign (extends existing ads work)

---

## 1. Goal

A daily AI feedback loop that analyzes Google Ads performance using independent data sources (GSC, GA4, Ahrefs, Shopify) and surfaces keyword and copy suggestions for user approval. All changes require explicit approval before execution. Auto-apply is deliberately excluded from Phase 1 — trust in the AI's judgment will be established through the approval queue before any automation is unlocked.

---

## 2. Core Value Proposition

Google's own suggestion engine is biased toward spend. This tool's suggestions are grounded in data Google cannot see:

- **GSC** — if the site already ranks top-3 organically for a keyword, bidding on it is waste
- **GA4** — landing page CVR, session quality, and device performance on paid traffic
- **Ahrefs** — keyword difficulty and volume before recommending new keyword additions
- **Shopify** — revenue and AOV trends that inform whether ROAS targets are realistic

The AI's rationale must cite specific data points from these sources, not generic best-practice advice.

---

## 3. Suggestion Types

| Type | Description | Apply Method |
|---|---|---|
| `keyword_pause` | Pause an underperforming keyword | `mutate()` from `lib/google-ads.js` |
| `keyword_add` | Add a new keyword to an ad group | `mutate()` from `lib/google-ads.js` |
| `negative_add` | Add a negative keyword at campaign level | `mutate()` from `lib/google-ads.js` |
| `copy_rewrite` | Rewrite a headline or description in an RSA | `mutate()` — uses `editedValue` if non-empty, else `suggested` |

Copy rewrites are the only type with an editable field in the approval UI. All other types are approve/reject only. For `copy_rewrite`, both `null` and `""` in `editedValue` are treated as unset — the `suggested` value is applied. The dashboard enforces RSA character limits client-side: 30 characters for headlines, 90 for descriptions, with a live counter and hard cap on the input field.

---

## 4. Data Sources & Analysis

### Sources loaded per run

| Source | Data pulled | Lookback |
|---|---|---|
| Google Ads snapshot | Spend, impressions, clicks, CTR, CPC, conversions, CVR, ROAS, per-keyword metrics, Quality Scores, resource names | Yesterday — read from `data/snapshots/google-ads/YYYY-MM-DD.json` (produced by `agents/google-ads-collector/index.js`) |
| GSC | Queries, clicks, impressions, CTR, position — filtered to paid landing pages | 28 days |
| GA4 | Landing page CVR, session quality, device breakdown, bounce rate | 28 days |
| Shopify | Revenue by product, AOV | 28 days |
| Ahrefs | Keyword difficulty + volume for any term the AI considers adding | On-demand via `mcp__claude_ai_Ahrefs__keywords-explorer-overview` |

### Cross-source reasoning rules (prompt-enforced)

- Before suggesting a keyword add: check Ahrefs KD and GSC organic ranking. If the site ranks top-3 organically, flag as organic cannibalisation risk instead.
- Before suggesting a copy rewrite: cite a specific GSC query or GA4 landing page metric that motivates the change.
- Before suggesting a keyword pause: require at minimum 100 impressions or 10 clicks with zero conversions, or a CPA > $25 after 3+ conversions.
- Never suggest changes that would increase spend unless the rationale includes a ROAS improvement projection.

---

## 5. File Structure

```
agents/ads-optimizer/index.js         — daily analysis + alert email
agents/apply-ads-changes/index.js     — mutate executor, updates suggestion statuses
scripts/ads-weekly-recap.js           — Sunday digest email
data/ads-optimizer/YYYY-MM-DD.json    — suggestion store (processed output, not raw snapshot)
```

`data/ads-optimizer/` is intentionally separate from `data/snapshots/` — it contains AI-generated analysis and mutable suggestion state, not raw API responses.

---

## 6. Suggestion Schema

`data/ads-optimizer/YYYY-MM-DD.json`:

```json
{
  "date": "2026-03-20",
  "analysisNotes": "2–3 sentence account health summary citing specific metrics.",
  "suggestions": [
    {
      "id": "suggestion-001",
      "type": "keyword_pause",
      "status": "pending",
      "confidence": "high",
      "adGroup": "Coconut Lotion",
      "target": "coconut oil lotion",
      "rationale": "187 impressions, 0 conversions, 0.8% CTR. Site ranks #3 organically for this query — paid coverage is cannibalising budget with no incremental return.",
      "proposedChange": {
        "criterionResourceName": "customers/1234567890/adGroupCriteria/111~222"
      }
    },
    {
      "id": "suggestion-002",
      "type": "keyword_add",
      "status": "pending",
      "confidence": "medium",
      "adGroup": "Natural Body Lotion",
      "target": "natural lotion sensitive skin",
      "rationale": "GSC shows 280 impressions/mo at position 6 — paid coverage while organic climbs. Ahrefs KD 2, 880 vol/mo.",
      "proposedChange": {
        "keyword": "natural lotion sensitive skin",
        "matchType": "EXACT",
        "adGroupResourceName": "customers/1234567890/adGroups/333"
      }
    },
    {
      "id": "suggestion-003",
      "type": "negative_add",
      "status": "pending",
      "confidence": "high",
      "adGroup": null,
      "target": "recipe",
      "rationale": "12 impressions this week from 'coconut lotion recipe' — non-buyer intent, pure waste.",
      "proposedChange": {
        "keyword": "recipe",
        "matchType": "BROAD",
        "campaignResourceName": "customers/1234567890/campaigns/444"
      }
    },
    {
      "id": "suggestion-004",
      "type": "copy_rewrite",
      "status": "pending",
      "confidence": "medium",
      "adGroup": "Natural Body Lotion",
      "target": "Headline 4",
      "rationale": "GSC shows 'fragrance free lotion' drives 340 impressions/mo at 4.2% organic CTR — stronger signal than current Headline 4.",
      "proposedChange": {
        "field": "headline_4",
        "current": "No Parabens. No SLS. No Toxins.",
        "suggested": "Fragrance Free Body Lotion",
        "adGroupAdResourceName": "customers/1234567890/adGroupAds/333~555"
      },
      "editedValue": null
    }
  ]
}
```

### Status lifecycle
`pending → approved | rejected → applied`

### Dispatch key
The apply agent dispatches on the top-level `type` field. `proposedChange` contains only the fields needed to construct the mutate operation for that type — there is no redundant `action` field.

### Resource names
The Google Ads snapshot produced by `agents/google-ads-collector/index.js` must include resource names for each entity. The optimizer stores these directly in `proposedChange` so the apply agent never performs a lookup:

- `keyword_pause` — `criterionResourceName` (`customers/.../adGroupCriteria/adGroup~criterion`)
- `keyword_add` — `adGroupResourceName` (`customers/.../adGroups/...`)
- `negative_add` — `campaignResourceName` (`customers/.../campaigns/...`)
- `copy_rewrite` — `adGroupAdResourceName` (`customers/.../adGroupAds/adGroup~ad`)

---

## 7. Apply Agent

`agents/apply-ads-changes/index.js`:

- Reads today's suggestion file from `data/ads-optimizer/YYYY-MM-DD.json`
- Filters to `status: "approved"`
- For each suggestion, constructs the appropriate `Operation` object and calls `mutate(operations)` from `lib/google-ads.js` (one call per suggestion, `partialFailure: true`)
- **Partial failure handling:** Google Ads returns partial failures as `data.partialFailureError` in a 200 response — not as a thrown error. The apply agent must inspect this field after each call. If present, log the error details and suggestion ID, leave status as `"approved"` for retry, continue to next suggestion.
- On success: updates suggestion status to `"applied"` in the JSON file
- Streams progress via stdout for SSE pickup by the dashboard
- Final stdout line: `DONE {"applied": N, "failed": N}`
- Guards `main()` with `if (process.argv[1] === fileURLToPath(import.meta.url))` to allow test imports
- **Edge cases:**
  - If today's suggestion file does not exist: print `No suggestion file for today` to stdout, exit 0
  - If the file exists but has zero `approved` suggestions: print `No approved suggestions to apply`, exit 0
  - Both cases produce visible output in the dashboard run log so the user knows the agent ran cleanly

---

## 8. Dashboard (Ads Tab)

### Actions bar additions
Two new buttons added to `id="tab-actions-ads"` (new group, follows existing pattern in `switchTab`):
- **Run Ads Optimizer** — calls `runAgent('agents/ads-optimizer/index.js')` via `POST /run-agent`. Script must be added to `RUN_AGENT_ALLOWLIST` in `agents/dashboard/index.js`.
- **Apply Approved** — calls `POST /apply-ads` (new dedicated route, see below).

### New dashboard routes

**`POST /ads/:date/suggestion/:id`** — update a suggestion field
- Body: `{ status?: string, editedValue?: string }`
- Reads `data/ads-optimizer/:date.json`, updates the matching suggestion, writes back
- Returns `{ ok: true }`
- Used by both approve/reject buttons and the copy edit field (on blur)

**`POST /apply-ads`** — run the apply agent
- Spawns `agents/apply-ads-changes/index.js` as a child process
- Streams stdout as SSE (`data: <line>\n\n`), sends `event: done` on close
- Response shape identical to existing `/apply/:slug` endpoint

### Optimization card (top of Ads tab, above campaign metrics)

- `analysisNotes` rendered as a summary paragraph
- Suggestions grouped by type: Keywords first, then Copy
- Each suggestion card shows:
  - Confidence badge (`HIGH` / `MED` / `LOW`) — `"high"` → `HIGH`, `"medium"` → `MED`, `"low"` → `LOW`
  - Ad group + target
  - Rationale (prominent — this is the value)
  - Proposed change
  - For `copy_rewrite`: editable text field pre-filled with `suggested`, saves `editedValue` via `POST /ads/:date/suggestion/:id` on blur
  - Approve / Reject buttons — call `POST /ads/:date/suggestion/:id` with `{ status: 'approved' | 'rejected' }`
- Applied suggestions shown in a collapsed section below the queue for audit trail

### Run log
`<pre id="run-log-apply-ads" class="run-log" style="display:none">` — streams apply output. ID follows the same `run-log-<kebab>` convention as other log elements.

---

## 9. Email

Both emails use the existing Resend integration. The server URL is read from `DASHBOARD_URL` env var (consistent with `scripts/ahrefs-reminder.js`).

### Daily alert (sent only when suggestions exist)
**Cron:** 6:45 AM PT daily

```
Subject: Google Ads — {N} suggestions ready for review

Yesterday: ${spend} spend · {clicks} clicks · {conversions} conv · {roas}x ROAS

Suggestions:
• [HIGH] Pause "{keyword}" — {one-line rationale}
• [MED] Rewrite {Headline N}, {Ad Group} — {one-line rationale}
• [HIGH] Add negative "{term}" — {one-line rationale}

Review and approve: {DASHBOARD_URL} → Ads tab
```

### Weekly recap (every Sunday regardless of suggestions)
**Cron:** 7:00 AM PT Sunday

The recap window is the 7 days ending yesterday (the prior complete Sun–Sat). Since the recap runs Sunday morning and Sunday's collector hasn't finished, yesterday (Saturday) is always the last complete day. The 7-day window is therefore the 7 days Sun–Sat ending yesterday, e.g. if today is Sun Mar 22, the window is Sun Mar 15–Sat Mar 21. The subject line `w/c {Mon date}` shows the Monday of that window (e.g. "w/c Mar 16"). The script scans `data/ads-optimizer/YYYY-MM-DD.json` files dated within the window for applied change counts, and `data/snapshots/google-ads/YYYY-MM-DD.json` files for the same window for spend/conversion metrics. Week-over-week delta compares the current window against the prior 7-day window (8–14 days ago).

```
Subject: Google Ads Weekly — w/c {Mon date}

This week: ${spend} spend · {clicks} clicks · {conversions} conv · ${cpa} CPA · {roas}x ROAS
vs last week: spend {±$X} · conv {±N} · CPA {±$X}

Top keyword: [{keyword}] — {N} conv, ${cpa} CPA
Weakest: [{keyword}] — {N} clicks, {N} conv

{N} changes applied this week: {summary of types}
Organic overlap: {N} paid keywords already ranking top-3 organically

Next week outlook: {2–3 sentence Claude assessment}
```

---

## 10. Cron Schedule

| Time (PT) | Script | Condition |
|---|---|---|
| 6:25 AM daily | `agents/google-ads-collector/index.js` | Always |
| 6:45 AM daily | `agents/ads-optimizer/index.js` | Always (email only if suggestions exist) |
| 7:00 AM Sunday | `scripts/ads-weekly-recap.js` | Always |
| Manual | `agents/apply-ads-changes/index.js` | Dashboard-triggered only |

---

## 11. Google Ads Collector Snapshot Dependency

`agents/google-ads-collector/index.js` (existing, on `feature/google-ads-campaign` branch) must include `resourceName` for each entity in its daily snapshot. Required fields:

```json
{
  "campaigns": [{ "resourceName": "customers/.../campaigns/...", ... }],
  "adGroups": [{ "resourceName": "customers/.../adGroups/...", ... }],
  "keywords": [{ "resourceName": "customers/.../adGroupCriteria/adGroup~criterion", ... }],
  "adGroupAds": [{ "resourceName": "customers/.../adGroupAds/adGroup~ad", ... }]
}
```

Note: the collector exposes `adGroupAds` (not `ads`) with the compound `adGroup~ad` resource name, matching the `adGroupAdResourceName` field used by the apply agent for copy rewrites.

If the collector does not currently include resource names, it must be updated as part of this implementation.

---

## 12. Phase 2 — Auto-Apply (Not in Scope Now)

Auto-apply is intentionally excluded from Phase 1. Once the approval queue has established a track record of accurate suggestions, specific low-risk action types (e.g., pausing keywords with 200+ impressions and zero conversions) can be unlocked with a threshold configuration. This will be designed as a separate feature after Phase 1 is live and validated.

---

## 13. Out of Scope (Phase 1)

- Bid adjustments (Manual CPC → tROAS transition handled manually per the existing spec)
- Budget changes
- New campaign or ad group creation
- Auto-apply of any kind
