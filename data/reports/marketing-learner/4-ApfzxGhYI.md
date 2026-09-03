# Claude Has Officially Changed Facebook Ads Forever! (Tutorial)

**Creator:** Professor Charley T  
**Video:** https://www.youtube.com/watch?v=4-ApfzxGhYI  
**Published:** 2026-09-02  
**Inferred era cues:** Published 2026-09-02. References Claude skills vs. free-plan copy-paste prompts, Meta Ad Library page search, 3-2-2 Flexible Ads, the creator's 'Olympic rings' / 'Andromeda 1' campaign method, and Dara Denney as a research source. No stale platform mechanics — the account-level claims are current-era.  

A two-step LLM-assisted workflow for Meta ads. Step one: export your order history and have Claude rank every entry SKU not by revenue or ROAS but by how likely a first-time buyer of that SKU is to purchase again — using the Wilson score interval so low-order-count SKUs don't win on noise — and treat that SKU as the 'hero product' to buy customers with. Step two: a 3-2-2 ad builder that ingests six weighted categories of customer evidence (reviews, churn-survey free text, support tickets and ad comments, your own ads and landing page, competitor reviews and ads, interviews), explicitly refuses ad performance data, audits the gap between what you claim and what customers actually say, assigns the ad exactly one funnel job (earn attention for scale, convert trust for efficiency — 'midfunnel is a myth'), picks format from that job, generates and kills concepts with stated reasons, and finishes by pre-registering a written test specification with a 'because' hypothesis, what the test does not test, and what is and is not in doubt if it loses.

Found 23 tactics: 15 adopted, 8 rejected (2 of the adopted parked behind a stage gate).

## Adopted

### Pick the product you advertise by which entry SKU's first-time buyers come back most often, not by which SKU sells the most or shows the best ROAS. — 8/10

**Why it works:** The first order a customer places is the strongest observable predictor of whether they ever order again; if you spend acquisition dollars on the SKU whose cohort never repurchases, you buy one-and-done customers and repeat revenue never compounds, no matter how good the front-end ROAS looks.

**Evidence:** Case walkthrough of a ~$2M/yr coffee brand: the best-selling sampler had an ~8% repurchase rate (third worst in the catalog), while Single Origin Ethiopia showed a 35% repurchase rate and already produced more returning revenue than any other SKU off half the first-time customers.

**Fit:** Retention is the stated binding constraint and repeat customers are already 45-52% of revenue, so choosing which of 12 SKUs the $30/day Meta campaign points at is exactly the decision that moves the constraint. Runnable today from a Shopify order CSV; Amazon repeat data is thinner so the analysis is Shopify-led. At ~54 orders/month per-SKU contrasts are directional rather than significant — run it on all-time order history, not a 90-day window, and treat the ranking as a hypothesis about where to point spend rather than a proof.

**Target skill:** `marketing-offer-construction` (edit)

### Before writing any ad, assemble a customer-evidence corpus from six named sources in weighted order — reviews (heaviest), churn/exit survey free text, support tickets and ad comments, your own live ads and landing page, competitor reviews and ads, and recorded customer interviews — and keep every input in the customer's own words. — 8/10

**Why it works:** Each source answers a different question: reviews say why people stay, exit surveys and support say what nearly stopped them, your own assets say what you are claiming. Writing from the whole map instead of one source means the ad's message is sourced from language buyers actually used rather than from the brand's imagination.

**Evidence:** Live walkthrough on 340+ reviews, a 62-person churn survey, 18 support tickets, nine running ads plus a scraped landing page; the builder explicitly stated which category could and could not answer which question.

**Fit:** Entirely runnable by one person today — Real Skin Care has Shopify and Amazon reviews to export, an inbox of support email, its own live ads and PDPs, and can email a sub-1,000 list for exit feedback. Natural deodorant is an objection-heavy category (transition period, staining, 'does it actually work'), so the objection-side sources are the ones with the most to give. Complements review-mining rather than duplicating it: the new work is the weighting and the cross-source gap-reading, not the review export.

**Target skill:** `marketing-creative-evidence-map` (create)

### Audit your own claims against the evidence corpus by counting how often your core vocabulary appears in customer language, and stop making any claim that appears zero times. — 8/10

**Why it works:** The gap between what the brand asserts and what buyers say is what makes ads fail invisibly; if 400+ pieces of customer evidence never mention a feature, an ad built on that feature is filtering out the people most likely to buy and repurchase.

