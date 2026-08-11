# 30-Day Meta Giveaway — "36 Free Bars" → Email → Soap BOGO

**Date:** 2026-08-11
**Status:** design approved, ready for implementation plan
**Branch:** `feature/soap-giveaway-meta-campaign`

## 1. What this is, and what it is not

A 30-day Meta ads campaign that gives away bar soap to build the Klaviyo list, monetising entrants immediately with a buy-X-get-X-free soap offer.

**It is a lead-generation play. It will not pay for itself in 30 days.** Total cost is $1,895 ($1,500 ad spend + $395 prize). Breakeven needs 47–76 orders depending on tier mix — roughly a 9–10% entrant-to-buyer take rate. A realistic take rate for an on-message consolation offer with a deadline is 3–8%, so the expected outcome is **$600–1,100 underwater at day 30**, with ~600 confirmed, segmented subscribers and a first-party survey corpus as the residual asset.

Judging this on 30-day ROAS will misread a working campaign as a failure. The primary metric is **cost per confirmed, segmented email ≤ $3.50**.

### Why this fires while the CVR gate is red

The standing sequencing rule is Tracking → CRO → Offer/AOV → Traffic, and Gate 2 has regressed (true CVR ≈0.48%, down from 0.82–0.85%). This campaign routes around site CVR rather than depending on it: the optimisation event is an email, and the money step is a one-tap cart permalink, not a cold PDP. That is a genuine defence, but it is a defence — the gate did not turn green.

## 2. Decisions

| Decision | Choice | Why |
|---|---|---|
| Prize term | **3 years** | Per-winner ARV $536.40, under the $600 1099-MISC threshold. No W-9 paperwork. |
| Prize contents | 36 bars + 3 Sensitive Skin Sets | Soap hook for reach; the Sets put the $25-contribution product in the winner's hands as a review/UGC source. |
| Ad hook | **"Win 36 Free Bars of Soap"** | 12 bars/year covers only 8–10 months, so "3 Years of Free Soap" overstates supply. A count and a schedule are both exactly true, and hard numbers outperform vague claims. |
| Referral prize | Winner's referrer also wins | Bounded at 2 winners. Emotionally shareable: "if you win, your friend wins too." |
| Consolation offer | Two tiers, $99 hero | $99 is the only tier where "6 months free" is literally true, and it cuts breakeven from a 12.7% take rate to 7.8%. |
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
| Soap variants | Calming Lavender, Nourishing Tea Tree, Pure Unscented in stock; **Refreshing Lemongrass out of stock** | live `.js` endpoint |
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

- 36 bars of Moisturizing Coconut Soap over 3 years — 3 shipments/year of 4 bars
- 3 Sensitive Skin Moisturizing Sets
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

## 5. Funnel

```
Meta ad — "Win 36 Free Bars of Soap"
  → /pages/free-soap-giveaway    lander: hook, prize value stack, entry form, rules, draw countdown
  → /pages/giveaway-entered      3 required questions → offer reveal → scent pick → one-tap cart
                                 → entry-ladder widget ("your entries: N")
  → Klaviyo confirmed opt-in     tease → resell the list → THEN confirm entry + hand over the offer
  → segmented nurture            6 sends over 30 days, branched on gv_frustration
  → Day 30: draw                 winner + winner's referrer
  → draw-result send             biggest revenue moment of the campaign
  → Day 90: sunset non-openers
```

Step 4 is deliberately not a thank-you page. A sweepstakes produces 2 winners and ~598 losers; all revenue comes from what the losers are handed, and the moment of maximum motivation is the second after they submit.

## 6. Entry, questions, and the bonus ladder

### Step 1 — the lander form (the Meta `Lead` event)

Email, first name, and an optional "referred by a friend? their email". Nothing else. Every extra field on a cold lander costs opt-in rate.

### Step 2 — three required questions, on the entered page, above the offer

Single-tap, no typing, ~15 seconds.

