---
name: marketing-lifecycle-email-flows
description: Use when deciding which automated email/SMS flows should exist and which one to build next — auditing flow coverage for gaps, recovering abandoned carts, setting up the first two emails that follow any opt-in (including giveaway entrants), nurturing subscribers who joined the list but have not bought (including how to escalate offers to them on a fixed schedule), and choosing which medium carries a flow when email alone gets no response. Covers the inventory and the job of each flow; the content of the post-purchase flow lives in marketing-post-purchase-onboarding and the win-back offer in marketing-retention-offers.
---

# Lifecycle Email Flows

## Audit your automated flows against four required ones — abandoned cart, pre-purchase nurture, post-purchase, win-back — and build them one at a time.

**Why it works:** Roughly 98% of visitors leave without buying, and each flow recaptures a different slice of that leakage. A missing flow is a leak with nothing plugging it, and once built they run with no ongoing labour.

**Evidence offered:** Presented as the required set for any store, from 18 years of operating history. Assertion, no per-flow figures.

**Fit here (6/10):** Email is the one owned surface where the binding retention constraint can actually be worked — zero cost, no ad budget, no attribution needed. Held at 6 because a checklist is not itself a revenue mechanism.

**Run against the live account on 2026-07-29, all four are already covered** — eight flows are live, including Abandoned Cart, Welcome Series, Post-Purchase, Replenishment, Customer Winback, Browse Abandonment and Product Review / Cross-Sell. So the value here is not a build list; it is (a) re-running the check periodically, and (b) the one question the checklist raises that the account does not obviously answer: whether any flow nurtures subscribers who joined and *never bought*, as distinct from the Welcome Series everyone receives. Verify with the Klaviyo flows endpoint rather than assuming — assuming is how this section originally shipped claiming the cart flow was missing.

Note that the audit is an inventory of *jobs*, not of *channels*: a flow can be present and still be failing because it only ever goes out by email. Pair this check with the medium test below.

**Build one, get it working, then add the next.** This must be reconciled with the staging discipline in `marketing-upsell-offer-design` — four flows launched in a month at ~54 orders teaches nothing about which one worked.

*Source: MyWifeQuitHerJob Ecommerce Channel — "Exactly How I'd Build an Online Store That Makes $1K/Day (Step-by-Step)" (bOXEtdZliH8)*

## In the abandoned-cart flow, lead with a reminder rather than a discount.

**Why it works:** Cart abandoners have already selected a product and declared intent; the purchase stalled on distraction or a small hesitation, so a reminder resurfaces a decision that was nearly made rather than persuading a stranger.

**Evidence offered:** Claim that it recovers "up to 30%" of otherwise-lost sales. Unsourced.

**Fit here (7/10):** **This flow is already live here** (Abandoned Cart (RSC v2)), so this is not a build instruction — it is the standard to audit that flow against. No ad budget, no new traffic and no working attribution needed: recovery reads directly off the flow's own revenue, which makes it one of the very few items in this library that is genuinely measurable at ~54 orders/month. It works the Shopify side, where revenue is weakest at ~$875/mo.

Two cautions. **The 30% figure will not hold at this volume** — treat it as a reason to keep and tune the flow, not a forecast of what it will recover. And the optional-discount half pulls directly against the reflexive-discounting warning in `marketing-offer-construction`: the first message should be a plain reminder carrying the guarantee and the transition-period reassurance, with a discount held back for the final message if at all.

*Source: MyWifeQuitHerJob Ecommerce Channel — "Exactly How I'd Build an Online Store That Makes $1K/Day (Step-by-Step)" (bOXEtdZliH8)*

## Fix the first two emails after any opt-in: an immediate confirmation that names what they signed up for, who you are and what comes next; then a next-day email handing over your best-performing existing content on that subject.

**Why it works:** The immediate email closes the loop the opt-in opened, so the subscriber does not feel stranded between signing up and hearing anything. The day-two email delivers real value with zero new production, because it reuses material that has already proven it holds attention on that topic — you are not guessing what a cold subscriber wants, you are re-serving what an audience already voted for.

**Evidence offered:** Assertion — described as "easy wins" from the creator's own setup. No open, click or conversion data.

**Fit here (7/10):** Directly on the critical path. The Meta campaign is driving giveaway entries right now, and every entrant needs a first touch or the paid spend buys addresses that go cold before anything is ever asked of them. Both emails are runnable today in Klaviyo by one person, and neither needs ad budget, new traffic or working attribution.

The confirmation half overlaps the opt-in claim in `marketing-email-list-health` — treat that skill as the authority on consent and deliverability mechanics, and this as the content spec for the two sends. The distinct, additive instruction is the day-two rule: **seed the second email from your best-performing existing content rather than writing new material.** For this account that means the strongest existing asset on the natural-deodorant transition period or baking-soda irritation — whichever post, video or FAQ has the most engagement — not a fresh essay.

Two adjustments. **The "person behind it" introduction is the load-bearing part here**, not a formality: a sub-1,000 list buying a $50.46-AOV consumable is buying trust, and the founder introduction is where it starts. **And these two emails are the front of a longer sequence, not the whole of it** — where the opt-in was a giveaway entry or a list signup with no purchase, they should hand straight into the non-buyer nurture below rather than terminating.

