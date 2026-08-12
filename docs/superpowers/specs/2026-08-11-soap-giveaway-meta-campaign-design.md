# 30-Day Meta Giveaway — "36 Free Bars" → Email → Soap BOGO

**Date:** 2026-08-11
**Status:** design approved, ready for implementation plan
**Branch:** `feature/soap-giveaway-meta-campaign`

## 1. What this is, and what it is not

A 30-day Meta ads campaign that gives away **Pure Unscented** bar soap to build the Klaviyo list, monetising entrants immediately with a buy-X-get-X-free soap offer. Single variant, single angle: **fragrance-free for reactive skin.**

**It is a lead-generation play. It will not pay for itself in 30 days.** Total cost is $1,895 ($1,500 ad spend + $395 prize). Breakeven needs 47–76 orders depending on tier mix — roughly a 9–10% entrant-to-buyer take rate. A realistic take rate for an on-message consolation offer with a deadline is 3–8%, so the expected outcome is **$600–1,100 underwater at day 30**, with ~600 confirmed, segmented subscribers and a first-party survey corpus as the residual asset.

Judging this on 30-day ROAS will misread a working campaign as a failure. The primary metric is **cost per confirmed, segmented email ≤ $3.50**.

**All revenue lands in a single 7-day window starting on day 30.** The offer is the consolation prize for not winning, so nothing is sold during the campaign itself (§7.1). That means $1,500 goes out over 30 days against ~$0 in, and **the evaluation date is ~day 40** — a day-30 report shows pure spend by construction.

### Why this fires while the CVR gate is red

The standing sequencing rule is Tracking → CRO → Offer/AOV → Traffic, and Gate 2 has regressed (true CVR ≈0.48%, down from 0.82–0.85%). This campaign routes around site CVR rather than depending on it: the optimisation event is an email, and the money step is a one-tap cart permalink, not a cold PDP. That is a genuine defence, but it is a defence — the gate did not turn green.

## 2. Decisions

| Decision | Choice | Why |
|---|---|---|
| Prize term | **3 years** | Per-winner ARV $536.40, under the $600 1099-MISC threshold. No W-9 paperwork. |
| Prize contents | 36 bars + 3 Sensitive Skin Sets | Soap hook for reach; the Sets put the $25-contribution product in the winner's hands as a review/UGC source. |
| Product | **Pure Unscented only** (variant `45828179951786`) | 1,200-bar unscented production run is in progress; all effort focuses there. |
| Angle | **Fragrance-free / reactive skin** — persona 3, `p3a1` | Review-proofed for this exact SKU, and it attracts the Sensitive Skin Set buyer rather than a generic soap-seeker. |
| Ad hook | **"Most 'unscented' soap isn't. Ours is — and we're giving away 36 bars."** | Leads with the differentiating objection rather than the prize. Stated as a category callout, not a claim about the viewer's skin, which keeps it clear of Meta's personal-attributes rule. 12 bars/year covers only 8–10 months, so "3 Years of Free Soap" is not used. |
| Referral prize | Winner's referrer also wins | Bounded at 2 winners. Emotionally shareable: "if you win, your friend wins too." |
| Consolation offer | Two tiers, $99 hero | $99 is the only tier where "6 months free" is literally true, and it cuts breakeven from a 12.7% take rate to 7.8%. |
| **Offer timing** | **Day 30 only — after the draw** | The offer *is* the consolation prize for not winning. Releasing it at entry spends it before it has a story, and signals the prize wasn't the point. See §7.1. |
| Ad budget | $1,500 / $50/day flat | Enough Lead volume to exit learning; small enough that a failed test costs ~2 months of Shopify revenue. |
| Optimisation event | **Lead**, not Purchase | At 0.48% CVR and ~18 orders/month, purchase optimisation can never reach ~50 events/week per ad set. At $2.50 CPL, $50/day yields ~140 leads/week. |
| Entry mechanic | Weighted, with a 6-rung bonus ladder | Referral bonus entries are the only mechanic that makes CPL fall across 30 days rather than rise with saturation. |
| Social bonus | **Instagram only** | Facebook policy prohibits using personal Timelines to administer promotions. See §8. |

## 3. Verified facts this design rests on

Everything below was pulled live or from `origin/main` on 2026-08-11, not assumed.

