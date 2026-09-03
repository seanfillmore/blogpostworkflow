---
name: marketing-retention-offers
description: Use when the goal is a second or repeat purchase from someone who already bought — converting one-time buyers onto a refill or subscription cadence, setting the price gap between one-time and recurring, recovering failed recurring payments before they become silent cancellations, placing a reward just past the churn point, grandfathering existing subscribers when you raise the price, selling the next product to a customer right after they report a visible win, winning back customers who lapsed months ago, writing retention copy around habit and one-less-decision rather than product excellence, cultivating the top repeat buyers by hand, keeping a note on every customer so support never makes them repeat themselves, and answering a refund request with store credit instead of cash.
---

# Retention Offers

## Convert one-time buyers onto a recurring cadence: a lower per-period price converts many more people, each still pays the same total over time, and you end up with a much larger base to sell to later.

**Why it works:** Splitting a large price into recurring payments lowers the entry barrier so a bigger share of the same audience buys; retained periods rebuild the total revenue, and every extra subscriber is also an extra person available for later upsells. You sell once and get paid repeatedly.

**Evidence offered:** Worked arithmetic (100 prospects: 10 buyers at $1,000 = $10,000 versus 40 buyers at $50/mo held 20 months = $42,000 and 4x the upsell base). Illustrative math, not measured results.

**Fit here (8/10):** Deodorant, body care and oral care are consumables, repeat rate is 18–22.5%, repeat customers are 45–52% of revenue, and retention is explicitly the binding constraint. A Shopify subscribe-and-save / refill cadence is solo-executable at near-zero cost and needs no ad budget, attribution or new traffic — it converts existing buyers into scheduled revenue. Not higher because the arithmetic comes from high-ticket services; at a $50.46 AOV the per-order economics differ and enrollment rates on low-ticket consumable subscriptions are far lower than the 40% in the example.

**Do not implement via Shopify's Admin API.** Creating a selling plan group that way produces a plan that sells but never bills. Use the installed subscription app.

*Source: Alex Hormozi — "$100M Money Models" (book, part 9 of 11)*

## Once refills ship, stop leaking subscribers to failed payments: time charges to paycheck dates, retry a declined card several times the same day, and hold a backup payment method.

**Stage:** offer-aov — gate OPEN as of 2026-08-17. Live; no longer parked.

**Why it works:** Cards are likeliest to clear when the account has just been funded, and deposit timing varies within the day, so same-day retries capture charges that failed only on timing rather than on funds. Separately, a large share of recurring revenue is lost to customers who never chose to cancel at all — their card expired or maxed out — so a second stored method recovers revenue that was never actually at risk of refusal. This is involuntary churn: retention lost without a retention decision.

**Evidence offered:** Attributed to an early mentor plus the claim of recouping about a third of declined payments, and a scripted objection-handle for the second payment method ('it costs us man hours to get new payment information'). No dataset or recovery-rate figures.

**Fit here (6/10):** A durable operational mechanic aimed straight at the binding constraint — payment logic does not go stale, so the age of the source is not a concern. The non-default parts are real, configurable settings in any Shopify subscription app rather than card-updater defaults: schedule charge dates near common paycheck dates (1st/15th), set the dunning schedule to retry a decline several times within the same day, and capture a backup payment method. **Drop the conversational ACH ask and the 3% discount trade** — a 3% permanent give against a $50.46 AOV is not worth it, and ACH is not a practical consumer flow here. Configure the retry schedule and paycheck-date timing the moment refills ship, since they are one-time settings changes that cost nothing to leave running. **Do not spend attention on the backup-payment ask until the recurring base is meaningful** — with a subscription cohort in the low double digits, a 3–8% involuntary failure rate is a rounding error and costs more attention than it returns. The chase-and-recover work earns its keep at roughly a few hundred active recurring charges, where that failure rate becomes a readable, addressable dollar figure. Scored 6 rather than higher for exactly that reason, and because Amazon Subscribe & Save billing is platform-controlled and untouchable.

*Source: unknown — "untitled" (100m-money-models)*

## Advertise a permanently lower rate the customer earns by staying past your single most common churn point, and remind them as the milestone approaches.

**Why it works:** Churn clusters at a predictable point. Placing a permanent reward just beyond it gives the wavering customer a concrete reason to push through the exact moment they would otherwise quit, and once they are past it the habit is formed. A rate they can never get again also makes cancelling feel like losing an asset, so commitment length rises and churn falls while the discount is recovered over a longer lifetime.

**Evidence offered:** A named real-world example — a rice company selling a one-time price, 5% off subscription, and 15% off if you stayed subscribed five straight months, which he infers was set just past their typical cancellation point — plus a newsletter lifetime-rate example. Observational, no data from his own accounts.

