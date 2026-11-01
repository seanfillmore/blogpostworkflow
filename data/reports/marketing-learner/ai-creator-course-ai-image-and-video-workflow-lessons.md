# AI Creator Course: AI image and video workflow lessons

**Creator:** Anthony Gallo (ContentCreator.com)  
**Source:** transcript — `ai-creator-course-ai-image-and-video-workflow-lessons`  
**Published:** 2026  



Found 96 tactics: 64 adopted, 32 rejected.

## Adopted

### Use the image model for surgical edits to your own real photographs — remove an object from the frame, add a prop, colorize a black-and-white photo, open a subject's closed eyes — by naming only the change you want. — 8/10

**Why it works:** Modern editing models rebuild only the named region and leave everything else pixel-identical, so you can salvage or improve an otherwise-good real photo instead of reshooting it or generating a fully synthetic replacement. Because the base is a real photo, the output keeps the believability that fully generated frames lose.

**Evidence:** Multiple worked demos: phone and gimbal removed from a desk shot, a kitten added to the cleared spot, a black-and-white cat photo colorized, a blinking subject's eyes opened — before and after shown each time.

**Fit:** The operator shoots his own product and lifestyle photos on a phone, and this is how a cluttered bathroom-counter shot or a near-miss lifestyle frame becomes usable without a reshoot. It also protects the existing hard rule that any claim must live on the real packaging — editing a real photo keeps the pack authentic where a from-scratch render risks the listing. Existing claims cover correcting a model's own near-miss generation; none cover editing a real photograph you already own.

**Target skill:** `marketing-ai-product-imagery` (edit)

**Merged from:** part 1 of 9

### Change the environment or style around a subject while explicitly locking the subject — write the lock into the prompt ('keep the girl and the fish exactly the same, but change the image so she is waist deep in a pond'; 'keep the man exactly the same but make everything else look hand-drawn') — so one real photo yields many scenes. — 8/10

**Why it works:** Naming what must not change constrains the model to re-render only the background, so the subject's identity, lighting and detail survive. That turns a single real capture into an unlimited set of contexts and styles, which is the cheap way to get genuinely distinct scenes rather than near-identical crops.

**Evidence:** Worked demos: overcast sky replaced with golden hour with the subject and fish untouched; the same subject relocated into a lily-pad pond; an office restyled as a child's drawing while the person stays photographic; a heavily specified neon studio background swapped behind the same person.

**Fit:** The production answer to a requirement two existing skills already impose: Meta clusters near-identical creatives into one delivery entity so only a new scene, subject, format or lighting condition counts as a new ad, and the product-image stack asks for a lifestyle frame per use context. One real photo of the deodorant in hand becomes a gym bag, a bathroom counter and a car console without reshooting, and the locked subject stays real so the realism ceiling holds.

**Target skill:** `marketing-ai-product-imagery` (edit)

**Merged from:** part 1 of 9

### To make a generated shot show YOUR actual product rather than a hallucinated version of it, put a real photo of the product into the LAST frame — then the model has to arrive at your product exactly as it is instead of inventing one. — 8/10

**Why it works:** With a single start frame, anything the model introduces mid-clip is improvised, so a product that appears partway through a shot comes out wrong. Supplying the end state as an image of the real pack makes the product's appearance an input constraint rather than an output guess.

**Evidence:** Worked example: a hatless-man first frame plus a hat-on last frame produced a correct put-the-hat-on transition, with the creator noting a hat seller could swap in a photo of a hat they actually sell for brand accuracy.

**Fit:** The fix for the single biggest failure mode in AI creative for a formulated product with real packaging — the existing product imagery skill already requires auditing renders against the physical product and warns that a mismatched render gets a listing taken down. Using the real pack photo as the terminal keyframe makes 'picks up the deodorant', 'uncaps the lotion' and 'applies the lip balm' shots product-accurate by construction. One phone photo and a credit balance.

**Target skill:** `marketing-ai-broll-generation` (edit)

**Merged from:** part 5 of 9

### Shoot the real footage you can actually get, then use AI to generate only the specific shots you could not capture — the demonstration B-roll, the one missing establishing shot, the scenario you have no way to film. — 8/10

**Why it works:** The credibility-carrying footage (a real person, a real product, real hands) stays real, so the piece never reads as fully synthetic; AI is spent only on the gap list, which is where filming cost or impossibility actually blocks you.

**Evidence:** Creator demonstrates it on his own footage (real clip with an AI fire effect) and walks through a dog-trainer commercial where the interview is real and the training B-roll is generated; assertion otherwise.

**Fit:** The operator already films himself for social video with a phone. He cannot film sweat-through-a-shirt failures, a gym scene, a dentist chair, or an ingredient-sourcing shot — exactly the gap-list items this routes to AI while his real face and the real pack carry the trust. Durable production principle, not platform mechanics.

**Target skill:** `marketing-ai-broll-generation` (edit)

**Merged from:** part 3 of 9

### Run a deliberate sound-design pass on every generated or B-roll clip rather than shipping it with only voiceover: derive the effect list from two buckets — 'what do you see' (diegetic: footsteps, a cup rattling, a lid clicking) and 'what do you feel' (emotional: a suspenseful riser, a heartbeat, a deep impact) — then generate each one by plainly describing it to a text-to-sound model, and lay music under it too. — 8/10

**Why it works:** Generated video is visually plausible but acoustically dead, and that silence is a large part of what reads as synthetic. The diegetic layer supplies the physical cues a viewer unconsciously expects so the clip reads as filmed rather than rendered; the emotional layer tells the viewer how to feel at that moment. Splitting the list into two named buckets means you enumerate both instead of only the obvious ones.

**Evidence:** Before/after playback of the same hook with and without sound design, plus the literal prompts used ('cups and silverware rattle on a table as an earthquake starts to rumble', 'a subtle but suspenseful riser'), and the tool path demonstrated for generating effects.

**Fit:** Organic short-form and any AI-assisted ad are live surfaces produced end to end by one person, and sound design has no home in the skill set at all — the nearest skills cover voiceover casting and edit timing, not SFX. A cheap, repeatable quality lift on every video posted, and it applies identically at 16 orders a month or at $83K a month.

**Target skill:** `marketing-video-sound-design` (create)

**Merged from:** part 3 of 9; part 4 of 9; part 7 of 9

### Treat your existing footage library as the raw material for unlimited new ads — re-edit the same clips with a different script and a different AI voiceover each time rather than filming new content for every ad. — 8/10

**Why it works:** Once footage of the product and its use exists, the only variable cost per new ad is a script and a few cents of voiceover, so output per unit of effort rises sharply and more angles can be put in market without a new shoot.

**Evidence:** Creator's own client practice: years of retainer footage for a gym means new commercials are assembled from existing footage with a new AI voiceover and script, producing far more ads and better client results without proportionally more work; sample commercial played.

**Fit:** The highest-leverage item in the excerpt for a solo operator: the fleet requires covering distinct creative jobs and holding ~20% of slots for new angles, and the binding cost of that is production time. Reusing filmed product footage with new narration scripts turns one shoot into many angle tests, runnable today at $30/day with no second person.

**Target skill:** `marketing-short-form-video-production` (edit)

**Merged from:** part 6 of 9

### Convert horizontal talking-head footage to vertical by exporting one frame, AI-generative-expanding that still to 9:16, then laying the still behind the unchanged horizontal clip in a vertical sequence — feathering a mask around the speaker to hide the seam. — 8/10

**Why it works:** The only reason a horizontal clip cannot fill a vertical frame is the empty space above and below; if the footage is locked off, nothing in that space ever moves, so a single generated still is a convincing substitute for real footage. You keep the subject at a comfortable size instead of punching in hard, and you gain headroom to zoom and reposition afterwards.

**Evidence:** Walked end to end on the creator's own footage in Premiere with Photoshop, then repeated with the free Pixelcut tier; the finished frame is played back and compared against the two conventional alternatives (black bars, or cropping in 'way too close to Anthony's face').

**Fit:** The brand films its own founder-led video and publishes to vertical social; this unlocks reuse of any horizontal talking-head or demo footage as Reels/TikTok/Shorts and as 9:16 Meta placements, with a free tool, by one person. One phone, one laptop, no second person — exactly today's production capability.

**Target skill:** `marketing-vertical-video-reframing` (create)

**Merged from:** part 7 of 9

### Persist a standing custom instruction in the LLM's account settings telling it to ask clarifying questions whenever a request is too broad, so it interrogates you before generating. — 7/10

**Why it works:** You usually cannot tell your own prompt is underspecified. Moving the detection into a saved account-level instruction means the model forces the missing decisions (name, colors, audience, tagline) out of you before it commits to an output, instead of you discovering the gap after a bad generation.

**Evidence:** Assertion plus a worked demo — 'make a YouTube channel banner' comes back with three clarifying questions instead of a generic banner.

**Fit:** A solo operator who is also the copywriter, designer and media buyer prompts LLMs all day for ad copy, listing bullets, email drafts and image prompts. This is a one-time settings change that raises the floor on every one of those requests. Platform mechanics (fast-decay class) but current as of 2026, and the underlying move survives a UI rename. Distinct from the email-design claim about keeping a single brief deliberately vague — that is a per-task choice; this is a persisted account default.

**Target skill:** `marketing-ai-prompt-craft` (create)

**Merged from:** part 1 of 9

### Instead of writing a detailed prompt from scratch, keep your prompt framework as a reusable worksheet, paste it into the LLM with a one-line brief ('following the framework I've pasted here, create a prompt for [scene]'), and then hand-edit only the sections you actually have an opinion about rather than accepting what it returns. — 7/10

**Why it works:** The framework is the thinking; the long prompt is typing. The model enumerates the dimensions a good prompt has to specify — colour scheme, typography, layout, lighting, tagline space — which you would otherwise have to invent from memory, and surfaces fields you would have forgotten. You only overwrite the slots where you have a real requirement, so you get a fully specified prompt without composing one, which cuts trial-and-error rounds and raises output per hour without losing control.

**Evidence:** Worked demos: asks for a detailed prompt for a tech YouTube banner, gets back a specified prompt, then modifies only the colour section; separately demonstrates the exact meta-prompt against his saved text-to-video framework and warns explicitly against blindly accepting the result.