**Evidence:** Case: the brand's core vocabulary appeared zero times across 400+ pieces of evidence, five of nine live ads made a claim customers never made, and provenance, altitude, tasting notes, brewing qualifications and free shipping — the basis of most running ads — were never mentioned once.

**Fit:** High-leverage and free for a 12-SKU catalog whose ads and PDPs likely lead on formulation and ingredient language. Runnable today against existing Shopify/Amazon reviews and support email; it produces a kill list for PDP copy, Amazon bullets, and the Meta primary text going into the giveaway campaign. Durable copy principle, no age or volume dependency.

**Target skill:** `marketing-creative-evidence-map` (edit)

### Pre-register a written test specification with every ad test: a hypothesis containing a 'because', a business result rather than a platform metric, what the test explicitly does not test, what is and is not in doubt if it loses, the ordered list of what to revisit, and what the next bottleneck becomes if it wins. — 8/10

**Why it works:** A test without a written hypothesis is just spending — you cannot say afterwards what you learned. Naming in advance that only the concept is in doubt on a loss stops a single failed ad from being used to discard the hero product or the customer evidence, which came from receipts and from things people actually said.

**Evidence:** Demonstrated end to end on the case, including the 'if cold buyers exclude themselves because they think they're not serious enough, and 23 of 62 told us they nearly did, then...' hypothesis, the one-item loss list, and the win-side note that the landing page becomes the bottleneck.

**Fit:** This is the highest-value item in the video for this account. At ~54 orders/month and $30/day, most tests will return a result too small to be significant, so the only thing that makes a test worth running is a written statement of what it would mean — otherwise a null result gets misread as a verdict against the angle or the SKU. One page of writing, no spend, no volume, runnable today. Sharpens the existing after-the-fact decision log by pre-committing the falsification scope.

**Target skill:** `marketing-performance-pattern-analysis` (edit)

### Rank SKUs by the Wilson score interval on their repurchase rate rather than by the raw percentage, so a product with a tiny order count cannot top the list on noise. — 7/10

**Why it works:** The Wilson interval applies a confidence bound to a proportion at small sample sizes, so a 40% repeat rate off 12 orders scores below a 30% rate off 400 orders — which prevents you from re-pointing your whole ad budget at a vanity winner.

**Evidence:** Assertion plus the case: Panama Geisha had the nominally highest repeat rate (7%+ in his framing) but low confidence, while the highest-confidence SKU (Single Origin Ethiopia, ~8,000 customers) was a third product nobody was looking at. Attributed to Edwin Wilson, 1927, and to ranking systems used by social platforms.

**Fit:** This is the specific guard that makes claim-1 safe at ~54 orders/month — the method exists precisely for low-count data, so it is runnable now rather than parked behind scale. Durable statistical principle, not platform mechanics, so its 1927 origin is irrelevant to its score. Practical form for a solo operator: ask the LLM for the Wilson lower bound alongside the raw rate and sort on the bound.

**Target skill:** `marketing-performance-pattern-analysis` (edit)

### Make monthly revenue from non-first-time buyers the success metric that acquisition decisions are judged against, rather than campaign ROAS. — 7/10

**Why it works:** A high-ROAS ad can be profitably buying customers who never return; the only compounding line in the business is returning-customer revenue, so if that number rises month over month you can keep raising spend, and if it does not, front-end efficiency is an illusion.

**Evidence:** Assertion, framed as 'the only definition of success any business operator should ever care about' and supported by the case brand's discovery that its highest-spend, best-ROAS SKU had the third-worst repeat rate.

**Fit:** Fits the operating reality directly: prime directive is revenue, retention is the constraint, and repeat customers already carry ~half of revenue. Distinct from the existing LTGP:CAC ratio claim — this is a monthly trend line the solo operator can read off Shopify without a paid analytics tool. Concrete now: one number per month, tracked next to the $900/mo Meta spend.

**Target skill:** `marketing-paid-media-measurement` (edit)

### Deliberately exclude ad performance data from the creative research inputs. — 7/10

**Why it works:** Attribution metrics record what happened but never why, so ranking ads by result only ever returns 'make more of last month's winner' — and a winner built on an unsupported claim can be buying customers who never repurchase, which the ROAS column will never show you.

**Evidence:** Assertion; the builder is shown outright refusing performance files, with the 'doom cycle of constantly launching ads and getting nowhere' named as the failure mode.

