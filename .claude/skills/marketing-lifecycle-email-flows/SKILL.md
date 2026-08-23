---
name: marketing-lifecycle-email-flows
description: Use when deciding which automated email/SMS flows should exist and which one to build next — auditing flow coverage for gaps, recovering abandoned carts, and nurturing subscribers who joined the list but have not bought, including how to escalate offers to them on a fixed schedule and when to retry a dead sequence in a different medium (SMS instead of email). Covers the inventory and the job of each flow; the content of the post-purchase flow lives in marketing-post-purchase-onboarding and the win-back offer in marketing-retention-offers.
---

# Lifecycle Email Flows

## Audit your automated flows against four required ones — abandoned cart, pre-purchase nurture, post-purchase, win-back — and build them one at a time.

**Why it works:** Roughly 98% of visitors leave without buying, and each flow recaptures a different slice of that leakage. A missing flow is a leak with nothing plugging it, and once built they run with no ongoing labour.

**Evidence offered:** Presented as the required set for any store, from 18 years of operating history. Assertion, no per-flow figures.

**Fit here (6/10):** Email is the one owned surface where the binding retention constraint can actually be worked — zero cost, no ad budget, no attribution needed. Held at 6 because a checklist is not itself a revenue mechanism.

**Run against the live account on 2026-07-29, all four are already covered** — eight flows are live, including Abandoned Cart, Welcome Series, Post-Purchase, Replenishment, Customer Winback, Browse Abandonment and Product Review / Cross-Sell. So the value here is not a build list; it is (a) re-running the check periodically, and (b) the one question the checklist raises that the account does not obviously answer: whether any flow nurtures subscribers who joined and *never bought*, as distinct from the Welcome Series everyone receives. Verify with the Klaviyo flows endpoint rather than assuming — assuming is how this section originally shipped claiming the cart flow was missing.

**The audit has a second axis: medium.** A flow that exists but is email-only is only half-covered — see "When a follow-up sequence produces nothing, retry it in a different medium" below before concluding a live flow is doing its job.

**Build one, get it working, then add the next.** This must be reconciled with the staging discipline in `marketing-upsell-offer-design` — four flows launched in a month at ~54 orders teaches nothing about which one worked.

*Source: MyWifeQuitHerJob Ecommerce Channel — "Exactly How I'd Build an Online Store That Makes $1K/Day (Step-by-Step)" (bOXEtdZliH8)*

## In the abandoned-cart flow, lead with a reminder rather than a discount.

**Why it works:** Cart abandoners have already selected a product and declared intent; the purchase stalled on distraction or a small hesitation, so a reminder resurfaces a decision that was nearly made rather than persuading a stranger.

**Evidence offered:** Claim that it recovers "up to 30%" of otherwise-lost sales. Unsourced.

**Fit here (7/10):** **This flow is already live here** (Abandoned Cart (RSC v2)), so this is not a build instruction — it is the standard to audit that flow against. No ad budget, no new traffic and no working attribution needed: recovery reads directly off the flow's own revenue, which makes it one of the very few items in this library that is genuinely measurable at ~54 orders/month. It works the Shopify side, where revenue is weakest at ~$875/mo.

Two cautions. **The 30% figure will not hold at this volume** — treat it as a reason to keep and tune the flow, not a forecast of what it will recover. And the optional-discount half pulls directly against the reflexive-discounting warning in `marketing-offer-construction`: the first message should be a plain reminder carrying the guarantee and the transition-period reassurance, with a discount held back for the final message if at all.

If the flow's own revenue reads near zero after a fair window, the next move is not a bigger discount — it is the same reminder sent as an SMS. See the medium-switch section below.

*Source: MyWifeQuitHerJob Ecommerce Channel — "Exactly How I'd Build an Online Store That Makes $1K/Day (Step-by-Step)" (bOXEtdZliH8)*

## Run a pre-purchase nurture flow aimed specifically at subscribers who joined the list and never bought — on a dated schedule, with each step a materially stronger offer than the last.

**Why it works:** Someone who opted in is interested but not convinced — the gap is belief, not awareness. A sequence that supplies differentiation and trust closes the objection blocking them instead of re-pitching the product. And someone who declined the standard offer has not declined *every* offer: a fixed schedule of progressively stronger asks keeps testing the price and structure at which each remaining slice will move. Because the lead is already paid for, every incremental conversion is pure addition to what that lead was worth.

