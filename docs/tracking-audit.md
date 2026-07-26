# Tracking audit — gate 1 before paid traffic

Measured 2026-07-26 against the live site, the Shopify theme, the GA4 Admin API and the Google Ads API. This is gate 1 of `Tracking → CRO → Offer/AOV → Traffic`: until it's right, no ad result can be read.

Reproduce with the queries in section 6.

---

## 1. What's actually on the page

Identical on the homepage, a PDP and a collection page — so it's site-wide, not template-specific:

| Tag | Occurrences | Type |
|---|--:|---|
| `G-PYV4WG2QL8` | 12 | GA4 |
| `G-12BJ5N9FNX` | 8 | GA4 |
| `AW-10923654107` | 7 | Google Ads |
| `GT-TBVN96Q` | 1 | Google Tag container |
| `MC-FJPZDQBF71` | — | Merchant Center |

**All of it comes from one source:** the Shopify Google & YouTube channel app (`id: 390103210`), whose config carries `google_tag_ids: ["G-PYV4WG2QL8","GT-TBVN96Q","G-12BJ5N9FNX"]`.

**Correction to the prior record.** An earlier audit recorded that GA4 `…QL8` double-fires via "the channel integration plus a hardcoded theme gtag." That is wrong. All 241 liquid/js theme assets were scanned: **there is no hardcoded Google tag or `gtag(` call anywhere in the theme.** The duplication is two GA4 properties listed in one integration — which matters, because the fix is a channel setting, not a theme edit.

## 2. `G-12BJ5N9FNX` is still an active event destination

Re-verified 2026-07-26 02:53 UTC with a cache-busted request returning `cf-cache-status: DYNAMIC` — a fresh origin response, not a CDN copy. Sean removed this property on Google's side earlier the same day; **the Shopify channel config did not follow.**

The ID appears in two distinct functional roles:

1. In **`google_tag_ids`** — the array gtag initializes.
2. As an **`action_label` destination** on seven events: `search`, `begin_checkout`, `view_item`, **`purchase`**, `page_view`, `add_payment_info`, `add_to_cart`.

The second is what matters. This is not a stale identifier parked in a list — it is a live recipient. A purchase currently routes to `G-PYV4WG2QL8`, `AW-10923654107/C8Az…`, `MC-FJPZDQBF71` **and** `G-12BJ5N9FNX`.

**Removing a property in GA4, or unlinking a destination from the Google Tag (`GT-TBVN96Q`), does not rewrite Shopify's `google_tag_ids`.** They are separate systems. The fix belongs in **Shopify admin → Sales channels → Google & YouTube → Settings**, which is what emits config blob `id: 390103210`.

**Open question, and it changes the severity:** whether `G-12BJ5N9FNX` still exists as a property.

- If it was deleted — the tag still loads and still issues requests, but they land nowhere. Noise and wasted requests, no double-counting.
- If it still exists — every event is counted twice.

This cannot be answered while the GA4 Admin API is disabled (section 5), which is what makes enabling it the highest-value click available.

We report on property `358754048` (`GOOGLE_ANALYTICS_PROPERTY_ID`); which measurement ID maps to it is blocked by the same thing.

## 3. Verdict: tracking is imperfect, not broken

This section was rewritten twice. Both earlier versions overstated the problem; this one is measured against GA4 event data and Shopify orders directly.

**GA4 is recording purchases.** Last 30 days, property `358754048`:

| | Orders | Revenue |
|---|--:|--:|
| GA4 `purchase` events | 7 | $417.80 |
| Shopify actual | 13 | $723.45 |

The gap is explained, not mysterious:

| Source | Orders | Fires a browser `purchase`? |
|---|--:|---|
| `web` checkout | 9 | yes |
| `3890849` (channel) | 2 | unclear |
| `subscription_contract_checkout_one` | 2 | **no — billed server-side** |

**~78% capture on browser orders (7 of 9)** is within the normal range for GA4 — ad blockers, ITP, and consent gating routinely cost 10–30%. It is not evidence of misconfiguration.

**Recurring subscription orders are a permanent blind spot.** They are charged server-side and never fire a client event, so GA4 will always under-report by roughly the subscription share of orders (2 of 13 here, ~15%). This is by design, not a bug — but it means **GA4 revenue must never be treated as truth.** Use Shopify orders, as [`bundle-marketing-plan.md`](./bundle-marketing-plan.md) §5 does.

### The Ads conversion chain is correctly configured

| Action | Role | Source | Value | Ads label |
|---|---|---|---|---|
| `purchase` | **PRIMARY** | GA4 import | actual | none — GA4-sourced |
| `Purchase (2)` | secondary, not in Conversions | Website tag | actual (fixed 2026-07-26) | `8ETb…` |

The primary action imports from GA4 and needs no page label, so the dead labels in section 3a below **do not affect the metric campaigns bid on.**

`Purchase (2)` previously forced a $1 value; corrected to actual value on 2026-07-26 and verified via the API. It is secondary with `include_in_conversions_metric = false`, so it is observation-only.

