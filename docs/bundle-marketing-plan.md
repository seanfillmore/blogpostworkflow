# Bundle marketing plan

Go-to-market for the bundle roster. Economics live in [`bundle-economics.md`](./bundle-economics.md) (generated — don't hand-edit); the reasoning behind the roster lives in [`bundle-strategy-handoff.md`](./bundle-strategy-handoff.md). This document answers the question those two don't: **who do we sell each bundle to, through which channel, with what promise, and how do we know it worked.**

Written 2026-07-25.

---

## 1. The rules every playbook obeys

**1. Bundles exist to escape per-unit comparison, not to discount.**

Amazon SQP measured the generic lotion market clearing at $10–16 against our $30, and category demand collapsing to 0.3% of volume above $25. A 3× price gap cannot be closed by bidding, and it cannot be closed by being premium. It is closed by changing the unit of purchase: a quarter's supply isn't compared against a $10 lotion, it's compared against running out.

The operative consequence is a copy rule. **Every bundle leads with duration or completeness — never with savings-vs-single.** "A quarter of coconut, handled" survives comparison shopping. "Save $19" invites the shopper to compute a per-unit price and put us back next to the $10 bottle. Compare-at pricing stays on the PDP because Shopify shows it and it does real work at the moment of purchase; it just never leads the headline, the ad, or the subject line.

**2. Lotion and cream ship two scents only: Pure Unscented and Coconut Breeze.**

Both products currently carry five (`config/ingredients.json`). Until there's traction, every bundle containing a lotion or cream offers those two and no others. This is a merchandising decision, not a stock decision — production can scale.

It pays for itself three times: two SKUs to photograph and feed instead of five, a variant picker short enough not to stall the buy box, and consistency with the live Google Shopping test, which already runs on exactly Pure Unscented and Coconut Breeze. Other scents are reintroduced as a *deliberate expansion* once a bundle has proven demand, not as a default.

Scoped to lotion and cream only. Bar soap keeps four scents — the 4-pack's whole structure is one-of-each versus four-of-one. Deodorant keeps its range because it has neither Unscented nor Coconut Breeze to narrow to.

**3. The $45 free-shipping threshold is the on-site AOV mechanic, and it's already live.**

Nine of eleven bundles clear $45 unaided. Freight is paid once per order regardless of size, which is the entire reason order size beats price as a lever: $159 nets $100, $34 nets −$1.65. Every bundle page and cart should make the threshold visible, because the gap between a $39 cart and a $46 cart is the cheapest margin in the business.

**4. Retention is the constraint, not traffic — and that is also what the tracking gate permits.**

22.5% of customers repeat and they produce 52.0% of revenue, at a $52.10 AOV against $39.44 for one-time buyers (measured 2026-07-25, section 5). The highest-confidence bundle revenue available right now is owned-audience and replenishment, not acquisition. That happens to align with the `Tracking → CRO → Offer/AOV → Traffic` sequence: **paid acquisition is held for every bundle until GA4/Ads tracking is trustworthy**, regardless of how good the contribution math looks. Bundles at ≥2× CAC are marked paid-*eligible* below, meaning they go live on paid the moment the gate clears — not before.

---

## 2. Build order

Sorted by readiness × contribution, not by contribution alone. Inventory is **not** a gate — production scales. The only real gates are build effort and, for paid, tracking.

| # | Bundle | Status | Price | Contribution | CAC | Gate | Priority |
|--:|---|---|--:|--:|---|---|---|
| 1 | 90-Day Coconut Reset | draft | $99 | $68.06 | ✅ 2.7× | Build: publish + prune to 2 scents | **Ship this week** |
| 2 | Sensitive Skin Set | **live** | $46.80 | $28.38 | 🟡 1.1× | None — optimize in place | **Ongoing** |
| 3 | Bar Soap 4-Pack | draft | $39 | $17.78 | 🟠 0.7× | Build: publish + detach single-bar subs | **Ship this week** |
| 4 | 90-Day Clean Swap | proposed | $159 | $100.85 | ✅ 4.0× | Build: componentize + lander | **Next** |
| 5 | Head-to-Toe | proposed | $105 | $64.29 | ✅ 2.6× | Build: componentize + lander | **Next** |
| 6 | Pump 4-pack + Lotion | proposed | $72 | $39.82 | 🟡 1.6× | Build | Then |
| 7 | The Clean Swap | proposed | $59 | $34.06 | 🟡 1.4× | Build | Then |
| 8 | Pump 3-pack + Lotion | proposed | $59 | $31.46 | 🟡 1.3× | Build | Then |
| 9 | Pump 4-pack | proposed | $44 | $17.55 | 🟠 0.7× | Build | Attach only |
| 10 | Gift Box | proposed | $62 | $35.32 | 🟡 1.4× | Build by mid-September | Q4 |
| 11 | Two-Step Starter Set | draft | $39.99 | $21.77 | 🟠 0.9× | — | **Retire** |

**Not marketed, retire:** Pump + Refill (−$1.65) and Foam Soap Bundle (−$19.48) both lose money per order. The Foam Soap Bundle is a live draft and **must not be published**. Neither gets a playbook; the decision is to remove them, not to sell them better.

CAC target is $25. ✅ = ≥2× CAC (scalable on paid once tracking clears), 🟡 = ≥1× CAC (owned/organic/warm traffic), 🟠 = below CAC (attach and reorder only — never a paid destination).

---

## 3. Playbooks

### 1. 90-Day Coconut Reset — $99

- **Economics** — $68.06 contribution, 2.7× CAC, paid-eligible. See `bundle-economics.md`.
- **Buyer** — The lotion customer who has already repurchased at least once. They've demonstrated the product works for them and their real problem is running out, not choosing. Today they buy a $30 lotion three times a year and lapse in between.
- **Angle** — *A quarter of coconut, handled.* Duration is the entire pitch. The $118 anchor sits on the PDP; it never leads.
- **Channels** — Primary: Klaviyo replenishment flow (`TAfpnV`) and post-purchase flow (`VLQaYZ`), targeted at buyers with ≥1 prior lotion order. Secondary: the existing lander, plus a slot in the coconut collection. Paid: eligible, held for tracking.
- **Offer mechanics** — $99 against a $118 anchor. Ships free unaided. Digital bonus PDFs delivered by Klaviyo flow `XEMgA7`. Two scents.
- **Assets** — Lander is done and the delivery flow is live. Needs: prune variants to Pure Unscented + Coconut Breeze, flip draft → active, port the Set's 131 Judge.me reviews as social proof, one test order to confirm the bonus email fires.
- **Gate** — Build only, roughly an hour. The three-zero-stock blocker in the handoff is dissolved by the two-scent rule: Pure Unscented and Coconut Breeze are precisely the two that were buyable.
- **Success metric** — Contribution per order $68. Primary read is the repeat-rate delta between lotion buyers who take the Reset and those who don't — this bundle is a retention instrument first and an AOV instrument second.

### 2. Sensitive Skin Set — $46.80 (live hero)

- **Economics** — $28.38, 1.1× CAC. Warm traffic only until it earns more headroom.
- **Buyer** — First-time buyer arriving on the sensitive-skin and fragrance-free intent that RSC already ranks for. Doesn't yet trust the brand and won't spend $99.
- **Angle** — *The two things that fix dry, reactive skin — and nothing that irritates it.* Completeness, not duration; at two units the duration story isn't credible.
- **Channels** — Organic (it already ranks), the welcome flow, and site-wide as the default entry offer. This is the hero and it should not be rebuilt — it already clears $45 free shipping on its own, which is why the threshold was set at $45.
- **Offer mechanics** — $46.80 against $58. `SETSHIP` free-shipping code for email. 131 Judge.me reviews — the strongest social proof in the catalog.
- **Assets** — All live. Ongoing work is CRO, not construction: above-the-fold buy path, review placement, threshold messaging.
- **Gate** — None.
- **Success metric** — Conversion rate on the lander, and the share of new customers whose first order is the Set rather than a single SKU. Every first order that starts here instead of at a $30 lotion is +$11 contribution.

### 3. Bar Soap 4-Pack — $39

- **Economics** — $17.78, 0.7× CAC. **Never a paid destination.** It is a subscription vehicle.
- **Buyer** — Existing customer on any product. Bar soap is a terrible standalone ($11 nets ~$1 after freight) and an excellent subscription because it is nearly weightless and consumed on a predictable cycle.
- **Angle** — *Four bars, four months, one box.* Cadence is the pitch.
- **Channels** — Post-purchase flow and replenishment flow only. Cross-sell module on other PDPs. Not a landing page, not a paid target, not a collection hero.
- **Offer mechanics** — $39 against $44, on selling plan group `BARSOAP_4MO` — every 4 months, 15% off, per the flat-15% rule. Five variants: variety, or four of one scent.
- **Assets** — Componentized and inventory-tracked. Needs: publish, plus a cross-sell placement in the post-purchase flow.
- **Gate** — Build, plus one cleanup: the single-bar monthly subscription plans are **still attached to `coconut-soap`** and lose $1.41 per shipment. Detaching them requires `read_own_subscription_contracts` to check for existing subscribers first. Until that's done, the money-losing option is still purchasable — this is the highest-value item on the list relative to its effort.
- **Success metric** — Subscribers converted from single-bar monthly to 4-pack quarterly. Each conversion is +$53/yr (−$16.92 → +$36.30).

### 4. 90-Day Clean Swap — $159

- **Economics** — $100.85, 4.0× CAC. Best in the catalog. Paid-eligible.
- **Buyer** — The committed switcher: someone replacing conventional personal care wholesale, not trialing one product. Small audience, very high value.
- **Angle** — *Replace the four things you put on your body every day, for a quarter.* Completeness and duration together — the only bundle that earns both.
- **Channels** — When tracking clears, this is the bundle that can absorb the $2–5 CPCs that premium-intent search actually costs, and it is the correct paid destination instead of the $30 lotion. Before then: email to the most engaged segment, and the "clean swap" / "switch to natural" organic cluster.
- **Offer mechanics** — $159 against $207. Ships free. Uses the whole SKU range, which is what makes the margin work — deodorant, toothpaste and soap are 73–74% margin at near-zero marginal freight.
- **Assets** — Everything. Componentized bundle, collection, dedicated lander, creative. This is the largest build on the list and it is worth it.
- **Gate** — Build for owned channels; tracking for paid.
- **Success metric** — Contribution per order $101, and the 30-day gross profit per acquired customer against the $25 CAC. This is the bundle that determines whether paid acquisition is viable at all.

### 5. Head-to-Toe — $105

- **Economics** — $64.29, 2.6× CAC. Paid-eligible.
- **Buyer** — The discovery buyer who wants to try the brand broadly, and the generous gifter outside Q4.
- **Angle** — *One of everything.* Breadth, not duration — it's a sampler at scale.
- **Channels** — Email to non-lapsed buyers who've purchased exactly one category. Organic on brand and "natural body care" terms. Paid-eligible after the gate.
- **Offer mechanics** — $105 against $125. Ships free. Seven units, 2.24 lb — still a $7.83 box.
- **Assets** — Componentized bundle, collection entry, PDP with strong photography (breadth has to be *seen*), email.
- **Gate** — Build.
- **Success metric** — Contribution $64/order, and second-order rate — a sampler's job is to find each buyer their repeat SKU.

### 6. Pump 4-pack + Lotion — $72

- **Economics** — $39.82, 1.6× CAC. Warm traffic.
- **Buyer** — Household stocking every sink, who also uses lotion. The lotion is what makes the math work: pumps alone are 67% margin and 10 oz each, so four need a real box.
- **Angle** — *Every sink in the house, plus the lotion you already reorder.*
- **Channels** — Email and on-site cross-sell. Not paid — 1.6× is too thin to absorb premium-intent CPCs.
- **Offer mechanics** — $72 against $82, a shallow 12%. Keep the discount shallow; contribution is sensitive to it.
- **Assets** — Componentized bundle, PDP, email placement.
- **Gate** — Build.
- **Success metric** — AOV lift versus the pump 4-pack alone (+$22 contribution).

### 7. The Clean Swap — $59

- **Economics** — $34.06, 1.4× CAC. Warm and organic.
- **Buyer** — Interested in switching but not ready for $159. This is the on-ramp to bundle #4.
- **Angle** — *Start the swap.* Explicitly positioned as the entry version, with the 90-day as the upgrade.
- **Channels** — Organic "clean swap" cluster, welcome flow, and as the step-down offer when the $159 doesn't convert.
- **Offer mechanics** — $59 against $69. Ships free. Turns three weak singles into real margin.
- **Assets** — Componentized bundle, collection entry, shares the 90-day's lander narrative.
- **Gate** — Build. Sequence after #4 so it inherits that positioning rather than competing with it.
- **Success metric** — Upgrade rate to the 90-day on second order.

### 8. Pump 3-pack + Lotion — $59

- **Economics** — $31.46, 1.3× CAC. Warm only.
- **Buyer** — Smaller household; the same buyer as #6 with fewer sinks.
- **Angle** — *Three sinks and the lotion.*
- **Channels** — On-site cross-sell only. **Do not** give this its own campaign — it overlaps #6 almost entirely and two near-identical pump bundles will cannibalize.
- **Offer mechanics** — $59 against $69.
- **Assets** — Componentized bundle and a PDP. Nothing more.
- **Gate** — Build. Lowest priority of the pump family; ship only if #6 proves demand.
- **Success metric** — Incremental orders, not total. If it merely absorbs #6's buyers at $8 less contribution, retire it.

### 9. Pump 4-pack — $44

- **Economics** — $17.55, 0.7× CAC — and that's at full $52 MSRP, where it contributes $25.32 and barely clears CAC. Discounted to $44 it sinks to $17.55.
- **Buyer** — Existing customer reordering hand soap.
- **Angle** — *One per sink.*
- **Channels** — Reorder and AOV only: post-purchase, replenishment, cart cross-sell. **Never paid acquisition, never a landing page.** Four pumps at 10 oz need a real box, which is what eats the margin.
- **Offer mechanics** — Keep the discount shallow or drop it. Any discount sinks this below CAC.
- **Assets** — Componentized bundle and a PDP.
- **Gate** — Build.
- **Success metric** — Attach rate on existing orders. If it isn't attaching, it has no reason to exist.

### 10. Gift Box — $62

- **Economics** — $35.32, 1.4× CAC — but gifting escapes price comparison entirely, so this is the one bundle whose ceiling isn't set by the Amazon clearing price.
- **Buyer** — Q4 gift shopper, buying for someone else. Doesn't know our per-unit prices and isn't comparing them.
- **Angle** — *A gift that gets used up.* Presentation carries this one; the value stack doesn't.
- **Channels** — Seasonal email, organic gift-guide terms, and paid social where gifting intent is cheap. Q4 only.
- **Offer mechanics** — $62 against $71. Ships free. 1.06 lb — a bubble-envelope-class package with a $71 anchor, which is the best weight-to-value ratio in the roster.
- **Assets** — Packaging design, lifestyle photography, gift-guide outreach, collection. Longest lead time of any bundle here.
- **Gate** — **Build by mid-September.** Q4 creative and gift-guide placements are committed early; missing that window costs the whole season.
- **Success metric** — Q4 contribution, and new-customer share (gift buyers are new customers by definition).

### 11. Two-Step Dry Skin Starter Set — $39.99 — **retire**

- **Economics** — $21.77, 0.9× CAC.
- **Disposition** — Same contents as the Sensitive Skin Set at a deeper discount (31% vs 19%), earning $6.61 less per order. It is a strictly worse version of the live hero, and having both splits traffic and reviews across duplicate pages.
- **Action** — Unpublish and 301 to the Sensitive Skin Set. If a genuinely different second SKU pairing is wanted later, build it then — don't preserve this one to avoid the decision.

---

## 4. Channel matrix

| Channel | Carries | Must not carry |
|---|---|---|
| **Klaviyo — post-purchase (`VLQaYZ`)** | Bar Soap 4-Pack, Pump 4-pack, Coconut Reset | Anything requiring a cold pitch |
| **Klaviyo — replenishment (`TAfpnV`)** | Coconut Reset, Bar Soap 4-Pack, Pump 4-pack | New-customer bundles |
| **Klaviyo — welcome** | Sensitive Skin Set, The Clean Swap | $159 Clean Swap (too steep cold) |
| **Collections + organic SEO** | Sensitive Skin Set, both Clean Swaps, Head-to-Toe, Gift Box | Pump bundles (no search demand) |
| **On-site cross-sell / cart** | All pump bundles, Bar Soap 4-Pack | — |
| **Paid — held until tracking clears** | 90-Day Clean Swap, Coconut Reset, Head-to-Toe (the ✅ tier only) | **The single $30 lotion.** Every 🟡 and 🟠 bundle. |
| **Amazon** | Nothing yet — see below | — |
| **Google Shopping feed / Meta catalog** | ⚠️ **nothing — see below** | every componentized bundle |

Two standing prohibitions, both already costing money:

**Never send paid traffic to the single $30 lotion.** It produced 27 clicks and zero sales on generic lotion terms. It is an anchor SKU (3 × $30 + $28 = $118, which is what makes $99 read as an offer) and a reorder unit. `agents/shopping-calibrator` runs Sundays and auto-negates queries whose market clears below 60% of our price, which contains the bleeding but doesn't fix the destination.

### ⚠️ Componentized bundles cannot enter the Shopping feed or Meta catalog

Verified 2026-07-26. Publishing the Clean Swap or Head-to-Toe to either channel is rejected outright:

```
Channel Google & YouTube does not support variant-fixed bundles
Channel Facebook & Instagram does not support variant-fixed bundles
```

This is a Shopify platform limit on native (variant-fixed) bundles, not a settings problem. The 90-Day Reset shows as published to both channels because it predates its componentization; do not read that as proof the restriction can be worked around.

**This changes how paid traffic reaches bundles.** They cannot be Shopping listings or catalog items. Paid to a bundle has to be Search, Performance Max with a page feed, or Meta traffic ads pointing at the product URL — never a product/catalog ad.

That is not fatal: the marketing plan already sends paid to bundle *landing pages* rather than to a feed. But it removes Shopping as an option for the ≥2× CAC bundles, which was the assumed vehicle. It also means the single $30 lotion and other simple SKUs remain the only Shopping-eligible products — and per section 1, the lotion is exactly what should never be a paid destination.

Worth resolving before spending: either accept Search/PMax-to-lander only, or rebuild a bundle as a plain SKU with its own inventory (which forfeits component-level stock tracking, and the 4-pack was rebuilt *away* from that for good reason).

**Amazon is out of scope for bundles this cycle**, with one exception worth noting: the lotion sells there at $21.99 against $30 on Shopify. Testing a step-up on Amazon is a separate, higher-leverage piece of work than porting bundles to a price-comparison surface where the whole bundle thesis is weakest.

---

## 5. Measurement

**Attribution.** `agents/seo-impact` attributes Shopify revenue to pages and clusters. Its organic-dollar figures are known to be unreliable — reported organic has exceeded total Shopify revenue — so **use it directionally and reconcile against Shopify orders** before acting on any number from it.

**The four numbers that decide whether this worked**, reviewed monthly:

| Metric | Baseline | Why it's the right measure |
|---|---|---|
| AOV | **$50.46** (trailing 90d, 49 orders) | Bundles are an AOV instrument first. This is the headline. |
| Repeat rate | **22.5%** of customers, **52.0%** of revenue (trailing 365d) | Retention is the constraint. The Reset and Bar Soap 4-Pack are aimed squarely here. |
| Bundle share of orders | establish at launch | If bundles aren't displacing single-SKU orders, the merchandising isn't working. |
| Contribution per order | per `bundle-economics.md` | Dollars, not clicks. |

### The AOV baseline, settled

Measured 2026-07-25 from a full paginated pull of every Shopify order — `node scripts/aov-analysis.mjs [days]`.

| Window | Orders | AOV |
|---|--:|--:|
| Last 30 days | 13 | $55.65 |
| **Last 90 days** | **49** | **$50.46** |
| Last 180 days | 104 | $48.95 |
| Last 365 days | 182 | $45.14 |

**Use $50.46 as the pre-bundle baseline**, with the trailing-365 figure of $45.14 as the conservative comparator. The 90-day window is the right one because the store has a structural break: AOV ran high-$20s to low-$30s through mid-2025 and stepped to the mid-$40s from September 2025 onward, where it has stayed for eleven straight months. Averaging across that break produces a number describing no actual period. The 90-day window is also almost entirely *before* the $45 free-shipping threshold went live on 2026-07-25, so it is a clean pre-treatment baseline. Caveat honestly: 49 orders is small, so read monthly AOV as a trend, never a single month as a verdict.

**Both figures on record were right, about different things.** $19 is real — it is May–June 2024, when the store did 297 orders at ~$19.3. June 2024 alone was 239 orders, **37% of every order in the store's history**, so any all-time average is still dragged down to roughly $19 by one promotional month more than two years old. ~$46 is the current business. The trap is that `lib/shopify.js getOrders()` caps at `limit=250` with no Link-header pagination, so any query spanning that spike either truncates or silently over-weights it. `scripts/aov-analysis.mjs` paginates properly, which is why it can separate the two.

Two related numbers worth carrying forward, both from the same pull:

- **Repeat is stronger than recorded.** 22.5% of customers repeat (not 18%) and they produce 52.0% of revenue (not 45%), at a $52.10 AOV against $39.44 for one-time buyers. Retention being the constraint is *more* true than the earlier figures suggested, not less.
- **16.5% of orders are comped** — 36 of 218 in the last year, at $0.00. Combined with the handoff's finding that comped orders average $8.81 freight versus $7.33 overall, that is roughly $317/yr of pure freight cost. Excluding them is why the "all orders" AOV reads $38.04 against the true $45.14; any AOV number quoted without saying whether comps are in is unusable.

### What this changes about the plan

**AOV is already ~$50, which reprices what each bundle is actually for.** A bundle below the current AOV cannot be an AOV instrument — it *dilutes* the average even while selling well.

- **AOV-accretive** (above $50.46): 90-Day Clean Swap $159, Head-to-Toe $105, 90-Day Coconut Reset $99, Pump 4-pack + Lotion $72, Gift Box $62, The Clean Swap $59, Pump 3-pack + Lotion $59.
- **Not AOV instruments** (at or below baseline): Sensitive Skin Set $46.80, Pump 4-pack $44, Two-Step $39.99, Bar Soap 4-Pack $39. These are first-order conversion and retention plays, and they should be judged on repeat rate and attach rate — never on AOV, which they will correctly appear to hurt.

This is consistent with how each is positioned in section 3, but it means **the monthly review must segment AOV by whether an order contained an accretive bundle.** A blended AOV number will show the Bar Soap 4-Pack succeeding as a failure.

**The daily snapshot feed is healthy — read it on the server, not in your checkout.** `data/snapshots/` is gitignored and written by cron on the production box. The shopify feed has 112 days through 2026-07-24 and reconciles to the cent against a direct order pull (07-13: 2 orders/$82.83; 07-16: 1/$58.52; 07-17: 1/$132.00; 07-19: 2/$75.18; 07-20 through 07-24 genuinely had no orders). Zero-order days are real, not gaps — the store averages ~0.5 orders/day.

A local checkout showing six files ending 2026-03-23 is the expected state and is **not** evidence of a broken collector. Those six were committed once before the ignore rule took effect and then froze, which made a healthy feed look dead. They have been untracked so the directory is uniformly ignored.

**Judge feed health on the server:** `ssh root@137.184.119.230 'ls -t ~/seo-claude/data/snapshots/shopify | head'`.

**Kill criteria.** A bundle is retired if, after 90 days live with its assets actually built:

- it has produced fewer than 5 orders, **or**
- its buyers overlap >80% with a higher-contribution bundle (pure cannibalization), **or**
- realized contribution falls below the modeled figure by more than 25%, which means the freight or discount assumption was wrong.

Retiring is unpublish plus a 301 to the nearest surviving bundle — never leave a dead bundle page live to split traffic.

**Re-run `node scripts/bundle-economics.mjs --write` before each monthly review.** Freight is pulled live from measured labels; COGS and weights come from Shopify. The numbers in this plan are only as current as that file, and the whole point of generating them is that they move.

---

## 6. Open decisions

1. **Foam Soap Bundle** — still a live draft at −$19.48/order. Delete it, or reprice to $52 at 0% discount, which makes it pointless. Recommend delete.
2. **Subscription plan sprawl** — every product carries 3–4 overlapping selling plan groups from two apps, so customers see competing options. Three plans remain at 10% and must be fixed in the Recurpay admin UI; the API cannot reach them safely.
3. **Google feed title** — currently leads with "Coconut Body Lotion", the exact term the price data says we lose on. Changing it trades organic ranking for feed relevance and needs GSC data first.
4. **Deodorant scent range** — narrowed for lotion and cream only. Whether deodorant's four scents should also be pruned is unresolved; it has no Unscented or Coconut Breeze to narrow to, so it needs its own decision.
