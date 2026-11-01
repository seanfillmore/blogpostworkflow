---
name: marketing-ai-video-ad-production
description: End-to-end production of scripted AI video ads: a reusable director skill that turns the script into a persistent per-cut shot list used as the single source of truth for all generations, plus a global style prefix for cross-shot consistency, standalone non-referential prompt rules, behaviour-based acting direction, geo-spatial blocking, shot-length and storyboard-depth defaults, coverage harvesting, spend tapering and credit-repair moves.
---

# Ai Video Ad Production

## Install a reusable 'director' skill in the LLM and have it convert the full script into a per-cut shot list specifying camera angle, focal length, action, blocking and camera movement — then keep that shot list as a persistent file with a completion checkbox per scene, and work from the file as the single source of truth for every generation.

**Why it works:** The shot list is the brain of the video: it moves you out of asset creation and into the director's seat, so each generation prompt is derived from one coherent plan rather than invented ad hoc. Because the instructions live in a reusable skill, the same directing standard is applied to every project without re-briefing. A multi-shot piece is generated over many sessions, so progress has to live outside the chat: make the shot list a file artifact with a done/not-done state per scene that survives reloads, and when you want a change, have the model rewrite that same file with the edits applied and the scene numbering preserved rather than describing the change in conversation. Re-rendering the one file on every revision stops the shot list and the actual generations from drifting apart, and stable numbering means tracked progress is not lost when the file is rewritten.

**Evidence offered:** Walkthrough of installing and invoking the custom Director skill, showing the shot list it produced with camera angle, actions and movement per cut; downloadable skill offered. The persistence requirement is assertion only — specified as a hard requirement of the skill, with the localStorage keying scheme given.

**Fit here (7/10):** A solo operator who is also his own director benefits most from an externalised directing standard, and the shot list is what makes a multi-cut ad tractable for one person. Runnable today — an LLM skill, a script and a video model, no second person and no spend floor. The file-artifact-with-checkboxes half scores lower on its own (5/10): he is the only person tracking which of a dozen shots are done across sessions, but a six-shot ad is small enough that a plain doc mostly suffices.

*Source: Anthony Gallo (ContentCreator.com) — "AI Creator Course: AI ad creation lessons" (transcript, part 2 of 6)*

*Source: PromptEdit (shared in ContentCreator.com AI Creator Course) — "PromptEdit Shotlist Director (Claude skill for Seedance 2.0 shotlists)" (prompt document)*

## Write a single global 'Style Prefix' block — photorealism level, lighting doctrine, colour ratio, lens and shutter, skin detail, acting register, physics, continuity, frame rate, audio rules — and prepend it verbatim to every single shot prompt in the project, then reinforce it per shot with the specific lighting geometry of that frame.

**Why it works:** A video model has no project-level memory, so the only way a sequence of separately generated clips shares one look is if the same look instruction is physically present in each prompt. Keeping it as one locked block means every prompt is copy-paste-ready standalone with no reassembly. The per-shot reinforcement — where the window is, what the haze is doing, which colour dominates — tells the model where to actually place the rim light rather than leaving it to chance.

**Evidence offered:** Assertion only — presented as the skill's law, with a full default prefix supplied.

**Fit here (7/10):** He produces his own short-form video and AI-assisted ads solo, and the rest of this skill already covers writing scene prompts from a fixed template; this adds the missing cross-shot consistency mechanism, which is exactly the failure mode when a 30-second deodorant ad is assembled from six separately generated clips. Current-era platform mechanics, so no age discount.

*Source: PromptEdit (shared in ContentCreator.com AI Creator Course) — "PromptEdit Shotlist Director (Claude skill for Seedance 2.0 shotlists)" (prompt document)*

## Never write referential language in any field of a generation prompt — 'same as last shot', 'still at the train station', 'as established earlier', 'continues from the previous prompt' — and instead restate the location, setting, time of day and every character's physical state in full, explicit language in every prompt, even when it repeats the previous prompt word for word.