**Zero ad conversions in 30 days is expected, not alarming.** Ads counts only ad-attributed orders. 27 clicks at a 0.82% conversion rate predicts ~0.2 orders. The 13 organic orders would never appear.

### 3a. Real but lower-priority: dead page labels

The Shopify Google & YouTube channel still emits the old Google Shopping app's conversion labels, all of which are REMOVED in Ads:

| Site event | Label | Action | Status |
|---|---|---|---|
| `purchase` | `C8AzCJD3p5gY…` | Google Shopping App Purchase | REMOVED |
| `page_view` | `ACDHCJP3p5gY…` | Google Shopping App Page View | REMOVED |
| `view_item` | `KdHwCJb3p5gY…` | Google Shopping App View Item | REMOVED |
| `add_to_cart` | `gxmTCJz3p5gY…` | Google Shopping App Add To Cart | REMOVED |
| `begin_checkout` | `p8rcCJ_3p5gY…` | Google Shopping App Begin Checkout | REMOVED |
| `add_payment_info` | `crWqCKL3p5gY…` | Google Shopping App Add Payment Info | REMOVED |
| `search` | `M484CJn3p5gY…` | Google Shopping App Search | REMOVED |

Conversions sent to a removed action are discarded — but since no enabled action depends on these, the practical cost is wasted requests and a misleading page, not lost measurement. Worth cleaning by reconnecting the channel; **not a blocker for spending.**

### 3b. Cleanup items

- `CrossFit1873 - GA4 (web) purchase` (HIDDEN) still exists in the Ads account. Deleting the Google *tag* on 2026-07-26 did not remove the Ads *conversion action* — separate systems, the same lesson as `google_tag_ids`.
- `G-12BJ5N9FNX` and a stale `GT-TBVN96Q` remain in Shopify's `google_tag_ids` (the admin shows `GT-PHR6R7H`). Both are initialized but receive no events since Sean's 2026-07-26 cleanup.
- `begin_checkout` forces a value of $0. Harmless — it is excluded from Conversions — but wrong if it is ever promoted.
- 16 REMOVED conversion actions are legacy clutter.

### What this means for spending

**The gate is passable.** The primary conversion action is correctly wired to GA4 with actual values, GA4 is capturing browser purchases at a normal rate, and the known undercount is understood and quantified.

Two standing rules follow from the measurement, and they matter more than the cleanup:

1. **Judge revenue on Shopify orders, never GA4.** GA4 will read ~20% low on browser orders and miss subscriptions entirely.
2. **Expect Ads-reported conversions to lag Shopify.** Ads sees only ad-attributed, GA4-captured orders — roughly 78% of the browser subset. A campaign showing 1 conversion may well have produced 1.3.

## 5. Blocker

**Google Analytics Admin API is not enabled** in Cloud project `729233344313`. The `analytics.readonly` scope *is* granted; the API is simply switched off, so `accountSummaries` and `dataStreams` return 403. Until it's enabled we cannot map a measurement ID to a property, and therefore cannot say which GA4 tag is ours and which is the stray.

Enable at `console.developers.google.com/apis/api/analyticsadmin.googleapis.com/overview?project=729233344313`. One click, and it makes this audit reproducible rather than manual.

## 6. Reproduce

```bash
# tags on the live page
curl -sL https://www.realskincare.com/ | grep -oE "G-[A-Z0-9]{6,12}|AW-[0-9]{9,12}|GT-[A-Z0-9]{6,12}|MC-[A-Z0-9]{6,12}" | sort | uniq -c

# conversion actions and their value settings
# SELECT conversion_action.name, conversion_action.status, conversion_action.type,
#        conversion_action.primary_for_goal, conversion_action.value_settings.default_value,
#        conversion_action.value_settings.always_use_default_value
# FROM conversion_action
```

Note: `conversion_action` supports `metrics.all_conversions` / `all_conversions_value` only — selecting `metrics.conversions` against it returns `PROHIBITED_METRIC_IN_SELECT_OR_WHERE_CLAUSE`. And `LAST_90_DAYS` is not a valid GAQL date literal; `LAST_30_DAYS` is.

## 7. Fix list, in order

1. **Enable the GA4 Admin API** (Sean, one click) — unblocks identifying the stray property.
2. **Identify which GA4 property is ours**, then remove the other from the Google & YouTube channel config. Shopify admin → Google & YouTube → settings. Not a theme edit.
3. **Set `Purchase (2)` to use actual order value, or disable it.** Given `purchase` is already primary and GA4-sourced, disabling is cleaner — two purchase actions on one store is the problem, not the value setting alone.
4. **Investigate the CrossFit conversion action** before trusting historical Ads data.
5. **Place one real test order** and confirm exactly one purchase conversion fires at the correct value. Nothing above counts as verified until this passes.
6. Optionally tidy the 16 REMOVED actions.

Only after 5 passes should paid traffic scale.
