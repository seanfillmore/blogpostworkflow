# Claude + Three.js = Premium 3D Motion Graphics

**Creator:** Matt Penny | Applied AI  
**Video:** https://www.youtube.com/watch?v=CCUSpJkAfgU  
**Published:** unknown (not supplied via --published)  
**Inferred era cues:** Names Opus 5.5 as the current best model, and also mentions 'Sonnet 5.5', 'Astra 6' and Seedance 2.5 as one of the best current video models. He says the results were impossible 'a couple of months ago'. HyperFrames and Remotion are referenced as alternatives. These cues place it in the second half of 2026, close to today (2026-11-12), so the platform-mechanics claims are fresh.  

A demo-led tutorial on making 3D motion graphics entirely as code. Claude writes a Three.js scene with GPU shaders, the scene renders in a headless browser, and frames are captured at 60fps and stitched into video. No AI video model or After Effects is involved. The creator walks through five demos: a glassmorphic particle scene, metallic reflective spheres, a 3D RAG/vector explainer, a paper-textured gradient-descent explainer, and a globe showing packet routing. His prompting tips are: write a scene-by-scene spec with timings; name Three.js and shaders explicitly; ask for camera moves through 3D space and motion within each scene; ask for 'professional and sleek'; use a 'job-application showreel' role-play framing; let a strong model propose three ideas before building; and run a verification loop for overlapping elements and too-small text. He claims Opus 5.5 is clearly the best model for this. He prices a 15-second clip at about 5 cents on a Claude subscription, against roughly $1.50 on Seedance 2.5, where every revision is paid again. Use cases he names are social short-form, explainers, product launches, and overlays on podcast or client-call clips. The video ends with a pitch for his paid mastermind.

Found 10 tactics: 6 adopted, 4 rejected.

## Adopted

### Build motion graphics as code: have Claude write a Three.js scene, render it headlessly in a browser, and capture it frame by frame into video, instead of paying an AI video model or a motion designer. — 6/10

**Why it works:** A browser renders a 3D code scene the way a high-end website does, and a screenshot at 60fps turns it into frames. Generation costs only text tokens (~37K tokens, about 5 cents on a subscription for a 15-second clip). Every revision is a cheap code edit, whereas a video model charges per second (~$1.50 per 15 seconds) and charges again for each change.

**Evidence:** Five on-screen demos, and the creator says this is how all motion graphics in the video itself were made. The token arithmetic is shown for one clip, compared against Seedance 2.5 per-second pricing. He uses it daily on his own channel.

**Fit:** RSC posts organic video to Instagram and Facebook every day. Its core claims are non-demonstrable mechanism claims (what aluminium-free means, how odour forms, what is actually in the bar or cream), which the product-image-stack skill says need 'a different home' than a frame. A code-rendered animated explainer is that home. The first surface is Reels: a 3D ingredient breakdown or a 'how your deodorant works' piece, with the spoken or on-screen hook carrying the claim. It can also be cut as a 5-10 second mechanism beat between Trybe UGC lines. The same render can then be recommended to David Parrotino as a Meta creative variant and used as a Shopify PDP gallery or Amazon video asset. One person with a Claude subscription runs this end to end today, at near-zero marginal cost, so it is unstaged. The score is not higher because RSC's brand register is natural and believable, so the glossy glassmorphic and metallic look shown must be restyled toward the brand palette or it will read as an ad. The paid-creative skill also treats 'attractive' as a failure mode in native formats. Any depicted mechanism must stay inside what the formula substantiates.

**Target skill:** `marketing-ai-motion-graphics-editing` (edit)

### Have the model run a verification loop over its own render before shipping, checking for overlapping elements, text that is too small, and other mistakes. — 6/10

**Why it works:** Code-rendered graphics fail in predictable layout ways (collisions, illegible type at phone size). A self-check pass catches them before a human has to, which keeps quality high without manual frame-by-frame review.

**Evidence:** Demo two is shown with text 'a little bit too small', the defect the loop is meant to catch. Otherwise assertion only.

**Fit:** This is cheap, runnable today, and directly protects the surface that matters. RSC Reels are watched on phones, and the product-image-stack skill already demands phone-size legibility. The existing proofreading pass covers copy on generated image frames, not layout collisions in an animated code render, so this is not a duplicate. The checklist should be extended for RSC to include on-pack and product claims, so the loop flags any claim the formula cannot substantiate.

**Target skill:** `marketing-ai-motion-graphics-editing` (edit)

### Write the motion-graphics prompt as a scene-by-scene spec: say what happens in each scene and when, name Three.js as the framework, call for shaders where appropriate, and name the visual treatment (e.g. glassmorphic frosted panes). — 5/10

**Why it works:** The model builds exactly what it is told. Specific per-scene timings remove ambiguity. Naming Three.js unlocks 3D rather than Claude's default flat 2D graphics. Naming shaders unlocks GPU effects (reflections, glows, particles) that create the premium feel. A capable model decides where shaders belong once permitted.

**Evidence:** The demo prompts are shown on screen beside their outputs. He contrasts them with 'those flat motion graphics which Claude usually creates'.