| Fact | Value | Source |
|---|---|---|
| Bar soap price / COGS | $11 / ~$2.40 | `products/coconut-soap.js`; COGS from the 1M growth-plan spec |
| **Soap consumption** | **25 days/bar, range 20–30** | `config/consumption-rates.json` — merchant estimate, supersedes the old 47-day reorder gap |
| **Pure Unscented variant ID** | **`45828179951786`** | live `.js` endpoint |
| ⚠️ **Default variant trap** | The product's `defaultVariantId` is `44179485655210` = **Calming Lavender**, not unscented. A cart permalink built from the default ships the wrong soap to every buyer. | live `.js` endpoint |
| Unscented production run | **1,200 bars**, in progress as of 2026-08-11. A second run is planned; size and timing not yet supplied. | Sean, 2026-08-11 |
| Sensitive Skin Set | $46.80 (reg $58), ~$25 contribution, 131 reviews | `config/bundles.json`, growth-plan spec |
| Set sales | **1 order in 90 days** | growth-plan roadmap status, 2026-08-03 |
| Free shipping threshold | **$45** | live announcement bar |
| Existing promo code | `NEWCUSTOMER` — free shipping on $25+ | live announcement bar |
| Klaviyo list | ~481 subscribers, 7 live flows, SMS 0 | growth-plan spec |
| Google Ads benchmark | $208 / 232 clicks = **$0.90 CPC**, 0 conversions | growth-plan roadmap status |
| Meta pixel | **Does not exist.** Zero `fbevents` / `connect.facebook.net` / `fbq(` on homepage or two PDPs | live curl, 2026-08-11 |
| `lib/klaviyo.js` | Templates + flows only. **No list creation, no profile writes.** | `origin/main` |
| `lib/shopify.js` | Has `createPage`, `updatePage`, `getMainThemeId`, `updateThemeAsset`, `shopifyGraphQL`, `uploadImageToShopifyCDN` (image-only) | `origin/main` |
| Duration guardrail | `assertDurationClaim()` in `lib/supply-duration.js` | `origin/main` |

## 4. Prize and unit economics

### Grand prize (×2 winners: drawn entrant + their referrer)

- 36 bars of **Pure Unscented** Moisturizing Coconut Soap over 3 years — 3 shipments/year of 4 bars
- 3 Sensitive Skin Moisturizing Sets (both components are already Pure Unscented per `config/bundles.json`)

**The entire prize is one coherent fragrance-free proposition** — 36 unscented bars plus 3 unscented sets — rather than a soap hook with skincare bolted on. This is what makes the stack read as a single thing on the lander.
- **ARV $536.40/winner** ($396 soap + $140.40 sets)
- **Cost ~$197/winner:** soap COGS $86.40 + 9 shipments ≈ $54 + sets COGS $33 + 3 shipments ≈ $24
- **Total prize cost ≈ $395. Total ARV across both winners $1,072.80.**

### Consolation offer

| Tier | Price | Bars | COGS | Ship | Fees | **Contribution** | Honest duration of the free half |
|---|--:|--:|--:|--:|--:|--:|---|
| Floor | $66 | 12 | $28.80 | ~$10 | $2.21 | **$24.99** | 4 months |
| **Hero** | **$99** | **18** | $43.20 | ~$12 | $3.17 | **$40.63** | **6 months** |

At 20 days/bar (the conservative end of the merchant range), 9 free bars = 180 days = 6 months. 6 free bars = 120 days = 4 months. **"Buy 6, get 6 free = 6 months free" overstates supply by 33% and must not ship.**

The floor tier's $24.99 contribution ties the Sensitive Skin Set — from a SKU whose single-unit contribution is $2.40. This is not a violation of the "soap is never a cold-paid front end" rule; that rule prices one bar. Eighteen bars is a different offer on the same SKU.

### Inventory is the binding constraint, and it binds near breakeven

Each redemption consumes 12 or 18 bars, so the offer is rate-limited by the unscented run in a way no previous campaign has been.

| Consumer | Bars |
|---|--:|
| Prize, year 1 (12 bars × 2 winners) | 24 |
| Normal retail sell-through during the window | **input needed** |
| Remainder available to the offer | balance of 1,200 |

Against the full 1,200 less a 24-bar prize reserve, ~1,026 bars supports roughly **57 redemptions at all-$99, 85 at all-$66, ~66 at a 60/40 mix** — against a breakeven of 47–76 orders. **Inventory therefore binds at almost exactly the point where the campaign starts working.** An offer that converts better than breakeven produces a stockout, mid-campaign, while ads are still spending.

**Deferring the offer to day 30 largely defuses this** (§7.1). Because every redemption lands after the ads are off, the entrant count is known before a single bar is committed, so the bar budget becomes a **one-time sizing decision on draw day** rather than a live race against spend. The catastrophic version — ads running against an offer that cannot be fulfilled — is structurally impossible.