**Why it works:** Each generation is rendered in complete isolation with no memory of the script or of other prompts, so a phrase that only makes sense to someone who read a different prompt cannot be resolved and will be rendered wrong or silently ignored. The test is simple: if a phrase depends on another prompt for its meaning, it is broken. Repetition across 1a / 1b / 1c is mandatory, not wasteful.

**Evidence offered:** Assertion only, but with an explicit forbidden-phrase list, a stated test, and two worked examples.

**Fit here (8/10):** This is the single most common reason a multi-clip AI ad falls apart mid-sequence, and he assembles ads from multiple generations himself today. It generalises beyond video to any isolated-generation prompt, including the image frames used for listing and ad statics. Runnable at $30/day with no extra tooling.

*Source: PromptEdit (shared in ContentCreator.com AI Creator Course) — "PromptEdit Shotlist Director (Claude skill for Seedance 2.0 shotlists)" (prompt document)*

## Write acting direction as observable physical behaviour rather than emotion labels — not 'she looks sad' but 'her eyes drop to the table, jaw tightens, she swallows once before answering' — express carried-over emotion as how it looks right now, and default to restraint.

**Why it works:** A model can render a described physical action but has to guess at an emotion label, so naming the behaviour is the only way to control the performance. Not 'he's angry' but 'knuckles whiten on the glass, breath shortens, eyes never leave hers'. Expressing emotional state as present-tense visible fact — 'her hands haven't stopped shaking' — also keeps the prompt standalone instead of referring back to an earlier beat. Restraint reads as real: a whispered line outperforms a screamed one in most cases, and big emotion belongs only where the moment has earned it.

**Evidence offered:** Assertion with six before/after rewrite pairs.

**Fit here (8/10):** Directly usable twice over: in his AI video prompts and in directing his own on-camera delivery, where 'look relieved' is unfilmable and 'exhale, shoulders drop, half-smile' is. Durable craft principle, so age is irrelevant, and it needs nothing but a prompt field.

*Source: PromptEdit (shared in ContentCreator.com AI Creator Course) — "PromptEdit Shotlist Director (Claude skill for Seedance 2.0 shotlists)" (prompt document)*

## Block every shot geo-spatially: state where each subject and prop sits relative to the location and to each other in literal terms, rather than 'they sit and talk'.

**Why it works:** Explicit spatial relations — 'she sits across from him at the diner booth, knees touching under the table', 'the space between them is roughly twelve feet', 'he stops in the doorway six feet behind her' — are what let the model render a coherent, consistent space. Without them it reinvents the geometry of the room on every generation and the cuts stop matching.

**Evidence offered:** Assertion plus the worked example, which states distances and positions in every Scene block.

**Fit here (7/10):** Applies the moment he generates more than one shot of the same scene — e.g. a bathroom-counter sequence where the deodorant stick has to stay in the same place across cuts. Runnable today, costs nothing but prompt words.

*Source: PromptEdit (shared in ContentCreator.com AI Creator Course) — "PromptEdit Shotlist Director (Claude skill for Seedance 2.0 shotlists)" (prompt document)*

## Give every asset a simple descriptive filename in one Assets folder, register each one with the LLM as an @-name plus a one-line description, and have the shot list call assets by that @-name so each reference maps one-to-one onto the video tool's media picker.

**Why it works:** A shared naming convention across the LLM and the video tool turns prompt assembly into mechanical substitution — you highlight @jack_beach in the generated prompt and pick the matching element — instead of re-describing the character and hunting for files on every shot. The organisation cost is paid once and saves time on every generation thereafter.

**Evidence offered:** Demonstrated end to end: naming files Jack / Jack_Beach, declaring '@Jack — Jack in NYC' to Claude, uploading identically-named elements under Characters in the video tool.

**Fit here (6/10):** Pure operational hygiene, but it is the difference between a one-person AI video workflow that scales to many ads and one that collapses under its own file naming. Runnable today at zero cost; below the directing and coverage tactics because it is enabling plumbing rather than something that changes what the ad says.

