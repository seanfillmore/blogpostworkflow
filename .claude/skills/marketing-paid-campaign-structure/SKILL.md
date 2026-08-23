---
name: marketing-paid-campaign-structure
description: Use when configuring a small-budget Meta account, or deciding whether you are allowed to change it — keeping the first funnel to two elements (one ad type pointing straight at a PDP or landing page, no advertorial and no 15-step quiz in between) until a baseline exists, running one CBO campaign with budget edits made at campaign level and everything collapsed into a single ad set at low volume, choosing campaign objectives that optimize for the purchase or lead event instead of clicks, reach, or engagement, choosing first-run bid strategy and attribution window (and declining Advantage+ Shopping at small budget), seeding a lookalike from your own buyer list in descending order of quality with interest or broad targeting as the fallback when the seed is thin, freezing account edits for 7-14 days so the learning phase can exit after writing down the monthly loss you are willing to treat as tuition, scaling in budget steps of 5% or less when the last seven days beat target and reading the cost bump afterwards as a denominator effect, reverse-engineering the daily budget the steps climb toward from a customer target × CAC padded 20%, setting breakeven-on-first-purchase CAC targets justified by the lifecycle email and SMS revenue that follows, judged in profit dollars rather than ROAS multiple and gated on a 30-day client-financed cash test (30-day cash ≥ CAC + COGS, gap closed by a sized immediate upsell), measuring efficiency as lifetime gross profit to CAC with labour folded into CAC and 3:1 as the floor, and computing the allowable cost per lead or entry (downstream conversion rate × blended customer value, plus any measured referral multiplier) before blaming the creative — including raising that ceiling by lifting customer value or converting the leads you already paid for. What goes inside the ads is marketing-paid-creative-testing; what to measure and how to read it is marketing-paid-media-measurement. Complements marketing-lifecycle-email-flows and marketing-retention-offers, which own the backend flows that make paid payback math work.
---

# Paid Campaign Structure

## Start every new product, offer or brand with the simplest possible funnel — one type of ad pointing directly at a PDP or landing page, no advertorial and no quiz in between — and only add a step once the two-element version has a known result and known economics.

**Why it works:** Every extra funnel step is an extra variable, and variables are multiplicative. With an ad, an advertorial and a lander in the path, a flat result has half a dozen plausible explanations — wrong ad, wrong advertorial format, wrong headline, wrong design, wrong CTA placement, wrong offer — and none of them can be isolated. A two-element funnel produces a result you can actually attribute, which is what a baseline *is*. Once the baseline exists and the economics are known, any added step is measured against something rather than guessed at.

**Evidence offered:** Assertion plus an extended worked-through-in-prose illustration of the failure mode: a hypothetical skincare launch spending six months debating founder ads vs UGC vs dermatologist spokesperson vs wrinkles vs before-afters vs advertorial vs quiz, and the spiral of unanswerable questions that follows a failed listicle advertorial. No account data, no figures.

**Fit here (7/10):** Durable-principle class (test design and attribution), so age is irrelevant. Directly live: a $30/day hand-run Meta campaign is being stood up this week by one operator with no designer and no media buyer, and this is the rule that keeps the build to something that person can actually maintain and read. It has a specific, concrete bite here — marketing-offer-construction records a 'scent/SKU match quiz' as one of three lead-magnet options, and this argues to defer that until a plain ad → page path has a baseline, because a solo operator cannot debug a multi-step quiz and a new ad account simultaneously. Attribution matters *more* at this scale, not less: at ~54 orders/month and ~$2.50 modelled cost per entry there is barely enough signal to explain a two-element funnel, let alone a four-element one. Two honest adjustments. First, the live giveaway does have an intermediate page, but that is not a violation — the entry page **is** the optimised conversion event, not a stepping stone, and the allowable-cost-per-entry arithmetic below is what connects it to revenue. Second, 'establish a baseline' here will be a directional read over weeks, not a significant one.

*Source: Stefan Georgi — "Secret of the DTC Universe #8: Collapse the Wave Function" (social post)*

**Refinement — do not launch a new product or offer behind a quiz funnel.** Quiz sequences often run 15 to 20 steps, and conversion through a long sequence is the product of every step's pass rate, so a single weak page anywhere in the chain silently caps the whole funnel even when the ads and the product page are both right. Worse, the diagnostic space explodes: is the ad attracting the wrong person, is question one weak, is question seven causing drop-off, is the recommendation page unclear, is the offer wrong, or is the PDP losing it? With that many candidate explanations, optimisation stops being possible.

