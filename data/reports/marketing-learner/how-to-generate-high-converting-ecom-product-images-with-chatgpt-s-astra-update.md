# How to Generate High-Converting Ecom Product Images with ChatGPT's Astra Update

**Creator:** Oliver Kenyon (@oliverkenyon, ConversionWise)  
**Source:** social post — `how-to-generate-high-converting-ecom-product-images-with-chatgpt-s-astra-update`  
**Published:** 2026-09-08  
**Inferred era cues:** ChatGPT 'Astra' update and its image-generation tooling; published 2026-09-08; references an earlier article using Grüns; example brand getwinks.com; explicit note that Astra supports image-generation tools but is not itself the rendering model; observed export mismatch (2000x2000 requested, 1254x1254 delivered).  

A CRO practitioner walks through a reusable ChatGPT (Astra) workflow for generating a six-frame Shopify product carousel from nothing but a store URL. The core move is a setup prompt run BEFORE any image is generated: the model reads the product page, inspects real packaging photos, names one buyer and their frustration, collects only verified benefits/offer terms/reviews, fixes a brand visual identity, and plans six frames each with a distinct selling job (hero outcome, offer/value proposition, trust/social proof, product clarity/features, problem-to-solution, lifestyle/identity). Each of the six copy-paste prompts is then sent one at a time, carrying heavy anti-fabrication guardrails (no invented reviews, ratings, badges, certifications, scarcity or before/after proof; only show ingredients actually present) and mobile-first output specs. He closes with pre-ship checks — verify actual exported pixel dimensions rather than trusting the requested size, keep offer terms in page text too, and test the new carousel against the current one on revenue per session alongside conversion rate and AOV.

Found 15 tactics: 11 adopted, 4 rejected (1 of the adopted parked behind a stage gate).

## Adopted

### Before generating any product imagery, run a setup prompt that points the model at your product page URL and makes it research the product, inspect the real packaging photos, name one buyer and their specific frustration and desired outcome, collect only verified benefits/offer terms/reviews, fix a brand visual identity, and return a written six-frame creative plan with source links — generating nothing until that plan is approved. — 8/10

**Why it works:** Six attractive images can still leave six unanswered questions. Forcing research and a frame-by-frame plan first means each frame is assigned a distinct buying question to answer, and grounding the plan in the live page's own facts and packaging photos stops the model inventing product details.

**Evidence:** Demonstrated end-to-end on a real brand (Winks) with the full prompt published; creator states this plan-first step is 'the biggest improvement in this workflow'. No conversion data — he explicitly calls the outputs hypotheses, not tested winners.

**Fit:** The solo operator is the designer here and already generates listing imagery with AI; the existing imagery skill covers grounding in raw phone photos and correcting near-misses but has no plan-first research step. With conversion rate as the binding constraint across 12 SKUs on Shopify PDPs and Amazon listings, a step that forces every frame to earn a distinct job before a single render is spent is directly on the CRO path and runnable today at zero cost.

**Target skill:** `marketing-ai-product-imagery` (edit)

### Give one carousel frame the single job of stating the offer — the strongest verified current offer (subscription savings percentage, price, quantity, renewal interval, free shipping, pause/skip/cancel), with the qualifying condition shown explicitly and no more than two supporting details. — 8/10

**Why it works:** Savings create interest but the supporting terms explain the commitment: the buyer can understand price, quantity, renewal interval and how to get out without hunting around the page, so the 'am I locked in?' hesitation is answered inside the image rather than left to the fine print.

**Evidence:** Worked example showing 26% subscribe savings, $48 for a 28-stick pouch, four-week renewal, free shipping and pause/skip/cancel; conversion reasoning is stated as a hypothesis, not a tested result.

**Fit:** The recorded Shopify gallery slot order has no offer frame at all — it runs benefit headline, in-use, before/after, what's-in-the-box, how-it-works, us-vs-them, review. For a consumable catalogue where retention is the binding constraint and refill cadence is the lever, an image that spells out subscription price, cadence and cancel-anytime is exactly the frame missing, and it is one AI render the operator can add to every PDP this week.

