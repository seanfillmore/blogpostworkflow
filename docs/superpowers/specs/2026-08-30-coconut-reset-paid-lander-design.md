# The 90-Day Coconut Reset — paid landing page design

**Date:** 2026-08-30
**Status:** spec, not built. Nothing is changed on the live page until this is approved.
**Purpose:** give Meta paid traffic a destination that can clear breakeven. Today it cannot.

---

## 1. Verified live state — read before trusting any older note

Pulled read-only from the storefront 2026-08-30. Several long-standing notes are stale and were corrected here rather than carried forward.

| | Live value | What memory/plan said |
|---|---|---|
| Price | **$121.00** | $119, and $99 before that |
| Compare-at anchor | **$174.00** | $118, then $158 |
| Variants | Coconut Breeze, Pure Unscented | matches |
| Images | 12 | "0", then "3 stopgap" |
| Reviews shown | 184 | 131 |
| Value stack on page | **present** | "not on the live page" |
| Template | `bundle-landing` | matches |

### 1.1 The page contradicts itself, and this is the first fix

The rendered page states **two different value anchors and two different savings figures**:

- Hero: *"A complete **$180** routine — everything you need in one box — yours for $121"* … *"**$180** of value — yours today for $121.00. That's **$59** in savings"*
- Offer block: *"Total value **$174** · $121.00 today · **You save $53** today"*

Each block is internally consistent ($180−$121 = $59; $174−$121 = $53). They disagree with each other. On a page asking a cold visitor for $121, a self-contradicting value claim is a credibility defect, and it sits in the two places a skimmer actually reads.

**Fix this before anything else in this spec.** It is a copy edit, it costs nothing, and no amount of new creative compensates for a page that cannot state its own price consistently. Pick one anchor, verify the component arithmetic against `config/bundles.json` and the live component prices, and make both blocks cite it.

---

## 2. Economics — corrected

The "~$47 contribution" figure in circulation was the plan's **conservative estimate at a $99 price**. At the live $121:

| | |
|---|--:|
| Price | $121.00 |
| COGS — 3 × lotion @ $5.49, 1 × cream @ ~$5.50 | ~$22.00 |
| Shipping absorbed (free-ship threshold; light 4-item box) | ~$10.00 |
| Payment fees (~2.9% + $0.30) | ~$3.80 |
| **Contribution** | **~$85** |

**Assumption flagged:** COGS is operator-supplied and shipping is an estimate, not a measured average. Shipping is the soft number — a heavier box or a higher real ship cost moves contribution materially. Verify both before committing budget.

### 2.1 What that means for paid

Measured commercial-page CVR is **0.47%** (856 sessions → 4 orders, 2026-08-04 → 08-29; see `reference_commercial_page_cvr` and `npm run commercial-cvr`).

| CPC | Required CVR at ~$85 contribution | vs. measured 0.47% |
|--:|--:|---|
| $0.50 | 0.59% | **~25% short** |
| $1.00 | 1.18% | 2.5× short |
| $1.50 | 1.76% | 3.7× short |

Breakeven allowable cost-per-click at today's rate is **~$0.40**.

This reframes the whole exercise. The Reset is **not** 4–12× away from viable — at a cheap CPC it is within ordinary landing-page-optimization distance of breakeven. The lander does not need to be extraordinary. It needs to beat a generic PDP by about a third.

> `scripts/commercial-page-cvr.mjs` hardcodes `contribution: 47` for this offer in its `OFFERS` table. That is now known to be wrong and should be updated to ~85 with the assumption documented in the same commit.

---

## 3. What the page leads with

**Decision: sensitive-skin simplicity.** Scent is demoted to concrete sensory detail; it is not the hook.

This is a **deliberate divergence** from the strongest pattern in the competitor data, and the reasoning has to be on the record because someone will otherwise "fix" it back.

The teardown (1,508 active ads, 344 concepts, four brands) found **scent leads in 4 of 4 brands**, and every ≥90-day survivor is scent-led or IP-led. Following it literally would mean leading with Coconut Breeze. Three reasons not to:

1. **The pattern is validated for scent-products.** Dr. Squatch's 301-day champion is functionally a cologne ad built on sexual-desirability framing. Duke Cannon's proposition compresses to a scent name plus a place. Each & Every's product names *are* scent names. The Reset is a $121 ninety-day two-product regimen — a different purchase with a different decision.
2. **The teardown's own guardrail applies.** Longevity proves a structure works *for that advertiser*. It is not evidence the angle transfers.
3. **Half the SKU contradicts the hook.** Pure Unscented is one of two variants. A scent-led page sells against its own product.

Meanwhile **sensitive skin appears in 3 of 106 survivors** — effectively unclaimed in this category's paid media — and it is where RSC's actual customer language sits.

**The synthesis:** offering a genuinely unscented option *is itself* the sensitive-skin proof. Scent becomes a specific ("warm coconut, no synthetic fragrance") rather than the promise.

---

## 4. Page structure

Each section cites the finding that earns it. Sections without a justification do not go on the page.

### 4.1 Above the fold
- **Headline:** the simplicity/duration position. Ninety days, two products, short ingredient list. No efficacy verb.
- **Ingredient-negation checklist** — *C2, 4 of 4 brands, 23% of the ≥90-day set.* A checkmarked list of what is **absent**. This is the single most-validated device in the dataset **and** the only one that is automatically compliance-safe, because it claims absence rather than effect. Rare alignment; use it.
- **Numeric spec** — *C3, 3 of 4 brands.* RSC's lotion is **already titled "Non-Toxic Body Lotion Made With Only 6 Clean Ingredients."** We own the strongest version of the pattern competitors run as a headline and we are not leading with it. Surface the count.
  - ⚠️ **Verify the cream's ingredient count before publishing.** The 6 is verified for the lotion only. Do not state a combined or implied count that has not been checked against the actual labels.
