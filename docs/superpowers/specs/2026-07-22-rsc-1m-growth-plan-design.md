# Real Skin Care — Path to $1M/Year Growth Plan

**Date:** 2026-07-22
**Strategy:** Path A — DTC Paid-Acquisition Engine (skin-led), with Amazon as a parallel fix-and-scale track and wholesale/retail as a Phase-3 multiplier.
**Owner directive:** Capital available to invest; willing to run acquisition at breakeven or slightly below while the machine produces. Capacity 20–30k units/mo (not the constraint). Sequence must be **Tracking → Conversion Rate → Traffic** — do not scale spend into a non-converting funnel.

---

## 1. Thesis

RSC is two businesses with opposite economics. **Skin care (lotion / cream / sets)** carries $15–25 contribution per order and can absorb a paid CAC. **Everything else (deodorant, soap, toothpaste, lip balm)** nets $2–5 after shipping and cannot be acquired profitably with cold ads. Therefore:

> **Acquire skin customers with paid ads → force AOV up so the first order roughly pays for itself → harvest the low-margin categories through the retention flows already built.**

The plan does not chase $1M by "more SEO" or "more traffic." It fixes the two revenue leaks first (**tracking, then conversion**), stands up an AOV-lifting offer, and only then pours capital into acquisition — where the owner's willingness to run at breakeven becomes a scaling weapon.

The binding constraint is **conversion rate**, not capacity and not capital.

## 2. Verified baseline & unit economics

**Baseline (from memory + live pulls, 2026-07-22):**
- Shopify ~$875/mo · Amazon ~$1,800/mo (74% one lotion) → **combined ~$2.7K/mo (~$32K/yr)**
- Shopify: **true CVR 0.82%** (GA4 overstates), **AOV ~$19**, **repeat rate 18%**
- Capacity: **20–30k units/mo** available
- Amazon: **RSC fully Brand Registered** — all features available (SQP/BA reports, A+ Content, Sponsored Brands, Brand Store, Vine). Culina to be separated on its own Brand Registry.

**Shopify contribution margin (live prices × supplied COGS; processing 2.9%+$0.30):**

| Product | Price | COGS | Ship | **Contribution** | **Margin** |
|---|---|---|---|---|---|
| Body Lotion 8oz (hero) | $30 | $5.49 | $6.30 | ~$17.0 | 57% |
| Coconut Moisturizer/Cream 4oz | $28 | $5.18 | $6.30 | ~$15.4 | 55% |
| Two-Step Starter Set | $37.98 | ~$10.4 | $9.50 | ~$16.7 | 44% |
| Sensitive Skin Set | $46.80 | ~$10.7 | $9.50 | ~$24.9 | 53% |
| Deodorant | $15 | $4.04 | ~$5 | ~$5.2 | 35% |
| Lip Balm (4pk) | $15 | $5.00 | ~$5 | ~$4.3 | 29% |
| Bar Soap | $11 | $2.99 | ~$5 | ~$2.4 | 22% |
| Liquid Soap Pump | $13 | $4.26 | ~$5 | ~$3.1 | 24% |
| Toothpaste | $13 | $3.35 | ~$5 | ~$4.0 | 31% |
| Foam Soap Refill 32oz | $26 | $9.79 | $6.30 | ~$8.9 | 34% |

**Amazon contribution (live: all RSC listings are FBA; 15% referral + ~$5 FBA fee):**

| Product | Amazon $ | Shopify $ | **Amazon contribution** | Note |
|---|---|---|---|---|
| Body Lotion 8oz | **$21.99** | $30 | ~$7.70 (35%) | **Underpriced ~$8 vs Shopify — near-term margin fix** |
| Deodorant | $9.99 | $15 | ~$0.75 | Near breakeven — presence/reviews only |
| Toothpaste | $9.99 | $13 | ~$1.10 | Thin — presence only |

## 3. The constraint sequence (why order is non-negotiable)

Each stage is a **gate**. Do not fund the next stage until the current one passes. This is the discipline that separates a credible plan from burning capital.

