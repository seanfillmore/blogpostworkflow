---
name: marketing-ai-motion-graphics-editing
description: Agentic LLM workflow for motion-graphic edits of talking-head footage. This tactic contributes a scene-type menu mapped to script function, with a shared brand palette and texture.
---

# Ai Motion Graphics Editing

## Build the cutaways in an educational talking-head video from a fixed menu of scene types, each matched to what that script segment is doing. Every scene shares the same textures, edges and palette. The menu is:
- a graph for numbers or trajectories;
- a zigzag line through phases for progression;
- a side illustration with text for two things at once;
- a quote card for the closing line;
- an object or character callout for a named person or item;
- a painting reveal for a story moment;
- a single-subject centre illustration for a concept.

**Why it works:** A small, consistent visual vocabulary makes the edit look like one designed piece rather than a collage. Mapping scene type to script function makes the choice for each segment fast and repeatable. Shared texture and colour carry the brand look across very different scenes.

**Evidence offered:** Assertion and a taxonomy of about 130 reference scenes from one creator's videos, plus one demo edit.

**Fit here (5/10):** This fits RSC's educational organic pillar: ingredient mechanism, the deodorant adjustment-period timeline as a graph, and drugstore vs natural as a side-by-side. The cutaways can go over approved Trybe creator UGC footage, and the operator can run it alone. There are two cautions. First, the source aesthetic is philosophical and product-free, so the product must still appear (see the existing closing-product-frame claim). Second, its paintings and stock B-roll conflict with the existing 'never use stock footage in an ad' claim on paid cuts. So scope it to organic education, using RSC's fixed brand identity rather than Brooks' look.

*Source: Joseph | Video Editing — "How to Edit VIRAL Talking Head Videos Using ONLY Claude! (New Minimal Style)" (g9xoKm5DEeU)*

## Train the LLM on an editing style before asking it to edit:
1. Download about 20 strong reference videos and break each scene down by asking why it was designed that way.
2. Screenshot every good scene onto a board and categorise the scenes into the style's principles, naming the fonts, colours, sizes and patterns.
3. Give the videos plus the board to the model. Prompt it to make a word-by-word transcript and a frame-by-frame breakdown of animation placement relative to the script, design composition and animation timing.
4. Package the result as a skill with an extracted per-animation reference library.

**Why it works:** The reference videos teach the model the logic of where and how animations sit against the script. The human-built board teaches it the design. The extracted library gives it concrete references to copy later. Without this, the model produces generic 'slop' edits.

**Evidence offered:** Assertion plus the comparison of a slop edit against his trained-skill output, and the 225 extracted animations.

**Fit here (6/10):** The operator already runs Claude skills. RSC has no founder footage, so the style is built from competitor references plus the best-performing Trybe creator Reels (the per-style Reel report shows which). Codifying that house edit style turns every future edit into a repeatable build rather than a manual one. This is a solo laptop task. Existing claims cover modelling one reference video by hand and a hook/script corpus. Neither covers training a visual edit-style skill from a categorised scene board. The fast-decay tool-mechanics class applies to the Claude/Remotion specifics, but the source is current.

*Source: Joseph | Video Editing — "How to Edit VIRAL Talking Head Videos Using ONLY Claude! (New Minimal Style)" (g9xoKm5DEeU)*

## Do not let the model plan the edit itself. Have it return a planning document with the script beside the clip and, for each segment, scene designs recommended from the style library. Choose and annotate the scene for every line yourself, balancing variety and flow. Then paste that plan back as the build instruction.

**Why it works:** The model builds animations well but is not creative enough to plan a great edit unaided. Without a strong plan, individually good animations do not add up to a watchable video. Human judgement on scene choice and balance is the step that decides quality.

**Evidence offered:** Creator's stated experience ('if you let AI do the planning on its own, it's actually not creative enough'), plus his walkthrough of the plan.

**Fit here (7/10):** This is the highest-value step in the source. It keeps the operator's judgement at the decision point, since he is the editor and strategist, while handing execution to the model. It fits the solo-operator reality exactly and applies to any LLM-built RSC video, organic or paid. The existing director-skill claim converts a script into a shot list for generative video. It does not cover a model-recommended, human-selected scene plan for editing existing footage, so this is not a duplicate.

*Source: Joseph | Video Editing — "How to Edit VIRAL Talking Head Videos Using ONLY Claude! (New Minimal Style)" (g9xoKm5DEeU)*

## Have Claude produce the whole motion-graphic edit of a raw talking-head video on a standard subscription. It handles cuts, the planning document, text, lines, graphs, illustrations, revisions, sound and render. Once the plan is approved, the model:
- analyses the plan;
- pulls the matching references from the style library;
- writes an asset list;
- fetches the assets and fonts itself;
- builds each scene in code (Remotion) and renders a draft;
- asks you for anything it cannot find.
The operator spends about 15 minutes planning the edit and reviewing passes, instead of hand-editing or hiring an editor.

**Why it works:** An agentic LLM that writes and renders video in code turns a written edit plan and a reference library into finished motion graphics. One person can then produce them without a motion designer or paid plugins. The asset list makes sourcing explicit before the build starts. The human's time moves from executing the edit to planning it and approving passes. Total cost becomes a flat subscription, and wall-clock time drops to about 2 hours, mostly unattended.

**Evidence offered:** One demo edit built this way. The creator's time breakdown:
- 15 minutes for cuts and the planning doc;
- 15 minutes of human planning;
- about 60 minutes for Claude to build the edit;
- 10 minutes of revisions;
- 15 minutes of sound.
Cost was a $100/month Claude plan. It is one demo from a course seller, with no audience-performance data.

**Fit here (6/10):** This fits a solo operator who is his own editor. The footage to edit is approved Trybe creator UGC (RSC has no founder video), which already posts as Reels three times a day and is a paid-creative source. Moving an edit from hours of hand-cutting to about 15 minutes of planning raises how many videos he can publish under the posting-volume and 100-day-cadence claims. No existing skill covers agentic LLM end-to-end editing of filmed talking-head footage. Two RSC adaptations apply. First, source product shots and B-roll from his own phone footage of the product. Second, use only clearly public-domain or licensed fetched assets; the 'never use stock footage in an ad' claim still governs paid cuts. It is not higher because the evidence is one vendor demo, and the output's value depends on the style-skill and planning steps. The time savings should be verified on RSC footage. These are fast-decay tool mechanics, but current.

*Source: Joseph | Video Editing — "How to Edit VIRAL Talking Head Videos Using ONLY Claude! (New Minimal Style)" (g9xoKm5DEeU)*
