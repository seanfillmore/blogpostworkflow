---
name: marketing-ai-motion-graphics-editing
description: Agentic LLM workflow for AI-built motion graphics. Covers editing talking-head footage from a scene-type menu with a shared brand palette, training an edit-style skill, planning the edit by hand, and having Claude build and render the edit in code (Remotion). Also covers code-rendered 3D explainers (Three.js, rendered headlessly and captured frame by frame), the scene-by-scene prompt spec with camera fly-throughs, a self-verification pass, and dated model routing. Use it for RSC mechanism explainers on Reels, PDP and Amazon.
---

# Ai Motion Graphics Editing

## Build the cutaways in an educational talking-head video from a fixed menu of scene types, each matched to what that script segment is doing. Every scene shares the same textures, edges and palette. The menu is:
- a graph for numbers or trajectories;
- a zigzag line through phases for progression;
- a side illustration with text for two things at once;
- a quote card for the closing line;
- an object or character callout for a named person or item;
- a painting reveal for a story moment;
- a single-subject centre illustration for a concept. Where the concept is a process that is hard to grasp in words, upgrade it to a code-rendered 3D animated demonstration (see the mechanism-explainer section below).

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
- runs the self-verification pass (see below) on the draft;
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

## Build standalone 3D motion graphics as code: have Claude write a Three.js scene, render it headlessly in a browser, and capture it frame by frame (screenshots at 60fps) into video. Use this instead of paying an AI video model or a motion designer. It is the 3D counterpart to the Remotion edit above. Remotion handles cutaways over filmed footage. Three.js handles self-contained 3D explainer clips, which can stand alone or drop in as a beat inside an edit.

**Why it works:** A browser renders a 3D code scene the way a high-end website does, and screenshotting it at 60fps turns it into frames. Generation costs only text tokens: about 37K tokens, or roughly 5 cents on a subscription, for a 15-second clip. Every revision is a cheap code edit. A video model charges per second (about $1.50 per 15 seconds) and charges again for each change.

**Evidence offered:** Five on-screen demos. The creator says every motion graphic in the video itself was made this way. The token arithmetic is shown for one clip and compared against Seedance 2.5 per-second pricing. He uses it daily on his own channel.

**Fit here (6/10):** RSC posts organic video to Instagram and Facebook every day. Its core claims are non-demonstrable mechanism claims: what aluminium-free means, how odour forms, what is actually in the bar or cream. The product-image-stack skill says these need 'a different home' than a frame, and a code-rendered animated explainer is that home.

The first surface is Reels: a 3D ingredient breakdown or a 'how your deodorant works' piece, with the spoken or on-screen hook carrying the claim. It can also be cut as a 5-10 second mechanism beat between Trybe UGC lines. The same render can then be recommended to David Parrotino as a Meta creative variant and used as a Shopify PDP gallery or Amazon video asset.

One person with a Claude subscription runs this end to end today, at near-zero marginal cost. The score is not higher because RSC's brand register is natural and believable. The glossy glassmorphic and metallic look in the demos must be restyled toward the brand palette, or it will read as an ad. The paid-creative skill also treats 'attractive' as a failure mode in native formats. Any depicted mechanism must stay inside what the formula substantiates.

*Source: Matt Penny | Applied AI — "Claude + Three.js = Premium 3D Motion Graphics" (CCUSpJkAfgU)*

## Use a 3D animated demonstration to explain a concept that is hard to grasp in words. Seeing the process work is better for understanding than reading about it, so treat the animation as an explainer, not decoration.

**Why it works:** A spatial, animated demonstration (vectors, gradient descent, packet routing) makes an abstract process concrete. This improves comprehension, not just looks, and it especially helps viewers who struggle with text.

**Evidence offered:** Demos three, four and five (RAG, gradient descent, internet routing), plus the creator's personal anecdote about being dyslexic.

**Fit here (5/10):** RSC's differentiators are formulation and mechanism claims that cannot be shown as a visible result, such as what odour actually is and why aluminium-free works differently. A literal animated demonstration of the mechanism gives those claims a visual home on Reels first. The same asset can then become a PDP gallery 'how it works' frame and an Amazon listing video. It is runnable today.

It is close to, but not a restatement of, two existing claims. The copy-credibility 'demonstrate the product verbally in stages' claim is verbal. The scene-type menu above is about choosing cutaways; this section is the upgrade path for its concept slot. The guardrail is that the animation must depict only substantiated mechanism, never invented efficacy.