**Evidence offered:** Assertion, with the explicit caveat that quiz funnels work well in the right situation and may be necessary in categories like telemedicine. No drop-off data, no named accounts.

**Fit here (5/10):** Durable-principle class (funnel attribution), age irrelevant, and it lands on a real recorded temptation rather than a hypothetical one: marketing-offer-construction lists a scent/SKU match quiz across the 12-SKU catalog as one of three lead-magnet types, and marketing-paid-media-measurement's restraint rules note that a solo operator will want to build things during the do-nothing period. This is the counterweight — a 15-step quiz is not something one person hand-running $30/day can build, populate with logic for 12 SKUs, and then debug against ~54 orders/month. Held at 5 because it is a refinement of the simplest-funnel rule above rather than an independent mechanism, and because it is a decision *not* to act, which protects hours rather than producing revenue.

*Source: Stefan Georgi — "Secret of the DTC Universe #8: Collapse the Wave Function" (social post)*

## On a small budget run only lead or sales campaign objectives — never awareness, traffic, or engagement — because Meta's optimizer is literal and will deliver exactly the cheap action you asked for.

**Stage:** traffic — gate OPEN as of 2026-08-17. Live; no longer parked.

**Why it works:** The objective tells the algorithm which event to find people likely to perform. Ask for engagement and it finds commenters; ask for traffic and it finds clickers who never buy; ask for purchases and it optimizes toward purchases. With no budget to spare, every campaign must point directly at the conversion event you actually want.

**Evidence offered:** Assertion, framed as a rule ('point blank, period'), plus the agency's health-coach client cited as having produced 10,000+ leads and 23,000+ purchases. No campaign-level comparison of objectives.

**Fit here (8/10):** Platform-mechanics class and freshly published, and now the single most consequential setting on the giveaway campaign. A giveaway is the exact situation where the wrong objective is most tempting and most ruinous: entries look like engagement, so "engagement" or "traffic" will feel like the natural pick and will deliver cheap junk — people who tap and never enter, never confirm an email, never buy. Run it as a lead/conversion objective optimizing for the entry event itself, which means the entry must fire as a real tracked event, not just a thank-you page view. Raised from 5 to 8 because the gate that capped it is open and this is now a decision being made this week; the residual risk is only that objective naming in the interface has drifted since publication.

*Source: LYFE Marketing — "How to CRUSH Meta Ads with a Small Budget in 2026" (AVjmQfJT9iA)*

## On the first campaign set the bid strategy to highest volume and leave the attribution window at 7-day click / 1-day view.

Highest volume (rather than a cost or ROAS cap) lets the algorithm spend the budget without a ceiling it has too little data to respect. The 7-day click / 1-day view window is Meta's standard reporting default, and the point of leaving it alone is that every benchmark, tutorial and creator number you will compare yourself against assumes it.

**Why it works:** A bid cap constrains delivery before the account has produced enough conversions to know what a good cost even is, so on a first small-budget campaign it mostly starves delivery. And an attribution window is a *reporting lens*, not a performance setting — changing it changes the reported numbers without changing what happened, so a non-default window makes your results incomparable to every external reference point and to your own earlier campaigns.

**Evidence offered:** Stated as beginner defaults, with no comparison against other bid strategies or windows. Practitioner assertion only.

**Fit here (6/10):** Platform-mechanics class and the fastest-decaying kind — bid-strategy names and attribution-window options are exactly what Meta renames — so **verify both against the live interface rather than trusting this text**, which is the reason this is a 6 and not higher. It was rejected outright on 2026-08-16 for being a stale platform setting behind a closed gate; the gate is open and it is now a setting being chosen this week, which is precisely when a recorded default is worth having. Both defaults are also the *conservative* choice: they are what makes the first campaign's numbers legible next to anyone else's. Set them once and leave them.

*Source: Dara Denney — "How to Analyze Facebook Ads Data the Right Way (The 2025 Guide)" (CCsty8R0UaA)*

**Refinement — do not reach for Advantage+ Shopping on this budget.** ASC is built for high creative volume, with practitioner guidance putting the floor around $100/day and ~20 creatives in the campaign. That is more than this business's entire combined monthly revenue and more distinct assets than one operator produces for a single campaign, so the honest read is not "scale it down" but "pick something else": a simple manual campaign with a handful of creatives is the right structure until spend and creative supply justify otherwise.