**Fit here (8/10):** RSC already knows its churn point precisely: the natural-deodorant transition period, which is exactly when a first-time buyer concludes the product failed and is why repeat sits at 18–22.5%. A stated 'stay through order three and your price drops permanently' costs nothing to configure as a founding-subscriber rate, needs no traffic or attribution, and pairs with the transition-period education already in the post-purchase flow. The rice-company precedent is a consumable CPG rather than a high-ticket service, so it transfers cleanly. Held below 9 because the margin give is permanent and must be sized from real landed cost rather than a percentage-off reflex.

This rule fires on **tenure** — the customer earns the rate by staying. The grandfathering rule below fires on a **price-change event** and locks a rate the customer already has. They stack: a founding-subscriber rate earned at order three is exactly the kind of rate worth announcing as locked when the list price later steps up.

*Source: Alex Hormozi — "$100M Money Models" (book, part 10 of 11)*

## When you raise the price or withdraw an offer, announce it and tell existing customers explicitly that they are grandfathered in at their current rate.

**Why it works:** One announcement does two jobs. For prospects it puts a real deadline on the current price. For existing customers it converts a price rise — normally a churn trigger, because any billing change prompts a fresh review of the subscription — into a loyalty reward. The locked rate becomes an asset the customer forfeits by cancelling, so commitment lengthens at precisely the moment it would otherwise shorten. The announcement itself is the retention mechanism, not just the notification of one.

**Evidence offered:** Demonstrated rather than taught, and stated twice in the same passage: 'we're going to be removing my reports from Founder's Club shortly (don't worry you'll still get them - you're grandfathered in)... we're going to be offering them at a much higher price... once again you're grandfathered in.' Assertion only, no retention or conversion figures.

**Fit here (5/10):** Durable-principle class (retention and pricing psychology), so the age of the source is irrelevant. Directly actionable because offer construction here already prescribes stepping prices upward in committed increments on Shopify — this names what to do the moment that step lands: email the subscribe-and-save base to say the new price applies to new subscribers only and their rate is locked. Free, one email, solo-executable, aimed at the binding retention constraint. Capped at 5 because it is close kin to the milestone-rate rule above — the additive part is narrow (the trigger is a price-change event rather than a tenure milestone) — because the recurring base is still small, and because the urgency half only works if the increase is **genuinely honoured**; an announced rise that never happens burns the deadline for every future announcement.

*Source: Rich Schefren — "The Hidden Obstacles To Your Success" (special report, part 3 of 9)*

## Always have a next thing to sell an existing customer — another product or more of what they just bought — and fire the ask just after they report a visible win, because customers who run out of back end stop repurchasing and stop referring.

**Why it works:** Operators obsess over the front-end offer and neglect the back end, so a customer who has nothing left to buy quietly disengages — and a disengaged customer neither reorders nor refers. Desire to buy is spent somewhere; if you have no next offer, it is spent with a competitor. Each additional product a customer owns is another thing they can recommend to a friend, so back-end depth compounds into referrals rather than only into revenue. Timing matters as much as the existence of the offer: the ask lands hardest immediately after the customer has experienced a result, because that is the moment belief in the product is highest.

**Evidence offered:** Case example of a weight-loss company whose customers never referred anyone off the tier-1 product but did start referring friends after they bought the more expensive product. Single case, no figures.

**Fit here (7/10):** Retention is the stated binding constraint — 18–22.5% repeat while repeat buyers are already 45–52% of revenue — and with 12 SKUs across deodorant, body care, oral care and lip balm there is a genuine back end to sell into rather than a single product to re-push. The additive mechanic is the **trigger, not the offer**: fire the next ask at the moment the buyer reports a visible win — the transition period resolving, a 5-star review, a reply to the post-purchase flow saying it finally worked — rather than on a fixed day-N timer. That is a Klaviyo flow plus a review-platform webhook, runnable by one person at zero media cost.

Three limits. **Do not fire before the transition period resolves** — an ask sent to someone still in the rough weeks reads as tone-deaf and is the same window the milestone-rate and store-credit rules are built to survive. The per-customer note habit below is what tells you a win actually happened, so keep the two wired together. And Amazon buyers (~$1,800/mo) are unreachable by this flow entirely, so the addressable base is the Shopify list only.

*Source: Alex Hormozi — "$100M Leads" (book, (part 11 of 16))*

## Win back customers who haven't purchased in 6+ months by crediting back part of what they previously paid, framed as their own money returned, redeemable only against a new and usually larger purchase.

