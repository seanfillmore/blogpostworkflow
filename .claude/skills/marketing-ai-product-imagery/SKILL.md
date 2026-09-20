---
name: marketing-ai-product-imagery
description: Workflow for producing listing, PDP, and native-ad imagery with AI image models grounded in real product reference photos — including the plan-first research step, the structured candid-scene concept pass, original-concept ideation, converting-ad reference boards, reference-derived style prompting, a reusable anti-gloss base-layer prompt block, multi-turn edit moves for set variety, anti-fabrication prompt guardrails, and the QA passes (believability selection, hallucination audit, text proofreading, export verification) that make renders safe to ship.
---

# Ai Product Imagery

## Before generating anything, run a setup prompt that points the model at your live product page URL and makes it research the product, inspect the real packaging photos, name one buyer and their specific frustration and desired outcome, collect only verified benefits/offer terms/reviews, fix a brand visual identity, and return a written six-frame creative plan with source links — generate nothing until that plan is approved.

**Why it works:** Six attractive images can still leave six unanswered questions. Forcing the research and a frame-by-frame plan first means each frame is assigned a distinct buying question to answer, and grounding the plan in the live page's own facts and packaging photos stops the model inventing product details before a single render is spent.

**Evidence offered:** Demonstrated end-to-end on a real brand (Winks) with the full prompt published; the creator states this plan-first step is 'the biggest improvement in this workflow'. No conversion data — he explicitly calls the outputs hypotheses, not tested winners.

**Fit here (8/10):** The solo operator *is* the designer and already generates listing imagery with AI, but nothing in this workflow previously forced a job-per-frame plan before rendering. With conversion rate the binding constraint across 12 SKUs on Shopify PDPs and Amazon listings, a step that makes every frame earn a distinct job is directly on the CRO path and runnable today at zero cost. Pairs with the reference-photo rule below rather than replacing it: the plan supplies *what each frame must say*, the phone photos supply *what the product actually looks like* — the page's own packaging photos are a research input, not a substitute for your own multi-angle shots. Which slot owns which job is still governed by marketing-product-image-stack; use that as the check on the model's proposed six frames.

*Source: Oliver Kenyon (@oliverkenyon, ConversionWise) — "How to Generate High-Converting Ecom Product Images with ChatGPT's Astra Update" (social post)*

## Run a concept step in an LLM before touching the image model: for each angle, ask for four candid moments where the pain or relief is visible, returned in a fixed format — SCENE (one sentence), SUBJECT (age range matching the buyer), EMOTIONAL READ (what a stranger feels in half a second), WHY IT STOPS THE SCROLL — expect most to be unusable, and push back with 'make these more scroll stopping, elevate the realistic pain this person experiences in their actual day'.

**Why it works:** Going straight to the image model gives it a generic request and returns generic output. A structured concept pass costs two minutes, produces twenty candidates for five angles, and forces the scene and emotional read to be decided in language before any pixels are generated.

**Evidence offered:** Assertion from documented agency workflow; the named re-prompt line is reported as the one that reliably works.

**Fit here (8/10):** The plan-first setup prompt above covers product research and which buying question each listing frame answers — it does not generate candid *scenes*. This is how the solo operator turns one angle into four shootable-without-a-camera moments for Meta statics, PDP gallery frames and organic posts, at zero cost per concept. Durable workflow, runnable today. Sequence it after the angle is chosen and before any generation: concepts in language, then the base-layer prompt block below, then the believability selection pass. The fixed schema also makes the candidates comparable — you are picking between four written emotional reads, not four finished images you are already attached to.

*Source: Lorenzo Pravata (@lorenzo_pravata) — "How to exploit GPT-2.5 Images for more winning ads" (social post)*

## Ground every generation in your own raw phone photos of the actual product: shoot several angles, several zoom distances, and deliberate close-ups of any fine detail (engraved text, buttons, labels), and re-upload that same set at the start of every fresh chat.

**Why it works:** The model has no ground truth for your specific item — absent your own references it averages the category and renders a competitor's size and construction, and a single flat photo leaves it guessing at shape, depth, and small typography. Multiple angles plus explicit detail shots anchor scale and physical detail to the thing you actually ship.