*Source: Matt Penny | Applied AI — "Claude + Three.js = Premium 3D Motion Graphics" (CCUSpJkAfgU)*

## Write the 3D motion-graphics prompt as a scene-by-scene spec, and direct a camera fly-through rather than a slideshow. The spec should:
- say what happens in each scene and when, with specific timings;
- name Three.js as the framework;
- call for shaders where appropriate;
- name the visual treatment;
- direct the camera to fly through one continuous 3D space between elements;
- animate the elements within each scene, rather than having things simply appear.

An RSC example scene list:
- 0-2s: spoken hook plus on-screen text;
- 2-6s: a 3D molecule of the ingredient, rotating;
- 6-10s: camera push from a skin cross-section through the ingredient cluster to the product pack;
- 10-15s: pull back to the jar, then the CTA.

The visual-treatment line names RSC's own palette and texture (hex codes, natural or paper textures, like his fourth demo) rather than the tech-glass look.

**Why it works:** The model builds exactly what it is told, and specific per-scene timings remove ambiguity. Naming Three.js unlocks 3D rather than Claude's default flat 2D graphics. Naming shaders unlocks GPU effects (reflections, glows, particles) that create the premium feel, and a capable model decides where shaders belong once permitted. Camera travel between objects makes the piece read as a real 3D space rather than flat cards. Motion inside each scene adds a further quality level that is rare in AI graphics, which makes the piece stand out in feed.

**Evidence offered:** The demo prompts are shown on screen beside their outputs, contrasted with 'those flat motion graphics which Claude usually creates'. For the fly-through, the evidence is demos one and two plus the creator's own testing ('unlocks like a new sort of quality level'). Beyond that, it is assertion.

**Fit here (5/10):** This is the operating spec for the code-render tactic above, applied to RSC explainers, and a solo operator can put it into every prompt today. Holding attention past the hook matters most on the daily Reels surface. It is distinct from the scene-type menu, which covers which kind of cutaway fits a script segment, not how to instruct a 3D code renderer. It is also not covered by the basic-camera-move rules in the AI B-roll skill, which govern single-shot video-model generations rather than a continuous code-rendered 3D scene.

*Source: Matt Penny | Applied AI — "Claude + Three.js = Premium 3D Motion Graphics" (CCUSpJkAfgU)*

## Have the model run a verification loop over its own render before shipping. It checks for overlapping elements, text that is too small at phone size, and other layout mistakes. For RSC, extend the checklist so the loop also flags any on-pack or product claim the formula cannot substantiate. Apply the loop to both Three.js explainers and Remotion edits.

**Why it works:** Code-rendered graphics fail in predictable layout ways, such as collisions and illegible type at phone size. A self-check pass catches these before a human has to, which keeps quality high without manual frame-by-frame review.

**Evidence offered:** Demo two is shown with text 'a little bit too small', the defect the loop is meant to catch. Otherwise assertion only.

**Fit here (6/10):** This is cheap, runnable today, and directly protects the surface that matters. RSC Reels are watched on phones, and the product-image-stack skill already demands phone-size legibility. The existing proofreading pass covers copy on generated image frames, not layout collisions in an animated code render, so this is not a duplicate.

*Source: Matt Penny | Applied AI — "Claude + Three.js = Premium 3D Motion Graphics" (CCUSpJkAfgU)*

## Route motion-graphics code generation to the strongest coding model available, because output quality differs visibly between models. As of Nov 2026, that model is Opus 5.5. Re-check the choice when a new model generation ships.

**Why it works:** 3D scene composition, shader use and accurate detail (for example, a correct globe) depend on model capability. A smart model can also be given looser briefs and still choose shader placement well.

**Evidence offered:** The creator claims to have tested every provider's models and reports a noticeable difference over Sonnet 5.5, 'Astra 6' and OpenAI models. The globe demo is offered as proof of accuracy.

**Fit here (5/10):** This is a platform-mechanics claim in the fast-decay class, recorded with its date (Nov 2026). It is current now, so age does not lower it. It mirrors the label-fidelity model routing in the product-imagery skill, but for a different job (code-rendered motion), so it is not a duplicate. It is runnable today on the existing Claude subscription.

*Source: Matt Penny | Applied AI — "Claude + Three.js = Premium 3D Motion Graphics" (CCUSpJkAfgU)*