**Fit:** Directly useful to the operator's production load — every listing image, static ad frame and B-roll beat needs a specified prompt, and the existing image skills demand fixed-template, fully-specified prompts without saying where that specification comes from when you are not a photographer. This supplies the generation step and makes an eight-frame gallery or six-beat B-roll sequence promptable in one sitting. Runnable today with no budget or volume dependency.

**Target skill:** `marketing-ai-prompt-craft` (create)

**Merged from:** part 1 of 9; part 4 of 9

### Put your brand's actual hex codes into the generation prompt ('change the background of this image to a well-lit wall with the color #XXXXXX') to pull a generated image onto brand. — 7/10

**Why it works:** A hex code is an unambiguous instruction where 'our blue' is not, so the model reproduces the exact palette value rather than approximating a color word. Doing it in the prompt means brand consistency is enforced at generation time instead of being corrected afterwards in a design tool.

**Evidence:** Worked demo: a generated headshot's background swapped to the hex code tied to one of his own product lines, producing an on-brand profile image.

**Fit:** The product-image stack already requires fixing a brand visual identity once — palette, typography, lighting — and letting consistency come from that identity while every frame uses a different scene. This is the concrete prompt mechanic that makes that rule executable in an AI pipeline, across Amazon infographic slots, PDP gallery frames and email hero images.

**Target skill:** `marketing-ai-product-imagery` (edit)

**Merged from:** part 1 of 9

### Upload a low-quality casual phone photo of yourself and prompt the model to turn it into a professional headshot, rather than booking a photographer. — 7/10

**Why it works:** The model treats the amateur photo as an identity reference and re-renders it with studio lighting and framing, so the likeness is preserved while the production quality is raised — giving you a usable brand asset from a snapshot.

**Evidence:** Worked demo: a poor iPhone photo converted into a headshot he says is good enough to use online, then re-backgrounded to brand colors.

**Fit:** The operator is the brand's face — founder-story ads, the About page, the first-person social-proof substitute the credibility skill prescribes when the review corpus is thin, and email sender identity all need a presentable photo of him. Existing claims cover generating product heroes and lifestyle rooms instead of hiring a photographer, but not the founder likeness. Guardrail: for native-format statics the believable image still beats the beautiful one, so this is for brand and about-page surfaces, not UGC-styled ads.

**Target skill:** `marketing-ai-product-imagery` (edit)

**Merged from:** part 1 of 9

### Restrict every AI video generation to the small menu of basic camera movements real directors use for 90% of shots — static/tripod, pan left or right, tilt up or down, tracking, push in or out, jib up or down — state the move explicitly in the prompt, and keep it to one simple move rather than inventing elaborate camera choreography. — 7/10

**Why it works:** Undefined movement lets the model do anything and compound or elaborate motion makes generative models warp and drift; a single named simple move is something the model reliably executes, and restrained coverage is also what professional footage actually looks like, so the finished cut reads as professional rather than AI-wobbly.

**Evidence:** A demonstration shot where no movement was specified and the static result was luck, plus enumeration of the standard moves and the claim they cover 90% of Hollywood shots; no comparative tests shown.

**Fit:** Organic short-form video is a live surface he films, cuts and publishes himself, and AI B-roll is already an adopted workflow. A fixed menu of simple camera moves is a concrete quality gate on every generated clip going into a body-care Reel or a Meta video ad, and it costs nothing. It sharpens the existing 'write an explicit camera instruction into every shot prompt' claim by saying WHICH instruction and to keep it singular.

**Target skill:** `marketing-ai-broll-generation` (edit)

**Merged from:** part 3 of 9; part 4 of 9

### Build the character you animate by uploading a real photo of yourself (or the real subject) into an image model and generating new images from it, rather than describing an appearance in words — then animate those images and lay your voice over them, so you can appear in shots you could never film. — 7/10

**Why it works:** A written prompt cannot specify a real person's face closely enough to reproduce, but an uploaded reference photo hands the model the entire appearance for free, so the downstream video prompt only has to describe action, not identity. The same identity-anchoring that holds a fictional character consistent works on your own face, making the founder a reusable on-camera asset placeable in any setting without a shoot.

**Evidence:** Assertion plus forward-reference to a dedicated course section ('imagine trying to create a video of yourself… with Nano Banana Pro I can upload a real photo of myself'); the core mechanism is shown working on a fictional character in the same lesson.

**Fit:** The brand is founder-fronted and he is already the on-camera face, so the reference photos exist. Anchoring generated scenes to his own photographed likeness keeps a recurring character consistent across a batch of social videos and ads and lets one person produce demonstration scenes and scenarios he has no set, time or crew for. Guardrail: a trust-dependent skincare brand carries real downside risk in obviously synthetic founder footage, so this is a production option rather than a default.

**Target skill:** `marketing-ai-broll-generation` (edit)

**Merged from:** part 2 of 9; part 3 of 9

### Route a first-frame/last-frame shot to the model that handles its transition type — the photoreal model for simple transitions, the morph-happy model when the transition between the two frames is complex or physically impossible — and read a crossfade or hard cut in the output as the model giving up rather than as your prompt being wrong. — 7/10

**Why it works:** The two models fail differently: one renders more realistic frames but, when it cannot reason a path between two dissimilar keyframes, substitutes a fade any editor could have made; the other renders slightly less realistically but invents a plausible morph. Knowing which failure you are looking at tells you to switch models instead of burning credits rewriting the prompt.

**Evidence:** Side-by-side generations of the same keyframe pairs on both models: identical results on the horse and hat shots, Kling clearly better on the car-to-transformer and hike-to-city transitions, with Veo producing a visible fade both times.

**Fit:** Platform mechanics (fast-decay class) but a 2026 source naming currently-shipping versions, so it is live. The operator already generates AI video on pay-per-credit access, and the named failure signal (a fade means the model quit) is the kind of diagnostic that stops credit waste on product-transformation shots. The existing broll skill only covers switching models on an outright content-policy refusal, not on transition difficulty.

**Target skill:** `marketing-ai-broll-generation` (edit)

**Merged from:** part 5 of 9

### Build an ingredient 'deconstruction and reassembly' shot by uploading the product photo to the image model, prompting it to separate the product into its component parts, then animating the exploded frame back into the intact product as a first-frame/last-frame pair. — 7/10

**Why it works:** One image-edit prompt produces the exploded-components frame from a photo you already have; the two frames then define a reassembly motion the video model can solve on the first try. The resulting shot visually asserts what the product is made of without a claim sentence — the mechanism half of the copy delivered as motion.

**Evidence:** Worked example: a camera product shot prompted into a 3D deconstruction frame, then animated back together in Kling on the first generation, as shot one of a three-shot commercial.

**Fit:** Natural deodorant and body care sell on what is and is not in the formula, and the product image skill already calls for ingredient-representation frames as a main-image lever. This gives that frame a motion version for social video and Meta placements, produced from a phone photo and an edit prompt by one person.

**Target skill:** `marketing-ai-broll-generation` (edit)

**Merged from:** part 5 of 9

### Treat the 5–10 second generation limit as a non-issue: plan the piece as a sequence of short shots and default to 5-second clips, because the average shot length in real film and TV is 2.5–4 seconds. — 7/10

**Why it works:** Length in finished video comes from shot count, not clip length, so building to real editorial shot rhythm both fits the tool's limit and spends the fewest credits per finished minute.

**Evidence:** Cites a film scholar's analysis of 15,000 movies finding average shot length of 2.5–4 seconds; walks a mountain-climbing sequence to show no shot approaches 10 seconds.

**Fit:** Directly governs how the operator storyboards and budgets any AI-assisted video — 5-second generations at half the credit cost of 10-second ones, planned as a shot sequence, is the difference between affording a batch of social videos and affording one. Durable editorial principle with a concrete default setting.

**Target skill:** `marketing-ai-video-ad-production` (edit)

**Merged from:** part 3 of 9

### Generate the video's thumbnail/cover frame by uploading an ordinary photo of yourself plus a photo of the product and prompting a 16:9 close-up with a named facial expression, instead of staging a lit photoshoot for it. — 7/10

**Why it works:** The thumbnail is just a composite of a person and an object with a directed expression, and an image model can build that from two existing photos — turning a half-day of lighting, wardrobe and Photoshop into minutes, which also means you can generate several candidate covers and pick rather than being stuck with the one you shot.

**Evidence:** Creator's own before/after: the original camera-review thumbnail took 'almost half a day'; the team now uses the model for 'almost all' their thumbnails with 'amazing' results.

**Fit:** Organic short-form is filmed, edited and published by one person, and the cover frame is the single element deciding whether the post gets opened on a grid or in a feed. Replacing a staged shoot with a two-photo composite is exactly the production cost one person cannot otherwise absorb, and generating multiple candidates is free on pay-per-generation access. Off YouTube, the same frame is the Reels/TikTok cover and the grid tile.

**Target skill:** `marketing-short-form-video-production` (edit)

**Merged from:** part 2 of 9

### Script every video word for word before filming and read it from a teleprompter — and when nobody speaks, the script is still required as the written record of what happens on screen. — 7/10

**Why it works:** A written script forces the piece to be focused, planned and respectful of the viewer's time; and with AI generation the script is load-bearing because the model will not say or do anything you have not specified.

**Evidence:** Creator states he scripts every YouTube video, course video, ad and social post this way, including the one being watched.

**Fit:** Organic short-form is filmed by the operator himself, and the cheapest quality lever on a one-person shoot is not improvising — scripting plus teleprompter removes the rambling takes that kill retention, and the 'action script even with no dialogue' rule covers his product-demo and b-roll pieces. Zero cost, zero volume requirement, aimed at the surface he publishes to weekly.

**Target skill:** `marketing-short-form-video-production` (edit)

**Merged from:** part 2 of 9

### When you want maximum realism in a shot, film the real action plainly yourself and apply the AI effect to that footage — then layer the AI clip above the original in the editor and cut at the exact frame the action happens, masking or keyframing so your real face stays visible and the effect triggers on the beat. — 7/10

**Why it works:** Real footage already has physically correct light, motion and texture, so an effect laid onto it reads as real while a fully generated shot has to invent all of that and gives away the tell — and generated faces are specifically where viewers detect fakeness. The AI output runs the effect across the whole clip, so the cut-and-stack in the timeline is what converts it into a triggered effect rather than a continuous one.

