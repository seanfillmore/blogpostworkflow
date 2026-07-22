# Replenishment Flow — Design Spec

**Date:** 2026-07-21
**Status:** Approved design → ready for implementation plan
**Owner:** SEO Claude Team (Klaviyo flows)

## Context & goal

Real Skin Care's biggest growth lever is retention, not traffic. From Shopify
orders (Jan–Jul 2026): **107 customers, 17.8% repeat rate, 1.23 orders/customer**,
yet repeat buyers already drive **45% of revenue**. The store's consumables (lotion,
soap, moisturizer, deodorant) get reordered on a **median 49-day / mean 62-day**
cycle, but there is no lifecycle message tied to that runout. The existing flow
timeline leaves an explicit gap:

- Day 0 **Post-Purchase** (onboarding) → Day 14 **Review/Cross-Sell** → **[gap]** →
  Day 75+ **Customer Winback** (lapsed).

The median reorder (day 49) sits squarely in that gap. This flow fills it: a timed
**replenishment** sequence that nudges one-time buyers to re-purchase — preferentially
by **converting them to a subscription** — before they lapse and before they drift to
Amazon or a competitor.

**Primary success metric:** 90-day repeat-customer rate, **17.8% today → 25%+** within
2–3 months. Secondary: subscription starts attributed to the flow.

## Scope (v1)

- **Channel:** email only. (SMS is a fast-follow, gated on confirmed SMS consent volume.)
- **Products:** all consumables, handled dynamically from the triggering order's line
  items (no per-product flows). Timing tuned to the dominant reorders
  (lotion/soap/moisturizer, ~7-week cycle).
- **Primary CTA:** Subscribe & Save (subscriptions are live on-site).
- **Two emails:** day 35 (no coupon), day 50 (fence-sitter push).

Out of scope for v1: SMS, per-category timing branches, dynamic unique-per-recipient
coupon codes, subscribe-&-save cadence changes (see Recommendations).

## Subscription facts (from the live PDP buy box, confirmed 2026-07-21)

- **Subscribe & Save = 15% off** (e.g., hero lotion $30.00 → **$25.50**).
- **Cadence:** monthly (default; "You will receive an order every month").
- **Copy:** "Never run out of moisture. Cancel anytime."
- One-time purchase: full price.
- Separate standing promo: "Buy 2 save 10%, Buy 3 save 20%" (auto-applied at checkout).

The 15% ongoing subscription discount is a **stronger** offer than the 10% one-time
coupon, so the flow leads with subscription and never lets the one-time coupon
undercut it.

## Trigger & enrollment

- **Trigger:** `Placed Order` metric (same metric Customer Winback uses).
- **Profile filter (flow filter):** *has not placed another order since starting the
  flow* — mirrors the Winback pattern. The moment a customer reorders (one-time or
  subscription), they exit and receive no further nudges.
- **Enrollment guard:** exclude orders whose line items are exclusively
  subscription/recurring (they're already subscribers) — a subscriber shouldn't get a
  "come back and reorder" email. Implemented as a profile/flow filter on the order's
  line items.

## Flow structure (tree — fits `scripts/flows` model)

```
Placed Order
  └─ delay 35 days ─▶ Email 1  "Running low on your {{ product }}?"  (Subscribe & Save primary, one-time reorder secondary; NO coupon)
       └─ delay 15 days (→ day 50) ─▶ Email 2  "Never run out 🥥"  (Subscribe & Save hero; RESTOCK10 10% one-time as fallback)
Flow filter exits anyone who reorders mid-flow. Non-actors age into Winback at day 75.
```

## Email specs

### Email 1 — day 35 — "Running low on your {{ product }}?"
- **Goal:** helpful reminder at the moment of runout; move to subscription.
- **Body:** "You picked up {{ product }} about 5 weeks ago — most folks are getting low
  around now." Reinforce the 6-clean-ingredients story and "Never run out of moisture."
- **CTAs:** **primary** = "Subscribe & Save 15% — never run out" (→ PDP subscribe
  option); **secondary** = "Reorder once" (→ PDP / prefilled cart).
- **No coupon.** The standing 15% subscription discount is the only incentive.

### Email 2 — day 50 — "Never run out 🥥" (only if no reorder)
- **Goal:** convert fence-sitters; still subscription-first.
- **Body:** lead with subscription value — 15% off every order, cancel anytime, never
  run out — plus gentle urgency ("your {{ product }} is probably empty by now").
- **CTAs:** **primary** = Subscribe & Save; **fallback** = one-time reorder with
  **`RESTOCK10`** (10% off) for those who won't subscribe. Framed so subscription
  (15% ongoing) clearly beats the 10% one-time.

## Personalization & reorder-link mechanics

- Product name(s) pulled from the triggering order's line items via Klaviyo event
  variables, rendered **in-template** (RSC flows are trees, not DAGs — personalize in
  the template, not via item-split branches). If multiple items, feature the primary
  consumable (first eligible line item).
- **Reorder / subscribe link:** deep-link to the product PDP by handle (e.g.
  `/products/coconut-lotion`) where the live subscribe widget renders. Prefilled-cart
  or direct-to-subscribe deep links are an enhancement, not v1.

## Incentive mechanics

- **Standing:** Subscribe & Save 15% (site-managed; no code needed).
- **`RESTOCK10`:** static 10% one-time code, Email 2 fallback only. Created once in
  Shopify Discounts. Dynamic unique-per-recipient codes (like `WINBACK25`) are a
  fast-follow to prevent sharing, not v1.

## Build approach

- New flow module: `scripts/flows/flows/replenishment.js`, exporting the standard shape
  `{ name, entry, emails, actions(t, helpers, sendStatus) }` used by the other 6 flows.
- **`build.js` enhancement:** the current builder clones an *old* flow's trigger +
  profile_filter; there is no old replenishment flow. Add a "net-new flow" path that
  defines the trigger (`Placed Order` metric id) and profile filter inline from the
  module. This also makes future net-new flows straightforward.
- Ship path (mirrors existing flows): `templates` → `flow` (DRAFT) → `verify` →
  `render` both emails → live-test on a seed profile → `golive`.

## Testing plan

1. Upsert templates; `render` Email 1 and Email 2 with a sample order to confirm
   dynamic product name + links resolve.
2. Create the flow as **DRAFT**; `verify` structure (delays 35d/15d, two messages,
   flow filter present) via `listFlowActions`.
3. Live-test on a seed profile (send test / controlled trigger); confirm deliverability
   and that reordering exits the flow.
4. Only then `golive` (set live; no old flow to draft down).

## Recommendations / observations (not blocking v1)

- **Cadence mismatch:** subscription defaults to *monthly*, but the lotion lasts ~7
  weeks. Monthly delivery risks over-supply → cancellations. Recommend offering a 6- or
  8-week cadence option (subscription-app config, Sean's call). Separate from this flow.
- **Per-category timing:** toothpaste/deodorant last longer than day-35; a future
  version can branch timing by product category.
- **Subscriber conversion tracking:** attribute subscription starts to this flow so we
  can measure it as the #1 subscriber-acquisition point.

## Future work (post-v1)

- SMS touch (needs consent volume + Klaviyo SMS plan).
- Dynamic unique-per-recipient reorder codes.
- Per-category replenishment timing.
- Prefilled-cart / direct-to-subscribe deep links.