What remains is a bounded sizing problem: on draw day, set the two discount codes' usage limits from bars actually available. If the entrant count implies more demand than the run supports, the constraint is the *tier mix* offered, not an emergency.

A second production run is planned, so **no scarcity claim ships** — an "only N left" line that a second run falsifies is the same class of error as an overstated duration.

**With bars as the scarce input, the correct ranking metric is contribution per bar, and it confirms the tier choice:** $99/18 bars = **$2.26/bar** vs $66/12 bars = $2.08/bar. The $99 hero survives the constraint check.

## 5. Funnel

```
Meta ad — "Most 'unscented' soap isn't. Ours is."
  → /pages/free-soap-giveaway    lander: hook, prize value stack, entry form, rules, draw countdown
  → /pages/giveaway-entered      3 required questions → entry-ladder widget → full-price store links
                                 NO OFFER HERE — the offer is the consolation prize (§7.1)
  → Klaviyo confirmed opt-in     tease → resell the list → THEN confirm entry
  → segmented nurture            6 sends over 30 days, CTA = ladder actions, not selling
  → Day 12-15                    one full-price Set send to reactive/fragrance segment
  → Day 30: draw                 winner + winner's referrer
  → /pages/giveaway-offer         published draw day. 7-day window, 3 sends.
                                 THE ENTIRE REVENUE EVENT.
  → Day 90: sunset non-openers
```

A sweepstakes produces 2 winners and ~598 losers, and all revenue comes from what the losers are handed. The decision here is **when** to hand it over: at day 30, framed as the consolation prize, rather than at entry. §7.1 sets out what that trades away and what it buys.

## 6. Entry, questions, and the bonus ladder

### Step 1 — the lander form (the Meta `Lead` event)

Email, first name, and an optional "referred by a friend? their email". Nothing else. Every extra field on a cold lander costs opt-in rate.

### Step 2 — three required questions, on the entered page, above the offer

Single-tap, no typing, ~15 seconds.

| # | Question | Options | What it decides |
|---|---|---|---|
| 1 | Who's the soap for? | just me / me + partner / family of 3+ / a gift | Sizes the offer and **gates the duration claim** |
| 2 | Your #1 skin frustration? | dry & flaky / itchy & reactive / fragrance sets me off / ingredient concerns | Nurture routing. Tightened to the fragrance-free angle — every option now maps to a product, so there is no "just here for the soap" escape hatch |
| 3 | What are you using now? | CeraVe / Cetaphil / Dove / Dr. Squatch or Native / a natural brand / whatever's on sale | Competitor displacement map |

**Q1 gates the duration claim on the day-30 offer.** A bar lasts 20–30 days for one person and materially less shared across four, so `gv_household` decides which version of the offer that entrant is shown 30 days later, in both the email and on the offer page:

- *just me / me + partner* → "18 bars — **6 months free**"
- *family of 3+* → "18 bars — a bar in every shower, restocked" (**no months claim**, because it would not be true)

Deferring the offer to day 30 (§7.1) removes the friction argument these questions previously had to justify: with nothing to buy on this page, the questions cost no revenue at all. They are now the only ask on the page besides the ladder, which is strictly simpler.

Q3 is the highest-value question in the campaign. The rival set (CeraVe / Vanicream / Cetaphil) currently rests on qualitative Judge.me and Reddit mining; this tests it against n≈600 first-party answers.

**The fragrance-free angle largely dissolves the lead-quality risk.** The original concern was that a soap giveaway attracts prize-seekers rather than the buyer whose contribution is $25. A fragrance-free / reactive-skin angle attracts precisely the Sensitive Skin Set buyer, and both Set components are already Pure Unscented — so the cross-sell in §7 is coherent rather than bolted on. Q2's options were tightened accordingly: every answer now maps to a product, with no "just here for the soap" escape hatch.

### Step 3 — three optional questions, revealed after the required three and repeated in email

| # | Question | What it decides |
|---|---|---|
| 4 | What stopped you switching to natural before? | Objection inventory → PDP copy, FAQ, ad angles |
| 5 | What else do you buy? *(multi-select)* | Cross-sell map — could settle the toothpaste cluster (32 pages, ~$0) with demand data instead of GSC impressions |
| 6 | **Have you ever reacted to something labelled "unscented"?** *yes, more than once / yes, once / no / not sure* | **Validates or kills `p3a1` as the lead objection at n≈600.** Scent preference is moot on a single-variant campaign; this replaces it and is worth far more |