**Evidence:** Demonstrated end to end on the creator's own hand-snapping-into-fire shot: phone clip of a finger snap with a mimed flame, prompt 'his arm and hand is on fire', then a cut on the snap in Premiere with the head of the AI layer deleted and extended a few frames to fix mistimed sync, plus a circle mask and keyframed flame growth; he states the AI version of his face 'can sometimes look off'.

**Fit:** A scroll-stopping visual device a one-person shoot can execute today in CapCut or Resolve, and the fleet already prizes deliberately surreal statics purely to stop the scroll. Hybrid keeps the believability a skincare purchase depends on while getting a shot he could not otherwise capture, and it costs less than generating the scene from nothing. An honest translation exists (an effect over his real hands and the real pack) without fabricating a product claim.

**Target skill:** `marketing-short-form-video-production` (edit)

**Merged from:** part 2 of 9; part 3 of 9; part 6 of 9

### Place each sound effect on the timeline against the exact moment the viewer sees or feels it, and pull its volume down well below where it imports, because generated SFX arrive far louder than needed. — 7/10

**Why it works:** Sound effects exist to enhance the picture and the narration, not to compete with them — at import level they pull attention off the message, which is the opposite of the job.

**Evidence:** Demonstrated in the before/after playback; stated as standard practice.

**Fit:** Runnable today in the basic editor already in use, and it keeps the narration — which carries the actual selling argument — on top, which matters more for a product video than for an entertainment piece.

**Target skill:** `marketing-video-sound-design` (create)

**Merged from:** part 7 of 9

### Produce only the hook — the first ~60 seconds — as the first deliverable of a new narrated video or format, judge it, and only then repeat the identical process for the rest of the piece. — 7/10

**Why it works:** The hook is where the viewer decides to stay or leave, so it carries almost all the risk; building it alone caps the cost of a format test, and because the remaining sections are produced the same way, a working hook is proof the whole production pipeline works.

**Evidence:** Creator deliberately built only the one-minute Pompeii hook rather than a 30-minute documentary, stating that once you understand how the hook was built you repeat the exact same process for the rest.

**Fit:** A solo operator's scarcest input is production hours, and the fleet already puts ~90% of copy effort into concept and hook. This makes that allocation a production rule: ship and read the hook before funding the rest of an asset — runnable today on the brand's own social channels.

**Target skill:** `marketing-short-form-video-production` (edit)

**Merged from:** part 6 of 9

### Brief the LLM for a narration script by casting it in a named genre ('write the script for a Netflix-style documentary series about X'), then redirect with one specific note at a time, and finish by imposing a hard character limit that matches the runtime before hand-tweaking for pacing. — 7/10

**Why it works:** The genre reference imports an entire structure and tone the model already knows, named redirects move one variable at a time ('dive straight into the moment, kids playing, clear skies, then the ground trembles'), and a character cap is the only reliable way to force a script to fit a fixed runtime rather than overshooting.

**Evidence:** Full prompt chain shown: the documentary brief, a redirect for faster tension, 'rewrite the hook so it's under 500 characters', then manual pacing edits.

**Fit:** He writes every script himself with LLM help, and the character-count constraint is a concrete fix for the most common defect in generated video copy — a script that will not fit the placement. Durable-principle class on the briefing side; runnable today.

**Target skill:** `marketing-copy-body-structure` (edit)

**Merged from:** part 6 of 9

### Taper production spend across the runtime: put the expensive cinematic generations and the expensive talking-head/avatar format only where they earn their keep — the opening hook and roughly 30-second bursts at the open, middle and close — and carry the rest of the script on cheap AI voiceover over stills and simple B-roll, generating a clip only where the script absolutely demands motion. — 7/10

**Why it works:** The hook decides whether the rest is watched at all, so marginal production value is worth far more in the first seconds than at second forty; avatar video is priced per second of face while voiceover and stills cost almost nothing, so concentrating the expensive format where a face earns trust and covering the remainder with narration delivers the same runtime at a fraction of the cost.

**Evidence:** Worked cost reasoning for a 10-minute video and the same pattern applied to Reels and TikToks, plus the creator's own practice with a stated 20-minute total build time for the hook section.

**Fit:** A one-person operation producing its own social video has a hard time and credit budget, and this is an explicit allocation rule for both. Complements rather than duplicates the copy-side claim that 90% of copy effort belongs in the concept and hook — this governs production spend per second of finished video. His own face is free to film, so the honest translation is 'cinematic generations and face-to-camera where trust is earned, narration over stills elsewhere'.

**Target skill:** `marketing-ai-video-ad-production` (edit)

**Merged from:** part 3 of 9; part 7 of 9

### Run every generation through the cheaper video model by default and escalate only the individual shots that fail to the expensive model. — 7/10

**Why it works:** Output quality between the tiers is close enough that most shots come back usable from the cheap model; reserving the premium model for the minority of stubborn shots cuts the cost of a finished video without changing what ships.

**Evidence:** Side-by-side comparison of the same image and prompt animated by both Kling and Veo ('they both look great'), plus the creator's stated personal workflow.

**Fit:** A concrete cost-allocation rule applicable the first time he generates anything, and it compounds across a batch — per-video production cost decides how many social videos and ad variants he can afford to make at all. Platform mechanics in its named models, but the escalation rule is durable and survives version changes.

**Target skill:** `marketing-ai-broll-generation` (edit)

**Merged from:** part 3 of 9

### Split a long voiceover into separate generations sized to the video model's maximum clip length, and force the LLM to write each prompt as multiple scenes with explicit timestamps matched to the voiceover script rather than one scene per generation. — 7/10

**Why it works:** The model will cut between several scenes inside one long generation if the prompt tells it when each scene starts, so a single credit spend returns a correctly paced multi-shot sequence already aligned to the narration; a prompt without timestamps returns shots in arbitrary places that then have to be re-timed by hand.

**Evidence:** Demonstrated: the first LLM-written prompt omitted timestamps and was unusable; after asking for 'multiple scenes within one 15 second generation matched to the timestamps of the voiceover script', the returned clip cut scene-to-scene almost exactly on the narration lines and only one clip needed re-timing.

**Fit:** He runs his own organic short-form and writes, films, cuts and publishes it himself, so AI-generated B-roll sequences cut against a narration track are a live surface today. This sharpens the existing 'ask for several cuts inside one long generation' claim with the specific input that makes it assemble, plus the duration-limit split. Platform-mechanics class, but the tool names are 2026-current.

**Target skill:** `marketing-ai-video-ad-production` (edit)

**Merged from:** part 6 of 9; part 7 of 9

### When one generated shot is too short and throws the whole sequence's timing early, screenshot a frame from that shot, feed it to a cheaper image-to-video model with a one-line camera prompt ('drone shot of the city with the volcano in the background, slow push forward'), and splice the longer version in place of the original. — 7/10

**Why it works:** The pacing defect is a duration problem, not a content problem, so you only need more of the same frame — regenerating from the existing frame in a low-credit model preserves continuity exactly while costing a fraction of re-running the whole multi-scene generation.

**Evidence:** Demonstrated twice — on the opening drone shot and on the falling-destruction shot — each time cutting the original clip out, dropping the five-second regeneration in, and trimming to the narration line.

**Fit:** Directly runnable by a solo operator today: a repair move inside an edit he already does himself, and it keeps credit spend down on a business reference-budgeted at $30/day. Existing claims cover chaining end frames to start frames and salvaging believable seconds, but not regenerating a shot purely to extend its duration.

**Target skill:** `marketing-ai-video-ad-production` (edit)

**Merged from:** part 7 of 9

### In longer talking-head content, take the figurative line in your own script and generate the literal image of it as a cutaway — 'launching the business felt like getting to the top of the mountain' becomes an AI shot of you celebrating on Everest — so the viewer is not watching you at a desk for the whole runtime. — 7/10

**Why it works:** A metaphor the speaker says aloud is already the viewer's mental picture; showing it breaks visual monotony at exactly the moment attention would otherwise drift, and because the cutaway illustrates what was just said it costs no comprehension. Retention rises without changing the script.

**Evidence:** Worked example from the creator's own planned entrepreneurship video; assertion only on the retention effect.

**Fit:** He films himself talking to camera about aluminium-free deodorant, ingredients and why he formulated the line. The existing B-roll claims cover marking literal visual beats; this adds the higher-leverage move of rendering the metaphor — 'it felt like my armpits were in a plastic bag', 'like scrubbing with gravel' — as the cutaway. One person, one phone, one image model.

**Target skill:** `marketing-ai-broll-generation` (edit)

**Merged from:** part 4 of 9

### Get a second camera angle of a shot you only filmed or generated once by uploading the clip to a video-to-video tool and prompting for the reverse or alternate angle — naming the position, framing and camera movement explicitly ('the reverse angle filmed from behind the man, looking over his shoulder, showing his hands holding the phone', 'symmetrical, subtle push in') — and naming every element that must appear, because anything you leave unspecified comes back empty. — 7/10

**Why it works:** The tool re-renders the same subject and the same motion from a new vantage point and infers lighting, wardrobe, colour and mood from the source clip, so the generated angle matches the original without a continuity effort — holding character and product consistency that a fresh image-to-video generation would break. But it only renders what it is told about the newly-visible surfaces: an unspecified phone screen came back blank. One take becomes cuttable coverage.

**Evidence:** Demonstrated on a robot-on-a-bench clip (wider angle and tight close-up both preserving character and movement), on a window clip (reverse angle holding composition and adding the requested push-in), and on a night-time phone clip where the reverse over-the-shoulder matched lighting, dramatic register and even the phone case colour — with the acknowledged failure that the unspecified phone screen rendered blank.

**Fit:** He films alone with one phone, so multi-angle coverage is otherwise impossible and cut variety is what holds retention in short-form. The fleet already holds 'shoot each beat as coverage at two shot sizes' and 'write an explicit camera instruction into every shot prompt' — this extends both to real footage he already has. Runnable today on pay-per-generation credits; the 'name the newly-visible surfaces' caveat is the operational half.

**Target skill:** `marketing-ai-video-clip-editing` (create)