*Source: Anthony Gallo (ContentCreator.com) — "AI Creator Course: AI ad creation lessons" (transcript, part 2 of 6)*

## Feed the director the full script with wardrobe, setting, actions, feelings and reactions specified per scene — not a loose summary — because a generic brief produces generic output.

**Why it works:** The shot list can only be as specific as the story it is derived from; if the model has to invent wardrobe, location and emotional beats it will default to averaged, interchangeable choices, and every downstream generation inherits that vagueness. 'Give Claude generic AI slop and you get generic AI slop.'

**Evidence offered:** Stated explicitly while uploading the script, with the script's level of detail enumerated; assertion only.

**Fit here (6/10):** Translates cleanly to RSC: the wardrobe, bathroom or gym setting and the emotional beat of a deodorant ad are exactly the details that decide whether a generated clip looks like his buyer's actual morning. Sits at 6 rather than higher because it is adjacent to existing claims about not briefing a model cold — the new material is specifically which fields the script must carry before shot-listing.

*Source: Anthony Gallo (ContentCreator.com) — "AI Creator Course: AI ad creation lessons" (transcript, part 2 of 6)*

## Use the LLM for concept breadth and for critique, but write the script yourself: brief it with the rough idea and the video's job, harvest and pick from the variations it returns, write your own version, then paste that draft back and ask for feedback that tightens it.

**Why it works:** A model asked to write the whole script produces generic output, but it is good at generating more options than one person thinks of and at spotting slack in a draft. Splitting the labour — model ideates and critiques, human drafts — keeps the voice while borrowing the breadth, and it is the step that produces the detailed per-scene script the director skill then shot-lists.

**Evidence offered:** The creator shows his actual prompt and states he 'did not have ChatGPT write this out word for word' — he picked and chose ideas, wrote it himself, then got feedback that improved it.

**Fit here (6/10):** He writes every script himself and already uses LLMs in the creative loop. A specific division of labour for scripting a Reel or a video ad that is adjacent to — but not the same as — the existing 'take each draft to 80–90%, hand-edit, feed it back' engine claim, which is about converging on your voice rather than about who drafts first.

*Source: Anthony Gallo (ContentCreator.com) — "AI Creator Course: AI image and video workflow lessons" (transcript, part 4 of 9)*

## When a generated shot is wrong, go back to the director document and issue one named change scoped to that scene ('in scene one, do not punch into a 50mm, keep the whole action in one continuous 35mm shot') rather than hand-rewriting the generation prompt.

**Why it works:** Editing upstream regenerates only the affected prompt while leaving every other scene in the shot list untouched, so the plan stays internally consistent and you never lose the rest of the work; hand-editing the prompt desynchronises the shot list from what you actually generated. Issue the change against the shot-list file and have the model re-render the whole file with the edit applied and the numbering preserved, as in the file discipline above.

**Evidence offered:** Four worked corrections — removing a punch-in, switching to a car-mounted frontal shot, forcing one continuous shot, converting a cut to POV — each followed by a visibly better generation.

**Fit here (6/10):** A direct, repeatable iteration loop the operator can run alone today. It is the video analogue of the already-recorded 'correct a near-miss by naming the specific defect' move for statics, so it earns adoption on the new part — correcting in the upstream shot list so the rest of the sequence is preserved.

*Source: Anthony Gallo (ContentCreator.com) — "AI Creator Course: AI ad creation lessons" (transcript, part 2 of 6)*

## Treat the video model's 5–10 second generation limit as a non-issue: plan the piece as a sequence of short shots and default to 5-second clips — then write enough cuts and acting beats into each prompt to fill that fixed clip length, because an under-written prompt ends in dead air.

**Why it works:** Length in finished video comes from shot count, not clip length, so building to real editorial shot rhythm both fits the tool's limit and spends the fewest credits per finished minute — a 5-second generation costs roughly half a 10-second one. The limit only feels like a constraint if you were planning long unbroken takes that would look slack on a timeline anyway. The other half of the equation is filling the window you bought: the generator produces a clip of fixed duration regardless of how much you described, so design the beats to occupy the whole thing — either one long held shot that carries the moment or a rapid multi-cut sequence, whichever the action calls for. A 12-second moment still gets a full-length prompt, filled out with the breath, the look and the held silence after the line.

