---
name: marketing-lifecycle-email-flows
description: Use when deciding which automated email/SMS flows should exist and which one to build next — auditing flow coverage for gaps, recovering abandoned carts, and nurturing subscribers who joined the list but have not bought. Covers the inventory and the job of each flow; the content of the post-purchase flow lives in marketing-post-purchase-onboarding and the win-back offer in marketing-retention-offers.
---

# Lifecycle Email Flows

## Audit your automated flows against four required ones — abandoned cart, pre-purchase nurture, post-purchase, win-back — and build them one at a time.

**Why it works:** Roughly 98% of visitors leave without buying, and each flow recaptures a different slice of that leakage. A missing flow is a leak with nothing plugging it, and once built they run with no ongoing labour.

**Evidence offered:** Presented as the required set for any store, from 18 years of operating history. Assertion, no per-flow figures.

**Fit here (6/10):** Email is the one owned surface where the binding retention constraint can actually be worked — zero cost, no ad budget, no attribution needed. Held at 6 because a checklist is not itself a revenue mechanism.

**Run against the live account on 2026-07-29, all four are already covered** — eight flows are live, including Abandoned Cart, Welcome Series, Post-Purchase, Replenishment, Customer Winback, Browse Abandonment and Product Review / Cross-Sell. So the value here is not a build list; it is (a) re-running the check periodically, and (b) the one question the checklist raises that the account does not obviously answer: whether any flow nurtures subscribers who joined and *never bought*, as distinct from the Welcome Series everyone receives. Verify with the Klaviyo flows endpoint rather than assuming — assuming is how this section originally shipped claiming the cart flow was missing.

**Build one, get it working, then add the next.** This must be reconciled with the staging discipline in `marketing-upsell-offer-design` — four flows launched in a month at ~54 orders teaches nothing about which one worked.

*Source: MyWifeQuitHerJob Ecommerce Channel — "Exactly How I'd Build an Online Store That Makes $1K/Day (Step-by-Step)" (bOXEtdZliH8)*

## In the abandoned-cart flow, lead with a reminder rather than a discount.

**Why it works:** Cart abandoners have already selected a product and declared intent; the purchase stalled on distraction or a small hesitation, so a reminder resurfaces a decision that was nearly made rather than persuading a stranger.

**Evidence offered:** Claim that it recovers "up to 30%" of otherwise-lost sales. Unsourced.

**Fit here (7/10):** **This flow is already live here** (Abandoned Cart (RSC v2)), so this is not a build instruction — it is the standard to audit that flow against. No ad budget, no new traffic and no working attribution needed: recovery reads directly off the flow's own revenue, which makes it one of the very few items in this library that is genuinely measurable at ~54 orders/month. It works the Shopify side, where revenue is weakest at ~$875/mo.

Two cautions. **The 30% figure will not hold at this volume** — treat it as a reason to keep and tune the flow, not a forecast of what it will recover. And the optional-discount half pulls directly against the reflexive-discounting warning in `marketing-offer-construction`: the first message should be a plain reminder carrying the guarantee and the transition-period reassurance, with a discount held back for the final message if at all.

*Source: MyWifeQuitHerJob Ecommerce Channel — "Exactly How I'd Build an Online Store That Makes $1K/Day (Step-by-Step)" (bOXEtdZliH8)*

## Run a pre-purchase nurture flow aimed specifically at subscribers who joined the list and never bought.

**Why it works:** Someone who opted in is interested but not convinced — the gap is belief, not awareness. A sequence that supplies differentiation and trust closes the objection blocking them instead of re-pitching the product.

**Evidence offered:** Described as sharing your story and what makes the product different so they buy when ready. Assertion, no conversion data.

**Fit here (6/10):** Names a real hole. Other skills cover what a welcome email should *say* by awareness level (`marketing-awareness-level-messaging`) and how to *build* it (`marketing-email-design-production`), but nothing owned the non-buyer nurture sequence as an artifact. Natural deodorant has an unusually well-defined pre-purchase objection set — the transition period, baking-soda irritation, 'it quit by noon' — and this sequence is the natural place to answer it.

Held at 6 because the list is small so absolute revenue is modest, and **the content this flow carries is generated elsewhere** — by `marketing-problem-solution-inventory` and `marketing-awareness-level-messaging`. The only additive claim here is that the sequence should exist and should target non-buyers specifically.

*Source: MyWifeQuitHerJob Ecommerce Channel — "Exactly How I'd Build an Online Store That Makes $1K/Day (Step-by-Step)" (bOXEtdZliH8)*