**Fit:** Cheap discipline that is runnable now and protects a $30/day account where per-ad results are noisy anyway — at ~54 orders/month, sorting creative ideas by last month's ROAS is reading noise as strategy. Sits alongside, not against, the existing 'dissect a breakthrough ad' claim: performance tells you which asset to iterate, evidence tells you what to say.

**Target skill:** `marketing-creative-evidence-map` (edit)

### Split objections that arrive bundled in survey free text into distinct ones — price and 'suitability / not for someone like me' are not the same objection and are not solved by the same ad — and check whether one source corroborates another before treating either as real. — 7/10

**Why it works:** Exit-survey text collapses different hesitations into one bucket; if you treat them as one, the ad answers the wrong barrier. Cross-checking against support tickets shows which objection people actually act on versus which they only report.

**Evidence:** Case: 49 of 62 churned buyers mentioned price or suitability, but not one of 18 support tickets mentioned taste or price — the builder flagged the non-corroboration explicitly rather than accepting the survey at face value.

**Fit:** Directly applicable: natural deodorant churn almost always bundles 'it's expensive for a deodorant' with 'it didn't work for my body', and those need different creative. Runnable now — a short free-text exit question to lapsed buyers on a sub-1,000 list plus the existing support inbox is enough input, and the corroboration check is a reading discipline, not a volume requirement.

**Target skill:** `marketing-creative-evidence-map` (edit)

### Require every spoken or written line in the final ad script to trace back to an actual customer utterance, with the number of times it was said sitting next to it. — 7/10

**Why it works:** Frequency-counted verbatim language guarantees the ad speaks in words the market already uses and removes the copywriter's invention from the highest-leverage lines.

**Evidence:** Case: every spoken line in the three video executions came out of the review file with a count beside it; the disqualification hook was backed by '23 of 62 told us they nearly did'.

**Fit:** Runnable now with the existing Shopify and Amazon review corpus plus an LLM. Distinct from the existing 'golden nugget testimonial' export claim — the new requirement is traceability with a count for every line, which is what makes a low-volume $30/day test interpretable when it wins or loses. Durable copy principle.

**Target skill:** `marketing-review-mining` (edit)

### Build the hook on the buyer's own self-exclusion — an identity statement ('I'm not a coffee person and I don't want to be'), a list of the expertise they lack, and a near-miss confession ('I almost didn't order this, it looked like the kind of thing you're supposed to already know about') — so the ad removes the competence barrier before price is ever considered. — 7/10

**Why it works:** Many cold buyers exclude themselves because the category signals it is for enthusiasts. Opening on that self-exclusion and disqualifying the need for expertise dissolves the barrier and makes the near-miss confession do the persuading in the buyer's own voice.

**Evidence:** Three executions written this way, each line drawn from the review file with counts; 23 of 62 surveyed churned buyers said they nearly did not order for this reason.

**Fit:** Translates cleanly and specifically: natural deodorant and natural oral care carry a 'that's for crunchy people / I'd have to change my whole routine' competence and identity barrier, and the near-miss confession is a hook structure the operator can write today for the giveaway ads and the PDP. Distinct from the existing disqualify-the-wrong-reader claim, which excludes readers; this one includes the reader by disqualifying the expertise requirement. Durable copy principle.

**Target skill:** `marketing-copy-hooks-and-formats` (edit)

### Give each ad exactly one job — earn attention, clarify value, or convert trust — decide that job from whether your current problem is scale or efficiency, and choose the format only after the job is fixed; refuse 'midfunnel' as a diagnosis. — 6/10

**Why it works:** An ad asked to do several jobs does none. Diagnosing scale-vs-efficiency turns an abstract funnel debate into a question about your own account, and fixing the job before the format prevents format defaults (we always make statics / we always make video) from deciding strategy.

**Evidence:** Assertion, demonstrated: the builder recommended 'earn attention' from the evidence, refused a midfunnel answer, and only then asked what content could be produced.

**Fit:** Runnable today inside one CBO campaign — it is a decision rule, not a spend requirement. Partially overlaps the existing 'cover distinct creative jobs rather than creative volume' claim, but adds two things that claim does not hold: the job is chosen from a scale-vs-efficiency diagnosis of the account, and the job is locked before format. Scored moderately because of that overlap, not because of timing.

**Target skill:** `marketing-paid-creative-testing` (edit)