**Evidence offered:** Cites a film scholar's analysis of 15,000 movies finding average shot length of 2.5–4 seconds; walks a mountain-climbing sequence to show no shot approaches 10 seconds. The fill-the-window rule is assertion only, with a worked example showing one 15-second prompt built from three cuts.

**Fit here (7/10):** Directly governs how the operator storyboards and budgets any AI-assisted video — 5-second generations at half the credit cost of 10-second ones, planned as a shot sequence, is the difference between affording a batch of social videos and affording one. The chunking rule says how to divide; the fill rule says how to occupy each chunk, which is where the usable-footage ratio actually comes from. Compatible with the multi-cut batching rule below: a single 30-second request carrying six cuts is still a sequence of ~5-second shots, just bought in one transaction.

*Source: Anthony Gallo (ContentCreator.com) — "AI Creator Course: AI image and video workflow lessons" (transcript, part 3 of 9)*

*Source: PromptEdit (shared in ContentCreator.com AI Creator Course) — "PromptEdit Shotlist Director (Claude skill for Seedance 2.0 shotlists)" (prompt document)*

## Allocate shots by dramatic weight rather than by script length: give a heavy line its own prompt, give a reveal a single sustained close-up and refuse to undercut it with extra cuts, split a confession so it has air, compress an action sequence into short cuts.

**Why it works:** Runtime is the only currency you have for emphasis, so spending it in proportion to the words rather than in proportion to the drama flattens the moment the piece exists to deliver. Don't pack the script efficiently — pack it dramatically.

**Evidence offered:** Assertion only.

**Fit here (6/10):** Translates honestly to his 30-second ads: the mechanism claim or the result reveal gets its own held shot while the setup compresses, rather than every line getting equal screen time. Durable craft principle, so age is irrelevant.

*Source: PromptEdit (shared in ContentCreator.com AI Creator Course) — "PromptEdit Shotlist Director (Claude skill for Seedance 2.0 shotlists)" (prompt document)*

## Ask the video model for several cuts inside one long generation rather than generating each shot separately — and write that prompt as explicitly timestamped scenes matched to the voiceover script, splitting long narration into chunks sized to the model's maximum clip length.

**Why it works:** Generation cost is charged per generation (and per duration), not per usable shot, so packing cut 1, cut 2 and cut 3 into one 30-second request multiplies the footage you get for the same credits — and the cuts come back already matched in lighting and character appearance. The model will cut between several scenes inside one generation if the prompt tells it when each scene starts, so stating timestamps against the narration lines returns a correctly paced multi-shot sequence already aligned to the voiceover; a prompt without timestamps returns shots in arbitrary places that then have to be re-timed by hand. Force the LLM writing your prompts to produce multiple timestamped scenes per generation rather than one scene per generation.

**Evidence offered:** Demonstrated on the pool sequence (three cuts in one generation) and the sunset sequence (two scenes combined into one six-cut 30-second generation), described as 'a super effective way to create more footage without burning through your credits'. Separately demonstrated on a narration piece: the first LLM-written prompt omitted timestamps and was unusable; after asking for 'multiple scenes within one 15 second generation matched to the timestamps of the voiceover script', the returned clip cut scene-to-scene almost exactly on the narration lines and only one clip needed re-timing.

**Fit here (7/10):** Cost-efficiency per usable asset is the operative constraint for a solo operator producing video creative himself, and this materially raises the number of shippable shots per dollar of generation credits. He runs his own organic short-form and writes, films, cuts and publishes it himself, so AI-generated B-roll sequences cut against a narration track are a live surface today. Runnable on a single subscription or pay-per-use account; the timestamp instruction is the specific input that makes the batch actually assemble.