**Target skill:** `marketing-product-image-stack` (edit)

### When a literal before-and-after cannot be honestly demonstrated, build the transformation frame as a routine contrast instead — the frustrating current habit versus the desired one, with the same person, object and setting held constant across both states and two short labels — and make the difference readable through action and environment, not just brighter lighting or an added smile. — 8/10

**Why it works:** Recognition creates relevance: a buyer who sees their own evening in the first panel understands the appeal of the second, so the frame earns the emotional payoff of a before/after without asserting a caused result the brand cannot prove.

**Evidence:** Worked example ('Still scrolling.' / 'Time to unwind.') with the creator explicitly noting the comparison is about the routine, not evidence the product caused a sleep result. No test data.

**Fit:** Solves a live problem for this catalogue: the recorded gallery order calls for a before/after transformation frame, but natural deodorant, toothpaste and lip balm mostly cannot show a photographable before/after honestly, which is exactly where an operator either fakes it or skips the slot. The routine-contrast substitute (3pm anxiety versus a calm morning routine; harsh antiperspirant versus the switch) is runnable in an AI render today and keeps the highest-leverage format available across all 12 SKUs.

**Target skill:** `marketing-product-image-stack` (edit)

### Establish a brand visual identity up front (palette, typography style, lighting, photographic treatment) and let consistency come from that identity while every frame uses a different composition and scene — explicitly forbidding the closing lifestyle frame from repeating the hero's location, activity and framing. — 7/10

**Why it works:** If frames repeat the same scene the set reads as one idea photographed six times and later frames add no new information; holding the branding constant while varying composition keeps the set coherent yet gives the scroller a reason to keep swiping.

**Evidence:** Stated as a prompt requirement ('Consistency should come from the branding, not repeating the same scene'); creator's subjective read that the set holds together.

**Fit:** Adds a design-system rule the existing imagery skill only half covers — it says derive the rest of the set from the first good graphic so they share a visual treatment, but nothing prevents scene repetition or specifies palette/typography/lighting as the carrier of consistency. Across 12 SKUs whose imagery is produced by one person in an AI tool, a named identity plus an anti-repetition rule is directly executable and improves every listing set.

**Target skill:** `marketing-product-image-stack` (edit)

### Write anti-fabrication rules into the generation prompt itself: no invented testimonials, review counts, press logos, certifications, scarcity or before-and-after evidence; show only ingredients and components actually present; and never portray a generated person as the author of a real review or as a verified customer. — 7/10

**Why it works:** Image models will happily render plausible five-star badges, award logos and 'customers' to fill a composition. Banning those categories in the prompt keeps the frame's proof traceable to something real, so the listing survives a compliance check and the buyer is not trusting fabricated evidence.

**Evidence:** Stated as shared requirements across all six prompts, plus per-frame reminders ('an attractive person holding the product must not substitute for evidence'). Assertion only.

**Fit:** Extends rather than repeats the recorded guardrails: the existing claims cover auditing a render against the physical product and 'any metric or claim must live on the actual packaging'. Neither covers fabricated third-party proof — badges, review counts, certifications — or generated humans implied to be real customers, which is precisely the failure mode for a solo operator generating natural-deodorant listing frames on Amazon where a mismatched render gets the listing pulled. Runnable today as prompt text.

**Target skill:** `marketing-ai-product-imagery` (edit)

### Choose the review that goes in the trust frame from the objection most likely to stop the purchase, reproduce a short accurate excerpt with its attribution, and build the composition around the quote rather than around a smiling person. — 7/10

**Why it works:** A specific review answers a specific concern — in the example, whether you feel groggy the next morning — so the frame does evidentiary work. A photogenic model holding the pack signals nothing, and burying the quote in a wall of testimonials means no single objection gets resolved.

**Evidence:** Creator names this his favourite output of the set and reasons through why the chosen quote works; he also warns a review remains one person's experience and must not be turned into a universal promise. No test data.

