# Post-Purchase Flow — Design Spec

**Date:** 2026-07-20
**Owner:** Sean (approved design direction 2026-07-20)
**Channel:** Klaviyo (RSC account), email-only
**Status:** Design approved → implementation pending

## Goal (revenue-first)

Rebuild RSC's dormant Post-Purchase Flow (`RYiU6C`, currently draft) into a lean,
revenue-purposed sequence. RSC's binding constraints are **AOV ~$19** and **repeat
rate**. This flow exists to move both:

- **Lift AOV** toward the **$50 free-shipping threshold** via set/bundle cross-sell.
- **Drive repeat orders** via replenishment reorder on consumables.
- **Protect earned margin** by cutting refunds with product education.

No discount codes erode price — **free-shipping-to-$50 is the sole incentive**.

## Current state (audit findings)

`RYiU6C` is an auto-generated Klaviyo template started ~June 2025, never finished:

- 24 nodes; all branches "live" but **every email is a draft** and the flow is off.
- Trigger is sound: `Placed Order` (metric `V69ueg`), filtered to
  `Cancelled Order` (`WSzmJK`) count `= 0` since flow start.
- Two salvageable instincts: **customer-value segmentation** and **product-based
  personalization** (existing `trigger-split` into Lotion/Cream/Toothpaste/Deodorant/Soap).
- Problems: no email is built (placeholder subjects `Hi {{ first_name }}`, thin stub
  bodies); inconsistent naming ("Email #2", five "Email #4"s); **no revenue mechanic**
  (no cross-sell logic, no replenishment, no review request); Klaviyo catalog not synced
  (0 items — product blocks would be hand-coded regardless).

## Design decisions (locked)

| Decision | Choice | Rationale |
|---|---|---|
| Incentive | **Free-shipping-to-$50 framing**, no discount codes | Protects margin at $19 AOV; steers to a 2nd unit / set |
| VIP branch | **Dropped** | Free-gift fulfillment is manual/costly; one strong path for all |
| Segmentation | **Product-category split** kept; customer-value split dropped | Personalization that drives cross-sell/education; value split added complexity without a matching mechanic |
| Trigger | **Keep** `Placed Order`, exclude `Cancelled Order = 0` | Already correct |
| Build method | **Fully headless** via API (confirmed by spike) | Hand-coded responsive HTML templates + Create Flow graph |

## Reference facts

- Free-shipping threshold: **$50** (live on site). New-customer free-ship code: `NEWCUS`.
- Catalog (Shopify, live): Deodorant $15, Toothpaste $13, Bar Soap $11, Liquid Soap $13,
  Foam Soap Refill $26, Foam Soap Bundle $20, Lip Balm 4pk $15, Moisturizer $28,
  Body Lotion $30, **Sensitive Skin Moisturizing Set $46.80**, **Two-Step Dry Skin Starter Set $39.99**.
- Consumables (replenishment-eligible): deodorant, toothpaste, soaps.
- Non-consumables (skip replenishment): lotion, moisturizer, sets, lip balm.
- Reviews: Judge.me (`JUDGEME_API_TOKEN` available).
- Brand voice: founder ("Sean, Co-Founder"), matches existing thank-you copy.

## Flow architecture

Linear graph with two `trigger-split`/`conditional-split` points. Times are relative to
`Placed Order`. All emails responsive HTML, ≤600px, dark-mode-safe, single primary CTA.

| # | Email | Timing | Audience | Job |
|---|---|---|---|---|
| 1 | Thank-you + what to expect | +1 hr | All | Trust; reduce refunds; plant routine seed; soft "$50 = free ship" |
| 2 | How to use it (product-split) | +2 days | Split: Deodorant / Toothpaste / Soap+Lotion / Set/other | Retention + refund reduction; CTA → complementary product |
| 3 | Complete your routine → a Set | +5 days | All | **AOV lever.** Anchor relevant Set; "less than separately, clears $50" |
| 4 | Review + soft referral | +10 days | All | Judge.me review request + "friends get free ship with `NEWCUS`" |
| 5 | Restock in one click | +~35 days | **Consumables only**; others exit | **Repeat lever.** One-click reorder + "stock up 2–3, ship free" |

### Graph (linked-list definition)