| # | Question | Options | What it decides |
|---|---|---|---|
| 1 | Who's the soap for? | just me / me + partner / family of 3+ / a gift | Sizes the offer and **gates the duration claim** |
| 2 | Your #1 skin frustration? | dry & flaky / sensitive & reactive / avoiding certain ingredients / no issues, just want clean soap | Nurture routing — only the first three get pushed lotion/cream |
| 3 | What are you using now? | CeraVe / Cetaphil / Dove / Dr. Squatch or Native / a natural brand / whatever's on sale | Competitor displacement map |

These go **before** the offer because the answers change what the offer says. A bar lasts 20–30 days for one person and materially less shared across four, so:

- *just me / me + partner* → "18 bars — **6 months free**"
- *family of 3+* → "18 bars — a bar in every shower, restocked" (**no months claim**, because it would not be true)

The questions make the offer more accurate and more persuasive, and they qualify: someone who will not tap three buttons was never spending $99.

Q3 is the highest-value question in the campaign. The rival set (CeraVe / Vanicream / Cetaphil) currently rests on qualitative Judge.me and Reddit mining; this tests it against n≈600 first-party answers.

### Step 3 — three optional questions, revealed after the offer and repeated in email

| # | Question | What it decides |
|---|---|---|
| 4 | What stopped you switching to natural before? | Objection inventory → PDP copy, FAQ, ad angles |
| 5 | What else do you buy? *(multi-select)* | Cross-sell map — could settle the toothpaste cluster (32 pages, ~$0) with demand data instead of GSC impressions |
| 6 | Scent preference? | Prize fulfilment, which variant to feature, inventory planning |

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

**Instant offer** — on `/pages/giveaway-entered`, repeated in the confirmation email, 72-hour per-entrant deadline:

> **You didn't have to win to get free soap.**
>
> ⭐ **Buy 9 bars, get 9 free — $99** · 18 bars · $198 value · **6 months free**
> Buy 6 bars, get 6 free — $66 · 12 bars · $132 value · 4 months free
>
> Free shipping · 30-day no-questions guarantee

**Cross-sell, not a competing offer** — one add-on line inside the cart, not a second decision on the page: *"Add the Sensitive Skin Set for $46.80 — 131 reviews ★★★★★."* Shown only to entrants who answered dry / sensitive / ingredients on Q2. This keeps the Set in the path without betting the campaign on a page that has sold 1 unit in 90 days.

**Draw-result send, day 30** — the biggest email of the campaign. *"We drew the winner. It wasn't you — so here's the next best thing."* Both tiers, real 5-day deadline.

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
5. **Prize scent selection is limited to scents available at the time of each shipment.** Lemongrass is out of stock today; without this clause a stockout in 2029 breaks the prize promise.
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
| `/pages/giveaway-entered` | `templates/page.giveaway-entered.json` | 3 questions → offer → scent picker → one-tap cart → entry-ladder widget |

Built with `createPage` + `updateThemeAsset` against live theme `145536778410`, following the existing `landing-page-*` pattern. New sections `theme/sections/giveaway-entry.liquid` and `giveaway-offer.liquid`.

Two gotchas already paid for: the theme's sticky variant-scoping rule, and JSON-template sections rendering as `#shopify-section-template--<numericId>__<key>` — CSS must be scoped `[id$="__giveaway-offer"] .foo`, never `#shopify-section-giveaway-offer`.

### 9.3 Offer mechanics

**Shopify BXGY discounts do not add free items to the cart.** They discount the cheapest N items already in it. "Buy 9, get 9 free" requires **18 bars in the cart** with the discount zeroing 9. Built wrong, the customer pays $99 for 9 bars.

**Discount codes, not automatic discounts** — an automatic BXGY would hand the deal to all site traffic and cannibalise full-price soap. Two codes via `discountCodeBxgyCreate`, one use per customer:

- `SOAP4MO` — buy 6 get 6 ($66, 12 bars)
- `SOAP6MO` — buy 9 get 9 ($99, 18 bars)

Delivered as a one-tap cart permalink with the scent prefilled, so nobody types a code:

```
/cart/{variantId}:18?discount=SOAP6MO
```