**Why it works:** Past customers have already cleared the trust and first-purchase hurdles, so reactivating them is far cheaper than acquiring strangers. Framing the incentive as their own money returned reads as restitution and recognition rather than a markdown, so it does not devalue the product or train the list to wait for sales, and because it is redeemable only against a new purchase it converts a dormant customer into an order.

**Evidence offered:** Anecdote with numbers: 200 personalized videos to past customers offering $4,000 credit, ~20% conversion, one day of recording producing ~$1.9M annual revenue; plus a scripted chiropractor winback. High-ticket coaching context; the claim that it 'gets way more people to take it' is assertion.

**Fit here (8/10):** The closest fit to the binding constraint: repeat rate is 18–22.5% while repeat customers are 45–52% of revenue, meaning the largest identifiable revenue pool is people who bought once and never came back. A win-back email crediting their last order's value toward a multi-unit or refill pack costs nothing to send, needs no traffic, no ad budget and no working attribution — redemption is measured directly by discount code — and the list is small enough that the personalized-video version is genuinely feasible. It also gives a non-discount framing for the same dollars. Not higher because the credit is real margin at a $50.46 AOV so it must be gated to a larger or recurring purchase, absolute dollars recovered will be modest, and Amazon buyers (~$1,800/mo) cannot be contacted this way at all.

*Source: Alex Hormozi — "$100M Money Models" (book, part 6 of 11)*

## Point retention copy at habit — 'one less decision' — not at product excellence, because that is the reason repeat buyers themselves give for coming back.

**Why it works:** Repeat purchase on a consumable is sustained by the removal of a recurring decision, not by continued admiration of the product. Copy that installs the item as the default choice — it just arrives, you never think about it again — produces more second orders than copy that re-argues quality, because a buyer who already used the product has settled the quality question and is now weighing only the effort of deciding again. Re-selling the ingredients re-opens a question the customer had already closed.

**Evidence offered:** Case: a 340+ review corpus in which buyers attributed their repeat purchase to it becoming a habit and being one less decision to make, rather than to the coffee being great. Single corpus, one category, no split test of the resulting copy.

**Fit here (6/10):** Deodorant and oral care are consumables where the repeat is a restock decision, so this transfers cleanly and is runnable today against the existing review corpus — mine RSC's own reviews for the language repeat buyers use, then rewrite the post-purchase and win-back messaging around 'never think about it again' rather than around ingredients. It is the copy layer for three mechanics already in this skill: the subscribe-and-save conversion above (the pitch is decision removal, not the discount), the milestone rate (the reward for staying is that the decision stops recurring), and the win-back credit (frame the return as resuming a habit, not as a sale). Zero cost, no traffic or attribution needed. Scored 6 because the additive part is narrow — the *reason* given for the repeat and where the copy should point — and it partially overlaps the named-routine framing already used in post-purchase onboarding. One caveat: habit framing must not be fired before the transition period resolves, since a buyer still in the rough weeks has not yet closed the quality question and 'never think about it again' reads as dismissive.

*Source: Professor Charley T — "Claude Has Officially Changed Facebook Ads Forever! (Tutorial)" (4-ApfzxGhYI)*

## When refunding, rewarding, or rescuing an unhappy customer, offer store credit toward a better-fitting offer rather than cash — take-up tested the same, and the money stays in the business.

**Why it works:** Buyers respond to the size of the promised return, not its form, so the conversion effect is the same while the redemption becomes a future order instead of an outflow. A cash refund ends the relationship and books the loss; the same amount credited toward the thing that would actually solve their problem preserves revenue, reframes the failure as insufficient dose or duration rather than a bad product, and often produces a larger total order. Someone asking for a refund has usually rejected one specific outcome, not the whole category.