1. **Tracking (fix the measurement).** Past Google Ads lost money on *broken tracking* (0.23% CVR, 0.19x ROAS reported). GA4 overstates CVR; seo-impact organic $ is unreliable. **Nothing scales on numbers you can't trust.** Stand up server-side / CAPI conversion tracking reconciled against Shopify orders.
2. **Conversion rate (fix the leak).** At 0.82% CVR, every dollar of traffic is ~half-wasted vs a 1.5–2% benchmark. Doubling CVR doubles revenue from *existing* traffic at **zero acquisition cost** — the highest-ROI work in the plan. Fix funnel, PDP, offer clarity, buy-box, trust, mobile speed.
3. **Offer / AOV (make paid math possible).** Lift AOV $19 → ~$48 via the hero bundle, free-ship threshold, and subscription. Without this, no CAC is survivable.
4. **Traffic (scale acquisition).** Only now pour capital into Meta + Google + Amazon Ads, bidding up to breakeven CAC because the funnel converts and LTV compounds.

## 4. The offer architecture (Grand Slam Offer — $100M Offers) — two front doors

Grounded in Hormozi's three books (full framework extraction in the companion reference; key mechanics cited inline). The core insight from the Money Model math: **the $46.80 Set is the right hero but the wrong cold-traffic attraction offer.** We run **two front doors** with one back end.

### 4a. Front door #1 — the Set, reframed (lifts CVR)

The **Sensitive Skin Moisturizing Set** (`/products/sensitive-skin-starter-set`) — Lotion + Cream, contribution ~$25 — stays as the hero, but is **reframed per $100M Offers**:

- **Stop leading with the "reg $58 → $46.80" discount.** Discounting the *core* commoditizes it and price-anchors it against Cetaphil/CeraVe. Instead present a **value stack**: Lotion ($30) + Cream ($28) + free Lip Balm ($15) + free Bar Soap ($11) + zero-COGS info bonuses (Calm-Skin Routine Card, Patch-Test Guide, Trigger-Proofing Checklist, "$39 value") + free shipping → **stated value ~$115–125, your price $46.80.** Bonus value eclipses the price — Hormozi's core rule.
- **Frame as Buy-X-Get-Y-Free, not "% off"** (Money Models: "free" out-pulls "% off"): "Get the Set — **free Bar Soap + Lip Balm today**" (free items ~$6.40 COGS).
- **Value Equation levers:** ↑ Perceived Likelihood (surface the 131 Judge.me reviews, "formulated for sensitive skin," patch-test/ingredient proof — the cheapest lever to move a 0.82% page); ↓ Time Delay (promise a fast sensory win — "relief from tightness on first use"); ↓ Effort (done-for-you 2-step routine + subscription "never run out").
- **Name it (MAGIC):** e.g. **"The 14-Day Sensitive-Skin Calm-Down System."**
- **Name the guarantee:** **"The Calm-Skin Promise — 30 days; if your skin isn't calmer, email 'refund,' keep the products."** Unconditional is correct for low-ticket B2C; the "keep it" costs ~$5.49 COGS and removes return friction. Run the refund math, don't flinch (130 sales @10% refund beats 100 @5%).

### 4b. Front door #2 — the $99 bundle (the CFA scaling engine) — **NET-NEW, recommended**

A higher-AOV bundle is what makes aggressive/breakeven paid spend *safe* (see §5). Build **"The 90-Day Coconut Reset"** — 3× Lotion + 1× Cream, **$99** (COGS ~$21, contribution **~$47**). This is the primary destination for *scaled* paid traffic once CVR is proven, because its 30-day gross profit clears Hormozi's 2× infinite-scaling threshold.

### 4c. Back end (same for both doors) — Upsell → Downsell → Continuity

- **Upsell (Zipify 1-click, post-purchase, highest-profit-first, Anchor mechanic):** anchor the $99 bundle, then offer **lotion refill 25% off ($22.50, ~$12 contribution)**; second 1-click **"Everyday Essentials" (deo + toothpaste, $19, ~$9 contribution).**
- **Downsell (never price-cut — AOV too low for payment plans):** quantity/size downsell — single full-size Lotion ($30) or a cheap consumable as a foot-in-the-door for decliners. Goal = more *customers*, not per-buyer GP.
- **Continuity (Recurpay, subscribe-first — but never the cold attraction offer):** see §6.

## 5. Acquisition math & CAC policy — Client-Financed Acquisition ($100M Money Models)