**Fit:** This is the operating spec for the code-render tactic above, applied to RSC explainers. Example scene list: 0-2s spoken hook plus on-screen text, 2-6s a 3D molecule of the ingredient, 6-10s camera move to the product pack, 10-15s CTA. It is runnable today by one person. It is distinct from the existing scene-type menu, which covers which kind of cutaway fits a script segment, not how to instruct a 3D code renderer. The visual-treatment line should name RSC's own palette and texture (hex codes, natural or paper textures, like his fourth demo) rather than the tech-glass look, to stay on brand.

**Target skill:** `marketing-ai-motion-graphics-editing` (edit)

### Direct the camera to fly through a single 3D space between elements, and animate the elements within each scene, rather than producing a slideshow of things appearing. — 5/10

**Why it works:** Camera travel between objects makes the piece read as a real 3D space rather than flat cards. Motion inside each scene adds a further quality level rarely seen in AI graphics, which makes the piece stand out in feed.

**Evidence:** Demos one and two, plus the creator's own testing ('unlocks like a new sort of quality level'). Assertion beyond that.

**Fit:** This is a concrete craft direction a solo operator can put into every RSC explainer prompt today. An example is a camera push from a skin cross-section into an ingredient cluster, then a pull back to the jar. It serves the daily Reels surface first, where holding attention past the hook matters. It is not covered by the existing basic-camera-move rules in the AI B-roll skill, which govern single-shot video-model generations, not a continuous code-rendered 3D scene.

**Target skill:** `marketing-ai-motion-graphics-editing` (edit)

### Route motion-graphics code generation to the strongest coding model available (as of this video, Opus 5.5), because output quality differs visibly between models. — 5/10

**Why it works:** 3D scene composition, shader use and accurate detail (e.g. a correct globe) depend on model capability. A smart model can also be given looser briefs and still choose shader placement well.

**Evidence:** The creator claims to have tested every provider's models and reports a noticeable difference over Sonnet 5.5, 'Astra 6' and OpenAI models. The globe demo is offered as proof of accuracy.

**Fit:** This is a platform-mechanics claim, which belongs to the fast-decay class, so it must be recorded with its date (Nov 2026). It is current now, so age does not lower it. It mirrors the existing label-fidelity model routing in the product-imagery skill, but for a different job (code-rendered motion), so it is not a duplicate. It is runnable today on the existing Claude subscription. The model name should be re-checked when a new model generation ships.

**Target skill:** `marketing-ai-motion-graphics-editing` (edit)

### Use a 3D animated visual to explain a concept that is hard to grasp in words, because seeing the process work is functionally better for understanding than reading about it. — 5/10

**Why it works:** Spatial, animated demonstration (vectors, gradient descent, packet routing) makes an abstract process concrete. This improves comprehension, not just looks, and especially helps viewers who struggle with text.

**Evidence:** Demos three, four and five (RAG, gradient descent, internet routing), plus the creator's personal anecdote about being dyslexic.

**Fit:** RSC's differentiators are formulation and mechanism claims that cannot be shown as a visible result, such as what odour actually is and why aluminium-free works differently. A literal animated demonstration of the mechanism gives those claims a visual home on Reels first. The same asset can then become a PDP gallery 'how it works' frame and an Amazon listing video. It is runnable today. It is close to, but not a restatement of, the copy-credibility 'demonstrate the product verbally in stages' claim (which is verbal) or the scene-type menu (which is about choosing cutaways). The guardrail is that the animation must depict only substantiated mechanism, never invented efficacy.

**Target skill:** `marketing-ai-motion-graphics-editing` (edit)

## Rejected

### Add 3D motion-graphic overlays to existing footage (podcast clips, recorded client calls) to make the clips more engaging on social. — 4/10

**Rejected because:** Duplicate of marketing-ai-motion-graphics-editing's claim 'Have Claude produce the whole motion-graphic edit of a raw talking-head video', which already covers the overlay-on-existing-footage use. The Three.js rendering method is captured in the adopted code-render tactic.

**Fit reasoning:** The RSC translation would be overlays on approved Trybe creator UGC Reels. That is useful, but it is already recorded.

### With a capable model, give a loose brief and ask for three ideas in text first, then pick one for it to build. — 3/10

**Rejected because:** Duplicate of marketing-ai-video-ad-production's 'Use the LLM for concept breadth… harvest and pick from the variations it returns' and marketing-ai-motion-graphics-editing's 'have it return a planning document… Choose and annotate the scene for every line yourself'.

**Fit reasoning:** It is a sound habit, but it is already recorded in the fleet's skills.

### Prompt with a role-play framing such as 'pretend this is your application to a motion graphics job you really want, create a fantastic showreel', and ask for it to look professional and sleek. — 2/10

**Rejected because:** Motivational prompt framing with no stated mechanism. The creator offers only a 'weird' impression, so it is not a testable tactic with a causal story.

**Fit reasoning:** It has no causal story, and the creator himself frames it as an unexplained quirk. Persona-incantation prompting is the kind of trick that decays fastest with model generations.

### Render the same motion graphic vertical, square or horizontal to fit any platform. — 2/10

**Rejected because:** Duplicate of marketing-ai-product-imagery's 'Pick the aspect ratio from the placement and the composition — 1:1 for a feed static, 9:16 for a vertical UGC ad, 16:9…' and marketing-vertical-video-reframing's 'one proven asset serves multiple placements'.

**Fit reasoning:** It is already covered by the aspect-ratio-by-placement rules elsewhere in the fleet.

## Skills touched

- `marketing-ai-motion-graphics-editing` (edit)
