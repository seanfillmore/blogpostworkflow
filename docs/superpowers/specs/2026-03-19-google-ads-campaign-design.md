# Google Ads Campaign Design — Real Skin Care
**Date:** 2026-03-19
**Site:** https://www.realskincare.com
**Budget:** $10/day ($300/month)
**Branch:** feature/google-ads-campaign

---

## 1. Context & Data Foundation

### Site Performance Snapshot
- **45 total Shopify orders** (Jan 18 – Mar 10, 2026), $1,385.77 revenue, $30.79 AOV
- **Revenue trend:** Jan $187 → Feb $971 → Mar $228 (partial) — accelerating
- **GA4 overall CVR:** 0.55% (28 purchases / 5,123 sessions)
- **Paid Search CVR:** 1.74% (existing activity — 172 sessions, 3 purchases, $72.40)
- **Mobile CVR:** 1.26% vs Desktop 0.23% — mobile converts 5x better
- **Bounce rate:** 31.2% (healthy)
- **Avg session duration:** 67 seconds

### Top Products by Revenue
| Product | Revenue | Orders | Units |
|---|---|---|---|
| Coconut Lotion (8oz) | $836.00 | 26 | 38 |
| Non-Toxic Body Lotion | $638.00 | 21 | 29 |
| Coconut Moisturizer (4oz) | $299.92 | 15 | 15 |
| Foaming Hand Soap | $206.92 | 16 | 23 |

### Top Landing Pages by CVR
| Page | Sessions | Purchases | CVR |
|---|---|---|---|
| /products/coconut-lotion | 341 | 9 | **2.64%** |
| /collections/best-non-toxic-body-lotion | 56 | 2 | 3.57% |
| /collections/organic-body-lotion | 18 | 2 | 11.1% (small sample) |
| / (homepage) | 920 | 6 | 0.65% |

**Decision:** `/products/coconut-lotion` is the primary landing page — highest absolute conversions, proven CVR at meaningful sample size.

---

## 2. Campaign Structure

**Campaign name:** `RSC | Lotion | Search`
**Network:** Search only (no Display expansion)
**Goal:** Purchases
**Budget:** $10/day
**Geographic targeting:** United States
**Device bid adjustment:** Mobile +30% (justified by 5x mobile CVR advantage)
**Ad schedule:** All hours/days initially; optimize after 30 days of data

### Ad Groups

| Ad Group | Theme | Landing Page |
|---|---|---|
| `Coconut Lotion` | Product-specific, brand-named queries | `/products/coconut-lotion` |
| `Natural Body Lotion` | Category/benefit queries | `/products/coconut-lotion` |

Two ad groups isolate which message angle (product vs. category) drives better CTR and CVR, without splitting budget or landing pages.

---

## 3. Keywords

### Ad Group 1 — Coconut Lotion

| Keyword | Match Type |
|---|---|
| `[coconut lotion]` | Exact |
| `[coconut body lotion]` | Exact |
| `"coconut lotion for dry skin"` | Phrase |
| `"coconut oil lotion"` | Phrase |
| `[buy coconut lotion]` | Exact |
| `[coconut lotion natural]` | Exact |

### Ad Group 2 — Natural Body Lotion

| Keyword | Match Type |
|---|---|
| `[natural body lotion]` | Exact |
| `[clean body lotion]` | Exact |
| `[non toxic body lotion]` | Exact |
| `"natural lotion for dry skin"` | Phrase |
| `"fragrance free body lotion"` | Phrase |
| `[organic body lotion]` | Exact |

### Campaign-Level Negative Keywords

`DIY, recipe, homemade, wholesale, bulk, free sample, cheap, dollar, sunscreen, face, baby, dog, cat, amazon, walmart, target`

---

## 4. Ad Copy

### Ad Group 1 — Coconut Lotion RSA

**Headlines (15):**
1. Real Coconut Oil Body Lotion
2. Only 6 Clean Ingredients
3. Free of Toxins & Harsh Chemicals
4. Deep Moisture That Lasts All Day
5. Non-Toxic Lotion for Dry Skin
6. Made With Organic Coconut Oil
7. No Parabens, SLS, or Fragrance
8. Shop Real Skin Care Lotion
9. Lightweight & Fast Absorbing
10. Clean Beauty. Real Ingredients.
11. Feel the Difference in One Use
12. 100% Natural Body Lotion
13. Try Our Coconut Breeze Formula
14. Ships Fast — Order Today
15. Clean Lotion Your Skin Will Love