**Fit here (5/10):** Recorded as a *decision not to act*, which is why it sits as a refinement rather than its own tactic. The original claim was rejected on 2026-08-16 as unaffordable, and the affordability half of that judgement still stands — unlike the gate half, which does not. Worth keeping because "should this be an ASC campaign?" is a real question that will come up, and the answer at this budget is no.

*Source: Dara Denney — "How to Analyze Facebook Ads Data the Right Way (The 2025 Guide)" (CCsty8R0UaA)*

## Advantage+ Shopping needs roughly $100/day and ~20 creatives loaded into the campaign before its allocation logic works at all — that pair of numbers is the threshold at which declining it stops being correct.

**Stage:** scale — parked until the scale phase opens.

**Why it works:** The automated shopping campaign type is built around the algorithm choosing among many assets and needs enough daily conversion events to escape the learning phase. Too few creatives and there is nothing meaningful to allocate between; too little budget and the campaign never accumulates the conversion volume the allocation depends on. Running it underfed starves the exact mechanism you are paying for, which is why the correct move at low spend is a simple manual campaign rather than a shrunken ASC.

**Evidence offered:** Practitioner assertion plus secondhand hearsay ('I've actually heard the minimum number should be 20'); one $700/day campaign shown as the working example. No test or account data supporting either figure.

**Fit here (6/10):** This is the textbook scale park: a $100/day floor and a ~20-asset creative pool. The value of recording it is that it converts "not now" into a dated condition — the decline expires when three things hold together: sustained spend near ~$100/day (roughly 3x today's budget), a proven manual-CBO baseline worth trying to beat, and enough creative production throughput to keep ~20 assets in the pool. Two of those are budget conditions and one is a staffing condition; at one operator with no designer, the asset pool is likely to be the binding constraint rather than the money. Caveat on adoption: this is fast-decaying platform mechanics — campaign-type names, spend minimums and asset requirements must be re-verified in Ads Manager on the day the gate opens rather than trusted from this text.

*Source: undefined — "undefined" (CCsty8R0UaA)*

## Seed the lookalike from your own lists in descending order of quality — current and past customers first, then warm contacts, then cold leads — padding with lower-quality lists only as far as the platform minimum requires, and if you cannot build a usable lookalike at all, just target interests.

**Why it works:** The platform models responsiveness off the seed list, so the higher the buyer concentration in the seed, the more responsive the modelled audience. Padding down the quality ladder to reach the minimum broadens the model, which is acceptable precisely because filters can be layered back on top afterwards.

**Evidence offered:** Assertion plus 'this is exactly what I do'. No account data, no comparison against broad or interest targeting.

**Fit here (6/10):** Platform-mechanics class from 2023 and partly overtaken — Meta has since pushed toward Advantage+ audience, where the seed functions as a suggestion rather than a hard boundary, so **verify audience-type naming and minimum seed size in the live interface before implementing**. The underlying move is usable on the $30/day giveaway campaign now: upload the Shopify buyer list, then the sub-1,000 email list, as custom audiences, buyers first. But the fallback clause is what most likely applies here — with only a few hundred buyers the seed is thin, and interest or broad targeting with the creative doing the targeting work is the honest call. Do not let audience construction eat hours that belong to the post-entry email sequence, which is the higher-value lever at this list size.

*Source: Alex Hormozi — "$100M Leads" (book, part 8 of 16)*

**Refinement — layer only the exclusions your own order data actually supports.** The source's version is to stack filters (age, income, gender, interests, location, time of day) on top of the lookalike to raise the share of the right people, accepting that more filters mean a more efficient but faster-burning list: excluding segments that provably never buy raises buyer density in the delivered audience and lowers cost per result, at the price of a smaller pool that exhausts sooner.

**Evidence offered:** Assertion with illustrative examples (exclude under-25s and over-45s if they never buy). No cost or exhaustion data.

**Fit here (5/10):** The weakest-aged part of that chapter. At $30/day Meta needs conversion volume to exit learning, and heavy filter stacking starves delivery and inflates CPM; the modern default is closer to broad plus creative-as-targeting. Honest version for this account: apply only the exclusions the Shopify and Amazon order data supports — country, and any age or gender band with genuinely zero purchase history — and nothing speculative. Every extra filter is a bet you cannot currently afford to be wrong about, because it shrinks the pool feeding a learning phase that is already close to the edge.

*Source: Alex Hormozi — "$100M Leads" (book, part 8 of 16)*

## Run one CBO campaign with budget changes made at campaign level — and at this spend collapse everything into a single ad set with four to eight ads rather than splitting the budget across several.

**Why it works:** Ad-set-level budgeting is really a folder of single-ad-set campaigns — more structures to manage for no additional benefit. One campaign budget lets the system allocate across whatever sits beneath it, and editing at campaign level avoids resetting learning on each individual ad set. Below a certain volume, splitting the budget means no ad set ever accumulates enough conversions to exit learning at all, so consolidation is the only workable form.

**Evidence offered:** Practitioner assertion with a live account walkthrough of the structure. No comparison of CBO against ABO outcomes, and no stated volume threshold for when the collapse applies.

**Fit here (6/10):** Platform-mechanics class, one week old, so current — verify the CBO/ABO labelling in the live interface. The valuable part for this business is the creator's own fallback rather than the three-ad-set architecture he demonstrates. Do the arithmetic: **$30/day split across three ad sets is $10/day each**, and at a modelled **~$2.50 per entry** that is roughly **28 entries per ad set per week** — well under the **~50 conversions per week** Meta wants in order to exit learning. Consolidated into one ad set the same budget produces **~84 entries/week** and learning can actually exit. So the instruction here is: one campaign, one ad set, campaign-level budget edits. Held at 6 because it is account plumbing rather than a revenue mechanism, and because the demonstrated structure has to be discarded rather than followed.

*Source: Professor Charley T — "The Simple Facebook Ads Strategy Dominating in 2026" (4DutxlMzqgc)*

## Scale by raising the campaign budget 5% or less whenever the last seven days beat your target cost per result — and expect the cost per result to look temporarily worse afterwards, because that is arithmetic, not failure.

**Why it works:** If you are already beating target, a small budget increase buys extra impressions with enough margin that even zero incremental conversions still leaves you at or under target — the step is smaller than your safety margin, so it cannot break you. And because the increment is smaller than one conversion's worth of spend, the average cost per result rises before the next conversion lands. The dip is a denominator effect, not degradation.

**Evidence offered:** Worked arithmetic example ($50 target, $45 actual, therefore scale 5%). Assertion, no account data on outcomes of the increment rule.

**Fit here (6/10):** Durable in its logic — scale in increments smaller than your margin of safety, and read a short-term average-cost rise after a budget bump as an artifact. Directly usable on the live giveaway once a cost-per-entry baseline exists, and the interpretive half is the part that earns its place: a solo operator watching a $30/day campaign daily will see cost per entry rise the day after a bump and be tempted to reverse it. Two adjustments: a 5% step on $30/day is $1.50, so the meaningful move is a step every week or two rather than a nightly nudge; and 'target' here is cost per entry, which is only interpretable against the entry-to-purchase rate the post-entry email flow produces — compute that ceiling first, using the allowable-cost-per-lead arithmetic below. Not higher because the seven-day window at this spend is directional, not significant.

*Source: Professor Charley T — "The Simple Facebook Ads Strategy Dominating in 2026" (4DutxlMzqgc)*

**Refinement — the 5% steps need a destination: reverse the budget out of a customer goal, not out of comfort.** Once ads break even or better, stop asking "how much should I spend?" and compute instead: customers you can actually handle × CAC, padded 20% because ads get less efficient as they scale, divided into a daily number you then commit to. Budget set by comfort is arbitrary; budget derived from a capacity or revenue target makes spend a function of the outcome you want.

**Evidence offered:** Worked example only (100 customers × $100 CAC = $10k, padded to $12k, ≈$400/day). No account data.

**Fit here (6/10):** The arithmetic runs at any size, and a solo operator with fulfilment capacity limits can run it today: how many orders per week can one person pick, pack and post without the rest of the business stopping, times the CAC the ceiling arithmetic below permits, plus 20%. Mid because the precondition — ads at breakeven — is not met at $30/day, so the 5%-step rule above still governs the near term; this is the target the steps climb toward rather than a jump to make now. Computing the number is free and worth doing this week, because it also tests whether $30/day is even the right starting figure: if the capacity-derived number is $18/day, the current budget is already ahead of the business.

*Source: Alex Hormozi — "$100M Leads" (book, part 9 of 16)*

## Once a campaign is live, make no major changes for at least 7 days — 10-14 at low conversion volume — because every edit restarts Meta's learning phase.

**Stage:** traffic — gate OPEN as of 2026-08-17. Live; no longer parked.

**Why it works:** The learning phase is where Meta tests placements, frequency, and which users inside the audience convert; it exits on accumulated conversions. A small budget produces few conversions, so learning is already slow, and each edit resets the counter — meaning a constantly-tinkered account never reaches stable optimized delivery. Analysis and creative prep can continue in the meantime; only the account edits are frozen.

**Evidence offered:** Agency claims the client results shown were achieved within a 30-day window but only after longer ramp periods; otherwise practitioner assertion, no account screenshots or exit-rate data.

**Fit here (8/10):** Platform-mechanics class published 2026-04, so it is current, and the gate that capped it is open. This is the discipline most likely to be broken on the giveaway: a solo operator watching a new campaign daily will want to adjust something by day three, and every edit restarts learning.

**Do the arithmetic before deciding how long to freeze.** Meta's learning phase wants roughly **50 conversions per week** to exit. At **$30/day (~$210/week)** against a modelled **~$2.50 per entry**, that is ~84 entries/week — comfortably clear of the threshold, so **learning can actually exit on this budget**. The same campaign optimized for *purchases* could not: at ~54 orders/month across the whole business, 50 purchase conversions in a week is not reachable at any spend this business will run. That gap is the single strongest argument for the lead objective above, stronger than the cost argument. It also means the freeze is not merely defensive — it is the thing that lets a real optimization signal form. Recheck the $2.50 assumption against actual cost per entry in week one; if entries land closer to $8, the weekly total drops near the threshold and the freeze matters more, not less.

Take the 10-14 day end of the range rather than 7. The freeze covers account edits only; writing the next creative and reading reports continue throughout. Raised from 5 to 8 because it now governs a live campaign whose learning phase is genuinely reachable.

*Source: LYFE Marketing — "How to CRUSH Meta Ads with a Small Budget in 2026" (AVjmQfJT9iA)*

**Refinement — before launching, write down the monthly amount of ad money you are willing to lose, and treat it as tuition rather than earnings.** Pre-committing a loss budget is what stops a campaign being killed in week one on emotional grounds, and it forces the budget to be sized against what the business can absorb rather than against hoped-for returns.

**Evidence offered:** Assertion, plus the $100 'place one ad' exercise framed the same way ('you won't be earning, you'll be learning'). No data.

**Fit here (6/10):** $30/day is ~$900/mo against ~$2,700/mo combined revenue, which is a large enough fraction that the number has to be written down *before* the giveaway spends — otherwise the operator panic-edits mid-learning and resets the counter the freeze above exists to protect. Scored 6 because it partly overlaps the recorded evaluation-horizon step; what it adds is a **dollar** cap alongside the calendar date, so there are two independent stop conditions rather than one. State it explicitly: "I am prepared to lose $X this month buying data," and only revisit at the end of the freeze window.

*Source: Alex Hormozi — "$100M Leads" (book, part 10 of 16)*

## Expect most tested ads to lose money — many small losses and rare large wins — so judge the test portfolio in aggregate and pile budget onto the one winner rather than reading a running loss as failure.

**Stage:** scale — parked until the scale phase opens.

**Why it works:** Ad returns are heavily skewed. The expected value of a test program comes entirely from being able to identify and then multiply the rare winner, which requires having run enough losers to find it. Read at the level of the individual ad, the program looks like repeated failure; read at the portfolio level, it is one asymmetric bet paying for nine cheap ones.

**Evidence offered:** Worked hypothetical (ten ads at $100, nine lose, one returns 5x) plus a client who took a year to reach profitability and repaid it in a month. No portfolio-level account data.

**Fit here (7/10):** The psychology is genuinely valuable for a solo operator who will otherwise switch the campaign off in week two, but the mechanism it describes cannot run yet: finding a winner out of a ten-ad portfolio and then multiplying it needs spend and order volume this account does not have at $30/day and ~54 orders/month, where a single ad accumulates a readable result over weeks rather than days. Trigger for unparking: sustained spend at which a single ad can accumulate roughly 2x-30-day-cash of spend within a few days, across multiple simultaneous cells. Until then the live rules above — one ad set, few ads, long freeze — are the correct opposite of a ten-cell portfolio.

*Source: Alex Hormozi — "$100M Leads" (book, part 9 of 16)*

## Aim to break even on the first purchase from paid ads rather than turn a profit, because the email and SMS backend converts that customer into profit later — win on day 30, not day 1.

**Stage:** traffic — gate OPEN as of 2026-08-17. Live; no longer parked.

**Why it works:** If the backend flows reliably generate repeat purchases, a break-even first order means the customer was acquired for free and all subsequent lifetime value is margin.

**Evidence offered:** Framed as a mindset shift; supported only by the claim that email is ~30% of his revenue.

**Fit here (7/10):** Durable-principle class (CAC judged against lifetime value, not first-order margin), so age is irrelevant, and the gate that parked it is open. It is the right frame for the giveaway, with one adjustment that matters: a giveaway entrant is not a first purchase, so there is no first-order margin to break even against. The equivalent question is what an entry is worth — which is entirely a function of whether the post-entry email sequence converts entrants into buyers. That makes cost per entry meaningless in isolation. This section supplies the *frame*; the sections below supply the actual calculation and the order in which to run it. Treat the first campaign as buying the data to compute it. A legitimate 7 on merit.

*Source: MyWifeQuitHerJob Ecommerce Channel — "Exactly How I'd Build an Online Store That Makes $1K/Day (Step-by-Step)" (bOXEtdZliH8)*

**Refinement — name the window and make it a cash test: 30-day cash collected ≥ CAC + cost to fulfil.** "Break even eventually" is not a rule you can act on; "client-financed acquisition" is. Thirty days is the interest-free float on a credit card, so if the gross profit collected from a customer in their first 30 days covers both what you paid to acquire them and what it cost to fulfil them, you pay the card off in full, the customer was free, and every later purchase is profit — which means cash stops being the constraint on how fast you can buy customers. Waiting for lifetime value to trickle in over ten months caps ad spend at working capital instead. If the first purchase does not get there, do not lower CAC first: add an immediate upsell sized so that **upsell price × take rate closes the gap**.

**Evidence offered:** Worked arithmetic ($15/mo membership, $5 cost, 10-month retention, $30 CAC — a 3.3:1 LTGP:CAC that still leaves a two-month cash hole, fixed by a $100 upsell at a 1-in-5 take rate); plus his assertion that this is how he scaled every company past $1M/mo without outside funding.

**Fit here (8/10):** Decision-relevant right now. With a repeat rate of 18-22.5%, most of the "lifetime" value in the frame above never arrives, so funding acquisition out of it would be funding it out of a number that is mostly hypothetical. The 30-day cash test is the honest gate on what the giveaway campaign may pay per entry: at a **$50.46 AOV**, compute contribution margin after COGS and postage, subtract fulfilment, and whatever remains inside 30 days is the true acquisition budget per customer. The upsell-sizing arithmetic is directly actionable with 12 SKUs — a lip balm or deodorant add-on at a measured take rate is exactly the gap-closer described, and marketing-upsell-offer-design owns the construction. No volume gate; this can be computed and applied this week.

*Source: Alex Hormozi — "$100M Leads" (book, part 9 of 16)*

**Refinement — judge spend in profit dollars, not in ROAS multiple.** Stop demanding a 10x return on ad spend: a 3-4x ROAS that clears your margins and can be reinvested is a working machine. The cheapest, most in-market buyers convert first, so each incremental dollar of spend reaches a colder audience and costs more per customer — declining ROAS is the expected shape of scaling, not a failure. Since profit is the ratio multiplied by spend, a lower multiple on much larger spend produces more absolute money, so chasing the percentage caps the business at a small budget.

**Evidence offered:** Illustrative arithmetic ($1,000 product, $300 CAC = 3.3x; 10x on $5,000 vs 4x on $100,000), plus an unquantified health-coach client cited as having generated 10,000+ leads and 23,000+ purchases. No cohort or incrementality data.

**Fit here (5/10):** Durable-principle class (unit economics of scaling), so age is irrelevant, and the gate is open — but this one stays at 5 on its own merits rather than on timing. The worked example is a $1,000 high-ticket product with a $300 CAC, which does not transfer to a $50.46 AOV consumable where a 3x ROAS may not cover COGS and postage at all; only the direction of the argument transfers. Two parts do apply now: judge spend in profit dollars rather than chasing a multiple, and expect the multiple to fall as spend rises, because that decline is the shape of scaling rather than evidence of failure. Do the landed-margin arithmetic for real before setting any floor — an inherited rule of thumb is what makes a campaign look successful while losing money. Overlaps the break-even framing it sits beside.

*Source: LYFE Marketing — "How to CRUSH Meta Ads with a Small Budget in 2026" (AVjmQfJT9iA)*

## Measure paid efficiency as lifetime gross profit to CAC (LTGP:CAC) — gross profit, not revenue or a vague 'LTV', with every cost of getting a customer including labour folded into CAC — and read anything below 3:1 as the reason the business cannot scale.

**Why it works:** Gross profit is the only money actually available to buy customers and pay overhead, so a ratio built on revenue overstates headroom, sometimes by a multiple. Expressing it as a *lifetime* ratio rather than a per-order ROAS is what allows a channel that loses money on order one to still be correctly funded. And folding non-ad labour into CAC is what stops a channel that looks cheap on media spend from being expensive on hours. 3:1 is the observed threshold below which acquisition cannot outrun the costs stacked behind it.

**Evidence offered:** Pattern observed across the author's portfolio companies, plus worked arithmetic ($100k payroll / 1,000 leads = $100 per lead, 10% close = $1,000 CAC against $4,000 LTGP) and his own Acquisition.com content figures ($100k/mo payroll, 30,000 engaged leads, $3.33/lead).

**Fit here (8/10):** Computable today from numbers this business already knows: **$50.46 AOV**, **18-22.5% repeat rate**, known COGS and postage. That yields a lifetime gross profit per customer and therefore a hard CAC ceiling for the $30/day Meta campaign *before* a single dollar of spend is judged good or bad. Two things make it worth its own section rather than a footnote. First, it names retention explicitly as the LTGP lever — at a sub-25% repeat rate the numerator is small, so the ratio says the constraint is the backend, not the ads, which matches the standing read. Second, folding the operator's own hours into CAC is uncomfortable and correct at one-person scale: if hand-running the campaign costs ten hours a month, that is part of what a customer costs. Use the 3:1 floor as a go/no-go on the channel, and the 30-day cash test above as the separate go/no-go on whether it can be funded.

*Source: Alex Hormozi — "$100M Leads" (book, part 9 of 16)*

## When paid spend stalls, compute the allowable cost per lead *before* touching the ads — downstream conversion rate × blended customer value is the ceiling, and the constraint is usually the funnel economics, not the creative.

**Why it works:** A lead is only worth what it converts into. Allowable CPL = (probability the lead becomes a customer) × (blended value of that customer). Until that number is computed, every creative decision is being judged against an invented ceiling, and the operator burns effort optimizing the one input that is hardest to move — cost per click — while ignoring the two multiplicands that are easy to move.

**Evidence offered:** A worked back-of-napkin calculation on one client account: 25% trial-to-paid, 80% taking $200/yr and 20% taking $35/mo, therefore ~$41.50 per trial user and a ~$40 breakeven CPL — which exactly matched that client's observed scaling ceiling. Single account, self-reported, no data beyond the arithmetic.

**Fit here (7/10):** Durable-principle class (unit economics), so age is irrelevant. Directly live: a $30/day Meta campaign is driving giveaway entries right now, and "what is an entry worth" is the exact question this answers. Run the arithmetic as **entry→purchase rate × contribution margin per order** at a **$50.46 AOV**, plus the repeat-purchase tail implied by the **18–22.5% repeat rate**. That product is the ceiling on cost per entry, and it is what the 5%-step scaling rule above is comparing against. The additive part relative to the break-even framing above is the calculation itself and the *diagnostic ordering*: compute the ceiling first, and only then ask whether the creative is the problem. Held at 7 because at ~54 orders/month the entry→purchase rate will be a small-sample estimate for months, so the ceiling is a working number to revise, not a measurement.

*Source: Stefan Georgi — "Secret of the DTC Universe #10: Don't Forget The Other 75%" (social post)*

**Refinement — raise the ceiling by raising what a customer is worth, not only by cutting lead cost.** Deliberately lift customer value in the first months through congruent add-on offers rather than upsell spam, because CPL and customer value are multiplicative in the same equation: moving blended value from $167 to $200 moves breakeven CPL from $41.50 to $50, and $300 moves it to $75. A backend improvement therefore converts one-for-one into acquisition headroom and can unlock more scale than any amount of creative testing.

**Evidence offered:** Illustrative arithmetic across three value levels on the same client, plus the caveat that an established brand cannot hammer subscribers with upsells and must keep additions congruent (group coaching, a premium feature, a supplement stack). Assertion, no take-rate or revenue figures.

**Fit here (6/10):** Durable-principle class, age irrelevant, and it names the link that makes AOV and retention work pay twice: bundles, refill cadence and post-purchase cross-sells are not just AOV levers, they are what raises the price per entry the $30/day campaign can afford. The concrete moves belong to marketing-offer-construction and marketing-upsell-offer-design, so the additive claim here is narrow — **recompute the CAC ceiling whenever an AOV or repeat-rate change lands**, rather than treating acquisition and backend as separate projects. Held at 6 for that overlap, and because at $2,700/mo the arithmetic is real but the absolute headroom is small: a $5 lift in contribution per order buys a few extra dollars a day of spend, not a 3–10x scale step.

*Source: Stefan Georgi — "Secret of the DTC Universe #10: Don't Forget The Other 75%" (social post)*

**Refinement — when paid is capped, spend the hours on converting the leads you already paid for, not on lowering lead cost.** At a 25% conversion rate each lead is worth a quarter of a customer; at 100% it would be worth a whole one, so allowable CPL is 4x higher. Raising downstream conversion is mathematically identical to buying leads at a large discount, and it is usually the cheaper lever because it uses owned channels you have already paid to reach rather than competing for auction inventory.

**Evidence offered:** Worked example: sequentially recovering 5%, 10% and 10% of non-converters moves allowable CPL from $41.50 to ~$57.50 — a scale unlock the author says would double or triple ad spend, with "none of this having anything to do with ads". Illustrative arithmetic with invented take rates, no measured results.

**Fit here (7/10):** Durable-principle class (unit economics / effort allocation), age irrelevant, and it is the correct allocation rule for this exact week: the giveaway campaign's entrants are by construction a pool of people who raised a hand and did not buy. With one operator and $30/day, hours spent building the post-entry email sequence are worth more than hours spent shaving cost per entry, because the entry→purchase rate is the multiplicand on everything the ad budget buys. Note the interaction with the simplest-funnel rule at the top: improving the sequence that follows the entry is not the same as bolting another step onto the acquisition path — one raises the value of a lead you already have, the other adds a variable you then cannot debug. It also restates the standing read that retention, not traffic, is the binding constraint — here as an acquisition argument rather than a retention one. Held at 7 because the source's example is a zero-marginal-cost app subscription, so the 4x headroom claim does not transfer to a physical-goods catalog carrying COGS and postage, and at a sub-1,000 list the recovered percentages will be directional.

*Source: Stefan Georgi — "Secret of the DTC Universe #10: Don't Forget The Other 75%" (social post)*

**Refinement — count referred customers in the customer-value term, but only at a rate you have measured.** Referred customers arrive at zero acquisition cost, so they can be attributed back to the customer who referred them: a 4:1 LTGP:CAC business where every customer brings two more is effectively 12:1, and the ceiling on what you may pay for a lead rises with the measured referral rate.

**Evidence offered:** Worked arithmetic example only (4:1 becoming 12:1 at two referrals per customer). No data.

**Fit here (5/10):** The specific move — fold a referral multiplier into the customer-value multiplicand of the allowable-CPL calculation — is legitimate and applies against a live $30/day budget, and a giveaway is one of the few mechanics that plausibly generates referrals worth measuring (share-to-enter). But the sequencing is the whole point: **measure referral share first, then raise the ceiling by exactly what you measured.** Inflating the CAC ceiling on an assumed rate is precisely how a $900/mo budget against $2,700/mo revenue turns into an overspend. Until a referral field or share-link count exists in the data, the multiplier is 1.0.

*Source: Alex Hormozi — "$100M Leads" (book, part 11 of 16)*

## Ring-fence a fixed percentage of the ad budget (1%, 5%, 10%) for testing new campaigns, channels, pages or plain crazy ideas, with no expectation of return.

**Stage:** scale — parked until the scale phase opens.

**Why it works:** Segregating an exploration budget removes the requirement that every dollar return profit, which is the requirement that stops operators from ever testing anything new. Occasional winners raise the ceiling of the whole account by more than the cumulative cost of the losers, but only if the losing spend was pre-authorised as education rather than judged as failure.

**Evidence offered:** Attributed to a $3M/month operator at a private event; the author reports tripling his budget afterwards and going from $400k to $780k/month. Anecdote, single account.

**Fit here (6/10):** At $30/day a 10% carve-out is $3/day — below any threshold at which a separate test cell produces a readable signal, and the live structure rules above already say to collapse everything into one ad set at this volume, so a ring-fenced cell would be actively counterproductive. Trigger for unparking: daily spend high enough that an exploration cell can run alongside the working campaign without starving it, roughly the same $100/day region that governs the other automated-structure decisions. Distinct from the double-80/20 creative allocation in marketing-paid-creative-testing, which governs ad slots inside a working campaign rather than a ring-fenced budget for new channels and pages.

*Source: Alex Hormozi — "$100M Leads" (book, part 15 of 16)*