**Evidence offered:** Two worked demonstrations: three photos of an electric bike pump produced a primary render with correct brand text, display, hose and nozzle engravings; four photos of a diffuser produced a usable primary image on the first try. Counter-diagnosis: the generated diffuser kept coming out too large, which he attributes to the model 'referencing images online' where most competing diffusers are bigger than his. Practitioner demonstration, single products, no conversion data.

**Fit here (8/10):** Platform-mechanics class but published within weeks of the model's release, so no staleness discount. This is the single biggest unlock — and the precondition that makes every other tactic here safe — for a solo operator with 12 SKUs, no designer and no photographer, on the ~$1,800/mo Amazon channel where secondary image slots are the main conversion surface. Products are already in hand, the phone is free, and Gemini's cost is trivial against $2,700/mo revenue. Deodorant sticks and lip balms have exactly the fine detail (embossed labels, cap text, ingredient panels) the multi-angle rule protects, and a stick rendered at the wrong size or with the wrong cap is a listing-accuracy problem, not just an aesthetic one.

*Source: Chris Rawlings — "Nano Banana Pro for Product Photography (Step by Step 2026 Guide)" (12pQ0W2bCDE)*

## Put a scale reference in the reference photos — hold the product in your hand or set it next to money, a phone, or a laptop — because the model cannot infer size from a product shot against a blank wall.

**Why it works:** Physical scale is not recoverable from an isolated object photo, so the model invents it, which is what produces lifestyle images where the product is comically oversized relative to the furniture around it.

**Evidence offered:** Stated as a rule, then demonstrated in the negative: the first lifestyle render put the diffuser at obviously wrong scale next to a coaster and books, requiring a corrective prompt.

**Fit here (7/10):** Platform-mechanics class, freshly published, so no age penalty. Free and solo-executable, and it matters more than average here because a deodorant stick, a lip balm and a body bar are small objects whose size buyers routinely misjudge on Amazon — wrong-scale lifestyle renders read as fake and invite 'smaller than expected' returns. Not higher because it is a prerequisite step inside the reference-shooting tactic rather than an independent revenue mechanism.

*Source: Chris Rawlings — "Nano Banana Pro for Product Photography (Step by Step 2026 Guide)" (12pQ0W2bCDE)*

## Collect style references (Pinterest, competitor ads, the model's own research output), then deliberately close them and sketch your own visual concept from a blank page before touching a generation tool.

**Why it works:** References prime the visual vocabulary, but staying inside them means you only ever iterate on something that already exists, which produces derivative work. Closing the source and starting from blank forces an original concept; the collected references then serve as raw execution material for that concept rather than as its shape. Sarah Levinger applies the identical move to AI — let the model do the research, read the output, close it, open a blank doc.

**Evidence offered:** Both speakers describe it as their own practice — 'go on Pinterest, find various visual inspirations, then maybe close the laptop and think of really good visual ideas' / 'I force myself to read that output and then click X and open up a new blank doc'. Assertion only, no performance data.

**Fit here (6/10):** Durable creative-process principle with a concrete, named mechanism (collect, close, ideate blank), so it is not bare motivation. Cheap and entirely solo-runnable — this operator already produces his own statics, organic short-form and listing imagery, and the standing risk with AI tooling is that every frame comes out looking like the category average. Slots in between the approved creative plan above and the generation prompts below: the plan says what each frame must *say*, this step decides what it will *look like* before a reference or a model gets a vote. Scored below the plan-first and grounding tactics because the prescribed output is a better concept rather than a testable change to a surface, which makes it the weakest link to verify. **Scope boundary:** this is the rule for brand-led work — PDP gallery frames, organic, anything where being distinctive is the point. It does *not* govern performance statics; for those, use the converting-ad reference-board rule immediately below, which deliberately inherits from proven ads rather than starting blank.

*Source: Seb Valiente (@sebastian_dtc), with Sarah Levinger (@SarahLevinger) and Nate Lagos — "Brain Driven Brands podcast — what makes a good static ad (X post 2100971197039366619)" (transcript, part 2 of 2)*