**Descriptions (4):**
1. Moisturize without the mystery ingredients. Our coconut oil body lotion is made with only 6 real, clean ingredients you can actually pronounce. No fillers, no fragrance.
2. Ditch the toxins. Real Skin Care body lotion is non-toxic, fragrance-free, and made with organic coconut oil — gentle enough for sensitive skin, effective enough for extremely dry skin.
3. Real people. Real results. Our coconut lotion absorbs fast, locks in moisture, and skips the harmful chemicals found in most drugstore brands. Clean beauty that works.
4. Not sure what's in your lotion? Ours has 6 ingredients and nothing to hide. Organic coconut oil base, zero parabens, zero SLS. Try Real Skin Care today.

### Ad Group 2 — Natural Body Lotion RSA

**Headlines (15):**
1. Natural Body Lotion That Works
2. Only 6 Clean Ingredients Total
3. Organic Coconut Oil Formula
4. No Parabens. No SLS. No Toxins.
5. Best Non-Toxic Body Lotion
6. Clean Body Lotion for Dry Skin
7. Skip the Harsh Chemicals
8. Real Ingredients. Real Results.
9. Fragrance-Free & Gentle Formula
10. Natural Lotion for Sensitive Skin
11. Lightweight & Deeply Moisturizing
12. Shop Real Skin Care
13. Made for Dry & Sensitive Skin
14. Cruelty-Free. Vegan. Clean.
15. Your Skin Knows the Difference

**Descriptions (4):**
1. Tired of body lotions packed with chemicals you can't pronounce? Real Skin Care is made with just 6 ingredients — organic coconut oil, shea butter, and nothing you wouldn't recognize.
2. Non-toxic, fragrance-free, and actually moisturizing. Our natural body lotion is formulated for dry and sensitive skin — no parabens, no SLS, no artificial fragrance. Clean skincare, simplified.
3. Most body lotions have 20+ ingredients. Ours has 6. Real Skin Care natural lotion is lightweight, fast-absorbing, and free of the toxins your skin doesn't need. Clean beauty made simple.
4. Your lotion should heal, not harm. Real Skin Care uses organic coconut oil as the base for a clean, effective body lotion — gentle on skin, tough on dry patches. Free of harsh chemicals.

### Ad Extensions

**Sitelinks** (each URL includes UTM params with `utm_content` to distinguish sitelink clicks from headline clicks in GA4):
- Shop Coconut Lotion → `/products/coconut-lotion?utm_source=google&utm_medium=cpc&utm_campaign=rsc-lotion-search&utm_content=sitelink-coconut-lotion`
- Natural Deodorant → `/products/coconut-oil-deodorant?utm_source=google&utm_medium=cpc&utm_campaign=rsc-lotion-search&utm_content=sitelink-deodorant`
- Coconut Oil Toothpaste → `/products/coconut-oil-toothpaste?utm_source=google&utm_medium=cpc&utm_campaign=rsc-lotion-search&utm_content=sitelink-toothpaste`
- All Products → `/collections/all?utm_source=google&utm_medium=cpc&utm_campaign=rsc-lotion-search&utm_content=sitelink-all`

**Callouts:** 6-Ingredient Formula · Fragrance Free · Vegan & Cruelty-Free · Ships Fast

**Structured Snippets** (Type: Ingredients): Organic Coconut Oil, Shea Butter, Vitamin E

> **Note on Ad Group 2 landing page:** The collection page `/collections/best-non-toxic-body-lotion` shows a 3.57% CVR vs. 2.64% for the product page, and is a strong semantic match for category queries. However, that sample is only 56 sessions / 2 conversions — too thin to be reliable. Both ad groups land on `/products/coconut-lotion` for now. Revisit after 50+ paid clicks on Ad Group 2.

---

## 5. Bidding Strategy

### Phase 1: Days 1–30 (Manual CPC)
- **Max CPC:** $0.80
- **Rationale:** Revenue break-even CPC at 2.64% CVR and $22 AOV is $0.58. Note this is revenue break-even, not margin break-even — actual profitability depends on COGS. Capping at $0.80 allows top-3 positioning on moderate-competition terms while building conversion history.
- Smart Bidding requires ≥15 conversions to optimize effectively — manual CPC avoids wasted spend during the learning phase.
- **Realistic timeline note:** At $10/day and ~0.33 conversions/day (10 clicks/day × 2.64% CVR × 80% efficiency), reaching 15 conversions will take ~45 days, not 30. The Phase 2 trigger is conversion-count-gated, not calendar-gated.

