---
name: marketing-ai-prompt-craft
description: How to get usable output out of an LLM for marketing work: persisted account-level memory (business brief, your writing voice, output format, clarifying questions), having the model author its own prompts, writing reusable prompts and skills that actually fire and that show worked positive plus negative examples, long-running threads per recurring job, and staged conversational refinement with subtopic constraints and model-as-ranker.
---

# Ai Prompt Craft

Four groups of moves, in the order you should set them up: (1) things you persist once in
the model's account-level memory so every future chat inherits them; (2) teaching the model
your voice; (3) authoring prompts and reusable skills — letting the model draft them, and
writing them so they trigger and so their rules cannot be routed around; (4) how you run the
conversation once you are generating.

## Persist the business brief in long-term memory once — what you sell, who you serve, what that audience specifically values about you, your best-performing assets, the competitors they also follow — and explicitly instruct the model to store it and use it to inform future responses.

**Why it works:** Memory persists across threads, so the expensive context-setting is paid once instead of being re-pasted at the start of every session. Ungrounded models default to generic output; a persisted brief keeps every downstream idea, hook, script and headline aimed at the actual buyer rather than at the category average.

**Evidence offered:** Demonstrated live — he types the channel description and audience in full before making any request, and the model returns 'memory updated'; the subsequent idea list includes a video the channel had already made that earned a million views, which he treats as confirmation the context was working.

**Fit here (7/10):** One operator writing ad copy, listing copy, emails and video scripts in separate chats re-establishes the same context constantly. Persisting the SKU list, the 12-product catalogue, the deodorant/skin-line split and the review corpus into memory is runnable today and compounds across every AI task in the fleet. Do this before any of the other moves here — the clarifying-questions instruction, the voice training and the staged refinement all produce better output on top of a loaded brief.

*Source: Anthony Gallo (ContentCreator.com) — "AI Creator Course: content ideas, scripting and thumbnail lessons" (transcript, part 3 of 4)*

## Persist a standing custom instruction in the LLM's account settings telling it to ask clarifying questions whenever a request is too broad, so it interrogates you before generating.

**Why it works:** You usually cannot tell your own prompt is underspecified. Moving the detection into a saved account-level instruction means the model forces the missing decisions (name, colors, audience, tagline) out of you before it commits to an output, instead of you discovering the gap after a bad generation.

**Evidence offered:** Assertion plus a worked demo — 'make a YouTube channel banner' comes back with three clarifying questions instead of a generic banner.

**Fit here (7/10):** A solo operator who is also the copywriter, designer and media buyer prompts LLMs all day for ad copy, listing bullets, email drafts and image prompts. This is a one-time settings change that raises the floor on every one of those requests. Platform mechanics (fast-decay class) but current as of 2026, and the underlying move survives a UI rename. Distinct from the email-design claim about keeping a single brief deliberately vague — that is a per-task choice; this is a persisted account default.

*Source: Anthony Gallo (ContentCreator.com) — "AI Creator Course: AI image and video workflow lessons" (transcript, part 1 of 9)*

## Persist an instruction about OUTPUT FORMAT, not just subject matter — 'anytime I ask you to write a script, format it teleprompter-ready so I can read it word for word to a camera' — to suppress the model's default emoji-and-blog formatting.

**Why it works:** The model's default formatting is tuned for blog posts, so a script arrives full of headers, bullets and emoji that cannot be read aloud. Stating the delivery format once in memory means every future draft arrives in the shape the surface actually needs instead of being reformatted by hand.