*Source: Anthony Gallo (ContentCreator.com) — "AI Creator Course: AI ad creation lessons" (transcript, part 2 of 6)*

*Source: Anthony Gallo (ContentCreator.com) — "AI Creator Course: AI image and video workflow lessons" (transcript, part 6 of 9)*

## Treat AI generation as shooting coverage on a film set, not as hunting for one flawless render — re-run the identical prompt to get a different take, keep the best individual shot out of each generation, and stitch the winners together in the edit.

**Why it works:** Model output varies run to run, so no single generation will be perfect across every cut; the job during generation is to accumulate as much usable footage as possible, and the assembly decision is deferred to the editor where you can take shots 1–2 from take one and shot 3 from take two. Expecting perfection in one pass wastes credits re-prompting something that was never a prompt problem.

**Evidence offered:** Repeated worked examples: the pool sequence (first two shots from take one, Sophia-in-water from take two), the glass-breaking shot abandoned entirely, and an unchanged re-run of the horse prompt that produced a better take unprompted.

**Fit here (8/10):** The durable-principle core of the excerpt: it reframes how a solo operator should budget production effort — variance is harvested, not fought. It matches how he already works with image generations (expect to discard more than you keep) and extends it to video, where cost per attempt is higher. Runnable today with one editor and one account.

*Source: Anthony Gallo (ContentCreator.com) — "AI Creator Course: AI ad creation lessons" (transcript, part 2 of 6)*

## When only part of a multi-cut sequence fails, delete the cuts that already worked out of the prompt, renumber the remaining ones, shorten the requested duration to match, and regenerate only those.

**Why it works:** Credits are spent on seconds of generated video, so re-requesting cuts you already have is pure waste; trimming the prompt down to the three failing cuts and dropping a 30-second request to 10 seconds spends roughly a third as much for the same result.

**Evidence offered:** Worked example on the sunset sequence — kept cuts 1–3 from the first 30-second generation, regenerated only cuts 4–6 at 10 seconds — plus the stated rule 'don't regenerate an entire scene just because one part is wrong'.

**Fit here (7/10):** Concrete credit discipline that compounds across every video the operator makes, and it pairs with the multi-cut batching tactic as the other half of the cost equation. One person, one account, runnable today.

*Source: Anthony Gallo (ContentCreator.com) — "AI Creator Course: AI ad creation lessons" (transcript, part 2 of 6)*

## When one generated shot is too short and throws the sequence's timing early, screenshot a frame from that shot, feed it to a cheaper image-to-video model with a one-line camera prompt, and splice the longer version in place of the original.

**Why it works:** The pacing defect is a duration problem, not a content problem, so you only need more of the same frame — regenerating from the existing frame in a low-credit model ('drone shot of the city with the volcano in the background, slow push forward') preserves continuity exactly while costing a fraction of re-running the whole multi-scene generation.

**Evidence offered:** Demonstrated twice — on the opening drone shot and on the falling-destruction shot — each time cutting the original clip out, dropping the five-second regeneration in, and trimming to the narration line.

**Fit here (7/10):** Directly runnable by a solo operator today: a repair move inside an edit he already does himself, and it keeps credit spend down on a business reference-budgeted at $30/day. Existing claims cover chaining end frames to start frames and salvaging believable seconds, but not regenerating a shot purely to extend its duration.

*Source: Anthony Gallo (ContentCreator.com) — "AI Creator Course: AI image and video workflow lessons" (transcript, part 7 of 9)*

## When you are unsure which of two ways to construct a shot or sequence is stronger, generate both and compare them side by side instead of guessing.

**Why it works:** Generation is cheap enough that the decision cost of debating a creative choice exceeds the cost of producing both and watching them; the comparison is immediate and unambiguous in a way an argument about the storyboard is not.

**Evidence offered:** Worked example on the payoff shot — close-up match cut versus wide establishing shot cutting into the close-up — generated both and picked the wide-to-close version as telling the story better.

