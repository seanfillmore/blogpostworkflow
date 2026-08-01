# Using Claude to Make my Amazon Product Images (2026 Tutorial)

**Creator:** Chris Rawlings  
**Video:** https://www.youtube.com/watch?v=SOaXUiLyx2M  
**Published:** 2026-05-20  
**Inferred era cues:** Explicitly 2026-era: GPT Images 2.0 'just came out on April 21st', 'this literally just happened within the last 8 days', Nano Banana Pro, downloadable Claude skills, Amazon Experiments (Manage Your Experiments), Y Combinator commentary on models plugging into proprietary company data. Published 2026-05-20.  

A workflow video for Amazon sellers on generating and iterating primary (main) listing images with AI. The creator argues the main image is the single highest-leverage asset on a listing because it moves both click-through rate and conversion rate, shows a compounding revenue model (30% CTR + 30% CVR lift ≈ 60% revenue at flat impressions), and presents a portfolio of before/after main-image changes with claimed CTR/CVR lifts. He then walks a loop: export the 60-day search term report, have Claude distill insights and form CTR hypotheses, turn hypotheses into image prompts, generate with Nano Banana Pro or GPT Images 2.0 using reference images of the real product, edit the near-misses, patch garbled small text in Canva, and validate each change with an Amazon Experiments A/B test. Along the way he names a concrete lever list for main images (labels tied to search intent, models using the product, ingredient visuals, colour pops, scale references, render vs photo, packaging and multipack shots) and two hard Amazon compliance limits.

Found 8 tactics: 4 adopted, 4 rejected.

## Adopted

### Change the main image using a specific lever list: a label that speaks to the primary shopper intent, a model actually using the product, visual representation of ingredients, a pop of colour or higher contrast, multiple angles, a render instead of a photograph, a scale reference such as a hand, the product shown alongside its packaging, everything included in a multipack or kit, and the colour/scent variations. — 8/10

**Why it works:** Each lever fixes a different comprehension failure in a 1-second thumbnail glance — size, use case, contents, ingredients, or what the product even is — so the buyer no longer has to read the title to understand whether it is for them.

**Evidence:** A rapid-fire gallery of portfolio examples, one per lever, several with claimed CTR/CVR deltas (white pie → red pie in a pie holder; light rays to show UV action; hand added to show a bottle fits in a backpack; ingredients added plus better render = +30% CTR). Practitioner assertion with before/after screenshots, no controlled data.

**Fit:** Durable design principle, no decay, and it is the most directly usable thing in the video: 12 SKUs across deodorant, body, oral and lip care, each with a main image and a PDP hero, and every lever here is zero-cost editorial work needing no traffic or attribution. Scent variations, ingredient visuals, packaging-alongside and a hand-for-scale shot are all honest for this catalog. Additive to what the skill already owns — it covers secondary-slot formats (infographic, comparison, transformation) and hierarchy rules, but not the lead-image lever list. Note the tension to reconcile: the creator merges two or three hypotheses into one frame, which pulls against the existing one-job-per-asset rule — for RSC, pick one lever per test frame.

**Target skill:** `marketing-product-image-stack` (edit)

### Any metric or claim must live on the actual packaging or product in the photo — you cannot stamp it onto the image — and a generated render must match the real product exactly, or the listing gets taken down. — 8/10

**Why it works:** Amazon's image policy requires the main image to accurately depict the product being sold; overlay graphics and invented product features (the creator's example: an AI-added OLED screen that does not exist on the unit) are misrepresentation, so a lift that came from a non-compliant image is a suspension risk rather than a win.

**Evidence:** Stated flatly as a rule ('you can't just stamp it on the image, you'll get banned'), plus a live catch where GPT Images 2.0 rendered a screen the product does not have and he corrected it back to the reference image. Assertion from practice, no policy citation.

**Fit:** Platform-policy class rather than platform mechanics — the underlying 'main image must be the real product' rule is long-standing and the video is two months old, so no decay discount. It is load-bearing here because Amazon is the larger channel at ~$1,800/mo, and RSC's whole catalog is claim-adjacent body care where the temptation to overlay 'aluminum-free' or '24-hour' onto a frame is real. It also puts a hard guardrail on the AI generation workflow: any generated deodorant stick, cap, or label that does not match the physical unit is a compliance problem, not a style problem. Free to observe, and it protects the revenue-producing channel.

**Target skill:** `marketing-product-image-stack` (edit)

### Treat the primary/main listing image as the highest-leverage single asset to change, because it moves conversion rate as well as click-through rate — not just the thumbnail click. — 7/10

**Why it works:** A thumbnail that better communicates the use case, objection, or search intent pulls in traffic that is more relevant, so a larger share of the clicks it earns were already the right buyer — CTR and CVR rise together off the same impressions, and revenue compounds multiplicatively.

**Evidence:** A financial model (1.0%→1.3% CTR, 10%→13% CVR at flat 1.2M impressions = ~60% revenue lift) plus roughly six portfolio before/afters with claimed lifts (CTR doubled with +8% CVR; +30% CTR/+40% CVR; +40%/+50%; 0.9%→1.4% CTR). Real Amazon Experiments results claimed but no account screenshots, spend, or sample sizes shown.