## For performance statics, build the reference board from ads that are already converting in that category — never from a mood board — because the output inherits whatever is on the board.

**Why it works:** A generation pipeline reproduces the composition, framing and treatment of its references, so seeding it with proven-converting ads raises the hit rate before a word of the brief is written; an aesthetic mood board seeds aesthetics with no evidence of performance.

**Evidence offered:** Reported as one of two standing rules from the strategists who use the agency's static generator daily.

**Fit here (7/10):** Cheap and directly actionable — the operator already has access to competitor ad libraries, and the teardown skill ranks found ads by how long they have been running, which is exactly the filter this rule needs (long-running = converting; screenshot those, not the pretty ones). Durable-principle class. Reconciliation with the blank-page rule above: that one governs brand-led and PDP work where distinctiveness is the goal; this one governs paid statics where the job is to borrow a proven structure and swap in your product and angle. In both cases the reference controls *execution* — lighting, framing, layout — never the product's own form, which stays anchored to your phone photos.

*Source: Lorenzo Pravata (@lorenzo_pravata) — "How to exploit GPT-2.5 Images for more winning ads" (social post)*

## To hit a specific visual style, find a strong reference image, reverse-engineer that reference into a generation prompt, then mix that prompt with your own visual idea — this gets you roughly 80% of the way to the image you wanted.

**Why it works:** Describing an abstract idea to an image model cold leaves composition, lighting and treatment undefined, so the output drifts. A reference already encodes all of those decisions; converting it into prompt language transfers them wholesale, and layering your own subject and idea on top gives a controllable image that is original in concept while borrowing execution quality.

**Evidence offered:** Given as the summarised prompting workflow: 'figure out exactly what it is you're trying to visualize, find a really good reference, reverse engineer the reference in terms of a prompt — that'll give you 80% of the way there'. Assertion from practice, no output examples or test data.

**Fit here (8/10):** Directly operational for a solo operator already generating his own product and ad imagery, and it fills a real gap: everything else here controls how to get an *accurate product render*, nothing covered how to get a chosen *style* out of a model. Costs nothing but time and runs on today's tooling. Sequencing with the rules around it: fix the concept first (blank page for brand work, converting-ad board for paid), so the reference supplies execution rather than the idea; keep your own phone photos as the product ground truth (a style reference tells the model how to light and compose, never what your deodorant stick looks like); and treat the last 20% as the named-defect correction loop below, one fix per prompt.

*Source: Seb Valiente (@sebastian_dtc), with Sarah Levinger (@SarahLevinger) and Nate Lagos — "Brain Driven Brands podcast — what makes a good static ad (X post 2100971197039366619)" (transcript, part 2 of 2)*

## Write short plain-language prompts ('create a clean product photo rendering of this product to be used as the primary image on an Amazon listing') instead of engineering page-long prompts specifying camera make, lens, and lighting.

**Why it works:** The model is built to interpret ordinary human language, so elaborate prompt scaffolding adds effort without adding control; the reference images carry most of the information the model needs.

**Evidence offered:** Asserted as 'the first tip', then demonstrated — a one-sentence prompt plus four photos produced a usable primary image on the first attempt.

**Fit here (6/10):** Platform-mechanics class and current, so age is not the limiter. Free, and it removes a real time sink for a solo operator with no design help — the first attempt costs a sentence, not a prompt-writing session. Held at 6 because it is a workflow efficiency habit, not a revenue mechanism, and prompt-length norms are exactly the model-specific detail unlikely to survive the next model generation. Note the exceptions: the anti-fabrication rules, the output-format spec and the native base-layer block below are standing prompt text worth carrying every time, and the reverse-engineered reference prompt above is deliberately long because it is doing style transfer. Brevity applies to *creative direction on a well-referenced product shot* — not to guardrails, not to the candid-look suppression block, and not when you are chasing a specific look.

*Source: Chris Rawlings — "Nano Banana Pro for Product Photography (Step by Step 2026 Guide)" (12pQ0W2bCDE)*