**Fit here (7/10):** A genuinely cheap decision-making move for a solo operator who has nobody to argue the storyboard with. Note it is a craft-level judgement comparison, not a statistical ad test — it needs no order volume or spend to resolve, so it is runnable today and is not gated behind scale.

*Source: Anthony Gallo (ContentCreator.com) — "AI Creator Course: AI ad creation lessons" (transcript, part 2 of 6)*

## Upload the ad's actual music track into the video model as a reference element and instruct the character to move to the beat, naming the movement style explicitly.

**Why it works:** Without the track the model generates arbitrary motion that visibly fights the soundtrack in the edit; giving it the audio plus a named movement style ('smooth 80s disco moves to the beat') lets it time the action so the finished cut feels choreographed rather than pasted together.

**Evidence offered:** Worked example: dancers initially too aggressive and off-beat, fixed by uploading the song as a reference element and re-directing the movement style.

**Fit here (5/10):** Real mechanism and runnable today, but the surface it serves — beat-matched character motion — is a smaller slice of what RSC's short-form and Meta video needs than the shot-list and coverage tactics. It applies when he cuts a music-led brand or lifestyle piece, not to the demonstration and testimonial formats that will carry most of the work.

*Source: Anthony Gallo (ContentCreator.com) — "AI Creator Course: AI ad creation lessons" (transcript, part 2 of 6)*

## Add branding to the final shot by feeding the finished clip plus a logo image back into the video model and asking it to animate the logo in at a specified position that does not cover the product.

**Why it works:** The video tool can composite and animate a supplied logo over existing footage, so you get a branded end frame without an animation step in a separate editor — and constraining the placement ('keep it in the upper third') protects the product from being occluded at the exact moment the ad asks for the sale.

**Evidence offered:** Demonstrated: logo generated on a black background in the image model, then animated onto the final video with a stated upper-third placement constraint.

**Fit here (5/10):** Runnable today and useful for every video he ships, but it is a finishing step with modest leverage next to the directing and coverage decisions — and the placement rule (never occlude the product at the close) is the durable half, since compositing inside the video model is fast-decaying platform mechanics.

*Source: Anthony Gallo (ContentCreator.com) — "AI Creator Course: AI ad creation lessons" (transcript, part 2 of 6)*

## Build an AI video ad in five fixed stages in order — script outline, character generation, storyboard, video generation, edit — rather than prompting a video model straight from an idea.

**Why it works:** Each stage's output is the next stage's input: the script decides how many characters exist, the characters become the reference images, every storyboard frame becomes the literal start frame of a clip, and the clips become the edit. Skipping a stage means regenerating everything downstream, because image-to-video inherits whatever the frame got wrong.

**Evidence offered:** Demonstrated end to end on one ad; creator asserts the same style of ad took a company from $5M to $100M in a year, and that the whole piece cost under $30 to produce.

**Fit here (7/10):** RSC publishes its own short-form video and runs Meta creative, and the operator does every craft role himself — this pipeline lets him produce a scripted, multi-character ad with no second person on camera and no shoot day, in a category (natural soap/deodorant) that is Dr. Squatch's own. The fixed order is the part that survives tool churn; the named tools are fast-decaying platform mechanics.

*Source: Anthony Gallo (ContentCreator.com) — "AI Creator Course: AI ad creation lessons" (transcript, part 3 of 6)*

## Scale storyboard depth to the type of video — a talking-head piece needs almost none and leans on the script, a visual-heavy ad or narrative piece needs a full one — and do not start generating any video until the whole storyboard is settled.

**Why it works:** The script is the map of what is said and the storyboard the map of what is shown; when the visuals carry the piece, generating clips before the sequence is designed wastes paid generations on shots that will not cut together. When a face and a voice carry the piece, the storyboard adds nothing the script does not already fix.

**Evidence offered:** Assertion plus a demonstrated storyboard-to-video conversion for a short horror scene.

**Fit here (6/10):** A real spend-control decision rule not restated anywhere — the storyboard claim below covers how to organise frames in a Google Doc, not whether a given piece needs one. For a solo operator on pay-per-generation credits, knowing that talking-head clips need a script and no storyboard while a narrative ad needs a complete one before the first generation directly avoids burned credits and dead shots.