- **Variant choice visible above the fold**, Pure Unscented given equal weight — it is the proof, not a fallback.
- **One offer statement**, using the single reconciled anchor from §1.1.

### 4.2 The offer block
- *C5 — the acquisition unit is a bundle or multipack in 3 of 4 brands; no long-running acquisition ad in 344 concepts points at a single unit.* The Reset already satisfies this. Present it as one unit at one price, never as four things to evaluate separately.
- Itemized value stack with **verified** component arithmetic. One anchor. One savings figure.
- Digital bonuses listed as included, not as the lead. *C6 (free gift beats a bigger discount) is 2-of-4 — suggestive, not converged — and Squatch's version is a physical item whose build quality it demonstrates. A PDF does not carry that weight; do not over-invest in it.*

### 4.3 Proof
- **Third-party reaction, not self-description** — *C4, 3 of 4 brands.* The strongest proof shape in the set is an observed social consequence reported by someone other than the buyer, and it displaces the star-rating testimonial. Mine the 184 existing Judge.me reviews for quotes of that shape.
  - Every quote must clear the health-claim gate. A verbatim review can be correctly sourced and still be an illegal claim — that is exactly the 2026-08-16 incident. Screen before use.
- Review count and rating stay, but as support beneath the reaction quotes, not as the lead proof.

### 4.4 What to REMOVE or de-emphasize

Anti-convergence is as instructive as convergence, and the current page leans on three devices this category has abandoned:

| Device | Evidence | Action |
|---|---|---|
| Guarantee / risk reversal | **1 of 106 survivors**, buried in a checklist | Keep it (it is real and reassuring) but strip it from any prominent position. It is not a selling point in this category. |
| Free shipping as a hook | **1 of 106 survivors** | Demote to a line item. Effectively dead as a hook. |
| Before/after imagery | **0 of 344 concepts** | Do not build it. Also unavailable to us under claim rules. |
| Subscription | **0 survivors mention it in acquisition copy** | Keep off the cold lander entirely. This matches the existing rule that subscription is never the cold attraction offer. |

---

## 5. Compliance guardrails — non-negotiable

- **Cosmetic, not drug.** No treating, healing, curing, preventing. No condition names. The negation structure in §4.1 is recommended *precisely because* it claims absence rather than effect.
- **Do not port these competitor structures**, all present in the teardown and all unavailable to RSC: Duke Cannon's balm "repairs deep cracks"; Dr. Squatch "fights ashy dry skin"; Squatch's 187-day deodorant ad arguing a sweat/pore mechanism.
- **Never describe an RSC product as an antiperspirant.** Not applicable to this bundle, but it governs any deodorant cross-sell placed on the page.
- **No competitor phrasing.** The teardown deliberately recorded structure, not copy. Lifting a headline is both a legal and a positioning error — and a name-swapped headline is an echo ad that works for the competitor.
- Every generated string on this page goes through `lib/seo-copy-health-gate.js` before it ships.

---

## 6. Success criteria

The lander clears its bar when **commercial-page CVR for traffic landing on it reaches 0.59%** — breakeven at a $0.50 CPC and ~$85 contribution. Stretch target 1.0%, which carries a $1.00 CPC.

Measured with `npm run commercial-cvr`, which already segments by landing page. The Reset lander is a `/products/` path, so it currently pools into the `product` bucket — **it needs its own segment**, the same treatment `GIVEAWAY_PATHS` already gets, or its reading will be diluted by every other PDP.

**Do not judge this on the giveaway's numbers.** A $0.179 lead was a free-entry ask; this is a $121 purchase. They are not comparable and the earlier conflation of the two is what produced a wrong read of the funnel.

---

## 7. Open items — must be resolved before build

1. **Reconcile $180 vs $174 and $59 vs $53.** Verify component arithmetic against `config/bundles.json` and live component prices. (§1.1)
2. **Verify the cream's ingredient count.** Only the lotion's 6 is confirmed. (§4.1)
3. **Verify COGS and real shipping cost.** Contribution ~$85 drives every number in §2. (§2)
4. **Screen review quotes** through the health-claim gate before any appear on the page. (§4.3)
5. **Update `OFFERS` in `scripts/commercial-page-cvr.mjs`** from $47 to the verified contribution. (§2.1)
6. **Add the Reset lander as its own segment** in `lib/commercial-cvr.js`. (§6)

## 8. Explicitly out of scope

Building the page. Launching a campaign. Ad creative production. Any change to the live theme. This document is a design for review.

---

**Inputs:** competitor teardown 2026-08-30 (1,508 active ads / 344 concepts across Dr. Squatch, Native, Duke Cannon, Each & Every, ranked on `days_active`, GetHookd `performance_scores` ignored); `reference_commercial_page_cvr`; live storefront pull 2026-08-30.

**Sample honesty:** the ≥90-day survivor set is 13 concepts — percentages against it move in 1-in-13 steps. Each & Every, the only true size peer, has **no** survivors at all, so every longevity finding here comes from advertisers spending orders of magnitude more than RSC. Treat convergence as directional evidence about structure, never as proof an angle transfers.