```
Trigger: Placed Order (V69ueg), profile_filter: Cancelled Order (WSzmJK) count == 0 since flow-start
  → time-delay 1 hour
  → EMAIL 1 (all)
  → time-delay 2 days
  → trigger-split by purchased product category
        ├─ Deodorant  → EMAIL 2a
        ├─ Toothpaste → EMAIL 2b
        ├─ Soap/Lotion/Moisturizer → EMAIL 2c
        └─ else (Set/other) → EMAIL 2d
     (branches rejoin)
  → time-delay 3 days   (≈ Day 5)
  → EMAIL 3 (all)
  → time-delay 5 days   (≈ Day 10)
  → EMAIL 4 (all)
  → conditional-split: purchased a consumable?
        ├─ yes → time-delay ~25 days (≈ Day 35) → EMAIL 5
        └─ no  → exit
```

### Per-email content spec

- **Email 1 — Thank-you.** Founder note; what-happens-next (shipping); 1–2 quick usage
  tips; soft line "building your routine? everything ships free over $50" → best-seller Set.
- **Email 2 — How to use (personalized).**
  - Deodorant: the natural-deodorant **adjustment period** guide (this alone deflects
    return requests); CTA → soap/lotion to build routine.
  - Toothpaste: getting the most from fluoride-free; CTA → complementary.
  - Soap/Lotion/Moisturizer: 2-minute clean routine; CTA → complementary.
  - Set/other: getting-started overview; CTA → single-item add-on.
  - Every variant carries the $50 free-ship line.
- **Email 3 — Complete your routine (Set).** Show the relevant Set ($39.99 / $46.80):
  "everything you need, less than buying separately, and it clears $50 so shipping's on us."
  Anchored to what they bought.
- **Email 4 — Review + soft referral.** Judge.me review CTA (deep-linked to purchased
  product); secondary "love it? your friends get free shipping with `NEWCUS`."
- **Email 5 — Replenishment.** One-click reorder of the consumable(s); "stock up on 2–3
  and cross $50 for free shipping." Consumable branch only.

## Implementation approach (headless — feasibility confirmed)

Spike on 2026-07-20 confirmed the full write path:

- **Create Flow** (`POST /api/flows`, revision `2025-07-15`) accepts a `definition` graph.
- Graph is a linked list: `entry_action_id` + each action carries a `temporary_id` on
  create (server assigns real ids), linked via `links.next`.
- Schema notes learned: `id` not allowed on create (use `temporary_id`);
  `delay_until_weekdays` only valid when `unit == "days"`; delays support `minutes/hours/days`,
  `timezone: "profile"`.
- Round-trip verified (create → read-back graph → delete `204` → `404`).

Build order:
1. Author 8 HTML templates (E1, E2a–d, E3, E4, E5) → `POST /api/templates`, capture ids.
2. Assemble flow definition referencing those `template_id`s; `POST /api/flows` as **draft**.
3. Render-test + seed-send each email; visual review.
4. Only after review: set flow **live** (`PATCH /api/flows/{id}` status → `live`).

A small reusable module (`lib/klaviyo.js`) wraps auth/revision/retry so this and future
flow work is not raw curl.

## Error handling & safety

- **Always create as draft.** Never write directly to live; the existing `RYiU6C` draft is
  left untouched until the replacement is reviewed (then archive old, or repurpose).
- **Never auto-set-live.** Flipping to `live` is a discrete, reviewed step.
- Template writes are additive (new templates); no existing template is overwritten.
- Rate-limit aware (spike hit 429s) — backoff/retry in the wrapper.
- Verify after each mutating call (read-back), per project rule on trusting success logs.

## Testing

- Spike already validated create/read/delete.
- Per-email: Klaviyo template **render** + **send test** to a seed address; check mobile +
  dark mode; verify all links resolve (200) and merge tags populate.
- Flow: confirm graph shape reads back as designed; confirm trigger + profile filter;
  confirm branch conditions route correctly with a test profile before going live.

## Rollout

1. Build templates + draft flow (headless).
2. Seed-send review with Sean.
3. Set live; **archive/disable old `RYiU6C`** to avoid double-send.
4. Monitor first 2 weeks: opens/clicks, cross-sell (E3) and reorder (E5) attributed revenue,
   refund-rate change. Feed learnings back into subjects/timing.

## Out of scope (YAGNI / future)

- SMS branch (needs consent data review).
- Subscribe-and-save mechanism (E5 uses one-click reorder link, not a subscription).
- Formal referral program (E4 uses the existing `NEWCUS` code as a soft referral).
- Klaviyo catalog sync (emails hand-code product blocks from the 12-SKU catalog).
- VIP / customer-value tier (dropped for v1).