**Evidence offered:** Direct claim of A/B experience — 'my testing showed offering store credit and cash back got the same number of customers' — plus a dentist example ($200 cleaning that didn't whiten credited toward a whitening package). No figures or sample sizes.

**Fit here (7/10):** The single detail that makes incentives affordable at $2,700/mo: every credit redeemed is a second transaction landing on the 18–22.5% repeat rate rather than cash out the door. Exceptionally well matched to the known churn cause — a first-time buyer concludes natural deodorant failed during the transition period and asks for their money back; a saved reply that credits their order toward the correct formula, a different scent, or a two-month supply, paired with the transition timeline, converts a refund into a second purchase. Free to implement as a Shopify store-credit policy plus a canned response. Not higher because the claim rests on unquantified personal testing, **the credit must be offered as a choice rather than a substitute for a legally required refund**, the 'free' framing needs a compliance sanity check, and Amazon refunds are platform-controlled so this only fully applies to the Shopify side.

*Source: Alex Hormozi — "$100M Money Models" (book, part 2 of 11)*

## Steer the mix between one-time and recurring purchase with the size of the price gap — the wider the gap, the higher the share who choose the subscription.

**Why it works:** Buyers choose the option that looks cheaper per unit of value delivered, and roughly a third of people will pay a premium purely to avoid a recurring commitment, so the price gap becomes a dial: a small gap harvests up-front cash, a large gap pushes people into recurring revenue.

**Evidence offered:** A five-row table of ratios to target percentages, described as 'tested a ton' with 'the data look clear' for his own offers, plus a specific '33% above your continuity' prescription stated without any supporting test. Self-reported, from high-ticket services and digital products.

**Fit here (7/10):** The subscribe-and-save discount depth on Shopify is exactly this dial, and it is one settings change with no budget or attribution required. Capped at 7 because **the specific ratios do not transfer** — they come from $199–$799 coaching offers, not a $12 deodorant. A 2x one-time-to-subscription gap (or the ~25% subscription discount implied by the 33% rule) is likely margin-negative on physical goods carrying real COGS and postage at a $50.46 AOV. Only the direction of the lever transfers; set the depth from landed cost, and expect that at ~54 orders/month the resulting mix shift cannot be measured cleanly.

*Source: Alex Hormozi — "$100M Money Models" (book, part 9 of 11)*

## Identify the small group of highest-value repeat customers and cultivate them by hand — personal contact, priority service, and a standing code.

**Why it works:** A minority of customers who order repeatedly and in volume drive a disproportionate share of revenue and referrals. Making them feel recognised keeps them ordering and turns them into a referral source — something a marketplace relationship cannot replicate.

**Evidence offered:** Asserted from 18 years of operating history, with the observation that the best customer is often a different persona than the operator assumed. No figures.

**Fit here (7/10):** The distribution described is almost exactly this business — **18–22.5% repeat driving 45–52% of revenue** — which aims it straight at the binding constraint. At ~54 orders/month a solo operator can literally know and personally email the top repeat buyers, so this works *because* of the small scale rather than despite it. Zero cost for the personal-contact and priority-service halves. Additive to the rest of this skill, which covers subscription cadence, billing recovery, milestone rates, grandfathered pricing, back-end sequencing, win-back credit and store credit but nothing about identifying and cultivating a top-customer segment. These are also the buyers most likely to have already bought several SKUs, which is exactly the referral effect the back-end rule above describes — and the ones whose own words are worth mining for the habit language above.

Three limits. The standing discount code is **permanent margin** against a $50.46 AOV and must be sized from landed cost. Amazon buyers (~$1,800/mo, the larger channel) cannot be contacted this way at all. And the "your best customer is a different persona than you assumed" claim is a **prompt to check actual Shopify order history**, not a conclusion to act on — verify it against `personas.json` before rewriting anything.

*Source: MyWifeQuitHerJob Ecommerce Channel — "Exactly How I'd Build an Online Store That Makes $1K/Day (Step-by-Step)" (bOXEtdZliH8)*

## Never make a customer repeat themselves — keep a note per customer and open every reply by referencing what they already told you.

**Why it works:** Recapping a customer's own stated situation back to them signals that the business is organised and paying attention, which raises satisfaction and the odds they buy again. Making them re-explain signals the opposite, and it costs goodwill at precisely the moment they are already frustrated. In a multi-person shop this means notes travel down the handoff chain (setter → sales → onboarding 1 → onboarding 2); solo, it means keeping and re-reading your own notes before you answer.

**Evidence offered:** Assertion plus the described handoff chain, with the explicit note that a beginner taking all the calls himself should at least keep and review his own notes. No data.

**Fit here (5/10):** The solo-operator version is exactly the one the creator names, and it is free: one note per customer recording their prior order, scent, skin reaction and the issue they raised last time, and every support reply opening by referencing it. At ~54 orders/month a single person can genuinely maintain this, and with repeat customers at 45–52% of revenue, goodwill inside a support thread lands directly on the binding constraint. It is the service-layer complement to hand-cultivating the top repeat buyers, it is the record that tells you when a customer has hit the win that triggers the next back-end ask, and it makes the store-credit save far more convincing — "you told me the switch got worse around week two" beats a generic canned reply. Capped at 5 because it is a service habit rather than a revenue mechanism, it has no effect on the ~$1,800/mo Amazon channel where buyer identity is largely hidden, and the multi-person handoff half of the tactic is irrelevant with no team.

*Source: Alex Hormozi — "If I Wanted To Become a Millionaire in 2025, This Is What I'd Do [FULL BLUEPRINT]" (AN2KpRBsmRY)*