*Source: Anthony Gallo (ContentCreator.com) — "AI Creator Course: AI image and video workflow lessons" (transcript, part 2 of 9)*

## Anchor the character description by naming two or three real public figures whose blend you are after ('between Chris Pratt, Ryan Reynolds and James Schrader'), after closing your eyes and visualising the role.

**Why it works:** Named faces are dense, unambiguous descriptors the model already understands, so a hybrid of several gets the archetype and energy you pictured without a paragraph of facial-feature prompting — and blending several avoids landing on one recognisable person.

**Evidence offered:** Assertion plus demonstration on three characters (narrator, father, son).

**Fit here (5/10):** A cheap, real prompting shortcut for the recurring-character likeness RSC's image stack already calls for, and runnable today. Scored mid because it needs a guardrail the source does not give: the output must be a blend that resembles nobody identifiable, since a recognisable celebrity likeness in a paid ad is a legal exposure, not a creative choice.

**Guardrail (added at ingestion review):** Use the names only as private prompt shorthand. The rendered face must resemble no identifiable real person; check each final frame and regenerate any that reads as one of the named people. A recognisable celebrity likeness in a paid ad implies endorsement and creates right-of-publicity exposure. Never put a real person's name in ad copy, a filename that ships, or a caption.

*Source: Anthony Gallo (ContentCreator.com) — "AI Creator Course: AI ad creation lessons" (transcript, part 3 of 6)*

## Storyboard in a plain Google Doc — paste the script, drop each generated frame directly under the line of script it illustrates, keep only the images you will actually use in the doc, then export everything at once with File > Download > Web Page to get an organised folder of high-resolution frames.

**Why it works:** The doc gives a bird's-eye view of how every scene starts and connects before any generation credits are spent on video, and because the frame sits under its own line of script the mapping from dialogue to clip never gets lost. The web-page export solves the file-management problem of dozens of near-identical downloads, and the doc stays open as the running order while you generate, since exported files do not keep storyboard order.

**Evidence offered:** Demonstrated live; creator contrasts it with 'fancy software' and notes it costs nothing.

**Fit here (7/10):** A solo operator producing multi-scene video has exactly this problem — dozens of generated frames and no record of which belongs where. Zero cost, zero tooling, runnable today, and it directly supports the organic short-form surface RSC already publishes to.

*Source: Anthony Gallo (ContentCreator.com) — "AI Creator Course: AI ad creation lessons" (transcript, part 3 of 6)*

## Derive the 'before' version of a character by uploading the finished hero character image and prompting the model for a modified version of that same person (younger, clean-shaven, softer), so a before/after gag or transformation runs on one identifiable individual.

**Why it works:** The before-state is generated from the after-state image rather than from scratch, so the viewer reads the two frames as the same person changing rather than two unrelated models — which is the whole payload of a transformation shot.

**Evidence offered:** Demonstrated: the 'manly dad' image prompted into a 'youthful, clean-shaven' version, then transformed back in a later scene.

**Fit here (7/10):** RSC's product image stack already requires transformation frames and a routine-contrast substitute where an honest before/after does not exist — this is the generation method that makes the two states read as one person. Directly usable for deodorant and body-care contrast frames on social video and PDP galleries.

**Guardrail (added at ingestion review):** Use this for identity or comedy beats only (the character before he "switched", a younger self). Never use a generated before/after to show a product RESULT on skin, odor, teeth or body. An AI-made before/after of a result is a fabricated demonstration, deceptive under FTC rules in the same way as a fake testimonial, and for a cosmetic it also implies a treatment effect. Where an honest before/after does not exist, use the routine-contrast substitute in `marketing-product-image-stack`.

*Source: Anthony Gallo (ContentCreator.com) — "AI Creator Course: AI ad creation lessons" (transcript, part 3 of 6)*