Lemongrass renders **disabled, not missing**, so the page never offers a variant that cannot ship. Mixed-scent orders work via `id1:9,id2:9` but are v2; v1 is one scent, one tap.

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
- New flow **"Giveaway — Entry & Nurture"**: 6 sends over 30 days, branched on `gv_frustration`.
- New flow **"Giveaway — Draw Result"**: day 30 + day 33 reminder.
- Entry confirmation email sequencing: anticipation → **resell staying subscribed** → *then* confirm entry and hand over the offer. Leading with the reward spends the attention needed to keep them.
- `scripts/giveaway-sunset.mjs` — at day 90, suppress entrants with 0 opens in 60 days and no purchase. Klaviyo cannot do this from a flow action.
- Expect an ugly unsubscribe spike on the draw-result send. That is pulled-forward churn, not a signal to stop.

### 9.6 Testing gates

Nothing goes live on Meta until a **real end-to-end test entry** passes: enter → 3 questions → offer page → scent tap → cart shows 18 bars with 9 free at $99 → real order → confirmation email lands. Then refund it. Success logs lie; the live page is the evidence.

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

Creative is grounded in `data/context/personas.json`, persona 2 *"The Ingredient-Label Reader"*, angle `p2a1` — *"One ingredient: saponified coconut oil"*.

| # | Format | Angle |
|---|---|---|
| 1 | Static — 36 bars stacked | *"36 free bars. One winner. Entering is free."* |
| 2 | Founder video, Sean on camera | *"I make soap with one ingredient. I'm giving away three years of it."* — authority/education is the founder's lane, since he is not the target demo |
| 3 | Us-vs-them label shot | Our label vs a drugstore bar's 20-ingredient list (`p2a1`) |
| 4 | UGC / review-led | Customer quote over product — puts the 131-review asset to work in the demo's own voice |

Submit 3 creatives 4 days early. Sweepstakes ads get flagged; expect one rejection.

## 11. Measurement and kill criteria

`data/reports/giveaway/latest.json` written daily, surfaced as a dashboard panel: spend, CPL, entrants, Q2 answer mix, entry-ladder completion, take rate, revenue, contribution.

**Day 5 — three gates:**
- **CPL > $6** → pause and rework creative. At $6, $1,500 buys 250 entrants and breakeven is arithmetically out of reach.
- **Lander opt-in < 15%** → lander problem, not traffic. Do not touch the ads.
- **"Just here for the soap" > 60% of Q2** → audience is wrong. Shift budget to creative #3.

**Day 10:** take rate < 2% → the offer page is the problem, not the traffic. Fix the page before spending another dollar.

**Day 20:** extend, stop, or roll remaining budget into the winning creative.

**Primary metric:** cost per confirmed, segmented email ≤ $3.50, with contribution recovering ≥50% of spend by day 30. Orders are the secondary read.

## 12. Build order

```
Day 1    Sean: Business Manager + ad account + DNS domain verification   ← start first, 24-72h
Day 1-2  lib/klaviyo.js extensions + list + double opt-in
Day 2-4  both page templates + sections, BXGY codes, cart permalinks, entry ladder + widget
Day 4    official channel app install → pixel + CAPI, AEM priority
Day 5    nurture + draw flows, official rules page, upload path
Day 6    end-to-end test entry + test order + refund
Day 6-9  Sean: Meta ad review (submit 3 creatives, expect one rejection)
Day 10   Launch the 30 days
```

The bonus ladder adds ~2 days over a plain single-entry design, principally the weighted draw, the server-side entry counter, the nightly referral reconciliation, and the upload path.

## 13. Sean-gated items

1. Meta Business Manager + ad account + payment method
2. Cloudflare DNS TXT record for domain verification
3. Creative assets for #2 (founder video) and #1 (36-bar product shot)
4. Approval of the official rules text before the lander goes live

Everything else is buildable and verifiable from this repo.

## 14. Residual assets, independent of campaign outcome

- ~600 confirmed subscribers tagged with household size, primary skin problem, current brand, switching objection, and adjacent-category interest, feeding seven built-but-under-fed revenue flows
- A first-party competitor-displacement map at n≈600, against a rival set currently resting on qualitative review mining
- **The $99 tier itself** — the first offer in the catalog that turns a $2.40-contribution SKU into a $40 order. That structure is repeatable independently of this giveaway.
- Licensed target-demo UGC from the upload rung