## Open every native-style generation prompt with the same fixed base-layer block — candid phone photo, 1:1, natural lighting, slight grain, imperfect framing, true-to-life colour with no saturation boost, looks like a real camera roll photo not stock, no text/logos/watermark — then add the scene, subject and emotional read underneath; regenerate staged results with 'this should feel like someone took it of themselves without thinking about composition'.

**Why it works:** Image models default to polished commercial output; a standing suppression block plus a named regeneration line keeps every asset inside the native look, and reusing the same block means the whole set shares one treatment instead of drifting per prompt.

**Evidence offered:** Assertion from documented agency SOP; notes that the model's improved texture makes both realism and gloss arrive faster, so the suppression line matters more not less.

**Fit here (8/10):** Copy-pasteable today into whatever image tool the operator already uses, and it is the production half of the native static formats the paid-creative work prescribes. Nothing else here supplied a reusable anti-gloss base layer — the brevity rule above covers creative direction, the output-format spec covers pixels, neither suppresses the stock-photo default. Prompt-craft is fast-decaying platform mechanics, but the source is days old. Feed it the SCENE / SUBJECT / EMOTIONAL READ lines from the concept pass above verbatim; re-paste the block in full whenever you open a fresh chat, since none of it survives an abandoned session. Note the 'no text' clause is deliberate — headline copy gets laid on afterwards, which also sidesteps the misspelling defect the proofreading pass below exists to catch.

*Source: Lorenzo Pravata (@lorenzo_pravata) — "How to exploit GPT-2.5 Images for more winning ads" (social post)*

## Write anti-fabrication rules into the generation prompt itself: no invented testimonials, review counts, press logos, certifications, scarcity or before-and-after evidence; show only ingredients and components actually present; and never portray a generated person as the author of a real review or as a verified customer.

**Why it works:** Image models will happily render plausible five-star badges, award logos and 'customers' to fill a composition. Banning those categories up front in the prompt keeps every proof element on the frame traceable to something real, so the listing survives a compliance check and the buyer is not being asked to trust fabricated evidence. An attractive generated person holding the product is decoration, not proof — and must not be allowed to stand in for it.

**Evidence offered:** Stated as shared requirements across all six prompts, plus per-frame reminders ('an attractive person holding the product must not substitute for evidence'). Assertion only.

**Fit here (7/10):** Extends the guardrails already here rather than repeating them: the hallucination audit below owns the *rendered product* (invented features, wrong scale, cross-panel inconsistency) and marketing-product-image-stack requires any metric or claim to live on the actual packaging. Neither covered fabricated third-party proof — badges, review counts, certifications, press logos — or generated humans implied to be real customers. That is precisely the failure mode for a solo operator generating natural-deodorant frames on Amazon, where a fabricated certification or review count is not just a trust problem but grounds for the listing being pulled on the ~$1,800/mo channel. Free, runnable today as standing prompt text, and it prevents defects instead of catching them at audit.

*Source: Oliver Kenyon (@oliverkenyon, ConversionWise) — "How to Generate High-Converting Ecom Product Images with ChatGPT's Astra Update" (social post)*

## When a chat stops improving — specifically, when two corrective prompts fail to move the image — abandon it entirely, open a fresh chat, and re-upload the original reference photos (or the last good image) with the same instruction rather than continuing to course-correct.

**Why it works:** Accumulated context in a degraded chat keeps pulling the output back toward the bad version, so each correction fights the history; a clean session with only the good inputs and no committed mistakes usually resolves in one prompt.

**Evidence offered:** Multiple demonstrations: two rounds of correction on a bad features graphic returned 'basically the exact same thing', while a brand-new chat with the same original photos produced a graphic he called ready to upload; likewise the too-large lifestyle shot and the 'death ash black' diffuser were both fixed by starting a new chat with the last good image and the identical prompt. Anecdotal pattern, no controlled comparison.

**Fit here (7/10):** Platform-mechanics class but contemporaneous with the model, so no decay discount. This is the highest-value operational rule in the video for a solo operator: without it, the failure mode is spending an hour arguing with a stuck chat and concluding the tool does not work, and on a ~$20/mo tier wasted rounds are wasted usage. Free, no traffic or attribution needed, applies every time an Amazon A+ or PDP image is built. Note it is the counterpart to the direct-edit rule in marketing-email-design-production — reconciliation: targeted edit when the output is close, fresh chat when it has plateaued after two tries. When you do open the fresh chat, re-paste the anti-fabrication rules, the native base-layer block, the output-format spec and any reverse-engineered style prompt along with the references; none of that survives the chat you abandoned.

