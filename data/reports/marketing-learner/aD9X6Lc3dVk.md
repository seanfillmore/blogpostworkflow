# 10 GitHub Repos to 10x Your AI Motion Graphics

**Creator:** Matt Penny | Applied AI  
**Video:** https://www.youtube.com/watch?v=aD9X6Lc3dVk  
**Published:** unknown (not supplied via --published)  
**Inferred era cues:** Names 'Opus 5.5' (a prompt pack is titled 'awesome Opus 5.5 videos'). Describes Claude driving Blender through an MCP server and Claude writing Three.js and React scenes end to end. That places it around late 2026, consistent with the existing skill's Nov 2026 note that Opus 5.5 is the strongest coding model. Repos and tooling are platform-mechanics-class and decay fast; the 'select from proven templates rather than invent' principle is durable.  

A tour of ten open-source GitHub repositories that you paste into Claude, or connect to it, to raise the quality of AI-built motion graphics. The ten are: a 66-style film-style library (isometric explainer, paper cut, ink wash, retro terminal); Three.js for 3D charts, models, particles and camera fly-throughs; a pixel-art FX library; Blender driven through its MCP server for full 3D scenes, shaders and exploded product views; two prompt packs of styled HTML/WebGL video recipes; a 'Claude animation base' mascot kit with an emotion library and storyboarding guides; React + Rapier for real-physics scenes; a React post-processing stack for glow, depth of field, grain and glitch; Librosa for beat detection so on-screen changes land on the music; and a 'video shotcraft' library of about 124 product-launch promo templates that Claude selects from. The recurring thesis is that quality rises when the model selects from human-made, proven styles, templates and assets instead of inventing visuals itself. The video also pitches a paid 'skill selector' and mastermind.

Found 11 tactics: 5 adopted, 6 rejected.

## Adopted

### Give Claude a curated library of named visual styles (isometric explainer, paper cut, ink wash, retro terminal, etc.) and have it render the motion graphic in one chosen style, or ask it to pick, instead of letting it produce its default look. — 6/10

**Why it works:** A pre-written style recipe constrains palette, texture, layering and lighting to a coherent, human-designed look. That removes the generic 'AI slop' default and makes a mechanism explainer read as premium and intentional.

**Evidence:** The creator's own rendered examples (isometric phone-to-cell-tower explainer, paper-cut title sequence, ink-wash opener, terminal scene); assertion that he tested ~100 repos.

**Fit:** RSC posts Reels every day, and the existing motion-graphics skill already targets mechanism explainers for Reels, PDP and Amazon. An isometric 'how aluminium-free deodorant works under the arm' or an ink-wash 'where shea butter comes from' clip is a direct translation. The on-screen hook goes first, then the PDP gallery and Amazon video slot. One person can run it with Claude today. The existing skill trains the model on his own edit style; it does not cover importing a ready-made multi-style library, so this is an edit, not a duplicate. Not higher because style choice is a polish layer, not a conversion lever, and the binding constraint is conversion rate.

**Target skill:** `marketing-ai-motion-graphics-editing` (edit)

### Have the model select from human-made, proven templates and assets (pre-built UI elements, a library of ~124 product-launch promo formats) rather than generate visuals and structure from scratch. — 6/10

**Why it works:** The creative judgement is already embedded in templates that worked elsewhere, so the AI's job shrinks to selection and assembly. Selection is where it is reliable; invention is where it drifts into low-quality output.

**Evidence:** Assertion, plus examples of sleek UI-element motion graphics and the shotcraft template library choosing a format per brief.

**Fit:** This is a durable-principle-class tactic that directly serves RSC's own launch moments. Examples are a new scent, a bundle, or a seasonal set announced on daily Reels, then in Meta statics/video recommended to David and in email. He can paste a template repo into Claude and pick a launch format alone today. It is distinct from the existing motion-graphics claims, which cover his own style library and a scene-type menu, not importing third-party proven promo structures. Anti-fabrication still applies: the template must not carry invented scarcity or claims.

**Target skill:** `marketing-ai-motion-graphics-editing` (edit)

### Detect the music's beat programmatically (Librosa) and time every on-screen change in the motion graphic to land on a beat. — 6/10

**Why it works:** Viewers read audio-visual sync as production quality. Product-launch videos feel premium largely because every appearance and transition hits the beat, and beat detection makes that exact without hand-scrubbing.

**Evidence:** Demo clip; observation that software launch videos do this.

**Fit:** RSC's daily Reels often run on music or trending audio, and code-rendered edits can consume a beat timestamp list directly, so one person can run this today. It is distinct from existing claims: the organic program's 10-shot beat edit is manual cutting, and the AI-video-ad skill's 'move to the beat' prompts a video model. Neither covers programmatic beat grids driving cut and element timing. Applies to launch Reels first, then to the Meta video cut he recommends to David.