Plus an optional phone field: *"Want a text the moment we draw the winner?"* SMS sits at 0 subscribers and the draw is a genuine reason-why.

All answers stored as Klaviyo profile properties prefixed `gv_` so they are natively segmentable and greppable. The corpus should also flow into `data/context/voice-of-customer.md`, which is currently built from qualitative sources only.

### The bonus-entry ladder

| Action | Entries | Verification |
|---|--:|---|
| Enter your email | 1 | automatic |
| Confirm your email (double opt-in click) | +2 | automatic — and it buys deliverability |
| Answer the 3 optional questions | +3 | automatic |
| **Refer a friend who confirms** | **+5 each, max 10 friends** | async, nightly reconciliation |
| Post & tag @realskincare on Instagram | +3 | handle field, honour system, spot-check |
| Upload a photo/video with usage rights | +10 | automatic |

Maximum ≈69 entries. Referral at +5 capped at 10 is the lever that makes CPL fall across the 30 days. It stacks with the prize structure: *"Refer a friend — you get 5 entries, and if you win, they win too."*

**The upload is worth more than the tag.** A tagged Instagram post gives reach but no licence to use the asset. The upload, with a usage-rights checkbox, produces a licensed target-demo creative — a documented gap, since the founder is not the target demo.

**Purchases never earn entries.** This is the line that keeps the promotion a sweepstakes rather than a lottery, and it matters because a $99 offer appears seconds after entry.

## 7. Offer stack

Everything adds value; nothing discounts the Set.

### 7.1 The offer runs once, at the end

**There is no offer at entry.** The BOGO is the consolation prize for not winning, released only after the draw. This is a deliberate reversal of the obvious design, and it trades a real asset for three real gains.

**What it costs:** the second after submit is the highest-motivation moment in the funnel, and it now goes unused for revenue. It also means **no in-flight revenue signal** — the full $1,500 is spent before anyone learns whether the offer converts, so a broken offer surfaces on day 30 with the budget gone.

**What it buys:**

1. **The inventory constraint largely dissolves.** Every redemption lands after ads are off, and the exact entrant count is known before a single bar is committed. The worst failure mode — paying $50/day for traffic to an unfulfillable offer — cannot occur. The bars gate collapses from a daily in-flight monitor into a one-time sizing decision on draw day.
2. **The offer gets a genuine reason-why.** "You didn't win — here's the next best thing" is a real reason for a discount to exist and a real reason for it to expire. The instant-offer version had an arbitrary 72-hour timer with no story behind it.
3. **It protects the giveaway's tension.** A discount handed over seconds after entry tells the entrant the prize was never the point.

**Two mitigations for the losses above:**

- **A full-price buy path stays live on the entered page** throughout the 30 days: normal store links, plus the Sensitive Skin Set cross-sell at full price for entrants answering itchy/reactive, fragrance, or ingredients on Q2. An entrant who wants to buy on day 3 must not be blocked — the consolation offer is simply not spent early. This is the minimum bar for the Prime Directive.
- **One full-price send at day 12–15** to the reactive/fragrance segment featuring the Set. Costs nothing, does not touch the consolation offer, and produces a real conversion datapoint before the budget is exhausted.

### 7.2 During the 30 days — no offer

`/pages/giveaway-entered` is an entry confirmation, not an offer page: "you're in", the entry-ladder widget, what happens next, and full-price store links. The nurture's job is **driving ladder actions, not selling** — every CTA is refer / upload / tag / answer, which is also what pulls CPL down as the audience saturates.

### 7.3 Draw window — day 30, the entire revenue event

Seven days, three sends: draw day → day 3 reminder → final hours. A single send is too fragile when it is the whole campaign's revenue.

> **We drew the winner. It wasn't you — so here's the next best thing.**
>
> ⭐ **Buy 9 bars, get 9 free — $99** · 18 bars · $198 value · **6 months free**
> Buy 6 bars, get 6 free — $66 · 12 bars · $132 value · 4 months free
>
> Fragrance-free · Free shipping · 30-day no-questions guarantee · Offer closes [draw date + 7 days, rendered at send time]

**No scent picker.** Pure Unscented is the only variant offered, which removes a UI element, the out-of-stock-variant handling, and a whole class of wrong-product bug. One variant ID, one tap.

**Cross-sell, not a competing offer** — one add-on line inside the cart, not a second decision on the page: *"Add the Sensitive Skin Set for $46.80 — 131 reviews ★★★★★."* Shown only to entrants who answered itchy/reactive, fragrance, or ingredients on Q2. This keeps the Set in the path without betting the campaign on a page that has sold 1 unit in 90 days.