*Source: orenmeetsworld — "The only funnels guide you'll ever need (Marketing 2.0)" (-8YiaBpl3DU)*

## Run a pre-purchase nurture flow aimed specifically at subscribers who joined the list and never bought — on a dated schedule, with each step a materially stronger offer than the last.

**Why it works:** Someone who opted in is interested but not convinced — the gap is belief, not awareness. A sequence that supplies differentiation and trust closes the objection blocking them instead of re-pitching the product. And someone who declined the standard offer has not declined *every* offer: a fixed schedule of progressively stronger asks keeps testing the price and structure at which each remaining slice will move. Because the lead is already paid for, every incremental conversion is pure addition to what that lead was worth.

**Evidence offered:** For the nurture half, described as sharing your story and what makes the product different so they buy when ready — assertion, no conversion data. For the escalation half, a hypothetical ladder (Day 15 push notification at 50% off, a $20/mo variant, Day 21 at 75% off, then a $9.99 light tier) with invented take rates (5%, 10%, 10%) carried through the CPL arithmetic. No account data on any step.

**Fit here (6/10):** Names a real hole. Other skills cover what a welcome email should *say* by awareness level (`marketing-awareness-level-messaging`) and how to *build* it (`marketing-email-design-production`), but nothing owned the non-buyer nurture sequence as an artifact. Natural deodorant has an unusually well-defined pre-purchase objection set — the transition period, baking-soda irritation, 'it quit by noon' — and this sequence is the natural place to answer it. The escalation ladder supplies what the nurture framing lacked on its own: a schedule and a reason each message differs from the one before, applicable to giveaway entrants as well as never-bought subscribers.

The sequence starts where the opt-in pair above leaves off: confirmation on day zero, best existing content on day one, then the escalating steps on their dated schedule.

Held at 6 because the list is small so absolute revenue is modest, and **the content this flow carries is generated elsewhere** — by `marketing-problem-solution-inventory` and `marketing-awareness-level-messaging`. The only additive claims here are that the sequence should exist, that it should target non-buyers specifically, and that its steps should escalate on fixed days.

Two hard scale-downs on the ladder as pitched. **The descending-discount version does not survive a physical catalog** — 50% and 75% off a $50.46-AOV consumable with real COGS and postage is margin-negative, and `marketing-offer-construction` warns explicitly that a repeating percent-off ladder trains the list to wait. Escalate by offer *structure* instead: reminder, then a named bundle, then a low-COGS bonus (lip balm, travel size) with purchase, then a genuinely time-bounded promotion with a stated reason-why. **And at a sub-1,000 list each step's take rate is a handful of orders**, so read the numbers directionally and keep the ladder to three steps rather than five.

A third dimension to escalate on is *medium* — if the first two email steps land silent, send the third by SMS rather than adding a fourth email. See the next section.

*Source: MyWifeQuitHerJob Ecommerce Channel — "Exactly How I'd Build an Online Store That Makes $1K/Day (Step-by-Step)" (bOXEtdZliH8)*
*Source: Stefan Georgi — "Secret of the DTC Universe #10: Don't Forget The Other 75%" (social post)*

## When follow-up in one medium produces nothing, test the next medium before concluding the follow-up itself does not work — email, then phone, then SMS.

**Why it works:** Engaged leads who ignored one channel are not unreachable. The same message delivered in a medium they actually attend to converts, so a silent sequence is evidence of channel fit failing, not of the offer or the sequence failing. Diagnosing it as the latter kills a flow that was only ever mis-routed.

**Evidence offered:** Author's account: email produced nothing, phone calls produced nothing, text blasts moved the business from $1.5M to $1.8M/mo. Single-business anecdote, no breakdown of what else changed.

**Fit here (6/10):** The named media are not era-bound platform features, so this survives translation to a 2026 Klaviyo account. **This is the channel axis the flow inventory above deliberately does not cover** — that checklist specifies which flows must exist, this specifies which medium carries them, and a flow can be fully built and still dead because it only ever sends email. With a sub-1,000 list and an 18–22% repeat rate, one-and-done buyers and never-bought subscribers are a known dead pool email alone has not moved. Adding an SMS opt-in and re-running the existing win-back or non-buyer nurture message through it is a solo-operator-sized change inside Klaviyo — no new team, no ad spend — and it points straight at the binding retention constraint.

Three adjustments before acting on it. **Skip the phone step.** A $50.46-AOV consumable does not support outbound calls, and the middle rung of the ladder is the one piece of this that is business-model-specific to the author. Go email → SMS. **The $1.5M→$1.8M delta will not scale down proportionally** — treat it as a reason to open the channel, not a forecast; at ~54 orders/month the honest read is directional. **And SMS is consent-gated**, so the first work is an opt-in surface (checkout, the welcome flow, the giveaway entry form) that builds a list worth sending to, before any message is written. Until that list exists, this is a build task, not a test.

Run it as a true medium test, not a rewrite: send the *same* message that got no email response, so a lift is attributable to the channel rather than to new copy.

*Source: Alex Hormozi — "$100M Leads" (book, (part 15 of 16))*
