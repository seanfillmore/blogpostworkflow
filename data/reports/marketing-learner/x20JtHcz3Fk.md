# Amazon Ads: How to Optimize PPC (Step-by-Step System)

**Creator:** Mina Elias  
**Video:** https://www.youtube.com/watch?v=x20JtHcz3Fk  
**Published:** 2025-12-30  
**Inferred era cues:** Published 2025-12-30. References current Amazon Ads console features: portfolios, ad-group level budget control absent ('I really hope this is coming soon'), placement bid adjustments (top of search first page / rest of search / product pages), top-of-search impression share column, negative exact and negative product targeting, Search Query Performance report, Helium 10 as a keyword source. Speaker cites 204 managed brands and $700M managed revenue in the last 12 months. No explicit year stated.  

A screen-share walkthrough of a manual Amazon Sponsored Products optimization routine run entirely inside Campaign Manager (no bulk sheets, no software). It covers account hygiene first — one portfolio per parent product, a structured campaign naming convention, one ad group per campaign, and capping active keywords per campaign — then the optimization loop itself: sort campaigns by ROAS and raise budgets on winners, read the placement/bid-adjustment report and push top-of-search bid multipliers where top-of-search outperforms other placements at low impression share, kill wasted spend by negating zero-order and high-ACoS search terms in loose/broad campaigns while lowering bids instead of negating in one-to-one exact and product-targeting campaigns, de-duplicate and expand proven search terms into match types they are not yet running in, audit which ASINs/variations are actually being advertised, and raise bids on profitable targets only where sponsored/organic rank still leaves headroom.

Found 15 tactics: 12 adopted, 3 rejected.

## Adopted

### Group Amazon campaigns into portfolios with one portfolio per parent product so per-product ad performance is readable at a glance. — 7/10

**Why it works:** Portfolios act as folders that roll up spend, CPC, sales and ACoS by product; without them a flat campaign list forces you to mentally reassemble which campaigns belong to which SKU before you can judge any product's ad economics.

**Evidence:** Assertion plus on-screen demonstration of his own account (dripstick, mainstream, aloe vera wipes portfolios) showing CPC and sales compared across products in one view.

**Fit:** 12 SKUs and ~$1,800/mo of Amazon revenue is exactly the size where a flat campaign list becomes unreadable but a portfolio-per-product view is a 20-minute one-time setup for a solo operator. Platform mechanics, but the tactic is 8 months old and portfolios are a long-stable console feature, so no staleness discount. Runnable today at current volume — it is organization, not a signal that needs order volume.

**Target skill:** `marketing-amazon-ppc-management` (edit)

### Keep exactly one ad group per campaign, because Amazon does not allow ad-group-level budget control and will split campaign budget across ad groups unpredictably. — 7/10

**Why it works:** Budget is set at campaign level; with two ad groups Amazon can allocate 80/20 in a way you did not choose and cannot override, so a losing ad group can starve a winning one inside the same campaign and you cannot tell from campaign-level metrics.

**Evidence:** Assertion, with the explicit reasoning about the missing ad-group budget control; on-screen check of ad group count as a 'red flag'.

**Fit:** This is a structural constraint of the current Amazon Ads console (platform mechanics class, 8 months old and still accurate), and it matters most at small spend where a single mis-split budget wastes a meaningful fraction of a tiny daily amount. A solo operator can audit 12 SKUs' campaigns for multi-ad-group structures in an hour.

**Target skill:** `marketing-amazon-ppc-management` (edit)

### Start every optimization pass by sorting campaigns by ROAS highest to lowest, and where a campaign beats your target ROAS but is not spending its full budget, raise the budget. — 7/10

**Why it works:** A campaign already clearing your ACoS target is proven economics; raising the budget removes the only ceiling you control and lets Amazon buy more of an auction you already win profitably. Budget-capped winners are the cheapest incremental sales in the account.

**Evidence:** Demonstrated live — campaigns at 10-11x ROAS on a $100 budget spending only $10, with the decision to raise the cap; his stated target is 4x ROAS / 25% ACoS.

**Fit:** Amazon is ~$1,800/mo, the larger of the two channels, and this is the highest-value move in the video for a business this size: it spends more only where the return is already proven. Runnable today by one person in the console. Note that at this order volume a 'winner' should be read over 30-60 days rather than 7, and the ROAS target should be set from actual gross margin on a $50 AOV catalog rather than borrowing his 4x.

**Target skill:** `marketing-amazon-ppc-management` (edit)

### In one-to-one campaigns (manual exact and product targeting), respond to unprofitable spend by lowering the bid rather than negating the target. — 7/10

**Why it works:** An exact keyword or ASIN target triggers for only that one thing, so the bid is a clean lever: lowering it pushes the ad further down the page, where the shopper who still scrolls and clicks carries higher intent. You either find a lower position where the target is profitable, or the target quietly stops spending — without permanently discarding a term that might work at a cheaper price.

