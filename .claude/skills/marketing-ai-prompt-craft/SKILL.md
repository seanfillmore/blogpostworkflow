---
name: marketing-ai-prompt-craft
description: How to get usable output out of an LLM for marketing work: persisted account-level instructions, having the model author its own prompts, and staged conversational refinement.
---

# Ai Prompt Craft

## Persist a standing custom instruction in the LLM's account settings telling it to ask clarifying questions whenever a request is too broad, so it interrogates you before generating.

**Why it works:** You usually cannot tell your own prompt is underspecified. Moving the detection into a saved account-level instruction means the model forces the missing decisions (name, colors, audience, tagline) out of you before it commits to an output, instead of you discovering the gap after a bad generation.

**Evidence offered:** Assertion plus a worked demo — 'make a YouTube channel banner' comes back with three clarifying questions instead of a generic banner.

**Fit here (7/10):** A solo operator who is also the copywriter, designer and media buyer prompts LLMs all day for ad copy, listing bullets, email drafts and image prompts. This is a one-time settings change that raises the floor on every one of those requests. Platform mechanics (fast-decay class) but current as of 2026, and the underlying move survives a UI rename. Distinct from the email-design claim about keeping a single brief deliberately vague — that is a per-task choice; this is a persisted account default.

*Source: Anthony Gallo (ContentCreator.com) — "AI Creator Course: AI image and video workflow lessons" (transcript, part 1 of 9)*

## Instead of writing a detailed prompt from scratch, keep your prompt framework as a reusable worksheet, paste it into the LLM with a one-line brief ('following the framework I've pasted here, create a prompt for [scene]'), and then hand-edit only the sections you actually have an opinion about rather than accepting what it returns.

**Why it works:** The framework is the thinking; the long prompt is typing. The model enumerates the dimensions a good prompt has to specify — colour scheme, typography, layout, lighting, tagline space — which you would otherwise have to invent from memory, and surfaces fields you would have forgotten. You only overwrite the slots where you have a real requirement, so you get a fully specified prompt without composing one, which cuts trial-and-error rounds and raises output per hour without losing control.

**Evidence offered:** Worked demos: asks for a detailed prompt for a tech YouTube banner, gets back a specified prompt, then modifies only the colour section; separately demonstrates the exact meta-prompt against his saved text-to-video framework and warns explicitly against blindly accepting the result.

**Fit here (7/10):** Directly useful to the operator's production load — every listing image, static ad frame and B-roll beat needs a specified prompt, and the existing image skills demand fixed-template, fully-specified prompts without saying where that specification comes from when you are not a photographer. This supplies the generation step and makes an eight-frame gallery or six-beat B-roll sequence promptable in one sitting. Runnable today with no budget or volume dependency.

*Source: Anthony Gallo (ContentCreator.com) — "AI Creator Course: AI image and video workflow lessons" (transcript, part 1 of 9)*

## Prompt conversationally in deliberate stages — first ask the model what the factors of a good version of the asset are, then ask it to generate one using those stated principles, then refine with single-dimension follow-ups ('make it more engaging', 'add urgency').

**Why it works:** Making the model state the evaluation criteria before it produces anything puts those criteria into the context window, so the generation is written against an explicit standard instead of the model's default. Each subsequent one-variable follow-up steers toward the target rather than re-rolling the whole thing, so you converge instead of gambling on a one-shot prompt.

**Evidence offered:** Worked demo with YouTube titles: asks for the factors that make a title work (numbers, power words, curiosity, under 60 characters), then asks for titles using those principles, then refines for engagement and urgency.

**Fit here (6/10):** Honest translation to the surfaces this business writes: ask the model what makes an Amazon title or a Meta primary text or a subject line work, then have it generate against that list, then push one dimension at a time. Adjacent to existing claims about running a hook through a named clarity rewrite and hand-editing drafts back into the model, but the criteria-first-then-generate ordering is its own move. Scored below the other two prompt-craft items because it is the most generic and easy to do badly.

*Source: Anthony Gallo (ContentCreator.com) — "AI Creator Course: AI image and video workflow lessons" (transcript, part 1 of 9)*
