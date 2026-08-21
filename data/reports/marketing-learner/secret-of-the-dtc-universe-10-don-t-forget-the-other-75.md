# Secret of the DTC Universe #10: Don't Forget The Other 75%

**Creator:** Stefan Georgi  
**Source:** social post — `secret-of-the-dtc-universe-10-don-t-forget-the-other-75`  
**Published:** unknown (not supplied via --published)  
**Inferred era cues:** No explicit year. Era cues: his own 'StefanBrain' AI tool referenced as a paid product, a $100k/mo Meta spend account, an app funnel using push notifications and 14-day free trials, and CPL-based scaling language — all consistent with a 2024–2025 post. Undated overall; the content is offer/economics reasoning rather than platform mechanics, so the date matters little.  

A consulting-call teardown of a health app brand stuck at ~$100k/mo in Meta spend. Instead of auditing the ads, Georgi interrogates the funnel economics — $200/yr or $35/mo pricing, 25% trial-to-paid conversion, therefore a blended trial-user value of ~$41.50 and a breakeven CPL of ~$40. He then lays out three ways to unlock scale without touching creative: wait for cohort renewal data, raise first-year customer value through congruent upsells, or — his main argument — aggressively monetize the 75% of trial users who never convert, using staged descending-price flash offers on Day 15 and Day 21 plus a cheap 'light' tier, with each incremental conversion arithmetically raising the CPL the business can afford. The thesis is that unit economics, not ad creative, is what governs how far paid can scale.

Found 8 tactics: 4 adopted, 4 rejected.

## Adopted

### When paid spend stalls, stop looking at the ads and first compute the allowable cost per lead from the downstream conversion rate multiplied by blended customer value — the constraint is usually the funnel economics, not the creative. — 7/10

**Why it works:** A lead is only worth what it converts into. Allowable CPL = (probability the lead becomes a customer) × (blended value of that customer). Until that number is computed, every creative decision is being judged against an invented ceiling, and the operator burns effort optimizing the one input (cost per click) that is hardest to move while ignoring the two multiplicands that are easy to move.

**Evidence:** A worked back-of-napkin calculation on one client account: 25% trial-to-paid, 80% taking $200/yr and 20% taking $35/mo, therefore ~$41.50 per trial user and a ~$40 breakeven CPL — which exactly matched the client's observed scaling ceiling. Single account, self-reported, no data beyond the arithmetic.

**Fit:** Durable-principle class (unit economics), so age is irrelevant. Directly live: a $30/day Meta campaign is driving giveaway entries right now, and 'what is an entry worth' is the exact question this answers. The arithmetic here is entry→purchase rate × contribution margin per order at a $50.46 AOV, plus the repeat-purchase tail from the 18–22.5% repeat rate. The existing break-even entry in marketing-paid-campaign-structure states the frame but never gives the calculation or the diagnostic ordering (compute the ceiling before touching creative), which is the additive part. Held at 7 because at ~54 orders/month the entry→purchase rate will be a small-sample estimate for months, so the ceiling is a working number to revise, not a measurement.

**Target skill:** `marketing-paid-campaign-structure` (edit)

### When paid is capped, put the effort into converting the majority of leads who never bought rather than into lowering lead cost, because raising downstream conversion multiplies the value of every lead you are already paying for. — 7/10

**Why it works:** At a 25% conversion rate each lead is worth a quarter of a customer; at 100% it would be worth a whole one, so allowable CPL is 4x higher. Converting non-buyers is therefore mathematically identical to buying leads at a large discount — and it is usually the cheaper lever, because it uses owned channels you have already paid to reach rather than competing for auction inventory.

**Evidence:** Worked example: sequentially recovering 5%, 10% and 10% of non-converters is shown moving allowable CPL from $41.50 to ~$57.50 — a scale unlock the author says would double or triple ad spend, with 'none of this having anything to do with ads'. Illustrative arithmetic with invented take rates, no measured results.

**Fit:** Durable-principle class (unit economics / effort allocation), age irrelevant, and it is the correct allocation rule for this exact week: the giveaway campaign's entrants are, by construction, a pool of people who have raised a hand and not bought. With one operator and $30/day, hours spent building the post-entry email sequence are worth more than hours spent shaving cost per entry, because the entry→purchase rate is the multiplicand on everything the ad budget buys. It also reinforces the standing read that retention, not traffic, is the binding constraint — here stated as an acquisition argument rather than a retention one. Held at 7 because the source's example is a zero-marginal-cost app subscription, so the 4x headroom claim does not transfer to a physical-goods catalog with COGS and postage, and at a sub-1,000 list the recovered percentages will be directional.

**Target skill:** `marketing-paid-campaign-structure` (edit)

### Deliberately raise what an existing customer is worth in the first months — through congruent add-on offers, not upsell spam — because every dollar of added customer value raises the CPL you can afford and therefore how far ads can scale. — 6/10

**Why it works:** The CAC ceiling is a direct function of customer value, so an LTV improvement converts one-for-one into acquisition headroom. Moving blended value from $167 to $200 moves breakeven CPL from $41.50 to $50; to $300 moves it to $75. Because CPL and customer value are multiplicative in the same equation, a backend improvement can unlock more scale overnight than any amount of creative testing.

**Evidence:** Illustrative arithmetic across three value levels on the same client, plus the caveat that an established brand cannot hammer subscribers with upsells and must keep additions congruent (group coaching, a premium feature, a supplement stack). Assertion, no take-rate or revenue figures.