The spend policy is Hormozi's **30-day rule**, not a raw LTV:CAC target. A credit card floats you interest-free for ~30 days, so the binding test is **30-day gross profit per new customer vs. cost to acquire + service**:
- **Breakeven CFA:** 30-day GP ≥ CAC.
- **Infinite-scaling ("print money"):** 30-day GP ≥ **~2× CAC** — one customer funds acquiring two more inside 30 days. Above this, cash stops constraining spend.

**Worked against RSC's real contribution numbers:**

| Attraction offer | 30-day GP / new customer* | vs. $25 CAC |
|---|---|---|
| **$46.80 Set** (Buy-X-Get-Y + 1-click upsells) | ~$22 | **0.9× — below breakeven unless CAC held < ~$22** |
| **$99 "90-Day Coconut Reset"** (+ upsells) | ~$50 | **~2.0× — hits infinite-scaling threshold** |

*Continuity's 2nd charge lands ~day 42–56, outside the 30-day window, so it's the **LTV** engine, not the **CFA** engine.

**Policy:**
- **CAC ceiling = first-order contribution of the offer that acquired the customer.** Run the Set / cheap offers at **breakeven-to-slightly-negative** to maximize customer *count*; push CAC toward the 2× "print money" zone **only on the $99 bundle funnel**, where 30-day GP (~$50) supports it.
- The owner's willingness to run at breakeven is correct — but the machine that makes it *safe* is the **higher-AOV bundle + continuity (12-mo LTV ~$45–55)**, not the $19-AOV status quo.
- **Diagnostic guardrail ($100M Leads):** "don't confuse a sales problem with an advertising problem." At 0.82% CVR the constraint is conversion/business-model, so **CRO and offer come before spend** (§3).

**Spend → revenue model at $55K/mo Shopify (steady state):**
- ~60% new / 40% repeat. New: ~$33K via the bundle/Set mix, CAC held at breakeven-to-2× → **~$12–17K/mo ad spend**. Repeat: ~$22K organic (retention, no ad cost).
- Profit compounds as the subscription/repeat base grows; early phases deliberately run near breakeven on new-customer acquisition by design.

## 6. Retention / LTV engine — Continuity done right ($100M Money Models)

Retention is the true growth ceiling (18% repeat). The tools exist; the plan wires them into one loop **and fixes three continuity mistakes Hormozi flags**:

1. **Cadence: monthly → 6–8 weeks.** Monthly billing on a product used in 6–8 weeks *causes* over-supply churn (Profitwell: monthly 10.7% cancel vs. quarterly ~5%). Match cadence to consumption.
2. **Replace the flat 15% subscription discount with a Continuity Bonus + earned lifetime discount.** Discounting trains price-negotiability; instead give a **free soap/lip balm each shipment** (~$3 COGS, high perceived value) and **earn the 15% only after 3 shipments** (Hormozi: lifetime discount at your churn point). Never make the subscription the *cold attraction* offer — "no successful continuity business has a standalone membership offer"; front it with a cash offer, then subscribe-first at checkout.
3. **Add bulk-prepay + 4-week billing:** "Prepay 4 refills, get 1 free" (stacks 30-day cash) and bill in **4-week cycles = 13/yr = +8.3% revenue** for zero extra work.

Wired assets:
- **Replenishment flow** (Klaviyo TAfpnV, live) — day 35/50, subscribe-first, per-product CTAs → move to 6–8wk.
- **Post-purchase flow** (Klaviyo VLQaYZ, live) — cross-sell the low-margin catalog ("tell them what to buy next").
- **Recurpay** — continuity per the fixes above; add a **dunning flow** for failed payments.
- **Zipify OCU** — the CFA upsell engine (§4c).
- **Judge.me (131 reviews)** — Perceived-Likelihood proof in ads/PDP + UGC source for paid creative.
- **Rollover winback** — credit lapsed customers' past spend toward a bundle priced ≥4× the credit; highest-ROI play against 18% repeat.

## 7. Lead-generation engine — the Core Four ($100M Leads), sequenced for 1 person + agent fleet

Acquire on **skin only** (margin survives CAC); harvest the rest via §6. Prioritized by leverage-per-headcount:

1. **Post free content (agent fleet's core strength) — primary.** Reframe content **"How to" → "How I"** (founder voice), Hook→Retain→Reward, **give-until-they-ask**. Repurpose Judge.me reviews into UGC. This is the compounding organic asset.
2. **Paid ads — skin only.** Ad = **Call-Out → Value (What/Who/When) → CTA**; landing page must match the ad. **Track money before spending; test at 2× a customer's 30-day cash, kill losers at 1×, scale winners.** Seed lookalikes from customer + Klaviyo lists. Google Shopping is live; Meta (Set/bundle) is next.
3. **Customer referrals** — two-sided incentive (Dropbox/PayPal model) via Klaviyo + Judge.me + a **point-of-sale ask** ("who else has sensitive skin?"). Cheapest compounding channel; goal = referrals > churn.
4. **Affiliates/partners** — recruit estheticians + sensitive-skin/clean-beauty micro-influencers; launch **Whisper-Tease-Shout**; Integrate (they give the quiz/sample away or sell the Set). Highest leverage for scale.
5. **Warm outreach** — the **9-word email** ("Are you still looking to calm your sensitive skin?") to the dormant Klaviyo list; founder network for early wins.
6. **Cold outreach — deprioritize for D2C** (labor-heavy, ~1yr to scale). Use only 1:1 to recruit affiliates.

**Lead magnet for cold paid traffic:** a **free digital "What's sabotaging your sensitive skin?" quiz** that diagnoses and routes to the Set/bundle and captures the email (near-zero marginal cost). **Never ship free physical samples to cold paid traffic** — it destroys unit economics at this AOV; reserve samples for warm/referral/affiliate/in-box.

## 8. Amazon parallel track (full Brand Registry)

Runs alongside DTC, not instead of it:
1. **Price fix (Phase 0):** test lotion $21.99 → $25.99–27.99. Recovers ~$4–6/unit on the 74%-of-Amazon SKU.
2. **Sponsored Products / Brands:** now unlocked — target ~10–15% ACOS on lotion and top SKUs.
3. **Catalog + content:** A+ Content, Brand Store, expand skin SKUs (cream, sets) onto Amazon.
4. **Reviews:** enroll in Vine to build review velocity on new listings.
5. **Data:** consume SQP/BA reports (now available) into keyword-index for both channels.
6. **Culina separation:** complete once its Brand Registry approves; unblocks clean per-brand reporting.
- **Target:** $1,800/mo → ~$18K/mo (~10x) by month 18–24.

## 9. Revenue bridge

| Channel | Now | Target | Lever |
|---|---|---|---|
| Shopify DTC (paid engine) | $875/mo | **$55K/mo** | CRO + offer + paid, $48 AOV, ROAS ~3.2x |
| Amazon | $1,800/mo | **$18K/mo** | Price fix + Ads + catalog + reviews |
| Wholesale/Retail | $0 | **$10K/mo** | Faire + boutiques/natural grocery (Phase 3) |
| **Total** | **~$2.7K/mo** | **~$83K/mo (~$1M/yr)** | |

Capacity check: ~$83K/mo ≈ 3–5k units/mo vs 20–30k available. **Headroom to ~$3–5M** — the machine can outrun this plan.

## 10. Phased roadmap with gates & KPIs

- **Phase 0 — Foundation & measurement (Month 0–1).**
  Build the $99 bundle + reframe the Set (value stack, Buy-X-Get-Y, named offer/guarantee) + subscribe-first continuity. **Fix tracking (server-side/CAPI, reconciled to Shopify)** — this is Hormozi's "Track Money" and RSC's own known attribution gap. Fix Amazon lotion price. **Fix the 10.4% Clarity `scriptErrorPct`** (JS errors can break add-to-cart *and* the pixel).
  **KPI/Gate:** conversions tracked accurately end-to-end (paid → Shopify order match within tolerance).
- **Phase 1 — Conversion rate (Month 1–3).**
  Attack the three CRO suspects surfaced in Clarity: (a) **10.4% script-error rate**, (b) **28.8% scroll depth / ~68% mobile** — above-the-fold + mobile PDP do the whole job, (c) **offer↔traffic misalignment** — paid traffic was landing on a single-lotion page, not the hero offer. Ship the free digital quiz lead magnet. Small paid test ($1–3K/mo, skin only) to source real traffic and read CAC/creative.
  **⛔ Gate:** **CVR ≥ ~1.5%** *and* **30-day GP ≥ CAC** on the acquiring offer (breakeven CFA). Do not scale spend until both hold. *(Confirm the CRO suspects on a fresh data pull before committing fixes.)*
- **Phase 2 — Scale acquisition (Month 4–9).**
  Ramp spend on *proven* creative, routing scaled traffic to the **$99 bundle** (2× CFA). Full retention loop live (6–8wk cadence, continuity bonus, dunning, rollover winback, post-purchase cross-sell). Content on the Rule of 100; launch referrals + first affiliates. Amazon Ads on. Target ~$25–35K/mo combined.
  **Gate:** **30-day GP ≥ 2× CAC** on the bundle funnel; contribution ≥ spend + overhead trending.
- **Phase 3 — Compound + omnichannel (Month 10–24).**
  Scale spend at held CFA ratio. Scale affiliates (Whisper-Tease-Shout). Add wholesale/retail leg (Faire, boutiques). Expand catalog / new hero SKUs.
  **Gate:** capacity + cash flow keep pace. Approach **$83K/mo run-rate by month 18–24.**

## 11. Existing tooling → role mapping ("pull it all together")

| Asset (already built) | Role in the $1M engine |
|---|---|
| Klaviyo replenishment + post-purchase flows | LTV engine — turn one skin sale into repeat + low-margin cross-sell |
| Recurpay subscriptions | Recurring revenue base; cadence 6–8wk |
| Zipify OCU | AOV lift at checkout |
| meta-optimizer / meta-ab-checker | CRO on titles/meta (CTR leak) |
| seo-impact (revenue attribution) | Measure in dollars; reconcile vs Shopify |
| DataForSEO (`lib/dataforseo.js`) | Keyword/SERP intelligence for both channels |
| SP-API client (production) | Amazon price fix, reports (SQP/BA), catalog |
| Collections consolidation / linker | Convert organic skin traffic (commercial pages first) |
| Google Shopping test (live) | Seed of the paid engine — scale winners |
| Dashboard | Single pane for KPIs across the phases |

## 12. Risks & kill criteria

1. **Tracking not trustworthy →** repeat past Ads loss. *Kill:* no spend scaling until Phase 0 gate passes.
2. **CVR won't clear ~1.5% →** funnel is the ceiling. *Kill:* pause paid, keep working CRO/offer.
3. **30-day GP won't clear CAC →** creative/offer problem. *Kill:* return to offer/CRO before more spend; don't confuse a sales problem with an ad problem.
4. **Amazon 10x** depends on review velocity + ranking — partly external. *Mitigate:* Vine, Sponsored Products, price tests.
5. **Cash-flow timing —** paid burns cash before continuity compounds. *Mitigate:* CFA 30-day policy is the deliberate control; bulk-prepay + 4-week billing pull cash forward; monitor weekly.
6. **Continuity churn** (monthly cadence over-supplies) → *Mitigate:* 6–8wk cadence + bonus-not-discount; if >5% cancel early, fix the product, don't handcuff.

## 13. Immediate next actions (Phase 0)

1. Stand up **server-side conversion tracking** (Meta CAPI + Google enhanced conversions) reconciled to Shopify orders; **fix the 10.4% JS script-error rate.**
2. Build the **$99 "90-Day Coconut Reset" bundle** + reframe the Set (value stack, Buy-X-Get-Y, named offer + "Calm-Skin Promise" guarantee) + subscribe-first continuity (6–8wk, bonus-not-discount) in Shopify.
3. **Test Amazon lotion price** $21.99 → $25.99 (watch buy-box + conversion).
4. Define the **KPI dashboard** (CVR, AOV, **30-day GP/customer per funnel**, CAC, repeat rate) as the gate scoreboard.
5. Ship the **free digital sensitive-skin quiz** lead magnet; confirm true blended **contribution margin per offer** once tracking is live.
6. **Fresh data pull** (GA4/Clarity/Shopify/Klaviyo) to confirm the CRO suspects on current numbers.

---

*Success is measured in Shopify + Amazon dollars, not clicks. Every phase gate is a dollar/CVR threshold, not an activity checklist.*