### Assign each piece of customer evidence to one funnel stage and never use the same point twice — the price rebuttal and product mechanics stay collected but non-load-bearing in the attention ad and become load-bearing in the next-stage ad, so the sequence completes one conversation. — 6/10 · parked until `scale`

**Why it works:** Sequential messaging across stages means each ad advances the buyer instead of repeating the previous ad's argument, which is what lets a funnel build cash flow rather than re-litigating the same objection to the same person.

**Evidence:** Demonstrated in the ring-assignment report, where mapped evidence was explicitly marked as collected-but-not-load-bearing for the current job and reserved for the clarify-value ring.

**Fit:** Right for this business but not at $30/day with everything collapsed into a single ad set — a genuine multi-stage sequence needs several ad sets and enough traffic for a retargetable pool, which is order and spend volume this account does not have yet. Parked behind scale; the trigger is spend and traffic sufficient to run a second stage against a warmed audience (roughly a retargeting pool large enough to deliver, and budget beyond the single CBO ad set). The runnable-today fragment — writing down which evidence is reserved for a later stage rather than cramming it all into one ad — is already covered by the one-job rule above.

**Target skill:** `marketing-paid-campaign-structure` (edit)

### Let the ad's job dictate the format, and when the job is earning attention with a testimonial, that means a phone-shot vertical UGC video under 25 seconds with no colour grade. — 6/10 · parked until `team`

**Why it works:** Format is a delivery decision downstream of the job; a raw, ungraded phone video reads as a real person's account rather than as advertising, which is what earns attention from cold audiences.

**Evidence:** Demonstrated: the builder committed to video after the job was set, named UGC testimonial as the form, stated what a static could have done instead, and specified three executions all under 25 seconds, vertical, phone-shot.

**Fit:** Sound, but the asset is a customer on camera — UGC production and a creator to deliver it are exactly what the team gate parks. The existing static-first rule stands for the solo operator precisely because a static has two failure points one person controls. Trigger: a willing repeat customer or paid creator who can carry a clip, at which point the job-to-format rule and the 25-second/vertical/no-grade spec become the brief. Scored on the merit it will have then.

**Target skill:** `marketing-creator-content-sourcing` (edit)

### Generate several ad concepts, cut most of them, and write down the reason each was cut plus the runner-up you are holding, so the choice is arguable rather than assumed. — 6/10

**Why it works:** A visible kill log lets you disagree with the selection and gives you the next concept to run without redoing the research, and each surviving concept carries its evidence, format, core message, the objection it attacks, and a testable hypothesis.

**Evidence:** Demonstrated: five concepts built, three removed with stated reasons, the top pick and a held second surfaced with their carried components.

**Fit:** Runnable now by one person with an LLM and no spend — it is a documentation habit around concepting, and the held runner-up is what fills the next creative slot when the first one fails at $30/day. Overlaps the existing decision-log claim in spirit, so scored moderately, but the pre-selection kill reasons are a distinct artifact from a post-hoc change log.

**Target skill:** `marketing-paid-creative-testing` (edit)

### When repeat buyers explain why they keep buying, expect the answer to be habit — one less decision to make — and build the retention message on that rather than on product excellence. — 6/10

**Why it works:** Repeat purchase is sustained by removing a recurring decision, not by admiration of the product; copy and flows that install the product as the default choice produce more second orders than copy that re-argues quality.

**Evidence:** Case: the 340+ review corpus showed buyers attributing repeat purchase to it becoming a habit and one less decision, not to the coffee being great.

**Fit:** Applies directly — deodorant and oral care are consumables where the repeat is a restock decision, and this points the post-purchase and win-back messaging at 'never think about it again' rather than at ingredients. Runnable now against the existing review corpus. Scored moderately because it partially overlaps the existing named-routine claim in post-purchase onboarding; the new part is the reason given for the repeat and where the copy should point.

**Target skill:** `marketing-retention-offers` (edit)

## Rejected

### Build the final ad as a 3-2-2 — three creatives, two primary texts, two headlines, twelve combinations from one concept, all sharing one strategic center. — 3/10

**Rejected because:** Duplicate of the existing marketing-paid-creative-testing claim 'Build a 3-2-2 Flexible Ad — three creatives of the same format and aspect ratio, two meaningfully different primary texts, two meaningfully different headlines — so twelve combinations share a single learning pool and Meta allocates spend among them itself.'

