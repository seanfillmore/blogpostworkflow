# Sensitive Skin Set — Google Ads Validation Test

**Date:** 2026-05-09
**Product:** Sensitive Skin Moisturizing Set (`/products/sensitive-skin-starter-set`)
**Goal:** Validate whether the PDP and offer convert paid Google Search traffic. Binary read at day 21: scale, kill, or extend.

## Goal & success criteria

- This is a **validation test**, not a scaling campaign. Smallest spend that produces a defensible signal.
- Single Google Search campaign, single ad group, single landing page.
- Final URL: `https://www.realskincare.com/products/sensitive-skin-starter-set`
- Budget: **$12/day for 21 days = $252 total**.
- **Kill criteria:** ≥5 purchases at ≤$50 CPA over 21 days.
- The PDP is brand-new (launched 2026-05-09) — paid traffic is the only traffic source, so all signals are attributable to ads.

## Architectural decisions

These were the key forks; capturing them so future-me knows why the design landed where it did.

| Decision | Chose | Rejected | Why |
|---|---|---|---|
| Goal framing | Validation (D) | Direct ROAS, subscription LTV, awareness-combo | Page just launched; need binary read on whether page+offer converts at all before scaling. |
| Success metric | Conversion-count threshold | ROAS-only, leading-indicators-only, hybrid | Cleanest binary verdict. Leading indicators captured separately for diagnosis, not as kill criteria. |
| Threshold | ≥5 purchases at ≤$50 CPA | ≥5 at ≤$30 (original) | DataForSEO showed real CPCs run ~$1.05 blended (vs initial $0.80 estimate). At $12/day for 21 days, $30 CPA cap requires ≥9 purchases — too strict for cold paid to a new PDP. $50 CPA is profitable on subscription LTV. |
| Daily budget | $12/day | $7/day, $25/day | $7 yielded math-impossible thresholds at real CPCs. $12 gives ~240 clicks → 2.1% CVR needed for 5 conversions — achievable. |
| Channel | Google Search only (NOT Search Network partners) | Performance Max, Shopping, partners | Validation needs causality. PMax/Shopping obscure attribution; partners cheapen traffic. |
| Bidding | Manual CPC, Enhanced CPC OFF | Maximize Conversions, Target CPA | Manual is the only honest bid strategy at $252 spend — automated strategies need 50+ conversions to learn. |
| Ad-group structure | Single ad group, Format angle only | Symptom (eczema) ad group, both ad groups | PDP doesn't say "eczema" — running eczema ads to a sensitive-skin page creates message-mismatch and tanks CVR. Hold the eczema search demand for Phase 2 with a dedicated landing page. |
| Two-product test | Single test (Set only) | Run parallel Set + Coconut Lotion campaigns, sequential, page-level A/B with Intelligems | User chose to keep validation focused — visitors who want a single product can navigate from the Set PDP. |
| Tracking template | Append UTMs at campaign level | UTMs in each ad URL, no UTMs (gclid only) | Clarity reads URL not gclid; UTMs let us filter Clarity to paid-only sessions for the mid-test audit. |

## Campaign-level configuration

| Setting | Value |
|---|---|
| Name | `RSC \| Sensitive Skin Set \| Search \| Validation` |
| Channel | Google Search only (Search Network partners OFF, Display Network OFF) |
| Geo | United States only, presence-based |
| Language | English |
| Bidding | Manual CPC, Enhanced CPC OFF |
| Daily budget | $12 |
| Schedule | 24/7, no day-parting |
| Mobile bid adjustment | 0% |
| Status at launch | ENABLED (override agent default of PAUSED after dry-run review) |
| Final URL | `https://www.realskincare.com/products/sensitive-skin-starter-set` |
| Tracking template | `{lpurl}?utm_source=google&utm_medium=cpc&utm_campaign=sensitive-skin-set-validation&utm_content={adgroupid}&utm_term={keyword}` |

## Ad group: "Sensitive Skin Set — Format"

**Max CPC:** $1.40 (caps the most expensive keyword `paraben free body lotion` at $2.18 DataForSEO CPC)

### Keywords

| Keyword | Match | Vol/mo | DFS CPC | Bid range |
|---|---|---|---|---|
| `fragrance free body lotion` | PHRASE | 3,600 | $0.82 | $0.20–$2.80 |
| `fragrance free lotion for sensitive skin` | PHRASE | 2,900 | $1.18 | $0.38–$2.75 |
| `unscented body lotion` | PHRASE | 1,300 | $0.91 | $0.16–$2.75 |
| `unscented lotion for sensitive skin` | EXACT | 320 | $0.85 | $0.53–$2.81 |
| `paraben free body lotion` | EXACT | 720 | $2.18 | $0.35–$2.75 |

### RSA — Headlines (12, all ≤30 char)

