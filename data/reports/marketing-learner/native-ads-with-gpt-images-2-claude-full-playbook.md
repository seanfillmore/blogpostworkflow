# Native ads with GPT Images 2 + Claude (Full Playbook)

**Creator:** Lorenzo Pravata (@lorenzo_pravata)  
**Source:** social post — `native-ads-with-gpt-images-2-claude-full-playbook`  
**Published:** 2026-08-27  
**Inferred era cues:** Published 2026-08-27. References 'GPT Images 2' and (inconsistently) 'GPT Images 5' as the image generator, Claude Projects with custom instructions, Reddit comment scraping via Google search phrases, and a named competitor brand (Rejuveen) currently testing AI-generated native statics. Tooling references are current-era; the copy principles are format-agnostic.  

A workflow video for producing 'native' static ads — one candid, organic-looking photo paired with a 1,200–1,800 word first-person story that carries the reader from the pain they live with to who they want to be, with the product as the bridge. The creator's system is a persisted Claude Project running a numbered prompt chain: project instructions, a thread-finder prompt that outputs Google/Reddit search phrases, a comment-scraping prompt that harvests individual sufferers' first-person accounts, a product intake, a 'four decisions' gate (awareness level, tension, opening) confirmed before any copy exists, a story architect that drafts and gets approval section by section, and finally image-generation prompts pasted into an OpenAI image model to render the candid photo. He also gates the whole format: it only works for urgent, daily, evergreen problems (pain, fear, insecurity), not for low-stakes products.

Found 7 tactics: 4 adopted, 3 rejected.

## Adopted

### Source the story's raw material by having an LLM generate a list of search phrases, running them through Google to surface Reddit threads, and harvesting the individual comments where people describe their own experience — hunting comments rather than subreddits, and not filtering by thread age. — 8/10

**Why it works:** Real sufferers' comments supply the first-person phrasing, the specific micro-situations and the emotional register a copywriter cannot invent; comments rather than thread titles are where individual lived detail sits, and old threads stay valid because the underlying problem has not gone away.

**Evidence:** Assertion plus the creator's own reusable prompts and a worked seat-cushion research report.

**Fit:** Highest-value item in the video for this business. At ~54 orders/month the owned review corpus is too thin to mine for phrasing, so borrowed first-person language from natural-deodorant, armpit-detox and sensitive-skin threads is the practical substitute — and it feeds Meta primary text, PDP copy and Amazon bullets alike. Free, solo-runnable today, no volume or people dependency. Distinct from marketing-problem-solution-inventory's 'source the objections from public complaints', which harvests disqualifying beliefs rather than narrative and verbatim pain language.

**Target skill:** `marketing-review-mining` (edit)

### Screen the product against the format before committing to a long native story: it only works on urgent, daily, evergreen problems (pain, fear, anxiety, insecurity) where new sufferers keep arriving — 'nobody reads a 1,400-word story to buy an LED light'. — 7/10

**Why it works:** Reading 1,400 words is a real cost the reader will only pay if the problem is felt today and emotionally loaded; on a low-stakes or purely aesthetic purchase the format collapses regardless of how good the copy is, so the screen prevents wasting the most expensive asset type on the wrong SKU.

**Evidence:** Assertion, with named qualifying categories (back pain, hair loss, sleep, blood sugar) and a disqualifying counterexample (LED light).

**Fit:** Directly useful across a 12-SKU catalog where format fit varies sharply: daily underarm odor/irritation and the fear of a natural deodorant failing in public is an urgent, evergreen, insecurity-loaded problem that can carry long-form; lip balm and most body care cannot. With Meta live at $30/day and one person writing everything, a gate that decides which SKU gets the expensive asset is worth more than the asset itself. Adjacent to but distinct from marketing-awareness-level-messaging's desire-ranking claim, which ranks desires rather than screening a format's viability.

**Target skill:** `marketing-copy-hooks-and-formats` (edit)

### Lock the strategic decisions — awareness level, tension, opening — and confirm or redirect them before a single line of copy is written, then have the writer draft the story section by section with approval at each section rather than producing the whole piece at once. — 7/10

**Why it works:** The stated failure mode is skipping straight to writing: when a native ad flops it is almost always mis-targeted (wrong awareness level, wrong tension, wrong opening), not a bad format or bad product. Deciding those upstream and approving section by section keeps a long generated piece from drifting off its own premise.