**Evidence:** Assertion with clear reasoning, contrasted explicitly against why the same move is impossible in broad/auto campaigns.

**Fit:** This is the most transferable idea in the video for a low-volume account: at ~54 orders/month you cannot afford to permanently kill targets on thin data, and bid-down is the reversible version of the decision. Runnable today by one person in the console, no volume threshold required.

**Target skill:** `marketing-amazon-ppc-management` (edit)

### Use a fixed campaign naming convention — product code, campaign type/match type, keyword source, then an incrementing number — so any campaign's purpose is readable from its name alone. — 6/10

**Why it works:** You launch and kill campaigns continuously; without an encoded name you cannot tell at a glance whether a row is the auto discovery campaign, the exact harvest campaign, or a Helium 10 seeded test, which makes every optimization pass start with re-derivation.

**Evidence:** Assertion plus on-screen examples of his own naming ('product code - exact - search term report - 45').

**Fit:** Low-effort, zero-cost hygiene a solo operator can install in one sitting across a 12-SKU catalog, and it makes every future optimization pass faster. Value is real but modest against the binding retention constraint — it improves the speed of Amazon ad work, not the revenue directly.

**Target skill:** `marketing-amazon-ppc-management` (edit)

### Cap a manual campaign at roughly five active keywords: sort targets by sales over 30-60 days, pause the ones producing no sales, and relaunch those paused keywords in their own campaigns where they can get budget. — 6/10

**Why it works:** Within one campaign the top keywords absorb the budget, so a keyword can look dead purely because it never got funded. Pausing it in the crowded campaign and re-launching it in a campaign of its own gives it a real budget test rather than a starved one.

**Evidence:** Assertion plus on-screen filtering of active targets and sorting by sales; reasoning that 'it's probably not even getting budget'.

**Fit:** Directly runnable today: filtering targets by active status and sorting by sales is console work, not a statistical test. At ~$1,800/mo Amazon revenue the honest scale-down is to require a minimum click count (say 10+ clicks) before calling a keyword dead, otherwise you are pausing on noise rather than on evidence, and to relaunch only one or two orphaned keywords at a time so $30-level daily budgets are not fragmented across a dozen tiny campaigns.

**Target skill:** `marketing-amazon-ppc-management` (edit)

### Open the placement (bid adjustment) report and raise the top-of-search bid multiplier where top-of-search first page shows better ACoS and click-through rate than rest-of-search and product pages while top-of-search impression share sits under 5%. — 6/10

**Why it works:** Placements are not equal — the same keyword converts at a different rate depending on where the ad renders. If the placement that converts best is also the one you almost never win, the multiplier is the only lever that buys more of it, and the ad economics of the extra impressions are already known from the placement data.

**Evidence:** Demonstrated on two campaigns: one showing 45% CTR and 34% ACoS at top-of-search first page versus much worse product-page performance, with the multiplier raised from 105% to 120%.

**Fit:** Runnable today with an honest scale-down: at ~$1,800/mo Amazon revenue any single campaign's placement split will be a handful of clicks (the creator himself keeps skipping campaigns with $1-6 of placement spend), so read the placement contrast over a 90-day window and at portfolio level rather than per campaign per week, and move the multiplier in small steps. The mechanism does not require scale — only the read does, and lengthening the window supplies it.

**Target skill:** `marketing-amazon-ppc-management` (edit)

### Wasted spend is not only zero-order terms — also negate search terms that do convert but at high ACoS with very few orders, because in a multi-term target you cannot lower the bid on them individually. — 6/10

**Why it works:** A term with 1-2 orders at 47%+ ACoS is losing money at scale, but it sits under a broad/auto target whose bid applies to every term it triggers for; the only surgical instrument available is a negative exact.

**Evidence:** Demonstrated by sorting the search term report by ACoS and reasoning through the 47%/7-orders case (keep) versus 47%/1-2-orders case (negate).

**Fit:** Extends the existing zero-order negation claim to the unprofitable-but-converting case, which the skill does not currently cover. Runnable today in the console. Because this business runs ~54 orders/month total, the order-count threshold that separates 'keep' from 'negate' should be set low and read over 60-90 days, and the ACoS cut-off set from real gross margin at a $50.46 AOV rather than copied.

**Target skill:** `marketing-amazon-ppc-management` (edit)

### De-duplicate before launching: never run the same keyword in the same match type in two campaigns, and expand a proven term only into the match types it is not already running in. — 6/10

**Why it works:** Two campaigns holding the same keyword+match type compete in the same auction; only one can win the impression, and it will usually be whichever has the higher bid rather than whichever has the conversion history. The established campaign then loses its spend and its performance decays while the accidental duplicate learns from scratch — a strictly worse outcome than either alone.

**Evidence:** Assertion with a detailed causal walkthrough of the failure mode; he points to a de-duplication macro in his toolbox as the operational fix.

