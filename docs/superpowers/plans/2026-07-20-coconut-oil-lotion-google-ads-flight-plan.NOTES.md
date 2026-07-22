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
   ✅ **DONE 2026-07-21** — **two** single-product campaigns, PAUSED, SHOPPING,
   TARGET_SPEND (Max Clicks), MC 729030085/US, each scoped to one item_id (that
   variant included, all else excluded, $0.40 bid). Budget split enforces Sean's
   60/40 (Standard Shopping budgets are campaign-level; one campaign per product
   is the only way to hold a budget %):
     - **`24060021778`** "…Lotion - Pure Unscented" — **$6/day (60%)** — item
       `shopify_US_7691181686954_45828179165354`
     - **`24050427048`** "…Lotion - Coconut Breeze" — **$4/day (40%)** — item
       `shopify_US_7691181686954_44414530781354`
   Built by `scripts/create-shopping-test-campaign.mjs` (idempotent; loops
   `PRODUCTS`; `campaign-creator` is Search-only so hand-built). *(Earlier builds:
   all-products 24055192055, then all-lotion 24055379690 — both replaced.)*
3. **Sean (NEXT):** review the two paused campaigns in Google Ads, then **enable**.
4. Defuse the `Purchase (2)` landmine (`conversionActions/7556810073`) before any
   move to conversion/value bidding. Add more scents/products as data supports.

### Gate revision (Sean, 2026-07-21) — supersedes the plan's 2× rule

**~1× ROAS is a win, not the floor.** Priority is generating revenue and *evolving
the campaign as data comes in*, not hitting 2× out of the gate. So:
- **Don't auto-pause at 1.2×.** Keep spending while it produces sales at ~1×+.
- Pause only on genuinely dead spend (meaningful clicks, ~0 conversions / far
  below 1×) — a "this product/scent/term doesn't work," not a ROAS-target miss.
- The bet is acquisition + LTV: at ~1× the first order roughly breaks even on ad
  cost (a loss after COGS/fees), and pays off via repeat purchase — so the live
  post-purchase / email-SMS flow is what makes 1× rational. Keep it healthy.
- Scale winners gradually; refine by search-term/product report, not a fixed
  ROAS threshold. Revisit a higher target later once there's a conversion base.

Audit scripts (scratchpad, session 08ea6f2a): `audit-conversion-tracking.mjs`,
`ga4-purchases.mjs`.