**Fit reasoning:** Not a scoring problem — this is already recorded. marketing-paid-creative-testing holds 'Build a 3-2-2 Flexible Ad — three creatives of the same format and aspect ratio, two meaningfully different primary texts, two meaningfully different headlines — so twelve combinations share a single learning pool', including judging the ad as one unit.

### If the ad wins, the landing page becomes the bottleneck — an ad that disqualifies expertise cannot point at a page that demands it. — 3/10

**Rejected because:** Duplicate of the marketing-lead-capture-landing-pages claim 'Enforce congruency across the whole chain — ad, entry/pre-sell page, offer page — so the click-to-close experience reads as one continuous document rather than a Frankenstein of mismatched pieces.'

**Fit reasoning:** Already recorded, so no scoring judgment is needed on fit; the continuity requirement is held verbatim elsewhere.

### Pull competitor ads by searching their page name in the Meta Ad Library, and read their product reviews, because success and failure both leave clues. — 3/10

**Rejected because:** Duplicate of the marketing-competitor-messaging-teardown claim 'Research competitor ad libraries first and run a gap analysis on which awareness levels, personas, and formats are missing from your own rotation before producing anything.'

**Fit reasoning:** Already recorded as a standing first step, so this adds nothing new to the fleet.

### You do not need a full funnel of ads to start — only a couple of ads doing one job. — 3/10

**Rejected because:** Duplicate of the marketing-paid-campaign-structure claim 'Start every new product, offer or brand with the simplest possible funnel — one type of ad pointing directly at a PDP or landing page, no advertorial and no quiz in between — and only add a step once the two-element version has a known result and known economics.'

**Fit reasoning:** Already recorded; restating it would degrade triggering on the campaign-structure skill.

### The most important question you can ask is 'can we spend more money tomorrow?' — and the hero-product analysis exists to keep the answer yes. — 3/10

**Rejected because:** Duplicate of the marketing-paid-media-measurement claim 'Before changing anything, ask can I spend more money and stay profitable right now? — if yes, raise the budget and touch nothing else.'

**Fit reasoning:** The decision rule is already held in the measurement skill; only the framing is new, and framing is not a mechanism.

### Acknowledge that the repeat-rate report describes a pattern in your receipts but cannot explain it — it cannot separate a genuinely excellent product from a buyer type who repurchases from anyone. — 3/10

**Rejected because:** Duplicate of marketing-performance-pattern-analysis, which already covers 'treating conclusions at low volume as directional' and Step 11's requirement to separate what was actually stated from what you are inferring before acting on any finding. The caveat is instead carried in the reasoning on the adopted hero-product tactic.

**Fit reasoning:** Good intellectual hygiene, but the fleet already holds the equivalent rule about treating low-volume conclusions as directional and vetting imported claims before acting on them; recording it again would blur triggering on the analysis skill.

### Stop selling products and start buying customers — sell the steak, not the sizzle; be a cash-flow farmer, not a ROAS hunter. — 2/10

**Rejected because:** Motivational framing with no stated mechanism — not actionable or testable on its own, and its actionable content is fully carried by the hero-product selection and returning-revenue metric tactics adopted from this same video.

**Fit reasoning:** Motivational framing with no mechanism of its own. Everything testable inside it is already captured by the hero-product-by-repeat-rate tactic and the returning-revenue north-star metric, both adopted above.

### Install the creator's free Claude skill files (or paste them as one long prompt on the free plan), and get the maintained packaged versions from his academy. — 2/10

**Rejected because:** No marketing mechanism of its own — it is promotion for the creator's prompt package. The transferable step (run the order export and review corpus through an LLM) is already adopted as its own tactic.

**Fit reasoning:** This is tooling distribution for the creator's own product, not a marketing tactic. The underlying actionable step — hand an order-history CSV and a review export to an LLM and ask for the analysis — is already captured in the hero-product and evidence-map tactics.

## Skills touched

- `marketing-offer-construction` (edit)
- `marketing-performance-pattern-analysis` (edit)
- `marketing-paid-media-measurement` (edit)
- `marketing-creative-evidence-map` (create)
- `marketing-review-mining` (edit)
- `marketing-paid-creative-testing` (edit)
- `marketing-paid-campaign-structure` (edit)
- `marketing-creator-content-sourcing` (edit)
- `marketing-copy-hooks-and-formats` (edit)
- `marketing-retention-offers` (edit)
