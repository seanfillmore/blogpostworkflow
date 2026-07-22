# Google Ads flight plan — implementation notes & corrections

Companion to `2026-07-20-coconut-oil-lotion-google-ads-flight-plan.html`.
Data cross-check and decisions recorded **2026-07-21** (Sean + Claude).

## Correction to the plan's core premise

The flight plan's headline diagnosis — *"the account was blind, fix conversion
tracking in Week 0"* — is **wrong**. Cross-referencing three sources for
**Mar 1 – Jul 20 2026**:

| Source | Purchases | Revenue |
|---|---|---|
| Shopify (all orders, ground truth) | **87** | $4,026.89 (AOV **$46.29**) |
| GA4 (web-attributed) | 56 | $2,481.60 |
| GA4 → `google / cpc` (paid) | **1** | **$64** |
| Google Ads (tracked conversions) | **1** | **$64** |

The single Google Ads conversion is **accurate**: GA4 recorded exactly one
`google/cpc` purchase at $64 and Ads imported exactly that, with the **correct
value** ($64, not a default). The GA4→Ads pipeline works. The last run failed
because the **ads genuinely drove ~1 sale** from cold "body lotion" prospecting —
a real 0.23% CVR result, not a measurement gap.

Two further data corrections vs the plan's assumptions:
- **AOV is already ~$46**, not $30. The plan's whole "raise AOV to make 2×
  reachable" section is largely already true (bundles + subscriptions).
- **Store is small and organic-dependent**: ~0.6 orders/day; of 56 GA4 purchases,
  27 Organic / 17 Direct / several chatgpt.com / **1 Paid**. Paid must find
  *incremental* buyers, and that is a hard, slow grind at this size.

## Decisions (2026-07-21)

- **First test = Standard Shopping** (not PMax). PMax needs ~30 conv/mo to
  optimize; at ~1 paid conv/4.5mo it would flail. Standard Shopping is
  controllable/transparent at low volume; graduate to PMax later.
- **Budget = $10/day** (~$300/mo), Maximize Clicks (no ROAS target until a
  conversion base exists), US, built **paused** for review.
- Point at higher-AOV best-sellers (sets + top deodorant/lotion), not all 12 SKUs.

## Account facts found via Ads API (customer 5099369750)

- Merchant Center **729030085** linked (plus two broken `UNKNOWN`-type links).
  **Feed product-approval status unverified — check Merchant Center UI.**
- 16 paused legacy campaigns (5 PMax, 11 Search), some 2023-vintage; do NOT
  blindly resurrect (stale assets/pricing/budgets).
- Landmine: conversion action `Purchase (2)` (`conversionActions/7556810073`)
  is ENABLED + primary + `alwaysUseDefaultValue=true` default **$1**. Fires 0
  now. **Not a blocker for a Max-Clicks test** (Max Clicks ignores conversion
  values) — defuse (demote to non-primary) before switching to value bidding.
- Enhanced Conversions ON; customer-data terms accepted.

## Sequence

1. ~~**Sean (Merchant Center UI):** confirm products Approved & serving in MC
   729030085.~~ ✅ **DONE 2026-07-21** — 36/36 products Approved, 0 disapproved,
   "Top Quality Store". (Minor non-blocking nudges: "Return cost — Incomplete",
   descriptions missing on 10 products.)
2. ~~**Claude (Ads API):** build the paused $10/day Standard Shopping campaign.~~
   ✅ **DONE 2026-07-21** — campaign **`24055192055`** "RSC | Shopping Test | All
   Products", PAUSED, SHOPPING, TARGET_SPEND (Max Clicks), $10/day, MC
   729030085/US, ad group "All Products" → single all-products UNIT listing group
   ($0.30 bid). Built by `scripts/create-shopping-test-campaign.mjs` (idempotent;
   `campaign-creator` is Search-only so hand-built).
3. **Sean (NEXT):** review the paused campaign in Google Ads, then **enable** it.
4. Watch under the plan's 2× scale gate; defuse the `Purchase (2)` landmine
   (`conversionActions/7556810073`) before any move to conversion/value bidding.
   Refine product scope to best-sellers after the first product/search-term report.

Audit scripts (scratchpad, session 08ea6f2a): `audit-conversion-tracking.mjs`,
`ga4-purchases.mjs`.