**Fit:** Sharpens an existing selection rule rather than duplicating it — review-mining says pick quotes whose 'before' state matches today's buyer and that name the mechanism; this adds objection-led selection for a specific image slot and the rule that an attractive person cannot substitute for the evidence. RSC has real Shopify and Amazon reviews to mine and a natural-deodorant category with predictable blocking objections (transition period, all-day efficacy), so this is executable now.

**Target skill:** `marketing-product-image-stack` (edit)

### On a feature/ingredient frame, show only two or three verified details with accurate per-unit amounts, and label the selection honestly — 'three featured ingredients' — so the frame does not imply it shows the entire formula. — 7/10

**Why it works:** Specific, concrete numbers give an interested buyer something to evaluate and make comparison easy, while the 'featured' wording keeps the partial list from reading as a full ingredient declaration, which would be a claim the packaging does not support.

**Evidence:** Worked example showing three ingredients with amounts per stick; creator explicitly flags why the 'three featured' phrasing matters. Assertion only.

**Fit:** Directly usable across a natural deodorant, soap, toothpaste and lip balm catalogue where ingredient callouts are the main clarity lever and where an implied-full-formula frame is a real Amazon compliance risk. The existing skill covers capping us-vs-them at three or four attributes and requiring claims to live on the packaging, but not honest partial-spec labelling or per-unit quantity accuracy.

**Target skill:** `marketing-product-image-stack` (edit)

### After building a new carousel, test it against the imagery you have now and judge it on revenue per session alongside conversion rate and average order value. — 7/10 · parked until `scale`

**Why it works:** Attractive imagery can lift clicks or conversion while shifting the mix toward cheaper units; reading revenue per session alongside conversion rate and AOV catches that trade-off, so the winner is the version that makes more money per visitor rather than the one that converts a higher percentage.

**Evidence:** Stated as the closing instruction; he is explicit that the six concepts are hypotheses to test on a live store, not tested winners, and that the $3.2M Ezra Firestone figure came from CRO work, not from AI images.

**Fit:** The right metric set for image tests and a genuine addition to the recorded Amazon Experiments A/B claim, which does not name the read-out. Parked behind scale because a head-to-head Shopify carousel test needs a readable signal and the Shopify funnel runs ~16 orders/month — the trigger is enough weekly sessions and orders for a split to separate, or running the same comparison inside Amazon Experiments on the higher-volume marketplace listings first, which is available today.

**Target skill:** `marketing-product-image-stack` (edit)

### Make the lifestyle/identity frame an achievable aspiration — a warm moment at home rather than a yacht or an influencer pose — showing the wider experience the product supports rather than another usage demo, with the product still recognisable at thumbnail size. — 6/10

**Why it works:** Once the practical questions are answered the remaining job is picturing ownership, and a scene the buyer could plausibly live in this week does that; unattainable luxury signalling breaks the identification the frame exists to create.

**Evidence:** Worked example of two people sharing a relaxed evening with the product present; creator's stated preference plus the note that the models are illustrative, not customer proof. Assertion only.

**Fit:** Refines the recorded lifestyle rules (specify avatar, setting and emotional register; pick the setting from the actual reason people buy) with a calibration on aspiration level and a boundary that the lifestyle frame carries emotion while the trust frame carries evidence. Useful for a natural body-care brand whose buyer is a normal household, and producible today in the same AI tool, but it is a smaller adjustment than the offer or transformation frames.

**Target skill:** `marketing-product-image-stack` (edit)

### Specify the output format in the prompt (a consistent 1:1 square at a fixed pixel target, essential content held comfortably inside the edges for mobile), then verify the actual exported dimensions of the downloaded original rather than trusting the size you asked for, and optimise file size before publishing. — 6/10

**Why it works:** The model complies with a requested size in words but not in pixels — prompts asked for 2000x2000 and the delivered files were 1254x1254 — so an unverified export ships soft or upscaled imagery; and content near the frame edge gets cropped in mobile carousel and thumbnail rendering.