**Fit:** Durable principle class (asset prioritisation and why relevance-matched imagery converts), so age is not the limiter. It points at the surface that already produces the larger share of revenue — Amazon at ~$1,800/mo — and rewriting a main image is free, solo-executable, needs no ad budget, and sits squarely in the CRO stage of the gated sequence. Capped at 7 because the compounding arithmetic assumes 1.2M impressions; at roughly 36 Amazon orders/month the lift is real but unmeasurable, so this is a judgement-led change-and-move-on, not a test.

**Target skill:** `marketing-product-image-stack` (edit)

### Produce the images yourself with an AI generator by uploading reference photos of the real product, then fix near-misses with the tool's edit function rather than re-prompting from scratch, and patch garbled small text in Canva as a final step. — 6/10

**Why it works:** Reference images constrain the generator to the actual product geometry, logo and label; editing changes only the defective element instead of rerolling parts that were already right; and since current generators reliably mangle tiny text, doing that one fix in a static editor is faster than fighting the model for it.

**Evidence:** Live walkthrough: a first attempt got the button wrong, a prompt error ('no logos') was corrected, photo was switched to render, and the gibberish bottom-line text was fixed in Canva — whole loop asserted at 10–15 minutes. Side-by-side showing GPT Images 2.0 rendering minuscule text correctly where Nano Banana Pro produced AI gibberish. Single demonstration, no comparison against a designer.

**Fit:** Platform-mechanics class — specific tool names and edit affordances decay fast — but the video is two months old so no staleness penalty applies today; expect the tool names to be wrong within a year while the reference-image and edit-not-regenerate habits survive. Genuinely useful for a solo operator with no designer and 12 SKUs needing main images, secondary slots and PDP heroes on both channels, at near-zero cost. Held at 6 because it is a production-speed lever rather than a revenue mechanism, the edit-vs-regenerate rule already exists in marketing-email-design-production for email assets, and it must be run under the compliance guardrail above.

**Target skill:** `marketing-product-image-stack` (edit)

## Rejected

### Export the last 60 days of your Amazon search term report, have AI distill insights from it, then have it form click-through-rate hypotheses about which image content would close the gap between what shoppers search for and what your image communicates. — 4/10

**Rejected because:** Depends on ad search term or Brand Analytics query volume that does not exist at ~36 Amazon orders/month with paid spend gated, and the surviving principle duplicates existing awareness-level and competitor-gap skills.

**Fit reasoning:** The input does not exist at this scale. An advertising search term report requires meaningful ad spend, which is gated behind the Tracking → CRO → Offer/AOV → Traffic sequence, and the Brand Analytics query alternative returns thin, noisy data at roughly 36 Amazon orders/month — hypotheses derived from a handful of queries are the same guess with extra steps. The transferable residue, 'match the lead asset to the specific intent the buyer arrived with', is already owned by marketing-awareness-level-messaging and the competitor gap analysis in marketing-competitor-messaging-teardown, and voice-of-customer already supplies real buyer language for free.

### Prototype any AI workflow manually first — run it by hand, note where the model gets it wrong — and only codify it into a reusable skill once the output is consistently good. — 4/10

**Rejected because:** Workflow meta-advice with no marketing mechanism, and its usable content duplicates the brand-kit and briefing tactics already in marketing-email-design-production.

**Fit reasoning:** Sound advice but it is tooling process, not a marketing mechanism — it produces no revenue on its own and states no testable marketing claim. The specific-inputs-and-iterate half is already covered by the brand-kit and clarifying-question entries in marketing-email-design-production, so promoting it would duplicate an existing skill and degrade triggering accuracy.

### Feed the model your own proprietary playbook of what drives click-through rate rather than relying on the model's general internet knowledge, because grounded models outperform ungrounded ones. — 4/10

**Rejected because:** Duplicates the persisted brand-kit and reference-exemplar grounding tactics already in marketing-email-design-production, and the specific input — a proprietary playbook of tested results — does not exist at this scale.

**Fit reasoning:** The grounding principle is durable and correct, but it is already owned twice over: marketing-email-design-production covers assembling a persisted brand kit and exemplar library as generator input, and marketing-competitor-messaging-teardown covers supplying real reference assets instead of describing them. The distinctive input here is a proprietary agency playbook of tested CTR results, which RSC does not have and cannot build at ~36 Amazon orders/month, so what is left for this business is the part existing skills already say.

### Validate every image change with a continuously running Amazon Experiments A/B test (version A vs version B, scheduled, read the metric delta), and keep iterating so you always have a new variant in test. — 3/10

**Rejected because:** Requires traffic volume RSC does not have — at ~36 Amazon orders/month no image A/B test reaches a readable result, so a continuous experiment cadence produces noise, not decisions.

**Fit reasoning:** Depends on scale that does not exist here. Amazon Experiments needs enough sessions per variant to reach any read at all, and this listing set produces roughly 36 orders a month — a CTR or CVR difference of the size described would take many months to separate from noise, if the ASINs are even eligible. This is also platform-mechanics class, so the specific tool and thresholds are the fastest-decaying part of the video. The honest posture for RSC is to apply the image levers by judgement, ship, and move on rather than build a testing cadence it cannot read.

## Skills touched

- `marketing-product-image-stack` (edit)
