# 90-Day Coconut Reset — weighting the value proposition

**Date:** 2026-07-31
**Product:** The 90-Day Coconut Reset — `gid://shopify/Product/8566372303018`, handle `99-coconut-reset-digital`, **ACTIVE since 2026-07-29**, $119, 2 variants (Coconut Breeze, Pure Unscented), 11 qty each
**Live theme:** 147480051882 · template `templates/product.bundle-landing.json`
**Lander copy:** metaobject `bundle_lander` — `gid://shopify/Metaobject/220166586538`

## Problem

The page has a strong value proposition and under-weights it. It is not missing, and it is not badly ordered.

Rendered order of the visible elements:

| Position | Element |
|---|---|
| 24% | Judge.me badge (131 reviews, 4.85) |
| 50% | Hero subheading, and hero bullet "A complete $214 routine … yours for $119" |
| 53% | Visible price — a bare `$119` |
| 55% | Buy-box bullets |
| 58% | Itemised value stack: "Total value $214 → $119 today" |
| 67% | Final CTA: "you save $95" |

An earlier draft of this spec claimed the price landed at 34%, before any value framing, and proposed reordering on that basis. That was a measurement error — the 34% hit was `"price":11900` inside a JSON blob in a script tag, not the rendered price element. Measured against the actual markup, the value claim *precedes* the price and the whole offer sits in one above-the-fold cluster. **No reordering is needed, and the reordering rationale is withdrawn.**

What survives that correction is narrower and verifiable: **no `compare_at_price` is set**, so at the moment of decision the price renders alone, with no strike-through and no savings badge. That is the real weighting gap.

Compounding it, the page contradicts itself on what ships. Four claims, two of them wrong:

- `bundle.component_qty` = `[3,3]` — **3 lotions + 3 creams** (confirmed correct by Sean, 2026-07-31)
- `bundle.value_stack` line 1 = "3 Body Lotions + 3 Body Creams", $174 — correct, and 3×$30 + 3×$28 = $174 checks out
- metaobject `subheading` = "three daily lotions and **an overnight cream**" — **wrong, singular**
- metaobject `tabs` → "What's Inside" = "3 full-size Body Lotions (8oz) and **1 Body Cream** (4oz)" — **wrong**

The box gives away $56 of product that the page does not claim. A reader who notices the inconsistency discounts the whole offer, which is the opposite of weighting it.

## Design

### 1. Correct the contents copy

Two fields on metaobject `220166586538`:

| Field | From | To |
|---|---|---|
| `subheading` | "three daily lotions and an overnight cream" | three daily lotions and three overnight creams |
| `tabs` → "What's Inside" body | "3 full-size Body Lotions (8oz) and 1 Body Cream (4oz)" | 3 full-size Body Lotions (8oz) and 3 Body Creams (4oz) |

This precedes everything else. Weighting a claim the page contradicts amplifies the contradiction.

The rest of the metaobject is already correct and needs no edit — `bullets` says "3 Body Creams", `whats_in_it_note` says "three months of overnight cream", and the FAQ explains why lotion is 3×. Only these two fields are stale.

`buybox_bullets` line 2 reads "Two formulas, one routine — daily lotion + overnight cream". That is naming the two formulas, not counting units, so it stays.

### 2. Correct the shipping line in the value stack

`bundle.value_stack` carries free shipping at **$6**. Six items at that weight would cost a customer about **$12** to ship (confirmed by Sean, 2026-07-31). The stack understates itself:

| Line | Current | Corrected |
|---|---|---|
| 3 Lotions + 3 Creams | $174 | $174 |
| 90-Day Routine & Tracker (digital) | $19 | $19 |
| Coconut Skincare Field Guide (digital) | $15 | $15 |
| Free shipping | $6 | **$12** |
| **Total** | $214 | **$220** |
| **Savings vs $119** | $95 | **$101** |

One metafield edit. The template renders `[[TOTAL]]` and `[[SAVINGS]]` from this metafield, so the hero bullet, the stack and the final CTA all update together — no copy hunting.

### 3. Set `compare_at_price = $174`

On both variants. This produces a strike-through and savings badge in the buy box, where there is currently no reference point at all.

**$174, not $220 — and this distinction is load-bearing.** Compare-at is a *price* claim: what these goods sell for bought separately, verifiable against our own PDPs. The digital guides are free bonuses and shipping is a service we absorb; neither has ever been sold at that price. Putting $220 in a strike-through asserts "this used to cost $220", which is untrue and is the pattern FTC guidance and Shopify's pricing policy treat as a deceptive reference price.

Both numbers then work honestly:

- **$174 strike-through** in the buy box — a price claim
- **$220 itemised value** in the stack — a value claim, defensible because each line is shown

### 4. Add a savings line to the buy-box bullets

Prepend one line to the metaobject's `buybox_bullets`: **"$[[TOTAL]] value · you save $[[SAVINGS]]"**. Written with the existing tokens so it stays driven by `bundle.value_stack` rather than hardcoded, and it renders at 55% — immediately under the price — reinforcing the strike-through at the decision point.

This is a metaobject edit, not a template edit. Which makes the whole change data-only.

## Everything here is data, not theme code

All four changes are Shopify data edits — two metaobject fields, one metafield, two variant prices. **No change to `product.bundle-landing.json` is required.** The metaobject is the source of truth for lander copy, which is why the hero bullet already renders "3 Body Creams" correctly despite the template's stored setting still saying "1 Body Cream" (the stored setting is dead text, overridden at render).

That matters for risk: on a live revenue page, rollback is restoring captured field values, with no theme deploy in the loop.

## Non-goals

The itemised stack, reviews, FAQ, imagery, the `whats-in-it` grid, and section ordering are untouched. Ordering was measured and is fine. This is a correctness-and-emphasis pass, not a redesign.

The template's stale `subheading_rte` and `bullet-1` settings are left alone deliberately — they are overridden by the metaobject and editing them would imply they matter. Worth a separate cleanup so the next reader is not misled the way this spec's first draft was.

## Verification

1. Capture current values for every field changed, before changing them.
2. After applying, re-fetch `https://www.realskincare.com/products/99-coconut-reset-digital` and assert:
   - `compareAtPrice` renders as $174 with a strike-through
   - zero occurrences of "1 Body Cream" or "an overnight cream"
   - `$220` and `$101` appear, `$214` and `$95` do not — proving the metafield drives every instance
   - `[[TOTAL]]`, `[[PRICE]]`, `[[SAVINGS]]`, `[[CTA]]` do not leak as literals
3. Screenshot desktop and mobile above-the-fold.

## Risks and rollback

Live revenue page. Every change is a Shopify data edit — two metaobject fields, one metafield, two variant prices — so rollback is restoring captured values. No theme-template change is required for sections 1–3; sections 4–5 touch `product.bundle-landing.json`, which is backed up before editing.

## Out of scope, but flagged

Three creams instead of one changes the cost side materially, and the CFA maths in `project_growth_plan_1m` is stale in both directions:

- COGS: 3×$5.49 lotion + 3×~$5.50 cream ≈ **$33** (memory assumes ~$22)
- Shipping: ~**$12** for a 6-item box (memory assumes $8–12 for a "light 4-item box")
- Landed ≈ **$45** against $119 → contribution ≈ **$74** before payment fees, ≈ **$70** after ~3% processing
- Against a $25 CAC that is ~**2.8×** 30-day gross profit (3.0× before fees), still past the 2× infinite-scaling threshold

The offer still works. The numbers should be re-derived before a CAC ceiling is set or paid spend is turned on. Separate task.