**Merged from:** part 5 of 9; part 6 of 9; part 9 of 9

### When a clip you already have needs one specific change, run it through a prompt-driven video-to-video edit tool to make only that change rather than regenerating or reshooting — removing a distracting object, converting day to night, swapping the weather or adding an element outside a window. — 7/10

**Why it works:** The clip already contains everything that works — the subject, framing, performance, product in frame. Regenerating from scratch rolls the dice on all of it to fix one defect, while a prompted edit holds the rest of the frame fixed and alters only the named element, so one usable take becomes several visually distinct scenes at a few cents each. The creator's own results show the honest limit: a whole-frame light-to-night conversion came out weak, while localised changes (rain to snow, fire outside the window, a clock removed) came out near-perfect.

**Evidence:** Multiple worked demonstrations with the creator grading his own outputs: rainy window re-prompted to snow and then to 'outside the window a large fire rages' with refraction through the glass holding up; a wall clock removed from behind a subject; bare ground covered in snow; a daytime Hawaii hike converted to night with aurora; day-to-night called one of his worst results. Priced at ~60 credits per generation, 1,000 credits for $10.

**Fit:** He films, cuts and publishes his own short-form, so clip-level defects are a real recurring cost — a usable take of himself demonstrating deodorant with a cluttered shelf behind him currently means a reshoot, and this salvages the take. It also multiplies a single take into visually distinct clips, which is what the creative-distinctness requirement in paid testing demands. Tool-specific (platform-mechanics class) but 2026-current, and the durable part is 'edit the clip you have rather than regenerate'. Note the limit: restyled weather on the same take is a weak variant, not a genuinely new creative.

**Target skill:** `marketing-ai-video-clip-editing` (create)

**Merged from:** part 5 of 9; part 6 of 9; part 9 of 9

### When a prompted video edit keeps getting the change wrong, stop re-prompting the video tool — screenshot a frame, make the change you want in an image model, then upload that still as a reference image alongside the clip and prompt 'replace X with the Y from the reference image, match the reference image exactly'; upload one reference per element if several things are changing. — 7/10

**Why it works:** A text prompt leaves the video model to invent what the new element looks like, and it averages toward a hybrid (the 'chicken T-Rex'). An image model is far better at a single still, so you resolve the look once in the easier medium, then hand the video model a fixed visual target to match instead of a description to interpret — converting an open-ended generation into a matching task.

**Evidence:** Direct side-by-side: the text-only prompt returned a 'freaky chicken T-Rex hybrid'; the same edit run with a Nano Banana Pro reference still returned a believable giant chicken that fit the scene. Creator concedes it is still 'not perfect' on a large change.

**Fit:** The generalisable principle in the lesson: resolve a visual in the medium that controls it best, then hand the harder model a target rather than a description. Directly usable on his own video work — fixing a pack shot, a label, or a background element inside a clip he already filmed. Complements rather than duplicates the existing broll claim about routing a refused prompt to a different model; this fixes a prompt the model obeys but renders badly.

**Target skill:** `marketing-ai-video-clip-editing` (create)

**Merged from:** part 9 of 9

### Replace the background of footage you already filmed by screenshotting a frame, changing that single frame's background in an image model, then feeding the original clip plus the new frame into a video model to rebuild the whole scene in the new environment. — 7/10

**Why it works:** The video model only has to propagate an environment that an image model already composed correctly on one frame, so you get a consistent new setting across the clip — including through camera movement — without reshooting or hiring a location.

**Evidence:** Two live demos: a talking-head clip moved to a New York penthouse, and a moving handheld shot of a woman with a camera moved into a jungle, 'without messing really anything up'.

**Fit:** A solo operator filming himself at home for organic short-form and paid creative can change the implied setting of a clip after the fact — bathroom routine, gym context, outdoors — which is exactly the per-use-context variety the product-image and creative-testing skills demand, without a second location or person. A phone, a clip and two generations. Held short of the top because native/UGC creative often performs better unpolished, so this is a tool for context variety rather than cinematic polish.

**Target skill:** `marketing-ai-footage-background-replacement` (create)

**Merged from:** part 8 of 9

### Shoot against the cleanest, simplest wall you have with just enough empty space around your whole body for your arms to move, because anything that overlaps your body cannot be replaced by AI. — 7/10

**Why it works:** The AI can only rebuild the area outside the subject's silhouette; detailed or overlapping background elements sit inside the region the mask protects and force complex frame-by-frame editing instead of a one-pass replacement.

**Evidence:** Demonstrated by the failure case — a light switch directly behind his shoulder could not be removed, so he had to live with it, while the open wall either side was replaced cleanly.

**Fit:** A shoot-side decision a solo operator makes before he presses record, at zero cost, and it determines whether every downstream AI background move is cheap or impossible. Filming at home is his actual production reality, so the constraint it solves is the one he genuinely has.

**Target skill:** `marketing-ai-footage-background-replacement` (create)

**Merged from:** part 8 of 9

### Shoot with the conversion in mind: lock the camera on a tripod with no movement, keep clear empty space at the top, bottom and side edges of the frame, and stage the set so nothing moves in those margins (e.g. a desk that hides your legs, a barrier above your head). — 7/10

**Why it works:** A generated still can only stand in for the expanded margins if those margins are static — any camera move or any moving object in them exposes the fake instantly. Deciding this at the shoot costs nothing and makes every clip reframeable later.

**Evidence:** Stated as a hard precondition ('this process only works for a certain type of footage'), with his own desk setup shown as the example.

**Fit:** A free constraint applicable to the next thing he films himself — he is the videographer, so naming the role does not park this behind a team. It makes a single shoot serve horizontal and vertical placements, which is leverage a solo operator needs more than a crewed brand does.

**Target skill:** `marketing-vertical-video-reframing` (create)

**Merged from:** part 7 of 9

### Film ads in one aspect ratio with reframing room, run them, and only convert the winners to the second aspect ratio — so one proven asset serves multiple placements instead of reshooting per format. — 7/10

**Why it works:** Reframing is cheap and conditional on performance, while shooting a second version is expensive and speculative; sequencing conversion after the result means production effort is only spent on creative that has already earned it.

