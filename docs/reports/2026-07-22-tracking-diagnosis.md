# Tracking Diagnosis — realskincare.com (Phase 0 Task 3)

**Date:** 2026-07-22
**Tools:** `scripts/verify-tracking-beacons.mjs` (consent-aware Puppeteer beacon check), `scripts/ga4-conversion-events.mjs` (GA4 key-events breakdown), `scripts/growth-scoreboard.mjs` (GA4↔Shopify reconciliation).

## TL;DR

The pixels are **not broken at the network level** — the earlier "aborted beacons" were a headless artifact. The real tracking failure is a **conversion-definition** problem plus a **purchase-capture gap**, both in GA4 / Google Ads:

- GA4 reports **75 "conversions" / 30d**, but only **7** are `purchase`. The other 68 are `add_to_cart` (46), `begin_checkout` (21), `add_payment_info` (1) — all marked as **key events**.
- Actual Shopify orders same window: **13**. So GA4 also **under-captures purchases** (7 tracked of 13 real ≈ 54%).
- Net: any Google Ads optimization on "conversions" is optimizing toward **add-to-carts**, at a value/volume that is simultaneously **inflated 10× (by cart events) and undercounted on real sales**. This is the mechanism behind "past Google Ads lost money on broken tracking."

## Evidence

### Beacons fire (consent-aware check, `verify-tracking-beacons.mjs`)
Site is US-default (`shouldShowGDPRBanner: false`, tracking allowed; consent not the gate). Measured by HTTP status:
- **Google Ads (conversion + remarketing): fired 13, aborted 0, status 200/302** ✅
- **GA4 `g/collect`: status 204** ✅ · **GTM 200** ✅ · **TikTok 200** ✅ · **Clarity 200** ✅
- Shopify monorail shows some 401/aborts on `/sf_private_access_tokens` + `sendBeacon` unload pings — Shopify-internal, normal.
- The `net::ERR_ABORTED` counts in the console-error capture were `sendBeacon`/ping/unload requests Chrome labels aborted even though they deliver — **not** real failures.

### GA4 key-events breakdown (`ga4-conversion-events.mjs`, 30d)
```
keyEvents  eventCount  eventName
      46          46  add_to_cart      <- inflates "conversions"
      21          21  begin_checkout   <- inflates "conversions"
       7           7  purchase         <- the only real conversion
       1           1  add_payment_info <- inflates "conversions"
       0         314  view_item
TOTAL keyEvents: 75   (vs 13 Shopify orders)
```

### Reconciliation (`growth-scoreboard.mjs`, 30d)
2,059 sessions · 13 Shopify orders · GA4 75 "conversions" · **overcount 5.77×** · true CVR 0.63%.

## Fixes (Task 3) — for Sean, platform config

1. **Fix the conversion definition (GA4):** Admin → Events → Key events. **Unmark** `add_to_cart`, `begin_checkout`, `add_payment_info` as key events. Keep **only `purchase`**. (Keep the others as normal events for funnel analysis — just not "conversions.")
2. **Fix the Google Ads primary conversion:** set the **primary** conversion action = **purchase** (GA4 purchase import or the gtag/server purchase), with cart/checkout as **secondary** (observation only). Never let Ads bid toward a secondary.
3. **Close the purchase-capture gap (7→13):** enable server-side / enhanced purchase tracking so all real orders are counted at correct value:
   - Google: **Enhanced Conversions** + confirm the Shopify **Google & YouTube** channel is sending server-side purchase with value.
   - Meta: **Conversions API** (dedupe with browser via `event_id`).
   - This raises tracked purchases toward parity with Shopify orders.
4. **Verify convergence:** re-run `node scripts/growth-scoreboard.mjs`. Target: GA4 "conversions" ≈ Shopify orders (**overcount → ~1.0×**). That is the Phase-0 tracking gate.

## Google Ads side (`ga-conversion-actions.mjs`) — TWO more problems

Conversion actions (live pull 2026-07-22):
```
primary=true  [ENABLED] PURCHASE       "purchase"                       (GA4 import) OK
primary=false [HIDDEN]  PURCHASE       "CrossFit1873 - GA4 web purchase" leftover (wrong GA4 property once linked)
primary=false [ENABLED] BEGIN_CHECKOUT "begin_checkout"
primary=false [ENABLED] ADD_TO_CART    "add_to_cart"
primary=true  [ENABLED] PURCHASE       "Purchase (2)"                   (WEBPAGE tag) <-- DUPLICATE
```
Customer conversion goals (biddable = counts toward Smart Bidding):
```
biddable=true  PURCHASE          OK
biddable=true  BEGIN_CHECKOUT    <-- Ads is bidding on checkout-starts
biddable=-     ADD_TO_CART / PAGE_VIEW / DEFAULT
```

**Problem A — Ads bids on `begin_checkout`.** The BEGIN_CHECKOUT goal is biddable, so Smart Bidding optimizes toward checkout starts, not sales — independent of the GA4 key-event fix.
**Problem B — purchases double-count.** Two `primary=true` PURCHASE actions fire on the same order (`"purchase"` GA4 import **and** `"Purchase (2)"` webpage tag), so every sale is counted twice in the conversions column.

### Fixes (Google Ads → Goals → Conversions)
1. Set the **BEGIN_CHECKOUT** conversion goal to **Secondary** (remove biddable). Only Purchase biddable.
2. Keep **one** primary purchase action — recommend `"purchase"` (GA4, carries value + Enhanced Conversions) — and set **`"Purchase (2)"`** (webpage) to **Secondary**.
3. Optional: remove the HIDDEN `CrossFit1873` leftover action.
4. Re-run `node scripts/ga-conversion-actions.mjs` to confirm: exactly one primary PURCHASE, no biddable non-purchase goal.

## Reproduce
- `node scripts/verify-tracking-beacons.mjs [url]`
- `node scripts/ga4-conversion-events.mjs [days]`
- `node scripts/ga-conversion-actions.mjs`
- `node scripts/growth-scoreboard.mjs [days]`