The offer lives on a dedicated page (`/pages/giveaway-offer`) published on draw day, so the entered page never has to switch modes mid-campaign.

### Two margin landmines

1. **Entrants must be suppressed from the Welcome flow (`UUa3Qk`).** It hands out FIRST20; stacking that on $99 costs ~$20 of a $40 contribution by accident. Entrants get the soap offer *instead of* FIRST20. Only this flow needs suppression — Abandoned Cart, Browse Abandonment, Post-Purchase, Review, Replenishment and Winback should all keep firing.
2. **`NEWCUSTOMER` (free shipping $25+) is live** and stacks on everything. Harmless at $66/$99 since both clear $45 — but it means there is no shipping lever left to give away later.

## 8. Platform policy and official rules

### Meta policy

- **Prohibited on Facebook:** *"Personal Timelines and friend connections must not be used to administer promotions"* — explicitly naming "share on your Timeline to enter", "share on your friend's Timeline to get additional entries", and "tag your friends in this post to enter".
- **Allowed:** liking a Page, commenting, tagging friends in comments, following, and entering via an external landing page — which is this architecture.
- **Instagram does not prohibit** post/tag/follow bonus entries. It requires genuine entries and the Meta release in the rules *and* the post caption.
- Therefore the post-and-tag bonus is **Instagram only, never Facebook Timelines, optional never required.**
- Following, liking and tagging are treated as **de minimis, not "consideration"** under sweepstakes law — so social bonus entries do not jeopardise the no-purchase-necessary structure.
- **Ad-copy constraint:** Meta's personal-attributes rule prohibits copy asserting the viewer's health condition. *"For sensitive skin"* is fine; *"Do you have eczema?"* is a rejection.

### Official rules — the load-bearing clauses