*Source: Chris Rawlings — "Nano Banana Pro for Product Photography (Step by Step 2026 Guide)" (12pQ0W2bCDE)*

## Once one image in the set is good, lock it and stay in that chat to derive the rest — ask for the next graphic ('create a similar graphic but for benefits instead of features'), and for ad sets walk six named edit moves as turns in the same thread: before/after, switch the light angle, change the product, change the position, change the location, move the camera angle.

**Why it works:** The approved image sets the style, layout and product rendering as context, so subsequent asks inherit it — you gain momentum instead of re-establishing the look from scratch on every slot. Multi-turn editing that holds instructions across a long back-and-forth means the subject survives each edit, so each named move produces a genuinely different entity (new scene, new light, new angle) while the character and product stay recognisable — which is precisely what entity diversity requires. Naming the six moves is what converts 'make another one' into visual distinctness rather than a near-duplicate.

**Evidence offered:** Demonstrated for listing sets: after a good features graphic, the single prompt 'create a similar graphic but for benefits' returned a matching benefits graphic with correct button engravings and correct LED colors, with no further specification. The six-move sequence is reported as an existing documented SOP for B-roll that transfers to statics without modification, and is framed as the specific thing the newer model release improves.

**Fit here (7/10):** Platform-mechanics class, current. Directly useful because an Amazon listing needs six or seven visually consistent slots across 12 SKUs — a solo operator with no designer has no other way to hold a house style across ~80 images — and on the ad side it is the production mechanism that makes entity diversity executable for one person: one good image becomes six real ads in one chat session at $30/day. Free, no traffic or budget required, operates on the larger ~$1,800/mo channel. Not higher because it is a consistency and speed lever rather than something that changes what the images say; the job of each slot is owned by marketing-product-image-stack, and the approved creative plan from the setup prompt tells you which frame to derive next. Each derived variant still goes through the believability pass, hallucination audit, proofread and export check below — inheriting a good look does not inherit approval.

*Source: Chris Rawlings — "Nano Banana Pro for Product Photography (Step by Step 2026 Guide)" (12pQ0W2bCDE)*
*Source: Lorenzo Pravata (@lorenzo_pravata) — "How to exploit GPT-2.5 Images for more winning ads" (social post)*

## Correct a near-miss by naming the specific defect and where it is ('the upper left image shows the diffuser looking too tall versus the wider one in the upper right'; 'replace the text in the lower left section from cool mist aromatherapy to ultra quiet aromatherapy') rather than re-asking generically.

**Why it works:** A generic retry gives the model no information about what was wrong, so it regenerates the same defect; a located, named defect is an instruction it can execute, and a targeted text swap changes only the broken element while leaving the approved design intact.

**Evidence offered:** Two demonstrations — a vague 'make the dimensions match exactly' returned the same image, while the explicit tall-vs-wide phrasing fixed it; and a one-line text replacement executed perfectly with no Canva or Photoshop pass. Single-case, no controlled comparison.

**Fit here (7/10):** Platform-mechanics class, published at model launch, no decay discount. This is what makes AI imagery usable rather than merely impressive: a nearly-right Amazon infographic gets finished in one line instead of being rebuilt or hand-edited in a tool the operator does not own. Free, solo-executable, works on both Amazon slots and Shopify PDP images. Held at 7 because it partly restates the direct-edit-over-regenerate principle in marketing-email-design-production; the additive part is the located, named-defect phrasing.

*Source: Chris Rawlings — "Nano Banana Pro for Product Photography (Step by Step 2026 Guide)" (12pQ0W2bCDE)*

## When an image has several defects, correct exactly one per prompt instead of listing them all at once.

**Why it works:** A multi-defect instruction splits the model's attention and it degrades parts that were already correct; a single named change keeps the rest of a nearly-finished image intact, so each round is a strict improvement.