## Write every image-to-video prompt by answering four fixed questions in as much detail as possible — what is the person saying and in what tone, what is the camera doing, what is the action in the shot, what is the context around it — and leave the platform's prompt-expansion setting on.

**Why it works:** Those four questions cover the only dimensions the video model actually controls (dialogue, camera behaviour, subject action, environment), so answering all four stops the model inventing its own camera move or staging; the expansion setting then fills that structured answer out into a fuller prompt on the back end.

**Evidence offered:** Demonstrated with a full example prompt and the resulting clip.

**Fit here (7/10):** Runnable today on RSC's own social-video surface by one person with credits. The four-question structure is a durable principle; the named 'Enhance' toggle is fast-decaying platform mechanics and should be recorded as 'the platform's prompt-expansion setting, if it has one'.

*Source: Anthony Gallo (ContentCreator.com) — "AI Creator Course: AI ad creation lessons" (transcript, part 3 of 6)*

## Inside the video prompt, state the emotional register by naming a famous commercial it should feel like ('funny and over the top, similar to a classic Old Spice commercial') and explicitly instruct 'no music, no sound effects.'

**Why it works:** A named reference commercial transfers a whole tone in three words that would take a paragraph to describe. Suppressing generated music and SFX returns clean plates, so music, voiceover and sound design are decisions made once in the edit rather than fought with on every clip.

**Evidence offered:** Demonstrated inside the worked example prompt.

**Fit here (6/10):** Both halves are runnable today and the clean-plate instruction is the kind of thing that silently ruins a batch when skipped — generated backing music on individual clips cannot be removed and will not match across cuts.

*Source: Anthony Gallo (ContentCreator.com) — "AI Creator Course: AI ad creation lessons" (transcript, part 3 of 6)*

## Taper production spend across the runtime: put the expensive cinematic generations and the expensive talking-head/avatar format only at the hook and in roughly 30-second bursts at the open, middle and close, and carry the rest on cheap AI voiceover over stills and simple B-roll.

**Why it works:** The hook decides whether the rest is watched at all, so marginal production value is worth far more in the first seconds than at second forty; avatar video is priced per second of face while voiceover and stills cost almost nothing, so concentrating the expensive format where a face earns trust and covering the remainder with narration delivers the same runtime at a fraction of the cost. Generate a motion clip only where the script absolutely demands motion.

**Evidence offered:** Worked cost reasoning for a 10-minute video and the same pattern applied to Reels and TikToks, plus the creator's own practice with a stated 20-minute total build time for the hook section.

**Fit here (7/10):** A one-person operation producing its own social video has a hard time and credit budget, and this is an explicit allocation rule for both. Complements rather than duplicates the copy-side claim that 90% of copy effort belongs in the concept and hook — this governs production spend per second of finished video. His own face is free to film, so the honest translation is 'cinematic generations and face-to-camera where trust is earned, narration over stills elsewhere'.

*Source: Anthony Gallo (ContentCreator.com) — "AI Creator Course: AI image and video workflow lessons" (transcript, part 3 of 9)*

## Accept a visually imperfect generated clip when you know you will cut away from it, and judge it instead on audio clarity and delivery, because the voice can be replaced later but the tone and timing of the performance cannot.

**Why it works:** The edit decides what the viewer actually sees — a wide shot that only has to hold for two seconds before the close-up does not need to be flawless. But performance tone is baked into the generation, so that is the one attribute worth re-rolling for, and voice replacement in the edit makes vocal quality a non-criterion.

**Evidence offered:** Demonstrated on the first clip: 'the full shot doesn't have to be exactly perfect... as long as the audio is clear and the delivery sounds good... that is something we will not be able to change'.

**Fit here (7/10):** A concrete acceptance test that stops a solo operator burning credits and hours re-rolling frames the edit will cover anyway. Complements the existing rule to reject clips for shaky-camera and auto-zoom defects by naming what is NOT worth rejecting for.

*Source: Anthony Gallo (ContentCreator.com) — "AI Creator Course: AI ad creation lessons" (transcript, part 3 of 6)*