**Evidence:** Direct observation of the mismatch in his own outputs, stated as a caution ('a requested size is not a verified export size'), plus the shared prompt requirement to keep content inside the edges.

**Fit:** Concrete pre-ship mechanics the existing imagery skill does not hold — it covers hallucination auditing and proofreading but not export verification, safe margins or file weight. Amazon has hard minimum pixel dimensions for zoom and the Shopify PDP is mobile-first, so a soft or edge-cropped render costs conversion on the surface where the binding constraint sits. One person, no cost, today.

**Target skill:** `marketing-ai-product-imagery` (edit)

### Keep essential offer terms and product information in the page's own text as well as in the imagery, because text stays accessible and easy to update. — 6/10

**Why it works:** Information baked into an image cannot be edited when the price, cadence or formula changes, and is invisible to anything reading the page as text — so the image should reinforce the terms rather than be the only place they exist.

**Evidence:** Stated as a pre-publish instruction. Assertion only.

**Fit:** A real boundary rule for a 12-SKU store where one person maintains every PDP: if subscription price or ingredient callouts live only inside rendered frames, every change means regenerating art. Neither the imagery nor the friction-audit skill records the image-versus-text division of labour, and it is enforceable today with no volume or budget dependency.

**Target skill:** `marketing-product-image-stack` (edit)

## Rejected

### Build the whole carousel as six frames with distinct selling roles — hero outcome, offer, trust, features, transformation, lifestyle — each answering a different buyer question. — 4/10

**Rejected because:** Duplicate of the existing marketing-product-image-stack claims 'On the Shopify product page, order the gallery deliberately: (1) a big benefit headline… (7) a review screenshot' and 'Every creative asset should have exactly one goal and one persona'.

**Fit reasoning:** Duplicates a claim already held: marketing-product-image-stack prescribes the ordered Shopify gallery — benefit headline, product in use, before/after transformation, what's inside, how it works in steps, us-vs-them, review screenshot — plus 'every creative asset should have exactly one goal and one persona' and the static format rotation. Recording the same slot-role framing again would degrade skill triggering; the genuinely additive pieces (the offer frame, the honest-transformation substitute, the brand-consistency rule) are captured as separate tactics.

### Review every generated image at full size against the live product page (packaging text, quantities, claims, review attribution, offer terms), then look at it on a phone and check the key message is readable without zooming. — 4/10

**Rejected because:** Duplicate of 'Audit every generated image against the physical product before it ships' and 'Proofread the copy on every generated frame as its own pass' (marketing-ai-product-imagery), plus the phone-size 1-second comprehension check (marketing-product-image-stack).

**Fit reasoning:** Already held twice: marketing-ai-product-imagery has the hallucination audit against the physical product and a dedicated copy-proofreading pass, and marketing-product-image-stack has 'kill any asset that fails a 1-second comprehension test run at phone size'. Re-recording it would blur which skill triggers on image QA.

### Stop obsessing over traffic and invest in how the product is presented above the fold — better imagery, clarity, trust and positioning — because you have already paid to get the visitor onto the page. — 3/10

**Rejected because:** Duplicate of the existing claim that the primary listing image is the highest-leverage single asset to change, and otherwise framing without a distinct testable mechanism.

**Fit reasoning:** No mechanism beyond 'do CRO', and the specific version of it is already recorded: marketing-product-image-stack holds 'treat the primary/main listing image as the highest-leverage single asset to change, because it moves conversion rate as well as click-through rate'. The Tracking to CRO to Offer/AOV to Traffic sequencing is also already the operating spine, so this adds nothing actionable.

### Remember these prompts are not magic — they will not fix a weak offer, unclear positioning, a slow store or a frustrating buying experience, and only become useful combined with strong messaging, copy, offers, UX and testing. — 1/10

**Rejected because:** Motivational framing with no stated mechanism — not actionable and not testable.

**Fit reasoning:** Motivational caveat with no stated mechanism and nothing to execute or test; it names no surface, no artifact and no decision rule.

## Skills touched

- `marketing-ai-product-imagery` (edit)
- `marketing-product-image-stack` (edit)