**Evidence offered:** Demonstrated sequentially on the office shot — first fix the model's pose and touching, then the product scale, then the glow — with the stated reason that trying to fix them all at once 'kind of confuses the model.' Single walkthrough.

**Fit here (6/10):** Workflow habit, durable enough (it is about instruction specificity, not a UI affordance) and free. Useful because a solo operator regenerating a whole image set burns both time and paid-tier usage at ~$2,700/mo total revenue, and losing an already-good frame to a scattershot prompt is the common failure. Capped at 6 because it is a production-speed lever, not a revenue mechanism, and it is close kin to the existing one-targeted-edit rule in marketing-email-design-production.

*Source: Chris Rawlings — "Nano Banana Pro for Product Photography (Step by Step 2026 Guide)" (12pQ0W2bCDE)*

## In native formats, attractive is the failure mode — always pick the believable image over the beautiful one, and expect to discard more generations than you keep (some batches give five usable images immediately, others need regenerating until the wonkiness clears).

**Why it works:** The model is trained toward attractiveness, and polish is the exact signal that reads as advertising; selecting on believability preserves the not-an-ad leg, and pre-accepting a low keep rate stops you from shipping a glossy near-miss because you are tired of regenerating.

**Evidence offered:** Assertion from repeated production use, with the stated hit-rate range across batches.

**Fit here (7/10):** A concrete selection criterion for the solo operator who is also the designer and the person hitting publish — he is the only reviewer, so a named rule for which render survives is worth having. It adds a *judgement* pass alongside the factual passes below: the hallucination audit asks 'is this the real product', the proofread asks 'are the words right', the export check asks 'will the file survive the platform' — this one asks 'would a stranger believe a person took this'. Runnable today, zero cost. Applies to native statics and lifestyle scenes, not to white-background hero renders, where clean studio polish is the correct output. When a batch is wonky, prefer regenerating over correcting — and if two corrections fail, open a fresh chat per the rule above.

*Source: Lorenzo Pravata (@lorenzo_pravata) — "How to exploit GPT-2.5 Images for more winning ads" (social post)*

## Audit every generated image against the physical product before it ships — check for features the product does not actually have, mismatched proportions of the same product across panels, wrong physical scale relative to surroundings, and scenes that look 'a little too perfect' — and either prompt the defect out by name or reject the image.

**Why it works:** Image models invent plausible-looking details and subtle inconsistencies that survive a casual look; a rendered feature the buyer cannot find in the box is a broken promise at unboxing, and a buyer who notices an inconsistency concludes the images are fake, undermining the trust the images were supposed to build. Naming the false element and stating precisely which part of the product does behave that way gets it corrected.

**Evidence offered:** Worked through live: he rejects a lifestyle shot for wrong scale and 'too perfect' feel, rejects an otherwise-good instructions graphic because the same diffuser renders tall in one panel and wide in another, and twice corrects an invented orange glow with 'remove the orange glow from the body of the product — only the thin line between the ceramic and the wooden base actually glows.' Judgement calls and demonstrated fixes, no data on buyer reaction.

**Fit here (8/10):** Durable-principle class (asset QA), and the stakes are higher for Real Skin Care than in the source. These are cosmetics on Amazon: an image showing a texture, colour, applicator or label that does not match the shipped product is an accuracy violation on the ~$1,800/mo channel and a driver of the 'this isn't what I bought' disappointment behind the 18–22.5% repeat rate. Free, purely editorial, no traffic or budget needed, and nothing in the existing image or copy skills owns hallucination review. Practical rule: AI renders are safe for infographic, comparison and instructional slots; for the main image, verify the render matches the real label, cap and colour exactly, or use a real photo. This audit covers the *rendered product*; the anti-fabrication rules above cover *invented third-party proof and fake customers*, the believability pass covers *whether the scene reads as an ad*, and the companion rule below covers the *rendered text* on the frame — run all of them, plus the export check, before anything uploads. Style transfer raises the stakes, not lowers them: a reference-derived prompt, or a converting-ad reference board, can drag the product's own form toward the reference, so re-check proportions whenever you borrow a look — including after each of the six edit moves.

