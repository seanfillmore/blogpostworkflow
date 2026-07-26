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

## 3. Google Ads conversion actions — 21, and the enabled ones conflict

Four are ENABLED:

| Name | Type | Category | Primary | Value |
|---|---|---|---|---|
| `purchase` | GA4 purchase | PURCHASE | **yes** | 1 |
| `Purchase (2)` | Webpage | PURCHASE | no | **FORCED $1** |
| `add_to_cart` | GA4 custom | ADD_TO_CART | no | 1 |
| `begin_checkout` | GA4 custom | BEGIN_CHECKOUT | no | FORCED $0 |

Two problems:

**Two purchase actions are live at once** — one GA4-sourced, one webpage-sourced. A single order can register against both.

**`Purchase (2)` has `always_use_default_value = true` with a default of $1.** Every purchase it records is worth exactly $1 regardless of the real order value. On a store with a $50.46 AOV that understates value ~50×, and any ROAS computed from it is meaningless. This is a strong candidate for the historical 0.19× ROAS being a measurement artifact rather than a performance result.

**A foreign conversion action is in the account:** `CrossFit1873 - GA4 (web) purchase`, GA4 purchase type, status HIDDEN. It belongs to an unrelated business. It isn't currently counting, but its presence means this Ads account has been linked to a third party's GA4 property — worth understanding before trusting any historical figure from this account.

The other 16 are REMOVED — legacy clutter from previous Shopping app installs, harmless but noisy.

## 4. What the last 30 days actually show

| Campaign | Status | Cost | Clicks | Conversions | Value |
|---|---|--:|--:|--:|--:|
| Shopping Test — Coconut Breeze | ENABLED | $17.38 | 16 | 0 | $0 |
| Shopping Test — Pure Unscented | PAUSED | $26.13 | 11 | 0 | $0 |

Zero conversions recorded across $43.51 and 27 clicks.

**This does NOT by itself prove tracking is broken, and shouldn't be reported as if it does.** At 27 clicks and a true 0.82% conversion rate, the expected number of orders is about 0.2. Observing zero is entirely unremarkable. The sample is far too small to distinguish "tracking is broken" from "27 clicks didn't produce a sale."

What *is* proven is structural: the duplicate GA4 properties, the two competing purchase actions, and the forced $1 value are real misconfigurations that would corrupt measurement the moment volume arrives. Fix them before spending, not after.

**The decisive test is a real transaction** — place a live order and confirm exactly one purchase conversion registers, with the correct value.

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