**Evidence offered:** Assertion plus stated personal practice ('otherwise I find it uses a lot of emojis and keeps this blog formatting I don't personally use').

**Fit here (6/10):** RSC already scripts his own short-form video word for word and reads it off a teleprompter, so a draft that cannot be read aloud is wasted output. Generalises beyond video — write one format rule per surface (email body, Meta primary text, Amazon bullets, teleprompter script) so each comes out in its own shape rather than blog-formatted. Solo-runnable, no gate.

*Source: Anthony Gallo (ContentCreator.com) — "AI Creator Course: content ideas, scripting and thumbnail lessons" (transcript, part 2 of 4)*

## Train the model on your own voice before asking it to write anything: paste or upload a piece you personally wrote, prompt it to analyse your writing style, commit that analysis to memory, and write in that style from then on — then keep feeding it more of your own documents over time.

**Why it works:** Un-briefed models default to a generic register, so the output reads like every other AI post. A persisted style analysis derived from real samples of your own writing gives every future draft a voice target, and each additional sample narrows it further until the model reproduces your own jokes and explanations.

**Evidence offered:** Assertion plus personal experience — he says he has loaded dozens of his own documents and now sees the model use 'the same joke that I would have used'.

**Fit here (7/10):** RSC's copy is written by one person across video scripts, Meta primary text, email and Amazon bullets, and the separate approach of converging an LLM on your voice by hand-editing drafts back in takes twenty to thirty rounds. This is the cheap front-loaded version: upload the product-page and email copy he already wrote, get the style persisted in memory in minutes, then let hand-editing do the remaining fine work rather than all of it. Durable-principle class, no volume or budget dependency.

*Source: Anthony Gallo (ContentCreator.com) — "AI Creator Course: content ideas, scripting and thumbnail lessons" (transcript, part 2 of 4)*

## Maintain the voice at the word level as you go: when a draft uses a word you never use, name the swap explicitly and tell it to update memory ('you said incredible videos, I always say epic videos — remember that moving forward').

**Why it works:** Voice is carried by a small set of recurring word choices more than by structure, so patching individual wrong words into persisted memory builds a personal lexicon incrementally. Each correction is paid once and applies to every future draft.

**Evidence offered:** Assertion plus stated personal practice.

**Fit here (6/10):** This is the maintenance loop that keeps the persisted style analysis from drifting. For RSC specifically it is how brand vocabulary gets enforced across surfaces without writing a style guide — one person, zero cost, immediate.

*Source: Anthony Gallo (ContentCreator.com) — "AI Creator Course: content ideas, scripting and thumbnail lessons" (transcript, part 2 of 4)*

## If you have no written sample to train on, manufacture one in a minute by dictating a story into your phone's voice-to-text and pasting the transcript in as the style reference.

**Why it works:** Spoken language is closer to your real register than anything you would compose on a keyboard, and voice-to-text converts it into the text artifact the model needs — so the absence of written material is never a reason to skip the voice-training step.

**Evidence offered:** Assertion, offered as one of two fallbacks.

**Fit here (5/10):** A fallback RSC largely does not need — there are years of product-page, email and listing copy to train on — but it is the better source for the SPOKEN register his own social video uses, which written listing copy does not capture. Worth doing as a second sample specifically for script work. Runnable on a phone today.

*Source: Anthony Gallo (ContentCreator.com) — "AI Creator Course: content ideas, scripting and thumbnail lessons" (transcript, part 2 of 4)*

## Instead of writing a detailed prompt from scratch, keep your prompt framework as a reusable worksheet, paste it into the LLM with a one-line brief ('following the framework I've pasted here, create a prompt for [scene]'), and then hand-edit only the sections you actually have an opinion about rather than accepting what it returns.

**Why it works:** The framework is the thinking; the long prompt is typing. The model enumerates the dimensions a good prompt has to specify — colour scheme, typography, layout, lighting, tagline space — which you would otherwise have to invent from memory, and surfaces fields you would have forgotten. You only overwrite the slots where you have a real requirement, so you get a fully specified prompt without composing one, which cuts trial-and-error rounds and raises output per hour without losing control.

**Evidence offered:** Worked demos: asks for a detailed prompt for a tech YouTube banner, gets back a specified prompt, then modifies only the colour section; separately demonstrates the exact meta-prompt against his saved text-to-video framework and warns explicitly against blindly accepting the result.

**Fit here (7/10):** Directly useful to the operator's production load — every listing image, static ad frame and B-roll beat needs a specified prompt, and the existing image skills demand fixed-template, fully-specified prompts without saying where that specification comes from when you are not a photographer. This supplies the generation step and makes an eight-frame gallery or six-beat B-roll sequence promptable in one sitting. Runnable today with no budget or volume dependency.

*Source: Anthony Gallo (ContentCreator.com) — "AI Creator Course: AI image and video workflow lessons" (transcript, part 1 of 9)*

## When the reusable prompt or skill carries a rule, teach it with a worked example of good output PAIRED with a deliberately contrasting negative case — the same scene rendered both ways — and add a 'notice what's missing' paragraph naming the specific details absent from the bad version.

**Why it works:** A rule stated abstractly gets routed around. Showing one scene rendered twice — once with reference images attached and once without — and then naming the exact details that failed to appear in the second ('no mascara, no navy coat, no stubble, no hair colour') makes the boundary unambiguous in a way the rule alone does not. The negative case is doing the teaching; the positive case alone leaves the failure mode undefined.

**Evidence offered:** Demonstrated rather than argued — the skill carries Case A and Case B plus an explicit 'notice what's missing' paragraph.

**Fit here (6/10):** He already maintains persisted prompts and long-running threads for recurring marketing jobs, and the rest of this skill covers voice training and format instructions but never showing the model a negative example. This is the direct fix for the model inventing product detail he then has to catch in QA: pair the correct rendering of the deodorant stick, the label text and the scent name with a wrong one, and say what is missing from the wrong one. Cheap, immediate, solo.

*Source: PromptEdit (shared in ContentCreator.com AI Creator Course) — "PromptEdit Shotlist Director (Claude skill for Seedance 2.0 shotlists)" (prompt document)*

## Write a reusable skill's description as the literal phrases you would actually type when you want it — 'make a shotlist', 'break this script into prompts', 'generate prompts for [tool]' — plus the artifact types that should trigger it, so it loads at the right moment instead of having to be invoked by name.

**Why it works:** The assistant chooses which stored instruction set to apply by matching your request against its description, so enumerating the real trigger phrasings and the input types (script, scene breakdown, treatment, existing shotlist to revise) is what makes the saved work actually fire. A description written as an abstract summary of the skill's topic never matches how you phrase the request in the moment.

**Evidence offered:** Assertion, embodied in the skill's own frontmatter.

**Fit here (5/10):** He is the only operator and will accumulate saved prompts for ad copy, hooks, shot lists and listing graphics; a saved instruction that never triggers is wasted work. Runnable today. Current-era mechanics, so no age discount, but it is operational plumbing rather than a revenue lever, hence the modest score.

*Source: PromptEdit (shared in ContentCreator.com AI Creator Course) — "PromptEdit Shotlist Director (Claude skill for Seedance 2.0 shotlists)" (prompt document)*

## Keep one named, long-running thread per recurring content job (e.g. 'YouTube title ideas', 'email subject lines', 'ad angles') and always return to it rather than starting a fresh chat.

**Why it works:** Each new chat discards the context you spent effort establishing — audience, positioning, what has already been tried — so a dedicated thread per repeating task compounds, and the model's answers get more specific over time instead of resetting to generic. Projects are an optional organisational layer on top.

**Evidence offered:** Demonstrated — he renames the thread and explains the memory-preservation rationale; mentions projects as an optional organisational layer.

**Fit here (5/10):** Operational hygiene rather than a lever, and it is adjacent to keeping pitch material in a persistent LLM project — but that is about storing MATERIAL, whereas this is a one-thread-per-recurring-job discipline for the jobs RSC repeats monthly (content topics, email subject lines, ad angles). Free, immediate, solo.

*Source: Anthony Gallo (ContentCreator.com) — "AI Creator Course: content ideas, scripting and thumbnail lessons" (transcript, part 2 of 4)*

## Prompt conversationally in deliberate stages — first ask the model what the factors of a good version of the asset are, then ask it to generate one using those stated principles, then refine with single-dimension follow-ups ('make it more engaging', 'add urgency').

**Why it works:** Making the model state the evaluation criteria before it produces anything puts those criteria into the context window, so the generation is written against an explicit standard instead of the model's default. Each subsequent one-variable follow-up steers toward the target rather than re-rolling the whole thing, so you converge instead of gambling on a one-shot prompt.

**Evidence offered:** Worked demo with YouTube titles: asks for the factors that make a title work (numbers, power words, curiosity, under 60 characters), then asks for titles using those principles, then refines for engagement and urgency.

**Fit here (6/10):** Honest translation to the surfaces this business writes: ask the model what makes an Amazon title or a Meta primary text or a subject line work, then have it generate against that list, then push one dimension at a time. Adjacent to running a hook through a named clarity rewrite and hand-editing drafts back into the model, but the criteria-first-then-generate ordering is its own move. Scored below the other two prompt-craft items because it is the most generic and easy to do badly. The two sections below are the specific refinement moves to reach for instead of a vague 'make it better'.

*Source: Anthony Gallo (ContentCreator.com) — "AI Creator Course: AI image and video workflow lessons" (transcript, part 1 of 9)*

## Never run with the first batch of ideas — thank it and ask for ten more constrained to a named subtopic you choose, so the second batch is narrower and more specific than the first.

**Why it works:** The first batch is drawn from the broadest reading of your niche; naming a subtopic as the constraint forces the model into the corner of the category you actually want to own, and reading two batches rather than one surfaces ideas the first pass could not reach.

**Evidence offered:** Demonstrated — the subtopic constraint ('videos where we teach people how to create emerging and relevant types of videos') produces a visibly different and, in his judgement, better list.

**Fit here (6/10):** Maps straight onto RSC's own short-form ideation: a first ungrounded batch about 'natural deodorant' is broad category content, while a named subtopic ('the switching period', 'oral care for people who hate mint') aims at the narrow rings the organic-content skill already says to target. Runnable today by one person in one chat. This is the specific redirect to use as the second stage of the staged-refinement loop above — the subtopic constraint, not a generic 'more'.

*Source: Anthony Gallo (ContentCreator.com) — "AI Creator Course: content ideas, scripting and thumbnail lessons" (transcript, part 3 of 4)*

## Hand the model its own candidate list back and ask which one is most optimised for search and why, read its stated reasons, then override it where your own read of the line is stronger.

**Why it works:** The model can enumerate which keywords and search terms each variant contains faster than you can, so it is useful as a ranker and as an explainer of its own criteria — but it cannot judge which line is more shocking to your buyer, so the final pick stays human.

**Evidence offered:** Demonstrated — the model recommends one title citing 'best' as a high-volume search term and extra keyword depth; he reads the reasoning and picks the other one because it is 'more shocking'.

**Fit here (6/10):** A one-person shop has no second reviewer, so using the model as the critique pass on its own output — with the explicit rule that its reasoning informs but does not decide — is a real workflow gain on every title, subject line and headline batch. Adjacent to using the LLM for concept breadth and for critique in marketing-ai-video-ad-production, but that is about critiquing YOUR script; this is ranking its own candidates against one named criterion, with the override rule attached.

*Source: Anthony Gallo (ContentCreator.com) — "AI Creator Course: content ideas, scripting and thumbnail lessons" (transcript, part 3 of 4)*