### Phase 2: Days 45+ (Target ROAS)
- **Trigger:** ≥15 cumulative conversions in the account
- **Initial tROAS target:** 150% (Google's Smart Bidding needs headroom above 1x to explore bid variations; starting at 110% risks under-bidding and delivery stalls)
- **Step down to 130%** if impression share falls below 40% at 150% tROAS
- **Rationale:** Once conversion history exists, Google's model can optimize bid timing/audience in ways manual CPC cannot.

---

## 6. Conversion Tracking

**Method:** Import GA4 `purchase` event into Google Ads
- Path: Google Ads → Tools → Conversions → Import → Google Analytics 4
- No new pixel or code needed — leverages existing GA4 ecommerce tracking
- Conversion value: actual order value (dynamic, already passed by Shopify → GA4)

---

## 7. Google Ads API Integration

A `google-ads-collector` agent will be built to match the existing collector pattern (ga4-collector, shopify-collector, gsc-collector).

### New files
```
agents/google-ads-collector/index.js   — daily snapshot collector
lib/google-ads.js                       — shared API client
data/snapshots/google-ads/YYYY-MM-DD.json
```

### Daily snapshot schema
```json
{
  "date": "2026-03-19",
  "spend": 9.87,
  "impressions": 412,
  "clicks": 18,
  "ctr": 0.0437,
  "avgCpc": 0.55,
  "conversions": 0,
  "conversionRate": 0,
  "costPerConversion": 0,
  "roas": 0,
  "revenue": 0,
  "campaigns": [...],
  "topKeywords": [...]
}
```

### API resources used for campaign creation
Campaign creation is a one-shot setup script (`scripts/create-google-ads-campaign.js`), separate from the daily collector. The collector only reads; the setup script writes. Resources created in order:

| Resource | API service | Notes |
|---|---|---|
| CampaignBudget | CampaignBudgetService | $10/day, shared=false |
| Campaign | CampaignService | Search, Manual CPC, US-only |
| AdGroup (×2) | AdGroupService | Coconut Lotion + Natural Body Lotion |
| AdGroupAd (×2) | AdGroupAdService | RSA per ad group |
| AdGroupCriterion (×12) | AdGroupCriterionService | Keywords with match types |
| CampaignCriterion (negative) | CampaignCriterionService | Negative keyword list |
| CampaignExtensionSetting | CampaignExtensionSettingService | Sitelinks, callouts, structured snippets |

All mutations use `GoogleAdsService.mutate()` with `partialFailure: true`. On partial failure, log the failed operations with their error details and continue — do not abort the entire setup.

### Prerequisites
1. **Verify `GOOGLE_ADS_TOKEN`** in `.env` — confirm the developer token is approved for Basic Access in Google Ads API Center (Tools → API Center). Test with a `listAccessibleCustomers` call before any further work.
2. **Update `scripts/reauth-google.js`** — add `https://www.googleapis.com/auth/adwords` to the `SCOPES` array and update the success message from "GSC + GA4 authorized" to "GSC + GA4 + Google Ads authorized"
3. **Re-run reauth script** — updates `GOOGLE_REFRESH_TOKEN` in `.env` with adwords scope
4. **Add `GOOGLE_ADS_CUSTOMER_ID`** to `.env` (10-digit account ID, no dashes, from Google Ads UI top-right)

### Data lag handling
Google Ads reporting lags 24–48 hours; conversion data (imported from GA4) can lag up to 72 hours. The collector defaults to `date = yesterday` (same reasoning as the GSC collector). Running for "today" will always show 0 or understated conversions.

### Integration into CRO analyzer
`agents/cro-analyzer/index.js` currently loads four snapshot sources (Clarity, Shopify, GSC, GA4). Add Google Ads as a fifth:
- Add `GOOGLE_ADS_DIR` constant pointing to `data/snapshots/google-ads/`
- Add a `loadRecentSnapshots('google-ads')` call alongside the existing four
- Add a `## Google Ads Performance` named block to the user message passed to Claude, containing spend, ROAS, clicks, CVR, and top keywords
- Update the system prompt to describe the Google Ads data source

### Integration into dashboard
In `agents/dashboard/index.js`:

**KPI strip** — add two new KPI cards to the existing strip (following the same `{ label, value, subtext }` pattern as the current cards):
- `{ label: 'Ad Spend', value: '$X.XX', subtext: 'of $10.00/day' }`
- `{ label: 'ROAS', value: 'X.XXx', subtext: 'paid search' }`

**New "Paid Search" tab** — add a tab named `Paid Search` alongside the existing tabs (SEO, CRO, etc.). The tab contains two cards:
- **Campaign Overview card**: spend today, clicks, CTR, avg CPC, conversions, CVR, ROAS — sourced from `data/snapshots/google-ads/YYYY-MM-DD.json`
- **Top Keywords card**: table of top 5 keywords by conversions, showing keyword text, match type, clicks, CVR, CPC, Quality Score

Load the Google Ads snapshot using a new `GOOGLE_ADS_SNAPSHOT_DIR` constant (following the pattern of `GA4_SNAPSHOT_DIR`, `SHOPIFY_SNAPSHOT_DIR`). The snapshot is read via the existing `loadLatestSnapshot(dir)` helper.

---

## 8. Success Metrics

### Primary KPIs

| Metric | Days 1–30 Target | Days 31–60 Target |
|---|---|---|
| CTR | ≥ 3% | ≥ 4% |
| Avg CPC | ≤ $0.80 | ≤ $0.75 |
| Conversion Rate | ≥ 1.5% | ≥ 2.0% |
| Cost per Purchase | ≤ $20 | ≤ $15 |
| ROAS | ≥ 1.1x | ≥ 1.5x |
| Monthly revenue from paid search | ≥ $150 | ≥ $250 |

### Break-even Analysis
- CVR baseline: 2.64% (lotion product page)
- AOV: $22 (lotion price)
- **Revenue break-even CPC: $0.58** (`0.0264 × $22`)
- Max CPC target: $0.80 (allows ~38% margin above revenue break-even for learning inefficiency)
- Note: $0.58 is revenue break-even, not margin break-even. Actual profit break-even is lower once COGS and Shopify transaction fees (2–3%) are accounted for. The Phase 1 goal is data acquisition, not profitability.
- Days 1–30 revenue target of ≥$150 on $300 spend = 50% ROAS — this is intentionally below break-even and acceptable during the learning phase.

---

## 9. Optimization Plan

### 30-Day Triggers

| Condition | Action |
|---|---|
| Keyword CTR < 1% after 100 impressions | Pause, add variant |
| Keyword CPA > $25 after 5 conversions | Lower bid 15% |
| Ad group CVR < 1% after 50 clicks | Test new headlines or landing page variant |
| Mobile CPA < desktop CPA (confirmed) | Increase mobile bid adj to +50% |
| 15+ conversions attributed to this campaign | Switch Manual CPC → Target ROAS at 150% |
| Any keyword Quality Score ≤ 4 | Rewrite ad copy, consider dedicated landing page |

### 60-Day Expansion Triggers

| Condition | Action |
|---|---|
| ROAS > 1.5x sustained on lotion | Duplicate campaign for coconut oil deodorant, $5/day each |
| Starter Set page fully built | Add as third ad group, $2/day test |
| Any keyword QS ≥ 8 + CVR > 3% | Raise bid, push for position 1–2 |

---

## 10. Implementation Sequence

1. **Verify `GOOGLE_ADS_TOKEN`** — confirm developer token is approved for Basic Access (Google Ads UI → Tools → API Center); run `listAccessibleCustomers` test call
2. **Add `GOOGLE_ADS_CUSTOMER_ID`** to `.env` (from Google Ads UI)
3. **Update `scripts/reauth-google.js`** — add adwords scope to `SCOPES` array; update success message string
4. **Re-run `scripts/reauth-google.js`** — updates `GOOGLE_REFRESH_TOKEN` in `.env` with adwords scope
5. **Build `lib/google-ads.js`** — OAuth client, `listAccessibleCustomers`, reporting queries, mutate wrapper with `partialFailure: true` handling
6. **Build `agents/google-ads-collector/index.js`** — daily snapshot, defaults to yesterday's date
7. **Build `scripts/create-google-ads-campaign.js`** — one-shot campaign creation: budget → campaign → ad groups → RSAs → keywords → negatives → extensions
8. **Run campaign creation script** — creates `RSC | Lotion | Search` in Google Ads
9. **Import GA4 conversion** into Google Ads (Google Ads UI → Tools → Conversions → Import from GA4)
10. **Wire into cro-analyzer** — add Google Ads as fifth snapshot source with dedicated prompt block
11. **Wire into dashboard** — add Paid Search panel with spend, ROAS, CTR, top keywords
12. **Add cron entry** — `google-ads-collector` runs daily alongside existing collectors