1. Fragrance-Free Body Lotion
2. Pure Unscented. Pure Clean.
3. Zero Fragrance. Zero Parabens.
4. Unscented Lotion + Cream Set
5. For Fragrance-Sensitive Skin
6. No Mineral Oil. No Lanolin.
7. Light Lotion + Night Cream
8. Coconut Oil & Organic Jojoba
9. Handmade in the USA
10. 30-Day Money-Back Guarantee
11. From $0.55 a Day, 12-Wk Supply
12. Truly Unscented, Not Masked

### RSA — Descriptions (4, all ≤90 char)

1. Pure Unscented body lotion + overnight cream. No fragrance — not even masking scents.
2. Cold-pressed coconut oil + jojoba. Paraben-free, lanolin-free, mineral oil-free.
3. Two-step daily + nightly routine for sensitive, fragrance-reactive skin. Handmade USA.
4. Approx $0.55/day. Subscribe & get free lip balm + bar soap with your first order.

## Negative keywords (campaign-level, all PHRASE match)

**Wrong intent:** `free`, `coupon`, `cheap`, `discount code`, `recipe`, `homemade`, `how to make`, `diy`, `prescription`

**Wrong product:** `face`, `face lotion`, `hand cream`, `baby`, `baby lotion`, `tattoo`, `body wash`, `bar soap`, `essential oil`

**Wrong purchase channel:** `amazon`, `walmart`, `target`, `cvs`, `costco`, `sephora`, `ulta`