*Source: Chris Rawlings — "Nano Banana Pro for Product Photography (Step by Step 2026 Guide)" (12pQ0W2bCDE)*

## Proofread the copy on every generated frame as its own pass — misspelled product words, stray em dashes and other typography artifacts — and fix each with a named correction prompt ('deodorant is spelled wrong, please spell it correctly').

**Why it works:** Generators produce plausible-looking but wrong text at full size, not only in tiny illegible type, so the defect survives a glance at the layout — the eye reads the shape of the word rather than its letters. A misspelling of the product category on a listing image reads as a counterfeit or a careless seller, undermining the exact trust the image was built to create. A named, located edit fixes only the broken string and leaves the approved design intact.

**Evidence offered:** Two live catches in the demo: 'Dio Durant' rendered instead of deodorant (attributed to the tool's German origin) and an unwanted em dash in a headline, both fixed with one-line named edits. Anecdotal, no data on buyer reaction.

**Fit here (6/10):** Durable QA principle (asset review), age irrelevant. Additive in a narrow direction: the hallucination audit above owns invented product features, scale and cross-panel inconsistency, and marketing-product-image-stack covers garbled *small* text patched in Canva — but nothing owned proofreading legible, full-size copy on a generated frame. Stakes are real here: this catalogue literally sells deodorant, and a misspelled 'deodorant' on a secondary slot is a credibility problem on the larger ~$1,800/mo Amazon channel. Free, purely editorial, solo-executable. Capped at 6 because it is a checklist item close in spirit to the hallucination audit rather than a revenue mechanism — read the words letter by letter, out loud if needed, on every frame before upload. The cheapest version of this defence is the 'no text' clause in the native base-layer block: generate the photo clean, lay the headline on afterwards in a tool that spells.

*Source: Dara Denney — "AI Static Ads Masterclass (FULL GUIDE)" (5C5VhqW9HCc)*

## Specify the output format in the prompt (a consistent 1:1 square at a fixed pixel target, essential content held comfortably inside the edges for mobile), then verify the actual exported dimensions of the downloaded original rather than trusting the size you asked for, and optimise file size before publishing.

**Why it works:** The model complies with a requested size in words but not in pixels — prompts asked for 2000x2000 and the delivered files came back 1254x1254 — so an unverified export ships soft or upscaled imagery. And content sitting near the frame edge gets cropped by mobile carousel and thumbnail rendering, so the safe-margin instruction has to be in the prompt, not discovered after upload. A requested size is not a verified export size.

**Evidence offered:** Direct observation of the mismatch in his own outputs, stated as a caution, plus the shared prompt requirement to keep essential content inside the edges.

**Fit here (6/10):** Concrete pre-ship mechanics nothing else here held — the hallucination audit and the copy proofread cover what the frame *says*, not whether the file is big enough, cropped safely or light enough to load. Amazon has hard minimum pixel dimensions for main-image zoom and the Shopify PDP is mobile-first, so a soft or edge-cropped render costs conversion on exactly the surface where the binding constraint sits. Free, one person, today. Capped at 6 because it is a file-hygiene checklist rather than a revenue mechanism — but it belongs in the same pre-upload gate as the audits above: check dimensions of the downloaded original, check nothing critical is within the crop margin, compress, then publish. It also pairs with the mobile-optimised style rule below: that one makes the *design* legible at thumbnail size, this one makes the *file* survive the platform.

*Source: Oliver Kenyon (@oliverkenyon, ConversionWise) — "How to Generate High-Converting Ecom Product Images with ChatGPT's Astra Update" (social post)*

## Generate the primary white-background hero render and the lifestyle-in-a-room shot with the AI model instead of hiring a photographer or 3D rendering artist.

**Why it works:** The model can synthesise a studio-quality render and a plausible interior scene from hand-held phone shots, collapsing a cost and lead-time barrier that previously required paid specialists.

**Evidence offered:** Two primary renders produced live (bike pump, diffuser), plus a lifestyle image accepted after one corrective prompt; the claim that large brands and aggregators now trust the model over photographers is asserted with no examples named.

**Fit here (6/10):** Platform-mechanics class and current, so age is not the limiter — the cap is category risk. Amazon requires the main image to be an accurate depiction of the actual product, and for a cosmetic the render must match the real label text, cap colour and finish exactly or it is a misrepresentation and return driver on the ~$1,800/mo channel. Lifestyle scenes carry less risk and are genuinely useful for a body-care brand with no lifestyle photography. Held at 6: use AI freely for lifestyle and secondary slots, verify any hero render against the physical product pixel by pixel, and prefer a real photo for the main image where one exists.

*Source: Chris Rawlings — "Nano Banana Pro for Product Photography (Step by Step 2026 Guide)" (12pQ0W2bCDE)*

## For a native-style social ad, have the LLM turn the already-approved story into several numbered image-generation concepts, then paste each generation prompt into the image tool — rather than briefing the image model cold or booking a shoot.

**Why it works:** A native ad image has one job — look like a real photo the customer already lives in, so the scroll stops before the viewer registers it as an ad. Deriving the concepts from the finished story keeps the photo and the copy telling the same thing instead of a stock scene bolted onto a hook, and numbering the concepts gives you several independent swings to test from one story rather than one precious asset. Generating them removes the shoot, the photographer and the lead time entirely.

**Evidence offered:** Assertion plus the creator's Prompt 8 and 'Final Results' examples. No test data, no comparison against a real photo.

**Fit here (6/10):** Executable today by the solo operator with no team and no shoot, and it feeds the live $30/day Meta campaign and the giveaway entry ads. Marked down only because a candid native photo has to survive the authenticity test — a rendered scene that reads as AI defeats the whole point of the format, and for a ~$50 AOV body-care product a plain phone photo of the real product in a real bathroom is often the cheaper honest version. Tool-name specifics are fast-decay platform mechanics, but the source is weeks old so that is not what drove the score. Practical reconciliation with the rules above: use the fixed SCENE / SUBJECT / EMOTIONAL READ / WHY IT STOPS THE SCROLL schema for the numbered concepts and the native base-layer block for the prompts themselves; the reference-photo and scale-reference rules still apply (the product in the candid frame must be *your* product at *your* size); the anti-fabrication rules apply with extra force here — a generated person in a native ad must never be framed as a real customer or reviewer — and the believability pass, hallucination audit, copy proofread and export check still gate the upload. If the winning concept is one you could shoot in your own bathroom in five minutes, shoot it instead; this tactic earns its keep on scenes you cannot stage.

*Source: Lorenzo Pravata (@lorenzo_pravata) — "Native ads with GPT Images 2 + Claude (Full Playbook)" (social post)*

## Ask for a 'simple, modern, clean style' redo and explicitly specify 'mobile optimized' when generating Amazon graphics, and reject the first output if it is busy or has no clear focal point.

**Why it works:** Generators default to over-designed layouts with too many lines and boxes; naming the style and the viewing context forces the output down to one legible message per frame, which is what a shopper scanning a thumbnail on a phone can actually absorb.

**Evidence offered:** Side-by-side in the demo: the first comparison graphic is described as 'overly designed... too busy' with an unwanted 'Amazon product comparison' header; the same prompt plus 'more simple, modern, and clean style' and 'mobile optimized' produced a clean two-column check/X layout he calls 'a good one that would convert really well.' Practitioner assertion, no test data.

**Fit here (7/10):** Platform-mechanics class in its wording but published weeks ago, so no decay discount — and the underlying point (Amazon shoppers are majority mobile, so text must survive thumbnail size) is durable. Free, solo-executable, and it lands on the image slots for the larger ~$1,800/mo channel. It is the production-side complement to the 1-second comprehension test already in marketing-product-image-stack rather than a duplicate: that rule tells you to kill a cluttered asset, this one tells you what to say to get a clean one back. Note the scope split against the native base-layer block: clean-and-designed is right for listing infographics, candid-and-imperfect is right for native ad statics — never mix the two prompt blocks in one frame.

*Source: Chris Rawlings — "Nano Banana Pro for Product Photography (Step by Step 2026 Guide)" (12pQ0W2bCDE)*