**Evidence:** Stated as the creator's own and his clients' standing practice ('we'll typically film it in horizontal, then convert it to vertical if the ad does well, so we can run it in multiple placements').

**Fit:** Paid is runnable here — the account, pixel and creative exist and spend resumes on one decision — so a rule about which winning asset to reformat for which placement is actionable planning today, and it pairs with the existing claim about pulling placement breakdowns on a winner. The priority is reversed for this brand though: vertical Reels/TikTok is the primary surface, so the honest translation is 'frame with reframing room and only cut the second aspect ratio once a piece has earned it'.

**Target skill:** `marketing-vertical-video-reframing` (create)

**Merged from:** part 7 of 9; part 8 of 9

### Prompt conversationally in deliberate stages — first ask the model what the factors of a good version of the asset are, then ask it to generate one using those stated principles, then refine with single-dimension follow-ups ('make it more engaging', 'add urgency'). — 6/10

**Why it works:** Making the model state the evaluation criteria before it produces anything puts those criteria into the context window, so the generation is written against an explicit standard instead of the model's default. Each subsequent one-variable follow-up steers toward the target rather than re-rolling the whole thing, so you converge instead of gambling on a one-shot prompt.

**Evidence:** Worked demo with YouTube titles: asks for the factors that make a title work (numbers, power words, curiosity, under 60 characters), then asks for titles using those principles, then refines for engagement and urgency.

**Fit:** Honest translation to the surfaces this business writes: ask the model what makes an Amazon title or a Meta primary text or a subject line work, then have it generate against that list, then push one dimension at a time. Adjacent to existing claims about running a hook through a named clarity rewrite and hand-editing drafts back into the model, but the criteria-first-then-generate ordering is its own move. Scored below the other two prompt-craft items because it is the most generic and easy to do badly.

**Target skill:** `marketing-ai-prompt-craft` (create)

**Merged from:** part 1 of 9

### Restyle an existing scene by uploading an image of the target visual style and prompting the model to change the style of image one to match image two — explicitly instructing it to restyle both the subject and the background. — 6/10

**Why it works:** A style reference carries far more information about palette, line and rendering than a text description can, and naming subject AND background stops the model restyling only the figure and leaving an incongruent realistic set behind it.

**Evidence:** Demonstrated output: a desk photo restyled into the animation style of a cartoon screenshot.

**Fit:** A solo operator producing his own ad statics and organic video frames can generate a distinct, non-stock visual treatment for a body-care scene from one reference he likes, and the 'restyle the background too' instruction is a concrete defect fix. Distinct from the recorded reverse-engineer-the-reference-into-a-prompt move, which converts the reference to text first; this applies the reference image directly. Held at six because a stylised frame is a secondary format for a trust-dependent skincare catalogue.

**Target skill:** `marketing-ai-product-imagery` (edit)

**Merged from:** part 2 of 9

### Control exactly where new elements land in a generated scene by marking the target areas with coloured rectangles in any basic editor, then referencing those colours in the prompt ('add a plant in the area marked by the blue rectangle'). — 6/10

**Why it works:** Spatial instructions in prose are ambiguous and the model places elements wherever it likes; coloured region markers give it unambiguous coordinates inside the image itself, turning a re-roll into a precise edit.

**Evidence:** Demonstrated output: a bare living room gains a carpet, a lamp and a plant in the three marked positions.

**Fit:** Solves a recurring defect in the imagery work — the recorded workflow already says to correct a near-miss by naming the defect and its location in words, and this is the stronger version where the location is marked on the image. Directly applicable to placing the deodorant stick or soap bar in a specific spot in a bathroom lifestyle frame, or positioning a headline block before the text pass. One person, a laptop and a free editor.

**Target skill:** `marketing-ai-product-imagery` (edit)

**Merged from:** part 2 of 9

### When you can picture a composition but cannot describe it, sketch the element crudely onto the image yourself and prompt the model to recreate the image following the rough sketch provided. — 6/10

**Why it works:** A bad drawing still encodes position, scale, perspective and silhouette more precisely than a sentence can, and the model uses it as geometry while supplying the rendering quality you lack.

**Evidence:** Demonstrated output: a crude pencil-style spaceship sketch becomes a rendered ship in the sky of the same photo.

**Fit:** A genuinely new input mode for the imagery workflow and the only cheap way to get an exact composition when prose prompting keeps missing — useful for scale, placement and framing on product-in-scene statics and listing graphics. No drawing ability required, which matters when one person owns the designer role as well as everything else.

**Target skill:** `marketing-ai-product-imagery` (edit)

**Merged from:** part 2 of 9

### When the new camera angle would reveal something the source frame never showed — a face turned away, a hidden side of the product — upload a second reference image of that element and name it in the prompt as the reference for how it should look. — 6/10

**Why it works:** The model cannot invent a consistent face or label it has never seen, so the reverse-angle shot drifts into a different character. Supplying the unseen element as its own reference ('use the face from image 2 as a reference for how the man's face should look') gives it the missing information while the angle instruction keeps the set intact.

**Evidence:** Demonstrated output: an over-the-shoulder reverse angle where the previously unseen character's face matches the uploaded reference.

**Fit:** This is the specific failure that breaks a multi-shot AI sequence, and it prevents the defect at generation time rather than repairing it afterwards. Applies both to a character sequence and to revealing the back-of-pack ingredient panel in a reverse shot. Scored at six because it is a narrow repair move inside an already-covered workflow.

**Target skill:** `marketing-ai-broll-generation` (edit)

**Merged from:** part 2 of 9

### When you supply both a first and a last frame, write a deliberately broad one-line prompt rather than a detailed one, because the two images have already written the story. — 6/10

**Why it works:** The keyframes constrain the beginning and end states, so there are only a limited number of things that can physically happen in between. Over-specifying adds instructions the model has to reconcile against two fixed images and increases the chance it fights the frames.

**Evidence:** Demonstrated: 'A majestic horse walks into frame and starts grazing on the grass' produced a clean first-try result, and a three-shot camera sequence succeeded first try on similarly short action prompts.

**Fit:** A durable prompting principle rather than a platform detail, and it directly contradicts the instinct to apply the existing fixed-template scene prompt (written for single-frame generation) to two-frame shots. Saves regenerations on every product-in-use clip he builds.

**Target skill:** `marketing-ai-broll-generation` (edit)

**Merged from:** part 5 of 9

### When a published video underperforms, generate a new cover image and swap it onto the live video rather than writing the video off. — 6/10

**Why it works:** Cheap cover production removes the reason nobody iterates on published posts; the cover is the click decision, so replacing it on a video that already has watch-time signal can restart distribution on content the algorithm had stopped serving.

**Evidence:** Creator shows a views graph: flat growth after posting, then a sharp vertical climb immediately after the AI-generated thumbnail swap. Single case, own channel.

**Fit:** A live, runnable lever on the organic surface already published to — covers are editable on published Reels and TikToks and the image tooling is in hand. Marked down because the evidence is one anecdote from a channel whose reach dynamics differ, and this is platform-mechanics-class behaviour, so treat it as a cheap retest rather than a reliable rule.

**Target skill:** `marketing-short-form-video-production` (edit)

**Merged from:** part 2 of 9

### Scale storyboard depth to the type of video — a talking-head piece needs almost none and leans on the script, while a visual-heavy ad or narrative piece needs a full storyboard — and do not start generating any video until the whole storyboard is settled. — 6/10

**Why it works:** The script is the map of what is said and the storyboard the map of what is shown; when the visuals carry the piece, generating clips before the sequence is designed wastes paid generations on shots that will not cut together.

**Evidence:** Assertion plus a demonstrated storyboard-to-video conversion for a short horror scene.

**Fit:** A real spend-control decision rule not restated anywhere — the existing storyboard claim covers how to organise frames in a Google Doc, not whether a given piece needs one. For a solo operator on pay-per-generation credits, knowing that talking-head clips need a script and no storyboard while a narrative ad needs a complete one before the first generation directly avoids burned credits and dead shots.

**Target skill:** `marketing-ai-video-ad-production` (edit)

**Merged from:** part 2 of 9

### Order the coverage so a partial detail shot lands before the full reveal — show just the foot coming down, then cut to the wide shot of the whole creature — rather than opening on the full subject. — 6/10

**Why it works:** Withholding the full subject for a beat opens a loop visually; the viewer leans in to resolve what they are only seeing part of, and the wide shot then pays it off. Cutting between detail, wide and close-up also adds depth and makes the edit feel immersive rather than static.

**Evidence:** The creator points at his own finished video and explains the shot order he chose and why; no performance data.

**Fit:** Directly applicable to the social video published in-house: open on the detail — a cap twisting off, a swipe across skin, the bar being cut — and reveal the pack and lineup after. It is a shot-ordering rule for the edit, distinct from the existing claim about generating coverage at two shot sizes, and runnable with a phone and a basic editor.

**Target skill:** `marketing-short-form-video-production` (edit)

**Merged from:** part 4 of 9

### When generating a sound effect, tick the 'choose specific duration' option and set a longer duration than you need, because the model returns higher-quality audio when given room. — 6/10

**Why it works:** Left on auto, the model produces clipped, truncated artifacts; an explicit and generous duration gives it space to render attack and decay, and the excess is trimmed in the edit anyway.

**Evidence:** Assertion from repeated use ('I find it gives me higher quality sound effects').

**Fit:** A small concrete setting-level tip runnable today inside a workflow he can start this week. Fast-decay platform-mechanics class — the named control belongs to a specific 2026 tool UI, so it should be re-checked rather than treated as durable, which is what caps it.

**Target skill:** `marketing-video-sound-design` (create)

**Merged from:** part 7 of 9

### Sell a key visual moment by stacking two or three separate sound effects under it rather than one. — 6/10

**Why it works:** Each layer covers a different part of what the viewer expects to hear (the snap, the ignition whoosh, the sustained crackle), so the composite reads as real; without it the visual looks like a render.

**Evidence:** Demonstrated: three stacked audio layers — snap, flame burst, campfire crackle — under the hand-on-fire shot, with the creator noting the effect only 'really sells' once they are combined.

**Fit:** Cheap, runnable today in a free editor by one person, and it raises perceived production value on the organic short-form surface already published. Narrow in scope — a craft detail, not a lever on offer or conversion — which is what holds it at 6.

**Target skill:** `marketing-ai-voiceover-production` (edit)

**Merged from:** part 6 of 9

### Cut the long pauses out of the generated voiceover track before building the visuals on it, so the narration's pacing is fast and the clips are timed to a tight read. — 6/10

**Why it works:** Synthetic reads leave dead air that reads as slow on a feed; trimming the narration first means every downstream clip length is cut against the final pace rather than being re-timed later.

**Evidence:** Shown on the timeline — the voiceover is sliced into several clips with the longer pauses removed 'to keep the pacing fast'; assertion only on the effect.

**Fit:** Trivially runnable in a free editor and it directly affects retention on the organic short-form surface already running. The fleet's editing claims cover trimming visual clips to their beat but not trimming the narration track first.

**Target skill:** `marketing-short-form-video-production` (edit)

**Merged from:** part 6 of 9

### Generate the background music with an AI music tool, prompting its job rather than a genre vibe — 'no vocals, slow pulsing background track to serve as the backbone of the video, suspenseful' — and generate two options so you can pick the one that fits the dialogue. — 6/10

**Why it works:** Music raises the stakes and pushes a narrated video forward even when viewers do not consciously notice it, so a bed built for the specific narration outperforms a library track; prompting the function (no vocals, pulsing, backbone) rather than a style keeps it from competing with the voiceover.

**Evidence:** Demonstrated: two Suno generations from a stated prompt, the second chosen after laying both against the voiceover; creator asserts music is 'doing a ton of work' in good faceless content.

**Fit:** Cheap, one-person, pay-per-generation, and directly applicable to the narrated social video already published — no existing skill covers music at all. A production-quality lever rather than an offer or conversion lever, which is why it sits at 6.

**Target skill:** `marketing-ai-voiceover-production` (edit)

**Merged from:** part 6 of 9

### Do not drop the music in at the start of the timeline — slide and trim the track so its crescendo lands exactly on the most dramatic line of narration, and blend any splice with a short crossfade. — 6/10

**Why it works:** The emotional peak of the track and the emotional peak of the script have to coincide or the music works against the copy; because the track is longer than the edit, the free move is to reposition it rather than re-generate it.

**Evidence:** Demonstrated in DaVinci Resolve: track duplicated and dragged so the 'quiet before the storm' section runs under the calm lines and the punch-through lands on 'the mountain split open', plus a six-frame crossfade at a splice.

**Fit:** Runnable today in a free editor by one person, and it compounds with the music-generation tactic on the brand's own narrated short-form. Craft-level rather than strategic, which sets the ceiling.

**Target skill:** `marketing-ai-voiceover-production` (edit)

**Merged from:** part 6 of 9

### Run a faceless format — your voice or an AI voice plus generated/stock visuals carrying the story, with nobody on camera — as a second production line that does not require you to be the on-camera personality. — 6/10

**Why it works:** Removing the on-camera requirement removes the slowest, most reluctance-prone step in a solo content program, so output volume is limited only by scripting and editing; viewers reward value delivered, not the presence of a face.

**Evidence:** Creator points to multiple established faceless YouTube channels (Wendover Productions named) and produces a working Pompeii example; argues value to the viewer is what matters regardless of AI involvement.

**Fit:** Organic short-form is a live surface he runs himself and the content program is built on raw output volume — a faceless narrated format (ingredient education, why-aluminium-free, routine explainers) adds a production line that does not require him on camera for every post. Not higher because the founder-on-camera persona is itself an asset here, so this is additive rather than a replacement.

**Target skill:** `marketing-organic-content-program` (edit)

**Merged from:** part 6 of 9

### Pick a faceless/narrated topic by whether it tells an interesting story or answers an interesting question — and prefer topics that do both at once. — 6/10

**Why it works:** A question gives the viewer a reason to click and a loop to close; the story gives them a reason to stay through the middle. A topic with only one of the two either fails to earn the click or fails to hold.

**Evidence:** Creator names Wendover Productions as the model ('Why Trains Suck in America' both answers a question and tells the story of American development) and applies the test to his own Pompeii choice.

**Fit:** A usable screen on top of the fleet's five topic buckets for the narrated format specifically — 'why does deodorant stop working after a few weeks' answers a question and can carry the story of the switch. Runnable today by one person; a topic-selection heuristic rather than a revenue lever, which is where the ceiling comes from.

**Target skill:** `marketing-organic-content-program` (edit)

**Merged from:** part 6 of 9

### Use the LLM for concept breadth and for critique, but write the script yourself: brief it with your rough idea and the video's job, harvest and pick from the variations it returns, write your own version, then paste that draft back and ask it for feedback that tightens it. — 6/10

**Why it works:** A model asked to write the whole script produces generic output, but it is good at generating more options than one person thinks of and at spotting slack in a draft. Splitting the labour — model ideates and critiques, human drafts — keeps the voice while borrowing the breadth.

**Evidence:** The creator shows his actual prompt and states he 'did not have ChatGPT write this out word for word' — he picked and chose ideas, wrote it himself, then got feedback that improved it.

**Fit:** He writes every script himself and already uses LLMs in the creative loop. A specific division of labour for scripting a Reel or a video ad that is adjacent to — but not the same as — the existing 'take each draft to 80–90%, hand-edit, feed it back' engine claim, which is about converging on your voice rather than about who drafts first.

**Target skill:** `marketing-ai-video-ad-production` (edit)

**Merged from:** part 4 of 9

### Build a clone of your own voice in the voice tool and paste scripts into it, instead of recording narration takes or casting a stock synthetic voice. — 6/10

**Why it works:** A cloned founder voice keeps the brand's narration identical across every video while removing the record-and-retake step, so script changes cost a paste rather than a new session, and the consistency itself is a sales asset.

**Evidence:** Creator notes ElevenLabs lets you 'create your own voice clone and then paste your script into the tool' and shows two saved clones of his own voice in the tool; the how-to is deferred to a later lesson, so the mechanism is asserted rather than demonstrated.

**Fit:** The content is founder-voiced and the operator writes, films and narrates everything himself; a clone of his own voice holds the one-persona-across-every-surface consistency the copy skills already demand while letting him ship narration for a batch in one sitting. Distinct from the recorded claim about casting a stock synthetic voice from a library.

**Target skill:** `marketing-ai-voiceover-production` (edit)

**Merged from:** part 3 of 9; part 6 of 9

### Set the synthetic voice's stability/expressiveness parameter deliberately low (roughly 0.1–0.4) rather than accepting the default, because low stability gives energy fluctuation and high stability gives monotone consistency. — 6/10

**Why it works:** The parameter trades consistency against emotional range; narration that fluctuates in energy holds attention, so for marketing reads you want the expressive end and accept slight inconsistency.

**Evidence:** Creator's own working range stated from personal experience, with the two ends of the slider described; assertion only beyond that.

**Fit:** Directly actionable on the voiceover he already needs for narrated short-form, and the fleet's voiceover skill covers casting and bracketed director cues but not this parameter. Platform-mechanics class and current (2026), worth recording with the caveat that the slider name may change.

**Target skill:** `marketing-ai-voiceover-production` (edit)

**Merged from:** part 6 of 9

### Run image generation and video generation in two separate browser tabs side by side so you can queue a generation in one while working in the other. — 6/10

**Why it works:** Generations take real wall-clock time; a single-tab workflow serialises the waiting. Two tabs let the operator overlap queue time with prompt-writing and selection work, raising assets produced per hour.

**Evidence:** Offered as a 'pro user tip' from the creator's own workflow; no measurement.

**Fit:** A solo operator doing every role is throughput-bound on production time, and frame-then-animate is already how creative gets built here. A small but real multiplier on how many ad statics and B-roll clips get produced in a session, runnable today with no spend.

**Target skill:** `marketing-ai-broll-generation` (edit)

**Merged from:** part 4 of 9

### When no reference image anchors the look, the prompt must also state visual style (photoreal, CG animation, comic, a named animation house), environment/setting, shot composition and framing, and should state lighting direction and intensity, the colour of the light, the time of day, atmospheric effects (fog, rain, dust, embers) and the colour palette — optionally by naming a film whose look you want. — 6/10

**Why it works:** Everything a reference image silently supplies has to be stated in words once the image is gone. Each unstated field is a field the model fills at random, so two generations of the same scene come back visually unrelated and you cannot adjust incrementally.

**Evidence:** Presented as the creator's own worksheet of required versus bonus prompt elements, with on-screen examples for each field; no comparative tests.

**Fit:** The fleet already generates ad and listing imagery from a fixed scene-prompt template; this enriches that template with the look-defining fields it does not yet name — visual style, light colour, time of day, atmospherics and palette — which is how a batch of product frames stays consistent across a campaign instead of drifting. Runnable today at pay-per-generation cost.

**Target skill:** `marketing-ai-broll-generation` (edit)

**Merged from:** part 4 of 9

### Extend a sequence by uploading the finished clip and prompting for the next shot in it, naming the shot type and the action ('based on the uploaded video, create the next shot in this sequence, a tracking shot of the subject from the side as he runs through the forest'), rather than generating the follow-up shot from scratch. — 6/10

**Why it works:** The uploaded clip carries the character, wardrobe, lighting and environment, so the model inherits continuity from the video itself instead of from a written spec you have to re-supply — and naming the camera move means the new shot is a genuine cut rather than a repeat of the same framing.

**Evidence:** Demonstrated once: the dinosaur-in-burning-forest clip extended into a side tracking shot with a consistent character; creator self-grades it '9 out of 10'. Single example, no comparison against generating cold.

**Fit:** Useful for building a multi-cut AI video ad without re-specifying the character every time, and it complements the existing frame-chaining claim with a different mechanism (whole-clip continuation vs last-frame-to-first-frame). Scored at 6 because this brand's video need is mostly short demonstration and talking-head work where multi-shot narrative sequences are a smaller part of the output.

**Target skill:** `marketing-ai-video-clip-editing` (create)

**Merged from:** part 9 of 9

### Build the new background on a single exported still in sequence: first generative-fill 'remove' every distracting element to get a clean plate, then expand the frame's edges while it is still simple, and only then add detail elements one at a time by selection rather than prompting the whole background at once. — 6/10

**Why it works:** Removing clutter first gives the model an uncluttered canvas to reason about; expanding an empty background is a narrow, low-risk task the model does reliably whereas expanding after detail is added forces it to extrapolate complex geometry; and adding one named element per selection keeps control of composition instead of accepting whatever a single whole-scene prompt invents, with each result independently fixable.

**Evidence:** Walkthrough: lasso + 'remove' on two wall areas, then expand demonstrated in both Firefly and Photoshop ('that's going to make it easier on the AI'), then separate prompts for a bookshelf, a floating shelf with a green plant, a black modern clock, a camera and a large potted plant — with the explicit comparison that you could prompt 'make the background look like a coffee shop' but 'I just like having more control adding individual elements at a time'. Caveat noted that an expanded still then has to be scaled down to fit the original video frame.

**Fit:** A concrete, runnable sequencing rule for a surface he already produces, and the video analogue of the imagery discipline of correcting one defect per prompt and deriving a set from one locked good frame. It is also the production answer to needing the same footage in 9:16 for Reels and 1:1 or 16:9 elsewhere, which the placement-driven aspect-ratio rule already demands. Mid-high because the payoff is production quality rather than a change to what the copy claims.

**Target skill:** `marketing-ai-footage-background-replacement` (create)

**Merged from:** part 8 of 9; part 8 of 9; part 9 of 9

### Hand-blur every AI-added background element to match the depth of field of the real footage, because the model cannot infer how far behind you the background sits and renders added objects too sharp. — 6/10

**Why it works:** A composite reads as fake when focus falloff is inconsistent — a razor-sharp plant next to a blurred light switch exposes the edit — so matching the blur of a real in-frame reference restores physical plausibility.

**Evidence:** Demonstrated: the generated plant, clock and shelf came back sharp while the real light switch behind him was blurry; he merged the layers and brushed blur over each added object, 'all of a sudden that just looks way more realistic'. He also notes the tool got the blur right on one shelf because a real plant was in frame as a distance reference.

**Fit:** Directly runnable by one person in any editor, and it is the video-side version of the existing realism discipline — audit the render against physical reality and fix the named defect — applied to focus rather than proportions. It decides whether the composite is shippable at all.

**Target skill:** `marketing-ai-footage-background-replacement` (create)

**Merged from:** part 8 of 9

### Composite the finished still background over the video by scale-matching first — drop the background layer's opacity so you can see the video underneath, scale until the two line up exactly, restore opacity — then draw a rough pen-tool mask around yourself, invert it so the mask becomes a hole, and feather the edge only if a hard seam is visible. — 6/10

**Why it works:** An outpainted background is a different resolution and framing from the source clip, so masking before aligning produces a hole that does not register with the plate behind it; semi-transparency turns alignment into something you can see and nudge instead of guess at. The subject is the only part of the frame that moves meaningfully in a locked-off talking-head shot, so a single static hole lets the live video show through while the still carries the entire environment — no rotoscoping, no greenscreen, works in any free or paid editor.

**Evidence:** Step-by-step demos in Premiere, including toggling layers to show the hole working and a deliberate colour-shift test to show when feathering is needed; creator notes the result is 'very hard to tell that there's any AI in this image' apart from one artefact.

**Fit:** The step that makes the whole background workflow usable, and the creator explicitly notes any editor will do — so it runs today on the tools already used to cut Reels. Honest translation: replace a cluttered home background behind himself in a demo or founder-story video without renting a set. Craft-level rather than strategy-level, and note the existing 'believable over beautiful' guardrail — a polished composite can work against the native phone-shot register that performs in this category.

**Target skill:** `marketing-ai-footage-background-replacement` (create)

**Merged from:** part 8 of 9; part 9 of 9

### On a background-replacement generation, set video quality to maximum, and when a clip is long or heavy, export it at a slightly lower resolution or cut it into smaller chunks and run each separately to avoid failed generations. — 6/10

**Why it works:** The tool degrades on long clips and large file sizes, so reducing per-generation payload raises the hit rate and stops you burning credits on failures.

**Evidence:** Assertion from repeated use ('it does struggle with longer clips in really big file sizes… your odds of getting a failed generation will be much lower').

**Fit:** Platform-mechanics class so it will decay, but the source is 2026 and the tool is current, and the underlying rule (shorten the payload when a model fails) transfers across models. Runnable today by one person paying per generation, and it protects a real cost line rather than requiring volume.

**Target skill:** `marketing-ai-footage-background-replacement` (create)

**Merged from:** part 8 of 9

### When a whole-frame generative expand keeps failing, stop asking for the whole frame — marquee-select one region at a time and expand it with its own instruction ('expand the desk to take up the whole frame', then separately the ceiling). — 6/10

**Why it works:** Each region has a different, simpler description; asking the model to solve all of them in one pass multiplies the ways it can go wrong, while a region-scoped request gives it one unambiguous job and a smaller area to be plausible in.

**Evidence:** Demonstrated after three whole-frame variations and an unprompted regeneration all came back unusable; the region-by-region results were judged better than the best whole-frame attempt.

**Fit:** Runnable today and applies beyond reframing to any product-image repair. Related to the existing 'correct exactly one defect per prompt' claim but distinct — that is about fixing defects, this is about decomposing a generation task spatially before it fails.

**Target skill:** `marketing-vertical-video-reframing` (create)

**Merged from:** part 7 of 9

### Give the expand a short directive prompt that names both what to add and what must not appear ('expand the frame with more desk at the bottom and expand the ceiling — there are no lights on the ceiling'), and clean up leftover artifacts by marquee-selecting them and generative-filling with the single word 'remove' rather than using the built-in remove button. — 6/10

**Why it works:** Left unprompted, the model invents plausible-but-wrong set dressing (ceiling lights that are not in the room); an explicit exclusion suppresses its default. For cleanup, the generative model reconstructs surrounding texture better than a content-aware patch tool.

**Evidence:** Demonstrated — the unprompted generation came back worse, and the 'remove' generative fill cleanly erased a seam line and three invented ceiling lights.

**Fit:** Runnable today and transfers straight to AI product imagery, where invented detail is already a known failure mode. Narrower than the existing anti-fabrication and named-defect-correction claims, which it sits alongside rather than restates.

**Target skill:** `marketing-vertical-video-reframing` (create)

**Merged from:** part 7 of 9

### Animate a logo or graphic with no VFX skill by using a blank white frame as the first frame and the finished logo as the last frame, prompting the manner of the reveal (e.g. 'the letters appear one at a time'). — 5/10

**Why it works:** The blank-to-finished pair makes the whole clip a reveal of the known end state, so the model only has to invent the manner of appearance. You get a branded animated bumper from a static logo file without learning a motion-graphics program.

**Evidence:** Demonstrated on the creator's own ContentCreator.com logo; he reports both Kling and Veo do it acceptably, Kling slightly better.

**Fit:** Real mechanism, runnable today from an existing logo file, and a consistent end-card bumper supports the fixed brand visual identity the image-stack skill already asks for. Scored mid because a logo sting is polish rather than something that moves conversion rate, which is the named binding constraint.

**Target skill:** `marketing-ai-broll-generation` (edit)

**Merged from:** part 5 of 9

### When exporting the AI-edited still out of the image editor, uncheck 'embed colour profile', because the profile shifts colours just enough that the still looks unnatural when recombined with the original video. — 5/10

**Why it works:** A colour-managed export and the video timeline interpret colour differently, so a subtle cast appears exactly along the mask edge and gives the composite away.

**Evidence:** Assertion from his own experience on Mac ('if your colours do look odd when you do this, make sure you uncheck this box').

**Fit:** A narrow but real defect-prevention step for a workflow runnable today — the difference between a composite that reads as real and one that does not. Scored modestly because it is a single export checkbox with no reach beyond this workflow, and it is platform-mechanics class so a tool update may obsolete it.

**Target skill:** `marketing-ai-footage-background-replacement` (create)

**Merged from:** part 8 of 9

## Rejected

### Upload two or more images and reference them explicitly by position ('the perfume bottle from image one placed in the beach environment from image two'), specifying camera angle, who holds what and which plane is in focus, to composite your real product into a chosen scene or into a person's hand. — 8/10

**Rejected because:** Duplicate — the multi-reference compositing mechanic with explicit per-image addressing is already recorded in marketing-ai-product-imagery.

**Fit reasoning:** Highly relevant — this is exactly how a real deodorant pack gets into a generated lifestyle scene — but the mechanic is already recorded verbatim in the skill that owns it.

### Build AI video by generating stills first in a cheap image model, iterating them to taste, then animating the approved frame with a short prompt — then arrange and trim the clips on a timeline against the voiceover — rather than prompting a video generator from text. — 7/10

**Rejected because:** Duplicate — marketing-ai-broll-generation already holds 'Split the tools by job: the image model makes the frames and the video model only animates them — clip quality is decided almost entirely by the start frame you feed it', and marketing-short-form-video-production already holds the timeline-assembly-against-narration claim.

**Fit reasoning:** Correct and relevant, but this is already the recorded spine of the AI video pipeline in the fleet.

### Reverse-engineer a prompt from an output you admire — upload the image, title or script, ask the model to analyze what makes it work and write a detailed prompt that would produce something similar, then modify that prompt. — 6/10

**Rejected because:** Already recorded twice: marketing-ai-product-imagery holds 'find a strong reference image, reverse-engineer that reference into a generation prompt, then mix that prompt with your own visual idea', and marketing-copy-hook-generation holds 'paste in a swipe file of hooks that actually grabbed YOUR attention and instruct it to rewrite your hooks in those styles.'

**Fit reasoning:** Genuinely relevant but already recorded twice in the fleet, covering both the image case and the headline case.

### Access the image, video, voice and music models through pay-per-generation or free-tier credits on a single marketplace rather than subscribing to each tool directly, since the same model gives identical output on any platform (~60 credits per generation, 1,000 credits for $10). — 6/10

**Rejected because:** Duplicate — marketing-ai-product-imagery already holds 'Prefer pay-per-generation access to AI image and video models over stacking several monthly subscriptions, so a month with little output costs little.' Every variant here is that claim with a different vendor named in front of it.

**Fit reasoning:** Sensible cash discipline for a solo operator, but the purchasing principle is already held and the specific tool names are fast-decaying platform mechanics. The creator also has a stated commercial interest in the named marketplace.

### Default the generation count above one — two or three variations of every prompt — so you always have alternatives to compare rather than shipping the first result, and re-run the identical prompt for another batch if none land. — 6/10

**Rejected because:** Duplicate — marketing-ai-video-ad-production already holds 'Treat AI generation as shooting coverage on a film set... re-run the identical prompt to get a different take, keep the best individual shot out of each generation' and 'generate both and compare them side by side'; marketing-ai-product-imagery holds 'expect to discard more generations than you keep'.

**Fit reasoning:** Reasonable operating habit but the recorded workflow already runs on exactly this logic in two places.

### Never prompt broadly — add context to every prompt (industry, style, colors, name, use case, framing and explicit exclusions), and when a generation comes back wrong assume the prompt was at fault and rewrite it more specifically. — 5/10

**Rejected because:** Duplicate — marketing-ai-broll-generation already requires every scene prompt be written from a fixed template 'because a vague scene prompt regenerates a radically different scene every run' and already records named-exclusion instructions; marketing-ai-product-imagery holds the sharper version explaining why vagueness is costly. The remainder ('a bad result is your fault') is framing with no additional mechanism.

**Fit reasoning:** The framing principle of the lessons rather than a tactic; the specific-prompting rule and the named-exclusion instruction are both already recorded in the skills that own generation prompts.

### Change a character's wardrobe by uploading a reference photo of the clothing and prompting the model to match the outfit from image two onto the person in image one. — 5/10

**Rejected because:** Duplicate — the recurring-character workflow already recorded in marketing-ai-broll-generation includes the wardrobe-reference step.

**Fit reasoning:** Only matters once a recurring generated character exists, and that workflow is already specified in the fleet including its wardrobe step.

### Expect the model to miss on the first try and plan for a round or two of revision prompts. — 5/10

**Rejected because:** Duplicate of recorded iteration guidance in marketing-ai-product-imagery, which states it in a more operationally useful form (discard more than you keep; correct one named defect per prompt).

**Fit reasoning:** True but generic, and already covered in more operationally useful form.

### Do not use one-click 'make me a video' AI tools — generate each shot individually and run a hybrid human+AI workflow through the five fixed steps (idea, script, storyboard, video creation, edit), assembling in a basic editor. — 5/10

**Rejected because:** Duplicate — marketing-ai-video-ad-production already holds 'Build an AI video ad in five fixed stages in order — script outline, character generation, storyboard, video generation, edit', and marketing-short-form-video-production holds the claim to edit in a basic editor rather than relying on one-shot AI editing tools.

**Fit reasoning:** Correct and relevant, but the staged-workflow rule is already on the books twice.

### Because the start image already supplies everything visual, an image-to-video prompt only needs three things: the subject's action, the camera movement, and the emotional mood or tone. — 5/10

**Rejected because:** Duplicate — marketing-ai-video-ad-production already holds 'Write every image-to-video prompt by answering four fixed questions — what is the person saying and in what tone, what is the camera doing, what is the action in the shot, what is the context around it', and the broll scene template already ends on mood and emotional direction. Three slots versus four is a rewording.

**Fit reasoning:** Sound and directly relevant to how video gets built here, but it is a reworded version of a recorded claim.

### Derive a new camera angle or insert shot from an approved frame by prompting the angle change on that image, then animate the new frame — so the set, lighting, wardrobe and time of day stay identical and the angles belong to the same scene. — 5/10

**Rejected because:** Duplicate — marketing-ai-broll-generation already holds 'Shoot each beat as coverage at two shot sizes rather than one frame: generate the wide establishing shot... then derive the matched close-ups from that approved frame with named instructions.' Only the reveal order is new, and that is adopted separately.

**Fit reasoning:** Directly useful for AI b-roll but already recorded verbatim in substance.

### Hold a recurring character consistent across shots by building one character template image first (have the LLM write the detailed character prompt, generate that single image) and uploading it as the reference on every subsequent generation — 'use the character from image one, create a new image showing him in [new outfit / environment / emotional state]'. — 5/10

**Rejected because:** Duplicate — marketing-ai-broll-generation already holds 'Build every recurring character from a filled-in structured spec... then paste that same block into every generation prompt', 'Do the production in a fixed order — characters first, environments second, product last', and 'carry the same reference image and the same written character spec into every thread'. Having the LLM write the spec is a rewording.

**Fit reasoning:** Relevant to any recurring-character ad series, but it is the mechanism of claims already recorded.

### Use first-frame/last-frame generation — supply a start image and an end image plus a prompt describing only what happens in between — so you control where the clip ends, not just where it starts. — 5/10

**Rejected because:** Duplicate — marketing-ai-broll-generation already holds 'Create a transformation shot by generating it as a first-frame/last-frame pair — supply the start image and the end image, describe only what happens in between, and state the transition duration.'

**Fit reasoning:** Core technique for this pipeline, but the base claim is already recorded.

### Use AI-generated B-roll to cover a talking-head or interview video when you only had time or access to capture the person speaking and could not shoot the supporting footage. — 5/10

**Rejected because:** Duplicate — this is the founding premise of marketing-ai-broll-generation; the sharper production allocation version (shoot what you can, generate only the gap list) is adopted separately.

**Fit reasoning:** Exactly this operator's situation, which is why it is already an entire skill in the fleet.

### Write scripts with AI as a back-and-forth: draft a rough outline yourself, hand it to the model to expand into a full script, then review and hand-edit it — having first trained the model on your personal writing style. — 5/10

**Rejected because:** Duplicate — the recorded copy-engine claims already cover training the model on your voice and taking each draft to 80–90% then hand-editing and feeding it back.

**Fit reasoning:** This is how the operator should work, and it is already recorded in two forms.

### Generate the voiceover by typing the script into a synthetic-voice tool, choosing a voice and hitting generate, then assemble the clips on a timeline in whatever basic editor you have — advanced editing software is not required. — 5/10

**Rejected because:** Duplicate — marketing-ai-voiceover-production holds 'Cast the voiceover deliberately from a synthetic-voice library — filter by language, accent and age, audition candidates', and marketing-short-form-video-production instructs editing in a basic editor with the clip-order and trim claims beside it.

**Fit reasoning:** True and already held in two places.

### Copy each line of the script into the LLM, say what you want to see for it, and have the LLM write the image prompt for that beat — then generate the frame with the character template attached, repeating until every line has an image. — 5/10

**Rejected because:** Duplicate — marketing-ai-broll-generation holds 'mark its visual beats (usually eight to ten in a 40-second piece), and write a one-line scene for each in the same SCENE / SUBJECT / EMOTIONAL READ format', and marketing-ai-product-imagery holds 'have the LLM turn the already-approved story into several numbered image-generation concepts'.

**Fit reasoning:** Correct method, already recorded in two skills.

### Prompt the background swap in short plain language that names the location, the window view and the time-of-day lighting, leaving all other settings at default. — 4/10

**Rejected because:** Duplicate — marketing-ai-product-imagery already holds both the short-plain-language prompt claim and the fixed scene-prompt template that orders framing, subject, lighting and tone.

**Fit reasoning:** Sound but already covered twice in the imagery skill; re-recording it would degrade skill triggering rather than add capability.

### Reimagine an uploaded photo of real people in any decade or era ('place them in a classic 1920s photo shoot style scene') to produce period-styled versions of the same image. — 4/10

**Rejected because:** No stated marketing mechanism — offered as novelty. Any honest version for this catalogue is just a scoped style change, which the adopted lock-the-subject-and-swap-the-environment tactic already covers at full strength.

**Fit reasoning:** Presented as fun, with no mechanism beyond novelty; the stated applications (time-travelling AI characters, modernising photos of grandparents) have no path to a deodorant or toothpaste order.

### Use Veo 3.1 or Kling 2.5 for first-frame/last-frame work — Veo has slightly better overall realism — and re-check the current best tool rather than committing to one. — 4/10

**Rejected because:** Fast-decay platform mechanics with no durable mechanism; the portable half (route a shot to whichever model handles it, prefer pay-per-generation access) is already recorded in marketing-ai-broll-generation and marketing-ai-product-imagery, and the transition-difficulty routing rule is adopted separately.

**Fit reasoning:** A specific model-version ranking is the fastest-decaying class of platform mechanics and carries no durable mechanism.

### Leave the video model's built-in sound and sound-effects generation switched on, because it usually does a decent job and saves a separate audio step. — 3/10

**Rejected because:** Contradicts recorded claims rather than adding anything: marketing-ai-video-ad-production holds 'explicitly instruct no music, no sound effects' and marketing-ai-voiceover-production holds 'Delete the video model's own audio from every generated clip and lay your separately cast voice under it instead.'

**Fit reasoning:** A settings preference with no stated benefit mechanism, and it conflicts with recorded practice the fleet relies on.

### Use an AI voiceover instead of hiring an actor and setting up microphones, because it costs pennies and raises the perceived professional quality of the video. — 3/10

**Rejected because:** Duplicate — marketing-ai-voiceover-production already holds 'Cast the voiceover deliberately from a synthetic-voice library — filter by language, accent and age, audition candidates' and the claim to lay it under generated clips.

**Fit reasoning:** Already recorded; the distinct additions in the same excerpt (stability parameter, voice clone, footage-reuse economics) are captured as their own tactics.

### Great faceless content still rests on three pillars — the video idea, the video quality, and the packaging (title and thumbnail, or the hook on social) — and AI can help with all three. — 3/10

**Rejected because:** Duplicate — marketing-organic-content-program already holds 'Build every piece of content from the same three-part unit: hook attention, retain attention, reward attention' and 'Judge content by value per second'; the packaging pillar is the entire marketing-copy-hook-construction skill.

**Fit reasoning:** A restatement of recorded frameworks rather than a new play.

### Edit in DaVinci Resolve because the free version is powerful and the pro version is a one-time fee rather than the recurring subscriptions CapCut and Adobe charge. — 3/10

**Rejected because:** Near-duplicate of the recorded marketing-short-form-video-production claim to edit 'in a basic editor (Reels native or CapCut)'; no marketing decision changes.

**Fit reasoning:** Swaps a tool name without changing any marketing decision, and tool pricing is fast-decaying platform mechanics.

### Upload a photo of a dated room or an unfinished yard and prompt the model to redesign it while keeping the layout, to plan a renovation or landscaping project without hiring a designer. — 2/10

**Rejected because:** Out of scope — the entire output is a contractor brief for a building, not a marketing asset. Not a volume, budget or headcount gate.

**Fit reasoning:** Interior design and physical-premises work with no honest translation to an ecommerce catalogue at any size.

### Use the generation history's 'reuse' button to reload a past generation's start frame and prompt rather than re-entering the details when you want a small change. — 2/10

**Rejected because:** Not a marketing tactic — it changes no message, offer, surface or spend decision, and it is the fastest-decaying class of platform mechanics (a button in one vendor's 2026 UI).

**Fit reasoning:** A tool-UI convenience inside one vendor's interface, not a marketing tactic.

### Finish the video by downloading a title template from a template library and swapping in your own video title. — 2/10

**Rejected because:** Near-empty claim — 'use a template to save time', with nothing about what the title should do or say; adopting it would dilute the skill set.

**Fit reasoning:** No real marketing mechanism and tied to one tool's proprietary library.

### Do not hand the whole creative process to AI — faceless content made with zero human creativity, taste or editing produces slop nobody wants to watch; use AI to enhance your ability to make valuable content instead. — 2/10

**Rejected because:** Not executable — no decision, threshold or artifact. The specific editorial moves that embody it (music placement, pause trimming, crossfades, cutting on the beat) are extracted as their own tactics.

**Fit reasoning:** Exhortation with no stated mechanism or test — it names no decision, threshold or artifact.

### Chain first-frame/last-frame clips into a finished sequence by making each clip's last frame the next clip's first frame, then laying the clips end to end on a timeline in any free editor so the sequence plays seamlessly. — 0/10

**Rejected because:** Duplicate — marketing-ai-broll-generation already holds 'Chain the frames — the last frame of clip one becomes the start frame of clip two — so continuity comes free and you halve the number of generations', and marketing-short-form-video-production already holds the basic-editor assembly claim.

**Fit reasoning:** Exact duplicate of a recorded claim; re-adding it would degrade skill triggering.

### Delete the video model's own generated audio from every clip and lay your separately generated professional voiceover underneath instead. — 0/10

**Rejected because:** Duplicate — marketing-ai-voiceover-production already holds 'Delete the video model's own audio from every generated clip and lay your separately cast voice under it instead... keep the narration track on the top layer.'

**Fit reasoning:** Exact duplicate of a recorded claim including its mechanism.

### Trim each clip so the cut lands where the narration line ends and the next clip starts exactly where the next line begins. — 0/10

**Rejected because:** Duplicate — marketing-short-form-video-production already holds 'Assemble the edit against the storyboard one line at a time — drop that audio onto the timeline first, then find its clip and time the clip to the words' and 'Time a cut so the visual beat lands on the specific word in the narration that it illustrates.'

**Fit reasoning:** Duplicate of two recorded editing claims.

### Put a visually shocking impossible element into the ad — adding a Tyrannosaurus to a scene, then setting it on fire — specifically to shock the viewer with what AI can do. — 0/10

**Rejected because:** Duplicate — marketing-paid-creative-testing already holds the deliberate-abstraction position ('either uber-clear... or deliberately surreal and abstract purely to stop the scroll while staying relevant'), including the relevance condition this version drops.

**Fit reasoning:** Duplicate of a recorded claim and otherwise unanchored; shock for its own sake has no stated route to a purchase for a natural deodorant catalogue.

## Skills touched

- `marketing-ai-prompt-craft` (create)
- `marketing-ai-product-imagery` (edit)
- `marketing-ai-broll-generation` (edit)
- `marketing-ai-video-ad-production` (edit)
- `marketing-short-form-video-production` (edit)
- `marketing-video-sound-design` (create)
- `marketing-ai-voiceover-production` (edit)
- `marketing-copy-body-structure` (edit)
- `marketing-organic-content-program` (edit)
- `marketing-ai-video-clip-editing` (create)
- `marketing-ai-footage-background-replacement` (create)
- `marketing-vertical-video-reframing` (create)