**Target skill:** `marketing-ai-motion-graphics-editing` (edit)

### Connect Claude to Blender through its MCP server so it can build full 3D scenes with materials, shaders, lighting and camera moves, including exploded views of a product's constituent parts and physical-process explainers. — 5/10

**Why it works:** Blender is a professional CGI tool. Via MCP the model can do anything a human operator can, which yields far higher material and lighting fidelity than hand-coded Three.js geometry, for the cost of a prompt and an hour of render time.

**Evidence:** One-shot examples: population-as-buildings comparison, a solar-panel electricity explainer, an exploded headphones view; the creator says each would have cost thousands a few years ago.

**Fit:** Blender is free and the operator drives it alone through Claude, so this is runnable today. The RSC translation is a 3D 'what's inside the stick' or 'how the balm layers onto skin' explainer for Reels first, then the PDP gallery and Amazon video. The existing ai-broll skill already covers ingredient deconstruction/reassembly via image-to-video models. What is new here is the Blender route for geometric and material fidelity on a physical-mechanism explainer. Any depicted mechanism must pass the existing verification loop for claims the formula can substantiate. Moderate score because 12 simple SKUs give fewer mechanism-heavy stories than gadgets, and the tooling is platform-mechanics-class and will date.

**Target skill:** `marketing-ai-motion-graphics-editing` (edit)

### Run every code-rendered frame through a post-processing filter stack (glow, depth-of-field blur, film grain, lens colouring, glitch), and use glow to highlight the specific element being talked about at that moment. — 5/10

**Why it works:** Post-processing adds the lighting and lens character flat motion graphics lack. Selectively glowing the element named in the narration directs the eye exactly where the voiceover is, which makes the explainer easier to follow and feel premium.

**Evidence:** Examples, including a sodium-atom explainer where electrons glow as they are discussed; assertion.

**Fit:** This is a craft upgrade he can apply alone to the Three.js and Remotion explainers the existing skill already builds for daily Reels. For example, glow on the shea butter or baking-soda-free callout at the moment it is named. Its value is in tightening voice-to-visual sync, which existing claims do not specify for code renders. It is incremental polish rather than a conversion lever, hence mid score.

**Target skill:** `marketing-ai-motion-graphics-editing` (edit)

## Rejected

### Use Three.js to turn charts into 3D (bars made of cash stacks with accurate axes), build 3D models, particle effects and camera fly-throughs. — 3/10

**Rejected because:** Duplicate of marketing-ai-motion-graphics-editing claims 'Build standalone 3D motion graphics as code: Three.js… rendered headlessly' and 'direct a camera fly-through rather than a slideshow'.

**Fit reasoning:** Already recorded in the existing motion-graphics skill.

### Use prompt packs ('awesome Opus 5.5 videos', 'Opus video prompts') of styled HTML/WebGL/Three.js video recipes. — 3/10

**Rejected because:** Restates the curated style-library tactic and the template-selection principle already adopted from this video.

**Fit reasoning:** The creator himself calls this 'similar to the very first one'.

### Use a mascot animation kit with a built-in character, emotion library and animation/storyboard guides to make cute explainer videos. — 3/10

**Rejected because:** Duplicate of marketing-product-image-stack claim 'Give the imagery an enduring non-founder likeness (a recurring character… or a mascot) and keep it consistent across frames'; the specific asset is Claude-branded and not transferable.

**Fit reasoning:** The specific kit's asset is a Claude-branded bot, unusable for RSC.

### Use React + Rapier to add real physics (Jenga collapse, domino word reveal, Galton board) to motion-graphic explainers. — 3/10

**Rejected because:** Covered by marketing-ai-motion-graphics-editing claim 'Use a 3D animated demonstration to explain a concept that is hard to grasp in words'; the physics engine adds no honest RSC-specific use beyond that.

**Fit reasoning:** There is little physical-dynamics story in deodorant, soap or lip balm. Where a demonstration is needed, it falls under the existing 3D-explainer claim.

### Use a pixel-art FX library (explosions, weather, fire, lightning) to make stylised pixel-art explainers or cinematic scenes. — 2/10

**Rejected because:** No mechanism beyond the style-library tactic adopted from this same video; adding it separately would duplicate that claim.

**Fit reasoning:** This is one more style within the style-library tactic already adopted above. Pixel-art explosions and lightning are also a poor tonal match for natural body care.

### Install a 'skill selector' that reads your request and picks the best video-production skill(s) to build it. — 1/10

**Rejected because:** Paid-product pitch with no marketing mechanism; duplicates marketing-ai-prompt-craft claim on writing skill descriptions as trigger phrases so the right skill loads automatically.

**Fit reasoning:** This is a promotional pitch. Skill routing is already handled by description matching in Claude Code.

## Skills touched

- `marketing-ai-motion-graphics-editing` (edit)