**Evidence offered:** For the nurture half, described as sharing your story and what makes the product different so they buy when ready — assertion, no conversion data. For the escalation half, a hypothetical ladder (Day 15 push notification at 50% off, a $20/mo variant, Day 21 at 75% off, then a $9.99 light tier) with invented take rates (5%, 10%, 10%) carried through the CPL arithmetic. No account data on any step.

**Fit here (6/10):** Names a real hole. Other skills cover what a welcome email should *say* by awareness level (`marketing-awareness-level-messaging`) and how to *build* it (`marketing-email-design-production`), but nothing owned the non-buyer nurture sequence as an artifact. Natural deodorant has an unusually well-defined pre-purchase objection set — the transition period, baking-soda irritation, 'it quit by noon' — and this sequence is the natural place to answer it. The escalation ladder supplies what the nurture framing lacked on its own: a schedule and a reason each message differs from the one before, applicable to giveaway entrants as well as never-bought subscribers.

Held at 6 because the list is small so absolute revenue is modest, and **the content this flow carries is generated elsewhere** — by `marketing-problem-solution-inventory` and `marketing-awareness-level-messaging`. The only additive claims here are that the sequence should exist, that it should target non-buyers specifically, and that its steps should escalate on fixed days.

Two hard scale-downs on the ladder as pitched. **The descending-discount version does not survive a physical catalog** — 50% and 75% off a $50.46-AOV consumable with real COGS and postage is margin-negative, and `marketing-offer-construction` warns explicitly that a repeating percent-off ladder trains the list to wait. Escalate by offer *structure* instead: reminder, then a named bundle, then a low-COGS bonus (lip balm, travel size) with purchase, then a genuinely time-bounded promotion with a stated reason-why. **And at a sub-1,000 list each step's take rate is a handful of orders**, so read the numbers directionally and keep the ladder to three steps rather than five.

Note that the escalation axis and the medium axis are independent. If the three-step ladder runs out with nothing to show, do not add a fourth, steeper step — re-run the existing steps in a different medium first.

*Source: MyWifeQuitHerJob Ecommerce Channel — "Exactly How I'd Build an Online Store That Makes $1K/Day (Step-by-Step)" (bOXEtdZliH8)*
*Source: Stefan Georgi — "Secret of the DTC Universe #10: Don't Forget The Other 75%" (social post)*

## When a follow-up sequence produces nothing, retry it in a different medium before concluding follow-up does not work.

**Why it works:** The failure may be the channel rather than the message or the audience. The same list that ignored email or calls can respond to a text blast, so medium is a variable to test independently of the offer — and testing it is cheaper than rewriting the offer, because the copy and the segment already exist.

**Evidence offered:** The author's own sequence — tested email (nothing), then phone calls (nothing), then text blasts, which in his telling moved monthly revenue materially. Anecdotal, one operator, no figures given.

**Fit here (6/10):** The mediums named are not platform mechanics that decay, so this ages well. This business runs its lifecycle flows on a sub-1,000 email list with retention as the binding constraint, which makes an SMS variant of an existing step a live, cheap test needing no ad spend, no new staff and no volume threshold: the segments are already defined and the copy is already written. The two obvious candidates are the abandoned-cart reminder and the Customer Winback step — both target people who have already transacted or declared intent, which is where SMS consent is easiest to have collected legitimately.

Scored 6 because it is a single operator's anecdote and **a sub-1,000 list gives thin signal either way** — a text blast to a couple hundred consented numbers producing two orders is not evidence the medium works, and producing zero is not evidence it does not. Read results directionally and let the test run across several cycles before deciding.

Three constraints specific to this account. **Consent is the gate, not the sending tool** — SMS requires its own opt-in, so the honest first question is how many subscribers have actually granted it, not how to write the text. **Do not escalate the offer at the same time as the medium**, or the test tells you nothing about which variable moved; hold the offer fixed, per the staging discipline in `marketing-upsell-offer-design`. And **phone calls are out of scope here** — at ~54 orders/month there is no one to make them and the economics do not support it; the transferable half of this tactic is email → SMS.

*Source: Alex Hormozi — "$100M Leads" (book, part 15 of 16)*