**Fit:** Durable-principle class, age irrelevant, and it names the link that makes AOV and retention work pay twice: bundles, refill cadence and post-purchase cross-sells are not just AOV levers, they are what raises the entry/order price the $30/day campaign can afford. The concrete moves are already owned by marketing-offer-construction and marketing-upsell-offer-design, so the additive claim is narrow — recompute the CAC ceiling whenever an AOV or repeat-rate change lands, rather than treating the two as separate projects. Held at 6 for that overlap, and because at $2,700/mo the arithmetic is real but the absolute headroom unlocked is small: a $5 lift in contribution per order buys a few extra dollars a day of spend, not a 3–10x scale step.

**Target skill:** `marketing-paid-campaign-structure` (edit)

### Build a staged sequence of escalating offers to leads who did not buy — fire the next one on a fixed day (Day 15, then Day 21), make each one materially more generous than the last, and measure each step by the incremental take rate it adds. — 5/10

**Why it works:** People who declined the standard offer have not declined every offer; a fixed schedule of progressively stronger asks keeps testing the price and structure at which each remaining slice will move, and because the lead is already paid for, every incremental conversion is pure addition to what the lead was worth.

**Evidence:** A hypothetical ladder — Day 15 push notification at 50% off, a $20/mo variant, Day 21 at 75% off, then a $9.99 light tier — with invented take rates (5%, 10%, 10%) carried through the CPL arithmetic. No account data on any step.

**Fit:** Durable-principle class (offer sequencing), age irrelevant. It genuinely adds something the existing pre-purchase nurture entry in marketing-lifecycle-email-flows lacks: that flow is defined as supplying belief and differentiation, with no schedule and no escalation ladder, and this supplies both — a dated sequence for giveaway entrants and never-bought subscribers. Two hard scale-downs. First, the descending-discount version does not survive a physical catalog: 50% and 75% off a $50.46-AOV consumable with real COGS and postage is margin-negative, and marketing-offer-construction explicitly warns that a repeating percent-off ladder trains the list to wait. Escalate by offer *structure* instead — reminder, then a named bundle, then a low-COGS bonus (lip balm, travel size) with purchase, then a genuinely time-bounded promotion with a stated reason-why. Second, at a sub-1,000 list each step's take rate is a handful of orders, so read it directionally and keep the ladder to three steps rather than five.

**Target skill:** `marketing-lifecycle-email-flows` (edit)

## Rejected

### Wait for cohort data on renewal rates before deciding how far you can scale, and use the waiting period to improve the product and user experience so renewal probability rises. — 3/10

**Rejected because:** No distinct mechanism — it is 'be patient and improve the product', and both halves already sit inside marketing-paid-campaign-structure (CAC ceiling from repeat value) and the retention/onboarding skills. Adding it would be duplication.

**Fit reasoning:** Durable-principle class, so age is not the issue — the issue is that there is no mechanism here beyond patience plus 'make the product better'. Both halves are already owned: setting the CAC ceiling from observed repeat value is covered by the break-even framing in marketing-paid-campaign-structure, and the product/experience improvement that raises repeat purchase is the entire subject of marketing-post-purchase-onboarding and marketing-retention-offers. Adding it would duplicate two skills and degrade triggering without supplying a single new testable action.

### Move non-converters onto a free or very cheap 'light' version of the product to keep them engaged and warm, then convert them to the full offer later. — 3/10

**Rejected because:** Restates the low-COGS entry offer and declined-upsell downsell already covered by marketing-offer-construction and marketing-upsell-offer-design, plus the non-buyer nurture flow in marketing-lifecycle-email-flows. A software 'light tier' has no zero-cost analogue for a physical consumable.

**Fit reasoning:** Durable-principle class, but there is no honest non-duplicative translation. A physical catalog's version of a 'light tier' is a cheap entry SKU offered when the main offer is declined — which is already covered three times over: the splinter/low-COGS entry offer and the four-offer-types audit in marketing-offer-construction, and the explicit declined-upsell downsell rule in marketing-upsell-offer-design. The 'keep them warm for free' half is the non-buyer nurture flow in marketing-lifecycle-email-flows. Nothing here is additive, and a free-tier analogue for a consumable means giving away product at real COGS against $2,700/mo revenue.

### Attribution and tracking are essential when a brand has both a large organic presence and paid spend, because the two channels support each other over an extended period. — 3/10

**Rejected because:** Motivational framing with no stated mechanism — it asserts attribution is essential but prescribes no metric, procedure, or test, and marketing-paid-media-measurement already owns the reporting stance for this business.

**Fit reasoning:** Durable-principle class in substance, but as stated it is an exhortation with no procedure — it names no metric to watch, no holdout, no reporting change, nothing testable. The stance this business needs on the question is already recorded in marketing-paid-media-measurement: use native platform reporting, do not buy a multi-touch attribution subscription at this revenue, and read primary metrics only. Promoting a contentless 'tracking matters' line would add no mechanism while competing with a skill that already owns the topic.

### Reach the non-converting majority through additional channels beyond the app — email, SMS, a branded community for downloaders, and a call center making value-driven outbound calls that end in a discount offer. — 2/10

**Rejected because:** The call-center and community halves assume resources and platforms this business does not have and cannot scale down honestly at a $50.46 AOV; the email and SMS halves duplicate the existing lifecycle-flow and warm-outreach skills.

**Fit reasoning:** Fails on standing constraints rather than on any gate. A call center is staffed outbound telesales — there is no team, no agency, and no honest scaled-down version for a $12 deodorant, where a phone call costs more than the contribution margin of several orders. A branded community is a platform Real Skin Care is not on and has no plan to be on. The only two channels with real form here, email and SMS, are already owned by marketing-lifecycle-email-flows and marketing-email-design-production, and the founder-emails-a-handful-of-people version is already covered as warm outreach in marketing-acquisition-channel-selection.

## Skills touched

- `marketing-paid-campaign-structure` (edit)
- `marketing-lifecycle-email-flows` (edit)