**Competitor brands** (brand-modified queries won't convert to us): `aveeno`, `cerave`, `cetaphil`, `eucerin`, `lubriderm`, `vaseline`, `vanicream`, `gold bond`, `nivea`

**Symptom-keyword block** (PDP doesn't address these conditions, so block them from triggering on long-tail variations): `eczema`, `psoriasis`, `dermatitis`, `rosacea`

**B2B / wrong relationship:** `wholesale`, `bulk`, `distributor`, `near me`, `samples`

## Conversion tracking

### Primary conversion (drives kill-criteria measurement)

- GA4 `purchase` event → imported in Google Ads as primary conversion
- Counts: every purchase

### Secondary conversions (visible in reports, do NOT drive bidding)

- `add_to_cart`
- `begin_checkout`
- `view_item`

### Pre-launch checks (gate before flipping campaign to ENABLED)

- [ ] GA4 `purchase` event firing on `/checkouts/.../thank_you` (test order)
- [ ] Google Ads ↔ GA4 link active in Linked Accounts
- [ ] `purchase` imported as primary conversion in Google Ads
- [ ] `add_to_cart`, `begin_checkout`, `view_item` imported as secondary
- [ ] Auto-tagging ON (default; verify)
- [ ] Server check passes for `?utm_source=google...` URL — already verified 2026-05-09 (HTTP/2 200, no redirect)
- [ ] Browser render check (incognito, paste full UTM+gclid URL, confirm UTMs persist + page renders + no console errors)
- [ ] Clarity recording active on the PDP (visit page incognito; confirm session in Clarity dashboard within 30 min)
- [ ] Phase 0 PDP micro-audit complete (1-paragraph review of H1 + above-fold copy alignment to "fragrance free body lotion" intent — flag specific edits if needed)

## Phased timeline

| Phase | When | What happens |
|---|---|---|
| **Phase 0 — Prep** | Day -3 to Day 0 | Code work (lib/clarity URL filter, campaign-creator trackingUrlTemplate field). Build campaign JSON. PDP micro-audit. Pre-launch checklist. |
| **Phase 1 — Launch** | Day 0 | Push campaign via `campaign-creator` (PAUSED), verify in Ad Preview & Diagnosis, flip to ENABLED. Record start timestamp. |
| **Phase 2 — Quiet period** | Days 1–4 | No touching. Daily 30-second glance: spend pacing, no disapprovals, click volume ~10/day. Sample too small for any optimization. |
| **Phase 3 — Clarity audit + ONE adjustment** | Days 5–7 | Run mid-test report script. If signals show fixable leaks, make ONE PDP tweak and timestamp it. |
| **Phase 4 — Mid-test monitoring** | Days 7–14 | Daily glance. Weekly check: any keyword burning >$30 with 0 conv → pause it. No copy/layout changes — let Phase 3 fix breathe. |
| **Phase 5 — Final stretch** | Days 14–20 | Same cadence. Day 18: project final outcome at current pace vs kill criteria; if trending INCONCLUSIVE, draft an extension plan. |
| **Phase 6 — Verdict** | Day 21 | Pull final report. Apply kill criteria. Write verdict + scale/kill/extend plan. |

## Phase 3 mid-test audit

### Quantitative — `node scripts/sensitive-skin-set-mid-test-report.js`

New script that pulls and combines:
- **Clarity** (URL-filtered, paid-only via UTM): avg scroll depth, rage-click %, dead-click %, quickback %, time on page
- **GA4** (sessions where `utm_source=google`): ATC rate, begin_checkout rate, purchase rate, revenue
- **Google Ads**: impressions, clicks, CTR, avg CPC, conversions, spend

Output: markdown report at `data/reports/sensitive-skin-set-validation/day-N.md`

### Qualitative — Clarity dashboard, manual (~30 min, you)

- Filter to URL = `/products/sensitive-skin-starter-set` AND `utm_source=google`
- Watch **10–15 session recordings**, biased toward sessions with engagement (didn't bounce <5s) but no purchase
- Pull the **scroll heatmap** — where does the bottom 50% fall off?
- Pull the **click heatmap** — any dead clicks on non-clickable elements?

### Adjustment criteria (what triggers a PDP fix)

| Signal | Threshold | Action |
|---|---|---|
| Avg scroll depth on paid sessions | <40% | Hero/above-fold not earning the scroll — rework H1 or hero copy |
| Quickback % (click ad → bounce <5s) | >25% | Strong message-mismatch signal — ad copy and PDP H1 disagree |
| Dead clicks on non-CTAs | >5% sessions | Visual confusion — make the actual CTA more obvious |
| Add-to-cart rate on paid sessions | <2% | Offer/price isn't landing — tweak offer presentation, NOT page structure |
| All signals look fine but conversions <2 | — | No fix; let it run |

**Rule:** make ONE change, not a bundle. We need to attribute any post-change CVR delta to a specific cause.

## Code work needed (Phase 0)

### 1. Extend `lib/clarity.js`

Add URL-filter support to `fetchClarityInsights()`:
- New signature: `fetchClarityInsights({ url = null, numOfDays = 1 } = {})`
- When `url` is set, append `dimension1=URL&dimension1Value=<urlencoded path>` to the API request
- Backward-compatible: no args → same site-wide aggregate as today
- Reusable for any future PDP audit

### 2. Extend `agents/campaign-creator/index.js`

Extend `buildCampaignOperation()` to accept and emit `trackingUrlTemplate`:
- Add optional `trackingUrlTemplate` field to the campaign create object
- Single-line addition + one test update in `tests/agents/campaign-creator.test.js`

### 3. New `scripts/sensitive-skin-set-mid-test-report.js`

Composes calls to extended `lib/clarity.js`, `lib/ga4.js`, `lib/google-ads.js`. Outputs markdown to `data/reports/sensitive-skin-set-validation/day-N.md`. ~80 lines.

### 4. Build `data/campaigns/2026-05-09-sensitive-skin-set-search-validation.json`

The campaign proposal file in the schema validated by `campaign-creator`. Hand-built using the spec sections above. Status: `approved` once Sean signs off; `approvedBudget: 12`.

## Day 21 verdict report

Final markdown report at `data/reports/sensitive-skin-set-validation/final.md`:
- Total spend, clicks, CPC, conversions, CPA, ROAS
- Leading-indicator breakdown (CTR, ATC rate, checkout rate)
- Clarity behavior summary across the 21 days (scroll depth, dead/rage clicks)
- Verdict against kill criteria + recommended next move. Every outcome maps to exactly one band:

| Outcome at end of Day 21 | Verdict | Action |
|---|---|---|
| ≥5 purchases AND CPA ≤ $50 | **WIN** | Scale plan — 2× budget, layer brand-alt or symptom keywords with new dedicated LPs |
| ≥5 purchases AND CPA $50.01–$70 | **INCONCLUSIVE — efficiency** | Targeted 1-week extension; tighten max CPC and/or pause the most expensive keyword |
| ≥5 purchases AND CPA > $70 | **KILL — too expensive** | Volume is there but unit economics don't work even on LTV; revisit with a lower-AOV product or a stronger offer |
| 3–4 purchases (any CPA) | **INCONCLUSIVE — volume** | Targeted 1-week extension with a specific PDP/copy change informed by Clarity |
| <3 purchases | **KILL** | Document root cause hypothesis — traffic quality, page, or offer? Use Clarity findings |
| <100 total clicks | **INCONCLUSIVE — sample too small** | Diagnose: keywords too narrow or CPCs higher than projected; either way, extend or rebuild |

## Out of scope (intentional)

- **Performance Max, Shopping, Display.** Validation needs causality; these obscure it.
- **Symptom (eczema) keyword angle.** Hold for Phase 2 with a dedicated eczema landing page; PDP doesn't address eczema explicitly.
- **A/B testing the page itself.** Decided against in favor of single-page, single-test simplicity. Reconsider after validation if the test is INCONCLUSIVE and we suspect page-level issues.
- **Coconut Lotion test.** Same — single-test focus. Revisit after Set test concludes.
- **Brand-alternative keywords** (`aveeno alternative`, etc.). Hold for post-validation scaling campaign.
- **Sequential or parallel two-product test.** Decided against — visitors can navigate to single products from the Set PDP if they prefer.
- **Google Ads Drafts & Experiments support in `campaign-creator`.** Worth building eventually but not for this test.