**Evidence:** Assertion, presented as 'the single biggest reason native ads don't work for people', plus the prompt sequence itself (Prompt 5 four decisions, Prompt 6 story architect).

**Fit:** Runnable today by one person with an LLM and no budget. It is the operational control that complements the existing 'never ship LLM-generated copy as-is — run a named audit for the golden thread' claim: sectional approval catches the drift while it is cheap instead of after the piece exists. Real value at $30/day where a mis-targeted 1,400-word asset burns a week of the operator's only scarce resource, time.

**Target skill:** `marketing-copy-hooks-and-formats` (edit)

### Generate the candid native photo with an AI image model by having the LLM write several numbered image-generation concepts from the finished story, then pasting each generation prompt into the image tool. — 6/10

**Why it works:** The image's only job is to look like a real photo the customer lives in and stop the scroll; deriving the concepts from the already-approved story keeps photo and copy congruent, and generating them removes the need for a shoot or a photographer.

**Evidence:** Assertion plus the creator's Prompt 8 and 'Final Results' examples.

**Fit:** Executable today by the solo operator with no team and no shoot, and it feeds the live $30/day Meta campaign and the giveaway entry ads. Marked down only because a candid native photo has to survive the authenticity test — a rendered scene that reads as AI defeats the whole point of the format, and for a ~$50 AOV body-care product a plain phone photo of the real product in a real bathroom is often the cheaper honest version. Tool-name specifics ('GPT Images 2/5') are fast-decay platform mechanics, but the video is weeks old so that is not what drove the score.

**Target skill:** `marketing-ai-product-imagery` (edit)

## Rejected

### Run the native ad format itself: one candid, organic-looking photo paired with a 1,200–1,800 word first-person story, where the image stops the scroll and the story does the selling. — 5/10

**Rejected because:** Duplicate of the existing marketing-copy-hooks-and-formats claim: 'Run a long-form native-style ad: an organic-looking image with no text overlay, paired with a long first-person emotional story that ends in the accidental discovery of the product.' The 1,200–1,800 word range is a wording detail on the same claim, not a new tactic.

**Fit reasoning:** Paid social is a live surface at $30/day, so the format is executable here — but the claim is already recorded verbatim in marketing-copy-hooks-and-formats ('Run a long-form native-style ad: an organic-looking image with no text overlay, paired with a long first-person emotional story that ends in the accidental discovery of the product'). Adding a reworded version would degrade skill triggering. Durable-principle class; age is not the issue.

### Structure every native ad as a move from point A (the insecurity, pain or fear the reader lives with daily) to point B (who they want to be), with the product positioned as the bridge between them. — 4/10

**Rejected because:** Duplicate. Matches 'Write to a primal desire (status, sex, belonging, safety, approval) and treat the product as the mechanism, not the headline' in marketing-conversion-copy-angles, plus 'Lead with the transformation' in marketing-copy-hooks-and-formats.

**Fit reasoning:** Sound and durable, but already held twice in the skill set: marketing-conversion-copy-angles' 'Write to a primal desire and treat the product as the mechanism, not the headline' and marketing-copy-hooks-and-formats' 'Lead with the transformation — the after-state — instead of the conventional problem-then-solution order.' Durable-principle class, so age is irrelevant; the problem is duplication.

### Check what big brands in and around your category are currently running — the creator points at a competitor (Rejuveen) and notes they are now testing a mix of AI images beyond pure native — to see which static formats are live right now. — 4/10

**Rejected because:** Duplicate of the marketing-competitor-messaging-teardown claim 'Research competitor ad libraries first and run a gap analysis on which awareness levels, personas, and formats are missing from your own rotation before producing anything.'

**Fit reasoning:** Right instinct and cheap for a solo operator, but already recorded: marketing-competitor-messaging-teardown holds 'Research competitor ad libraries first and run a gap analysis on which awareness levels, personas, and formats are missing from your own rotation before producing anything.' A reworded version would dilute that skill's triggering.

## Skills touched

- `marketing-copy-hooks-and-formats` (edit)
- `marketing-review-mining` (edit)
- `marketing-ai-product-imagery` (edit)