Standard scaffolding (sponsor name/postal address, entry period with timezone, one entry per email, odds depend on entries, taxes are the winner's responsibility, privacy policy link), plus:

1. **"No purchase necessary. A purchase will not improve your chances of winning."** Also on the offer page, not just in the rules.
2. **Every entry method and its entry value listed explicitly**, with the referral cap stated. **Purchases do not earn entries.**
3. **Void in Rhode Island** and void where prohibited. Total ARV $1,072.80 exceeds RI's $500 retail-sweepstakes registration threshold. NY and FL bond at $5,000 — clear of both.
4. **Referral prize:** the winner's named referrer wins the same prize **only if they are themselves a confirmed entrant.** Self-referral void. Mailing a $536 prize to someone who never accepted the rules is not defensible.
5. **The prize is Pure Unscented soap.** If that variant is unavailable at the time of any shipment, the sponsor may substitute a comparable bar of equal or greater retail value. Without a substitution clause, a stockout in 2029 breaks the prize promise.
6. **Liability cap:** if the business ceases operations, remaining shipments may be fulfilled as a cash equivalent or terminated. This is what bounds a 3-year obligation.
7. **Unsubscribing does not forfeit an entry** — otherwise the promotion is coercive. **This means the draw reads from the committed entrant snapshot, not the live subscribed list.**
8. **Meta release:** "This promotion is in no way sponsored, endorsed, administered by, or associated with Meta, Facebook, or Instagram."

## 9. Technical build

### 9.1 Meta pixel + CAPI — prerequisite, ~3 days

Nothing exists today. Install via the **official Facebook & Instagram sales channel app**, not a theme edit — that provisions pixel + Conversions API server-side with no Liquid changes. This matters because the orphaned `twq` pixel that threw a JS error on every page and pushed Clarity's script-error rate to 12.4% is exactly what hand-installed tags produce here.

Then, in Meta Business Manager:

1. Business Manager + ad account + payment method — **Sean-gated**
2. **Domain verification** for `realskincare.com`, DNS TXT via Cloudflare — **Sean-gated**, 24–72h propagation. Longest pole; start first.
3. **Aggregated Event Measurement: rank `Lead` at priority #1.** If Purchase outranks Lead, iOS lead conversions are silently dropped and the campaign optimises on partial data.
4. Fire standard `Lead` on `/pages/giveaway-entered`. One event only.

### 9.2 Pages

| Page | Template asset | Content |
|---|---|---|
| `/pages/free-soap-giveaway` | `templates/page.giveaway.json` | Hook, prize value stack ($536), entry form, rules link, draw countdown |
| `/pages/giveaway-entered` | `templates/page.giveaway-entered.json` | 3 questions → entry-ladder widget → what happens next → **full-price** store links. No offer. |
| `/pages/giveaway-offer` | `templates/page.giveaway-offer.json` | Published on draw day only. Both tiers, one-tap cart, closing date. Kept as a separate page so the entered page never switches modes mid-campaign. |

Built with `createPage` + `updateThemeAsset` against live theme `145536778410`, following the existing `landing-page-*` pattern. New sections `theme/sections/giveaway-entry.liquid` and `giveaway-offer.liquid`.

Two gotchas already paid for: the theme's sticky variant-scoping rule, and JSON-template sections rendering as `#shopify-section-template--<numericId>__<key>` — CSS must be scoped `[id$="__giveaway-offer"] .foo`, never `#shopify-section-giveaway-offer`.

### 9.3 Offer mechanics

**Shopify BXGY discounts do not add free items to the cart.** They discount the cheapest N items already in it. "Buy 9, get 9 free" requires **18 bars in the cart** with the discount zeroing 9. Built wrong, the customer pays $99 for 9 bars.

**Discount codes, not automatic discounts** — an automatic BXGY would hand the deal to all site traffic and cannibalise full-price soap. Two codes via `discountCodeBxgyCreate`, one use per customer:

- `SOAP4MO` — buy 6 get 6 ($66, 12 bars)
- `SOAP6MO` — buy 9 get 9 ($99, 18 bars)

Delivered as a one-tap cart permalink, so nobody types a code:

```
/cart/45828179951786:18?discount=SOAP6MO
```

**That variant ID is Pure Unscented and must be hard-coded, not read from `defaultVariantId`** — the default is Calming Lavender. A test asserting the permalink resolves to `45828179951786` is cheap insurance against shipping the wrong soap to every buyer.

**Both codes are created inactive and activated on draw day**, with total-usage limits set then from bars actually available and the known entrant count. Shopify caps usage per code, not across codes, so the two limits are set from the bar budget and reconciled daily through the 7-day window. This is an operational safeguard, not a scarcity claim — **no "only N left" copy ships.**

### 9.4 Entries, referral, and the draw

**Referral direction, stated once because it is easy to invert:** the *entrant* names their referrer at entry, stored as `gv_referred_by` on the **entrant's** profile. Credit flows the other way — `+5` is added to the **referrer's** `gv_entries`. So one referral relationship produces two benefits for the referrer: 5 entries now, and the grand prize if the person they referred is drawn.

- `gv_entries` integer on the Klaviyo profile, incremented **server-side only** — client-side is trivially gamed.
- Per-action breakdown stored alongside the total so the result is auditable.
- **Referral credit is async:** the +5 lands on the referrer's profile only when the named friend completes double opt-in. A nightly reconciliation script handles this — simpler than hosting a Klaviyo webhook, and a 24h delay is fine.
- Photo upload rides `uploadImageToShopifyCDN` (exists, image-only, the supported path) plus a usage-rights checkbox.
- Live "**your entries: N**" widget with remaining actions on the entered page. This is the engagement engine and the main reason the ladder is worth building.

**Draw, day 30:**

1. Snapshot all confirmed entrants with entry counts → `data/reports/giveaway/entrants-<date>.json`, committed.
2. **Weighted** random draw over the snapshot, weighting by `gv_entries`.
3. Read the **drawn winner's** `gv_referred_by`. That person wins the same prize only if they are themselves a confirmed entrant in the snapshot. If not, there is one winner, not two.
4. Reject self-referral at both form-validation and draw time.

Anti-fraud: referral cap 10, dedupe on normalised email, one entry per email, spot-check the top 20 entry-holders before the draw. Instagram-tag fraud ceiling is +3 — not worth engineering against.

### 9.5 Klaviyo

`lib/klaviyo.js` needs three new functions: create list, subscribe profile with properties, upsert profile properties.

- New list **"Giveaway 2026-09 — Entrants"**, **double opt-in on**. Confirmed-only is the single biggest protection for the sending reputation the 481 converting subscribers depend on.
- Suppression filter on the **Welcome flow only** (`UUa3Qk`).
- New flow **"Giveaway — Entry & Nurture"**: 6 sends over 30 days, branched on `gv_frustration`. **Every CTA is a ladder action — refer, upload, tag, answer — not a purchase.** The ladder is what gives entrants something to do across a 30-day wait, and referrals are what pull CPL down as the audience saturates.
- One **full-price Set send at day 12–15** to the reactive/fragrance segment. Not part of the consolation offer; its job is to produce a real conversion datapoint before the budget is spent (§7.1).
- New **campaign** (not a flow) **"Giveaway — Draw Result"**: 3 sends across a 7-day window — draw day, day 3 reminder, final hours. This is a campaign rather than a flow because it fires once to a fixed audience on a fixed date.
- Entry confirmation email sequencing: anticipation → **resell staying subscribed** → *then* confirm entry. There is no reward to hand over at this stage, which makes the resell the entire job of the email — and raises the stakes on getting it right, since the double-opt-in click is worth +2 entries and the deliverability protection.
- `scripts/giveaway-sunset.mjs` — at day 90, suppress entrants with 0 opens in 60 days and no purchase. Klaviyo cannot do this from a flow action.
- Expect an ugly unsubscribe spike on the draw-result send. That is pulled-forward churn, not a signal to stop.

### 9.6 Testing gates

Two separate gates, because the funnel now has two live moments 30 days apart.

**Gate A — before ads turn on.** A real end-to-end test entry: enter → 3 questions → entered page → entry-ladder widget increments → confirmation email lands → double-opt-in click credits +2. No offer is involved.

**Gate B — before the draw-result campaign sends.** With the codes activated on a staging basis, a real test order: offer page → cart shows **18 bars of Pure Unscented** with 9 free at $99 → order → refund it. **Confirm the line item reads Pure Unscented** — the default-variant trap in §3 is fixed at the product level, but the permalink is still hard-coded and must be asserted.

Success logs lie; the live page is the evidence. Gate B is the one with no second chance — it fires once, to the whole list, on a fixed date, and it is the entire revenue event.

- **`assertDurationClaim()` wraps every duration string on both pages.** "6 months free" fails the assertion at any quantity below 9 free bars — the guardrail that would have caught this two rebuilds ago.
- Unit tests: referral resolution (valid / non-entrant / self-referral), weighted draw, entry-count increments, duration assertions.
- `nvm use` first — Node 22, not 25. **Read the cancelled count in `node --test` output, not just `# fail 0`.**
- `curl` both pages for 200 after every Shopify mutation.

## 10. Campaign structure and creative

**One campaign. One ad set. $50/day flat from day 1.**

- Objective **Leads**, conversion location Website, optimising for `Lead`
- Broad: US, 25–60, **all genders**. No interest stacking — at $50/day manual interests raise CPL and starve learning. Do not exclude men; gift buyers and the "just here for the soap" segment still convert on a $99 soap order.
- Advantage+ placements
- 3–4 creatives in the single ad set; let Meta allocate
- **No retargeting ad set** — no pixel history on day 1, and splitting $50 means neither ad set exits learning. Retargeting happens free, in Klaviyo.

Creative is grounded in `data/context/personas.json`, persona 3 **"The Fragrance-Sensitive / Reactive Skin Buyer"** — the only persona with review proof for this exact SKU:

> `p3a1` — **"Truly unscented, not 'lightly fragranced'"**
> Objection: *"Everything labelled unscented still has a masking fragrance that sets me off."*
> Proof: *a self-described sensitive nose calls the unscented bar as close to scent-free as possible; another buyer bought it for a friend who can't have any scented products at all.*
>
> `p3a2` — **"The first lotion that didn't react"**
> Objection: *"Every lotion I try breaks me out or makes me itch — I've stopped trusting new products."*
> Proof: *multiple sensitive-skin buyers report zero reaction, no breakouts, no irritation, including on their children after bath time.*

| # | Format | Angle |
|---|---|---|
| 1 | Static — 36 bars stacked | *"Most 'unscented' soap isn't. Ours is. 36 free bars, one winner."* (`p3a1`) |
| 2 | Founder video, Sean on camera | *"Here's what goes in it, and here's what doesn't. I'm giving away 36 bars."* — authority/education is the founder's lane, since he is not the target demo |
| 3 | Us-vs-them label shot | Our label vs a drugstore "unscented" bar that lists fragrance/parfum (`p3a1`) — the format's strongest possible use, because the comparison is factual |
| 4 | UGC / review-led | The "bought it for a friend who can't have any scented products" review over product — puts the 131-review asset to work in the demo's own voice (`p3a2`) |

**Meta personal-attributes constraint applies to every one of these.** The objection must be framed as a fact about the *category*, never an assertion about the viewer. *"Most 'unscented' soap isn't"* is fine. *"Does unscented soap still make you itch?"* is a rejection.

Submit 3 creatives 4 days early. Sweepstakes ads get flagged; expect one rejection.

## 11. Measurement and kill criteria

`data/reports/giveaway/latest.json` written daily, surfaced as a dashboard panel: spend, CPL, entrants, Q2 answer mix, Q6 reaction-rate, entry-ladder completion, take rate, revenue, contribution, **and bars committed vs bars available**.

**Deferring the offer removes every in-flight revenue signal.** There is no take rate to read until day 30, so the day-10 conversion gate from the earlier design is gone — it cannot be evaluated. The in-flight gates are therefore all lead-quality and cost gates, and they carry more weight than they otherwise would, because they are the only thing standing between a bad campaign and a fully spent budget.

**Day 5 — three gates:**
- **CPL > $6** → pause and rework creative. At $6, $1,500 buys 250 entrants and breakeven is arithmetically out of reach.
- **Lander opt-in < 15%** → lander problem, not traffic. Do not touch the ads.
- **Q2 skewing away from reactive/fragrance answers** → the fragrance-free angle is not landing and the audience is generic soap-seekers. Shift budget to creative #3.

**Day 10 — ladder engagement.** If referral participation is near zero, the viral lever has failed and CPL will not improve. Rework the nurture CTA; do not raise budget.

**Day 12–15 — the only pre-draw revenue read.** The full-price Set send to the reactive/fragrance segment. Zero orders from a segment that self-identified as the target buyer is a serious warning about the day-30 offer, and it arrives while ~half the budget is still unspent. This send exists to produce that signal.

**Day 20:** extend, stop, or roll remaining budget into the winning creative.

**Day 30–37 — the whole revenue read.** Take rate, tier mix, contribution, bars consumed.

**Primary metric:** cost per confirmed, segmented email ≤ $3.50. **Evaluation date is ~day 40, not day 30** — the revenue event now sits at the end of the window rather than spread across it, so a day-30 report shows spend with no return by construction and must not be read as failure.

## 12. Build order

```
Day 1    Sean: Business Manager + ad account + DNS domain verification   ← start first, 24-72h
Day 1-2  lib/klaviyo.js extensions + list + double opt-in
Day 2-4  lander + entered page, entry ladder + widget, upload path
Day 4    official channel app install → pixel + CAPI, AEM priority
Day 5    nurture flow, official rules page
Day 6    GATE A: end-to-end test entry (no offer involved)
Day 6-9  Sean: Meta ad review (submit 3 creatives, expect one rejection)
Day 10   Launch the 30 days
--- campaign runs ---
Day 34   offer page, BXGY codes (inactive), draw-result campaign built
Day 36   GATE B: test order + refund, codes sized from bars available
Day 40   Draw, activate codes, publish offer page, send 1 of 3
Day 47   Offer closes
Day 50   Full report
```

Building the offer page and codes *during* the campaign rather than up front is deliberate: the code usage limits depend on the entrant count and bars available, neither of which is known on day 1.

The bonus ladder adds ~2 days over a plain single-entry design, principally the weighted draw, the server-side entry counter, the nightly referral reconciliation, and the upload path. Single-variant focus gives ~half a day back: no scent picker, no out-of-stock-variant handling, one hard-coded variant ID.

## 13. Sean-gated items

1. Meta Business Manager + ad account + payment method
2. Cloudflare DNS TXT record for domain verification
3. Creative assets for #2 (founder video) and #1 (36-bar product shot)
4. Approval of the official rules text before the lander goes live
5. **OPEN INPUT — second production run size and timing**, plus expected normal retail sell-through of unscented soap during the window. These two numbers size the bars-remaining gate in §11. Until supplied, the gate is provisioned against 1,026 bars, which is the conservative reading and is safe: it may pause ads earlier than necessary, but it cannot oversell.

Everything else is buildable and verifiable from this repo.

## 14. Residual assets, independent of campaign outcome

- ~600 confirmed subscribers tagged with household size, primary skin problem, current brand, switching objection, and adjacent-category interest, feeding seven built-but-under-fed revenue flows
- A first-party competitor-displacement map at n≈600, against a rival set currently resting on qualitative review mining
- **`p3a1` either validated or killed at n≈600.** Q6 asks whether the entrant has reacted to something labelled "unscented". That answer decides whether "truly unscented, not lightly fragranced" is the lead objection across every PDP, listing and email — a positioning decision currently resting on two reviews
- **The $99 tier itself** — the first offer in the catalog that turns a $2.40-contribution SKU into a $40 order. That structure is repeatable independently of this giveaway.
- Licensed target-demo UGC from the upload rung