**Fit:** The de-duplication rule is genuinely distinct from the existing 'negate the harvested term in the source campaign' claim and is a real failure mode for a solo operator relaunching campaigns across 12 SKUs. Runnable today — it is a spreadsheet check, not a test. Scale-down: at this spend, expand a proven term into one additional match type at a time rather than firing broad + phrase + exact simultaneously, because splitting a small daily budget across three new campaigns starves all of them.

**Target skill:** `marketing-amazon-ppc-management` (edit)

### Audit which ASINs are actually being advertised inside each ad group and troubleshoot any showing a 'not approved' status. — 6/10

**Why it works:** A product listed in the ad group but not approved for advertising is silently invisible — the campaign appears to be running while one of its products never serves, so any performance read on that SKU is meaningless and the spend concentrates on the remaining ASINs by default rather than by decision.

**Evidence:** Spotted live in his own account ('this one's not approved, this is something to troubleshoot') with speculation that the cheaper pack would have had better CTR if it were serving.

**Fit:** Pure hygiene, zero cost, runnable today across 12 SKUs by one person. Low ceiling on upside but the downside it prevents — concluding a SKU 'does not work on Amazon ads' when it was never eligible to serve — is exactly the kind of false verdict a solo operator with thin data is prone to.

**Target skill:** `marketing-amazon-ppc-management` (edit)

### When a parent listing has multiple variations, advertise only the variation with the best click-through and conversion rate and pause the rest, because buyers can switch to another variation once they are inside the listing. — 6/10

**Why it works:** The advertised child ASIN is what renders in the search result, so it determines the click-through rate for the whole listing. The variation with the widest appeal (his chocolate-vs-vanilla example) pulls the most traffic to the listing, and the buyer selects their preferred variation on-page — so you get the best-performing shopfront without losing the sale of the other variants.

**Evidence:** Assertion with the chocolate/vanilla analogy and a price-point example; no data shown.

**Fit:** Directly relevant to a natural deodorant catalog where scents are variations of one parent — this is the difference between paying to show a niche scent and paying to show the one that pulls clicks. Runnable today with an honest scale-down: at ~54 orders/month there is not enough ad-level CTR data to rank variations, so pick the advertised child from which scent already sells best organically on Amazon, then revisit as ad click volume accumulates rather than running a variation-level test.

**Target skill:** `marketing-amazon-ppc-management` (edit)

### Before raising the bid on a profitable target, check its current sponsored and organic rank — raise the bid only where there is positional headroom (e.g. position 10-20 moving to 5-6), not where you already rank at the top. — 5/10

**Why it works:** A bid increase only pays if it buys more impressions. If you already dominate the placement for that term, the extra bid raises CPC without raising volume — diminishing returns. Mid-page positions are where an extra increment of bid actually converts into incremental impressions, and at constant CTR and CVR more impressions mechanically means more sales.

**Evidence:** Assertion with reasoning; points to the Search Query Performance report as the data source and defers the detail to another video.

**Fit:** The principle — do not pay more for impressions you already have — is durable and correct, and Search Query Performance is available to brand-registered sellers, which a 12-SKU private-label catalog should be. Scored mid because the video only gestures at the method, and because at ~$1,800/mo Amazon revenue there are relatively few targets profitable enough to be candidates for a bid raise in the first place. Runnable today as a check before any bid increase.

**Target skill:** `marketing-amazon-ppc-management` (edit)

## Rejected

### Filter the search term report for terms with meaningful spend and zero orders, and add them as negative exact. — 4/10

**Rejected because:** Duplicate of the existing marketing-amazon-ppc-management claim about pulling the search term report, isolating zero-order spenders and negating them as negative exact. Re-recording it would degrade skill triggering.

**Fit reasoning:** Sound and relevant, but already held verbatim by marketing-amazon-ppc-management: 'Pull the last 30 days of search terms for a campaign, isolate every term with at least a couple of clicks and meaningful spend but zero orders, and negate them as negative exact — plus negate any ASINs that appear as negative product targets.'

### Take profitable search terms out of the discovery campaign and launch them as targeted keywords in a manual campaign. — 4/10

**Rejected because:** Duplicate of the existing marketing-amazon-ppc-management search-term harvesting claim.

**Fit reasoning:** Already held by marketing-amazon-ppc-management: 'Harvest search terms that converted (a minimum order count at or below your ACoS target) out of the auto campaign into a manual exact campaign at a chosen bid, and negate them in the source campaign so the two campaigns stop bidding against each other.'

### Optimize PPC first, then optimize the listing, and the combination compounds into a 10x more profitable product. — 2/10

**Rejected because:** Motivational framing with no stated mechanism — it is a pointer to another video, not an actionable or testable instruction, and the listing work it alludes to is already held by marketing-product-image-stack and marketing-awareness-level-messaging.

**Fit reasoning:** No mechanism is actually specified — nothing here says what to change on the listing or how to sequence the work, and the '10x more profitable' figure is unsupported. The listing-optimization work it gestures at is already covered in depth by marketing-product-image-stack and marketing-awareness-level-messaging.

## Skills touched

- `marketing-amazon-ppc-management` (edit)
