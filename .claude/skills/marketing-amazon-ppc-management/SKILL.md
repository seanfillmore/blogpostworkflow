---
name: marketing-amazon-ppc-management
description: Use when running, pruning or restructuring Amazon Sponsored Products campaigns for a small catalog — covers diagnosing whether the problem is PPC or the listing by comparing paid against organic conversion rate and routing on a four-quadrant read, pulling category conversion benchmarks and search terms from Brand Analytics Search Query Performance, account structure (one portfolio per parent product, one ad group per campaign, a fixed naming convention, de-duplicating keyword+match-type across campaigns), reading the search term and placement reports, negating zero-order spenders and unprofitable low-order converters as negative exact and negative product targets, pre-emptively negating attribute-qualifier searches the formula does not satisfy, treating a cheap ACoS on a poorly matched broad term as a delayed returns-and-reviews cost, bidding down instead of negating inside exact and product-target campaigns, raising budgets on budget-capped winners, capping and relaunching starved keywords, auditing ad-group ASIN approval and which variation you advertise, writing one ad creative per search intent (including the console's AI creative generation), gating which qualifier terms you bid on by whether the listing can confirm the qualifier, running auto campaigns as discovery against manual campaigns as the proven-keyword vault, and requiring plan-then-approve before any AI agent writes to a paid ads account.
---

# Amazon PPC Management

## Diagnose whether your Amazon problem is PPC or the listing by comparing the listing's paid conversion rate against its organic conversion rate, because the listing, price and reviews are identical and only the path the shopper took differs.

**Why it works:** Holding every variable constant except traffic source isolates the cause: if paid converts far worse than organic, the mismatch is in targeting or ad promise; if both convert badly, the listing itself is failing every visitor regardless of how they arrived. Spending optimization effort on bids and negations when the listing is the bottleneck buys nothing.

**Evidence offered:** Assertion plus a reasoned control argument (same listing, price, reviews); creator cites 10 years and 3,000 brands, and a client conversation that prompted the video.

**Fit here (8/10):** Amazon is the larger of the two channels (~$1,800/mo of ~$2,700) and the binding constraint named for the business is conversion rate, not traffic. This is exactly a conversion-vs-acquisition split and the CRO gate is open. Per-search-term paid-vs-organic rates need more term-level volume than the account has, so run the honest scaled-down version now: compare paid CVR to organic CVR at whole-ASIN level per parent product, which Seller Central already reports, and move to term level as spend and units grow.

*Source: Marketing by Emma — "It’s Boring, but It Will Fix 99% of Your Amazon PPC Problems" (twDUexmWaws)*

## Place the listing in one of four quadrants — bad PPC/bad organic, good PPC/bad organic, bad PPC/good organic, good PPC/good organic — and let the quadrant dictate the next action.

**Why it works:** Each combination has a different cheapest fix: bad/bad means every step of the framework pays, good PPC/bad organic means the listing is throttling an already-working ad, bad PPC/good organic means the foundation is sound and the job is putting correct spend behind it, and good/good means iterate against category drift.

**Evidence offered:** Assertion only; framework presented from the creator's client work.

**Fit here (7/10):** A concrete routing rule for a two-surface Amazon account, and it prevents the classic error of spending on ads to fix a listing problem — the exact sequencing spine (Tracking → CRO → Offer/AOV → Traffic) this business runs on. Scored lower than the underlying paid-vs-organic comparison because the quadrant labels depend on category benchmarks that must be sourced separately — see the Brand Analytics Search Query Performance section below for where those benchmarks come from.

*Source: Marketing by Emma — "It’s Boring, but It Will Fix 99% of Your Amazon PPC Problems" (twDUexmWaws)*

## Get brand-registered and mine the Brand Analytics Search Query Performance report for your category's real conversion benchmarks and for what shoppers search more broadly in your category, rather than importing a generic 'good conversion rate' number.

**Why it works:** What counts as a good conversion rate varies hugely by category, and the report shows impressions, clicks, cart-adds and purchases per search term for your own ASINs and the category — so it supplies both the benchmark and the term list without guessing.

**Evidence offered:** Assertion; creator calls the report 'an absolute goldmine' and gives the exact navigation path (Seller Central → Brands → Brand Analytics → Search Query Performance).

**Fit here (8/10):** This business sells its own branded 12-SKU line on Amazon, so the report is available and free once registry is in place — a one-person admin step, not a headcount or budget one. It also directly answers the benchmark question the quadrant diagnosis above needs, and complements the imported-claim vetting rule already in marketing-performance-pattern-analysis by replacing borrowed benchmarks with own-category data. Platform mechanics class, and the report and menu path are current as of the 2026 publication.

*Source: Marketing by Emma — "It’s Boring, but It Will Fix 99% of Your Amazon PPC Problems" (twDUexmWaws)*

## Group Amazon campaigns into portfolios with one portfolio per parent product so per-product ad performance is readable at a glance.

**Why it works:** Portfolios act as folders that roll up spend, CPC, sales and ACoS by product; without them a flat campaign list forces you to mentally reassemble which campaigns belong to which SKU before you can judge any product's ad economics.

**Evidence offered:** Assertion plus on-screen demonstration of his own account (dripstick, mainstream, aloe vera wipes portfolios) showing CPC and sales compared across products in one view.

**Fit here (7/10):** 12 SKUs and ~$1,800/mo of Amazon revenue is exactly the size where a flat campaign list becomes unreadable but a portfolio-per-product view is a 20-minute one-time setup for a solo operator. Platform mechanics, but the tactic is 8 months old and portfolios are a long-stable console feature, so no staleness discount. Runnable today at current volume — it is organization, not a signal that needs order volume.

*Source: Mina Elias — "Amazon Ads: How to Optimize PPC (Step-by-Step System)" (x20JtHcz3Fk)*

## Use a fixed campaign naming convention — product code, campaign type/match type, keyword source, then an incrementing number — so any campaign's purpose is readable from its name alone.

**Why it works:** You launch and kill campaigns continuously; without an encoded name you cannot tell at a glance whether a row is the auto discovery campaign, the exact harvest campaign, or a Helium 10 seeded test, which makes every optimization pass start with re-derivation.

**Evidence offered:** Assertion plus on-screen examples of his own naming ('product code - exact - search term report - 45').

**Fit here (6/10):** Low-effort, zero-cost hygiene a solo operator can install in one sitting across a 12-SKU catalog, and it makes every future optimization pass faster. Value is real but modest against the binding retention constraint — it improves the speed of Amazon ad work, not the revenue directly.

*Source: Mina Elias — "Amazon Ads: How to Optimize PPC (Step-by-Step System)" (x20JtHcz3Fk)*

## Keep exactly one ad group per campaign, because Amazon does not allow ad-group-level budget control and will split campaign budget across ad groups unpredictably.

**Why it works:** Budget is set at campaign level; with two ad groups Amazon can allocate 80/20 in a way you did not choose and cannot override, so a losing ad group can starve a winning one inside the same campaign and you cannot tell from campaign-level metrics.

**Evidence offered:** Assertion, with the explicit reasoning about the missing ad-group budget control; on-screen check of ad group count as a 'red flag'.

**Fit here (7/10):** This is a structural constraint of the current Amazon Ads console (platform mechanics class, 8 months old and still accurate), and it matters most at small spend where a single mis-split budget wastes a meaningful fraction of a tiny daily amount. A solo operator can audit 12 SKUs' campaigns for multi-ad-group structures in an hour.

*Source: Mina Elias — "Amazon Ads: How to Optimize PPC (Step-by-Step System)" (x20JtHcz3Fk)*

## Run an auto campaign and a manual exact campaign on the same product as a paired system — the auto campaign exists to discover search terms, the exact campaign holds the terms that have already been proven.

**Why it works:** The two campaigns do different jobs, so their expected ACoS is different and should be judged differently: the auto campaign's high ACoS is the price of discovery, and the exact campaign's low ACoS reflects that its keywords were selected on evidence. Judging them against one target makes you kill the discovery engine.

**Evidence offered:** Demo contrasted the same product's manual exact campaign at ~20% ACoS against its auto campaign at ~50%, and attributed the difference explicitly to the exact campaign having already been optimized by harvesting winning search terms.

**Fit here (7/10):** Runnable today by one person on one hero SKU — two campaigns, small daily budgets, no tooling required. It also protects against the specific mistake this operator is most likely to make: shutting off the auto campaign because its ACoS looks bad, which destroys the only mechanism that surfaces new search terms. Durable-principle class. Do not spread this across all 12 SKUs at current spend; pick the one ASIN that already sells.

*Source: Orange Klik (interview with Kartik, QuickMetrics) — "Amazon PPC: From Weekly Checks to Daily Rules (YouTube 2yqq9J9_1IE)" (transcript)*

## Start every optimization pass by sorting campaigns by ROAS highest to lowest, and where a campaign beats your target ROAS but is not spending its full budget, raise the budget.

**Why it works:** A campaign already clearing your ACoS target is proven economics; raising the budget removes the only ceiling you control and lets Amazon buy more of an auction you already win profitably. Budget-capped winners are the cheapest incremental sales in the account.

**Evidence offered:** Demonstrated live — campaigns at 10-11x ROAS on a $100 budget spending only $10, with the decision to raise the cap; his stated target is 4x ROAS / 25% ACoS.

**Fit here (7/10):** Amazon is ~$1,800/mo, the larger of the two channels, and this is the highest-value move in the video for a business this size: it spends more only where the return is already proven. Runnable today by one person in the console. Note that at this order volume a 'winner' should be read over 30-60 days rather than 7, and the ROAS target should be set from actual gross margin on a $50 AOV catalog rather than borrowing his 4x.

*Source: Mina Elias — "Amazon Ads: How to Optimize PPC (Step-by-Step System)" (x20JtHcz3Fk)*

## Pull the last 30 days of search terms for a campaign, isolate every term with at least a couple of clicks and meaningful spend but zero orders, and negate them as negative exact — plus negate any ASINs that appear as negative product targets.

**Why it works:** Auto campaigns match broadly and keep re-spending on terms that have already proven they do not convert; each negation permanently removes a known losing term from the auction, so the same daily budget concentrates on terms that still might convert. Zero-order-with-spend is the cheapest, least ambiguous waste signal on Amazon because it needs no comparison group.

**Evidence offered:** Live demo: 21 search terms had burned 70 clicks and ₹1,384 with zero orders in 30 days; 'car accessories' alone spent ₹413 on 14 clicks with no sales. Negative keyword count in the ad group went from 229 to 247 after execution. Single-account anecdote, vendor demo.

**Fit here (7/10):** Amazon is the larger of the two revenue lines (~$1,800/mo) and Sponsored Products is a live surface for a 12-SKU catalog. Unlike winner-harvesting, this needs no readable positive signal — a term with several clicks and zero orders is actionable at any spend level, so a solo operator can run the search term report monthly and negate by hand in the Ads console with no tooling. Scale down honestly by raising the click floor (say 5-8 clicks rather than 2) so single-click noise does not get negated permanently. Durable-principle class, not stale.

**Scope note:** this is the broad/auto case. In one-to-one campaigns (manual exact, product targeting) the reversible move is a bid decrease, not a negation — see "In one-to-one campaigns, respond to unprofitable spend by lowering the bid rather than negating the target" below.

*Source: Orange Klik (interview with Kartik, QuickMetrics) — "Amazon PPC: From Weekly Checks to Daily Rules (YouTube 2yqq9J9_1IE)" (transcript)*

## Wasted spend is not only zero-order terms — also negate search terms that do convert but at high ACoS with very few orders, because in a multi-term target you cannot lower the bid on them individually.

**Why it works:** A term with 1-2 orders at 47%+ ACoS is losing money at scale, but it sits under a broad/auto target whose bid applies to every term it triggers for; the only surgical instrument available is a negative exact. Sorting the search term report by ACoS (rather than only filtering for zero orders) is what surfaces this second class of waste.

**Evidence offered:** Demonstrated by sorting the search term report by ACoS and reasoning through the 47%/7-orders case (keep) versus 47%/1-2-orders case (negate).

**Fit here (6/10):** Extends the zero-order negation pass above to the unprofitable-but-converting case. Runnable today in the console. Because this business runs ~54 orders/month total, the order-count threshold that separates 'keep' from 'negate' should be set low and read over 60-90 days, and the ACoS cut-off set from real gross margin at a $50.46 AOV rather than copied from his 25%.

*Source: Mina Elias — "Amazon Ads: How to Optimize PPC (Step-by-Step System)" (x20JtHcz3Fk)*

## Proactively build a negative-keyword list of attribute-qualifier searches your formula does not satisfy — sourced from category keyword research, before the search-term report shows any waste.

**Why it works:** Broad targeting sweeps you into qualifier searches where the shopper has a hard, non-negotiable criterion ('silicone-free' when the product contains silicones). Serving them costs clicks you cannot convert, and the ones who do buy discover the mismatch at home — producing returns and negative reviews. Negating the mismatched qualifier up front prevents both.

**Evidence offered:** Demonstrated live: Neutrogena and MediCube ads served on 'silicone-free SPF' for silicone-heavy products, plus a silicone sun-patch and a non-SPF silicone gel appearing on the same query.

**Fit here (9/10):** Near-perfect fit for this exact catalogue: natural deodorant, soap and toothpaste searches are dominated by qualifier terms — 'aluminum-free', 'baking soda free', 'fluoride-free', 'unscented', 'plastic free'. Any of those the products do not satisfy should be a standing negative before spend touches it. Runnable today at $30/day-scale Amazon spend by one person in an afternoon; the Brand Analytics Search Query Performance report above is the cheapest place to source the category's qualifier terms.

**Scope note:** distinct from the two negation sections above, which negate on observed data after the fact. This one negates on formula mismatch before any data exists, and the harm it prevents is review damage, not wasted clicks. The mirror-image case — a qualifier term worth having that the listing cannot yet confirm — is a listing task, not a negation; see the keyword/listing gate below.

*Source: Marketing by Emma — "It’s Boring, but It Will Fix 99% of Your Amazon PPC Problems" (twDUexmWaws)*

## Treat a cheap-looking ACoS on a broad, poorly-matched keyword as an artificial signal carrying a delayed cost, not as a win.

**Why it works:** Broad match buys volume at low CPCs, so surface metrics look good. But the orders it produces come from shoppers who assumed a criterion was met; when the product arrives and it is not, the cost lands later as returns, one-star reviews and a damaged listing — which then depresses both paid and organic conversion. The ACoS column cannot see any of that.

**Evidence offered:** Reasoned scenario walked through in detail (customer assumes silicone-free, gets home, skin reacts, leaves review); assertion, no numbers.

**Fit here (7/10):** The negation sections above handle zero-order and high-ACoS low-order terms; this is the opposite and otherwise unrecorded case — a term that looks profitable and is not. For a low-review natural-deodorant catalogue where reviews are the main proof asset and switching from conventional deodorant already produces a rocky transition period, one wave of mismatched buyers is disproportionately expensive. Practically: before scaling any cheap-ACoS broad term, read the actual search terms under it and check they do not carry a criterion the product fails. Durable-principle class, so age is irrelevant.

*Source: Marketing by Emma — "It’s Boring, but It Will Fix 99% of Your Amazon PPC Problems" (twDUexmWaws)*

## In one-to-one campaigns (manual exact and product targeting), respond to unprofitable spend by lowering the bid rather than negating the target.

**Why it works:** An exact keyword or ASIN target triggers for only that one thing, so the bid is a clean lever: lowering it pushes the ad further down the page, where the shopper who still scrolls and clicks carries higher intent. You either find a lower position where the target is profitable, or the target quietly stops spending — without permanently discarding a term that might work at a cheaper price. The same move is impossible in broad/auto campaigns, where one bid governs many terms, which is why negation is the instrument there.

**Evidence offered:** Assertion with clear reasoning, contrasted explicitly against why the same move is impossible in broad/auto campaigns.

**Fit here (7/10):** This is the most transferable idea in the video for a low-volume account: at ~54 orders/month you cannot afford to permanently kill targets on thin data, and bid-down is the reversible version of the decision. Runnable today by one person in the console, no volume threshold required.

*Source: Mina Elias — "Amazon Ads: How to Optimize PPC (Step-by-Step System)" (x20JtHcz3Fk)*

## Cap a manual campaign at roughly five active keywords: sort targets by sales over 30-60 days, pause the ones producing no sales, and relaunch those paused keywords in their own campaigns where they can get budget.

**Why it works:** Within one campaign the top keywords absorb the budget, so a keyword can look dead purely because it never got funded. Pausing it in the crowded campaign and re-launching it in a campaign of its own gives it a real budget test rather than a starved one.

**Evidence offered:** Assertion plus on-screen filtering of active targets and sorting by sales; reasoning that 'it's probably not even getting budget'.

**Fit here (6/10):** Directly runnable today: filtering targets by active status and sorting by sales is console work, not a statistical test. At ~$1,800/mo Amazon revenue the honest scale-down is to require a minimum click count (say 10+ clicks) before calling a keyword dead, otherwise you are pausing on noise rather than on evidence, and to relaunch only one or two orphaned keywords at a time so $30-level daily budgets are not fragmented across a dozen tiny campaigns.

*Source: Mina Elias — "Amazon Ads: How to Optimize PPC (Step-by-Step System)" (x20JtHcz3Fk)*

## De-duplicate before launching: never run the same keyword in the same match type in two campaigns, and expand a proven term only into the match types it is not already running in.

**Why it works:** Two campaigns holding the same keyword+match type compete in the same auction; only one can win the impression, and it will usually be whichever has the higher bid rather than whichever has the conversion history. The established campaign then loses its spend and its performance decays while the accidental duplicate learns from scratch — a strictly worse outcome than either alone.

**Evidence offered:** Assertion with a detailed causal walkthrough of the failure mode; he points to a de-duplication macro in his toolbox as the operational fix.

**Fit here (6/10):** A real failure mode for a solo operator relaunching campaigns across 12 SKUs. Runnable today — it is a spreadsheet check against a keyword+match-type list, not a test. Scale-down: at this spend, expand a proven term into one additional match type at a time rather than firing broad + phrase + exact simultaneously, because splitting a small daily budget across three new campaigns starves all of them.

*Source: Mina Elias — "Amazon Ads: How to Optimize PPC (Step-by-Step System)" (x20JtHcz3Fk)*

## Open the placement (bid adjustment) report and raise the top-of-search bid multiplier where top-of-search first page shows better ACoS and click-through rate than rest-of-search and product pages while top-of-search impression share sits under 5%.

**Why it works:** Placements are not equal — the same keyword converts at a different rate depending on where the ad renders. If the placement that converts best is also the one you almost never win, the multiplier is the only lever that buys more of it, and the ad economics of the extra impressions are already known from the placement data.

**Evidence offered:** Demonstrated on two campaigns: one showing 45% CTR and 34% ACoS at top-of-search first page versus much worse product-page performance, with the multiplier raised from 105% to 120%.

**Fit here (6/10):** Runnable today with an honest scale-down: at ~$1,800/mo Amazon revenue any single campaign's placement split will be a handful of clicks (the creator himself keeps skipping campaigns with $1-6 of placement spend), so read the placement contrast over a 90-day window and at portfolio level rather than per campaign per week, and move the multiplier in small steps. The mechanism does not require scale — only the read does, and lengthening the window supplies it.

*Source: Mina Elias — "Amazon Ads: How to Optimize PPC (Step-by-Step System)" (x20JtHcz3Fk)*

## Before raising the bid on a profitable target, check its current sponsored and organic rank — raise the bid only where there is positional headroom (e.g. position 10-20 moving to 5-6), not where you already rank at the top.

**Why it works:** A bid increase only pays if it buys more impressions. If you already dominate the placement for that term, the extra bid raises CPC without raising volume — diminishing returns. Mid-page positions are where an extra increment of bid actually converts into incremental impressions, and at constant CTR and CVR more impressions mechanically means more sales.

**Evidence offered:** Assertion with reasoning; points to the Search Query Performance report as the data source and defers the detail to another video.

**Fit here (5/10):** The principle — do not pay more for impressions you already have — is durable and correct, and Search Query Performance is available to brand-registered sellers, which a 12-SKU private-label catalog should be (see the Brand Analytics section above for the navigation path and what else the report supplies). Scored mid because the video only gestures at the method, and because at ~$1,800/mo Amazon revenue there are relatively few targets profitable enough to be candidates for a bid raise in the first place. Runnable today as a check before any bid increase.

*Source: Mina Elias — "Amazon Ads: How to Optimize PPC (Step-by-Step System)" (x20JtHcz3Fk)*

## Audit which ASINs are actually being advertised inside each ad group and troubleshoot any showing a 'not approved' status.

**Why it works:** A product listed in the ad group but not approved for advertising is silently invisible — the campaign appears to be running while one of its products never serves, so any performance read on that SKU is meaningless and the spend concentrates on the remaining ASINs by default rather than by decision.

**Evidence offered:** Spotted live in his own account ('this one's not approved, this is something to troubleshoot') with speculation that the cheaper pack would have had better CTR if it were serving.

**Fit here (6/10):** Pure hygiene, zero cost, runnable today across 12 SKUs by one person. Low ceiling on upside but the downside it prevents — concluding a SKU 'does not work on Amazon ads' when it was never eligible to serve — is exactly the kind of false verdict a solo operator with thin data is prone to.

*Source: Mina Elias — "Amazon Ads: How to Optimize PPC (Step-by-Step System)" (x20JtHcz3Fk)*

## When a parent listing has multiple variations, advertise only the variation with the best click-through and conversion rate and pause the rest, because buyers can switch to another variation once they are inside the listing.

**Why it works:** The advertised child ASIN is what renders in the search result, so it determines the click-through rate for the whole listing. The variation with the widest appeal (his chocolate-vs-vanilla example) pulls the most traffic to the listing, and the buyer selects their preferred variation on-page — so you get the best-performing shopfront without losing the sale of the other variants.

**Evidence offered:** Assertion with the chocolate/vanilla analogy and a price-point example; no data shown.

**Fit here (6/10):** Directly relevant to a natural deodorant catalog where scents are variations of one parent — this is the difference between paying to show a niche scent and paying to show the one that pulls clicks. Runnable today with an honest scale-down: at ~54 orders/month there is not enough ad-level CTR data to rank variations, so pick the advertised child from which scent already sells best organically on Amazon, then revisit as ad click volume accumulates rather than running a variation-level test.

*Source: Mina Elias — "Amazon Ads: How to Optimize PPC (Step-by-Step System)" (x20JtHcz3Fk)*

## Write ad creative for one specific search intent and reinforce that the shopper's exact criterion is met, instead of one general line built to survive every query the campaign might match.

**Why it works:** A shopper typing a qualifier search has already fixed their criteria; an ad that restates the criterion confirms 'you are in the right place' and wins the click at lower effort, whereas a broad line ('SPF 50 with no cast, just glow') speaks to a different desire and is ignored by everyone whose criterion it does not name.

**Evidence offered:** Live walkthrough of MediCube's no-white-cast creative appearing against 'silicone-free' searches, and a 'goodbye to oily sunscreen' ad taking top placement on 'no white cast sunscreen' — the wrong promise for that query.

**Fit here (8/10):** Directly runnable: Sponsored Brands headlines and Sponsored Display creative are per-campaign, and campaigns here already sort by parent product. The one-creative-per-intent rule pairs with the existing awareness-level messaging skill but is not recorded anywhere else as a paid-Amazon rule, and the operator writes all copy himself, so headline variants per keyword theme are today's work, not a hiring problem. Practically: one campaign per qualifier theme ('aluminum-free', 'baking soda free', 'unscented'), each with a headline that names that criterion.

*Source: Marketing by Emma — "It’s Boring, but It Will Fix 99% of Your Amazon PPC Problems" (twDUexmWaws)*

## Use the AI creative generation built into the Amazon advertising console to produce many intent-specific ad creatives cheaply, instead of defaulting to one general creative because targeted creative is too expensive to produce.

**Why it works:** The reason brands ship broad creative is production cost per variant; generating variants inside the ads console collapses that cost, so per-search-term creative becomes affordable without a design budget. It is what makes the one-creative-per-intent rule above economically possible for a solo operator.

**Evidence offered:** Assertion; creator points to the feature existing natively in the Amazon ads console with its creative partner.

**Fit here (6/10):** Real and runnable — a solo operator with no design budget is the exact case it exists for. Scored moderate because marketing-ai-product-imagery already owns the broader 'generate assets with AI rather than hiring a photographer' workflow with much stronger anti-fabrication and QA guardrails; this only adds the console surface, and those guardrails still have to be applied by hand to anything it outputs (no invented product attributes, no claims the listing cannot confirm). Platform mechanics class — the feature is named as of 2026 and should be re-verified before it is relied on.

*Source: Marketing by Emma — "It’s Boring, but It Will Fix 99% of Your Amazon PPC Problems" (twDUexmWaws)*

## Let keyword selection and listing content constrain each other: only target a qualifier search term if the listing can confirm that qualifier fast, and when a term is worth having, fix the listing to confirm it before scaling spend on it.

**Why it works:** PPC and the listing are one journey — the term states the criterion, the creative promises it, the listing must confirm it. Bidding on a term the listing cannot confirm converts the click into a bounce back to the search results; conversely, a term you want and cannot yet confirm is a listing task, not a bid task.

**Evidence offered:** Reasoned from the two demonstrations (mismatched ads, Kiehl's unconfirmable claim); creator states PPC strategy should inform listing strategy and vice versa.

**Fit here (8/10):** This is the sequencing rule the business already runs on — CRO before traffic — expressed as a concrete Amazon gate rather than a principle, and it gives a specific ordering for the 12-SKU catalogue: harvest the qualifier terms the products genuinely win on, build the confirmation into images/bullets/A+ (above the fold, not buried in the description), then bid. Runnable now at current Amazon spend by one person; nothing here needs volume, budget or another pair of hands.

*Source: Marketing by Emma — "It’s Boring, but It Will Fix 99% of Your Amazon PPC Problems" (twDUexmWaws)*

## Never let an AI agent write to your ad account directly — ask it for the plan first, review the full list of write actions (which keywords, which match types, which ASINs, which bid, which ad group), then approve execution as a separate step.

**Why it works:** Negations and bid changes are hard or tedious to reverse and are applied against live spend; forcing the agent to enumerate its intended writes turns an opaque action into a reviewable diff, catching wrong-ad-group or over-broad negations before they cost money.

**Evidence offered:** Demonstrated three separate times in the video — 'show me the plan' before negating, before harvesting, and before creating the automation rules. Presented as the presenter's standing habit, not tested against an alternative.

**Fit here (7/10):** Runnable today and cheap. Durable-principle class; nothing here depends on which vendor's MCP server is in use. A solo operator with no one to catch errors needs the plan-then-approve step more, not less.

**SCOPE — operator ruling, Sean 2026-09-05: PAID ADS PLATFORMS ONLY.** It binds any agent with write access to Meta, Amazon Ads, TikTok, Google Ads or a comparable ad account, and it does **not** generalize to every live marketing surface. The reason the line sits there is that an ad-account write spends money on a schedule you did not personally approve and cannot un-spend, and on Meta it also restarts the learning phase — so the cost of a wrong write is unbounded and partly irreversible. A Shopify, Klaviyo or CMS write is reversible, already carries its own gates and backups in this repo (`lib/queue-apply.js` captures a pre-write backup and stamps a `revert_plan`), and putting a human approval step in front of every one of those would stall the autonomy this fleet is built on. **Do not widen this to "any live marketing surface" without a fresh ruling** — an earlier draft of this note did exactly that and was narrowed.

*Source: Orange Klik (interview with Kartik, QuickMetrics) — "Amazon PPC: From Weekly Checks to Daily Rules (YouTube 2yqq9J9_1IE)" (transcript)*

## Harvest search terms that converted (a minimum order count at or below your ACoS target) out of the auto campaign into a manual exact campaign at a chosen bid, and negate them in the source campaign so the two campaigns stop bidding against each other.

**Stage:** scale — parked until the scale phase opens. Recorded now so it is not re-derived later.

**Why it works:** An auto campaign discovers demand but bids generically; moving a proven term to exact match lets you set an intentional bid against known economics and stops the auto campaign paying to re-discover something you already know converts. Negating in the source prevents internal competition on the same term.

**Evidence offered:** Demo showed two search terms at 7.2% and 4.6% ACoS being moved to the manual exact campaign at a bid of ₹8.45 with negative-exact applied to the auto campaign. Assertion plus one account's screen.

**Fit here (7/10):** Correct Amazon architecture and worth doing — but it needs a readable positive signal at the individual search term level: two or more orders on one term inside a 30-day window. At ~54 orders/month spread across 12 SKUs and two channels, almost every search term will sit at zero or one order, so a harvest rule fires on noise or never fires at all. Park behind scale. Trigger: one hero ASIN's auto campaign is producing enough monthly orders that single search terms clear 2+ orders in a 30-day lookback — then harvest that term and only that term. When it opens, apply the de-duplication rule above: expand the harvested term into one match type at a time and confirm no other campaign already holds that keyword+match type. Also apply the keyword/listing gate above before scaling spend on a harvested qualifier term.

*Source: Orange Klik (interview with Kartik, QuickMetrics) — "Amazon PPC: From Weekly Checks to Daily Rules (YouTube 2yqq9J9_1IE)" (transcript)*

## Connect your Amazon Seller Central and Ads data to an LLM through an MCP server so you can query performance and push changes conversationally, instead of exporting CSVs from Seller Central, analyzing them in a chat, and re-entering the changes by hand.

**Stage:** scale — parked until the scale phase opens. Recorded now so it is not re-derived later.

**Why it works:** The export-analyze-re-enter loop is where the hours go and where transcription errors enter; an MCP connection collapses read and write into one conversation, so the marginal cost of asking a question of the data drops to near zero and analysis actually gets done.

**Evidence offered:** Demo showed Claude pulling 220 search terms and writing 21 negations back to the ad account without the operator touching either dashboard. Vendor's own product; no comparative time or outcome data beyond 'this would take 30-40 minutes manually'.

**Fit here (6/10):** The mechanism is real and the solo-operator time saving is exactly the right kind of leverage. But it requires a paid analytics subscription on top of ~$2,700/mo combined revenue, and the vendor itself says it is aimed at sellers whose catalog and volume are already growing. Park behind scale per the paid-analytics-subscription rule; the 30-day free trial is the cheap way to test the claim before subscribing. Trigger: Amazon ad spend is large enough that 30-40 minutes of manual search term work per week is actually recurring, or Amazon revenue supports a monthly SaaS line item.

*Source: Orange Klik (interview with Kartik, QuickMetrics) — "Amazon PPC: From Weekly Checks to Daily Rules (YouTube 2yqq9J9_1IE)" (transcript)*

## Once you have run a PPC optimization pass by hand, convert that exact pass into a scheduled rule that runs on its own — with explicit thresholds (clicks, spend, orders, ACoS), a stated lookback window, a run frequency, and execute-and-notify so you are told what it changed.

**Stage:** scale — parked until the scale phase opens. Recorded now so it is not re-derived later.

**Why it works:** The negate-and-harvest pass is a known, repeating case with a decision rule you can write down; encoding it as a rule removes the weekly hands-on time entirely, and the notification keeps you informed without you having to open the dashboard. Your attention then goes to the cases that are genuinely new.

**Evidence offered:** Two rule sets were created live and verified inside the tool's rule-set page, mirroring the exact thresholds used in the manual pass. No before/after performance data on whether the automated version performs as well as the manual one.

**Fit here (6/10):** The 'turn the repeated manual pass into a written rule' shape is right for a solo operator with no team. But it needs the paid rule-set tool, and daily execution at ~54 orders/month would negate on single-click noise and would almost never fire the harvest branch — the thresholds only become meaningful once per-term click and order counts are readable. Park behind scale. Trigger: Amazon search term data is dense enough that the same negation decision recurs weekly; then encode it with a conservative click floor and weekly, not daily, frequency. This is not a duplicate of the 'install a written process when a problem recurs' claim in marketing-performance-pattern-analysis — that governs when to write a process; this specifies the thresholds and lookback an Amazon PPC rule needs.

*Source: Orange Klik (interview with Kartik, QuickMetrics) — "Amazon PPC: From Weekly Checks to Daily Rules (YouTube 2yqq9J9_1IE)" (transcript)*

## Once rules are automating the known cases, stop checking weekly and instead audit the rules themselves every month or two — open a fresh chat, have it review the action history and the campaigns, and adjust the order, ACoS or click thresholds if new cases have appeared.

**Stage:** scale — parked until the scale phase opens. Recorded now so it is not re-derived later.

**Why it works:** Automation handles the known case but silently ossifies as the account changes; a scheduled audit of the rule's own action log is what catches a threshold that has stopped matching reality, while a weekly check on an automated task is pure wasted attention.

**Evidence offered:** Stated by the presenter in the closing Q&A, pointing at the rule-set history page as the audit surface. Assertion only.

**Fit here (5/10):** Sensible maintenance discipline and it prevents the classic solo-operator failure of set-and-forget automation, but it is entirely downstream of having automation rules at all, so it inherits the same scale gate. Modest incremental value over the existing 'fix the evaluation horizon in writing' habit already recorded in marketing-performance-pattern-analysis, which is why it scores mid rather than high. Trigger: rule sets exist and have an action history to read.

*Source: Orange Klik (interview with Kartik, QuickMetrics) — "Amazon PPC: From Weekly Checks to Daily Rules (YouTube 2yqq9J9_1IE)" (transcript)*
