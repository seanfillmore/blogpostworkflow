# Ad Batch: one concept, 15-20 finished ad images

**Date:** 2026-10-06 · **Agent:** `agents/ad-batch/` · **Status:** built

## Why

Everitt Moder (Trybe creator) made 156 statics for RSC with AI. He locks one headline and product and varies only the scene, for 15-30 versions per concept. Sean wants the fleet to do the same: "We provide the product imagery and the copy and the AI builds us several variations." Meta's delivery then picks the winners ([[feedback_meta_picks_winners_feed_creatives]]).

A spike on 2026-10-06 proved the quality before anything was built. OpenAI `gpt-image-2` rendered finished ads, with the headline designed into the image, from our real product photos: 29 of 29 renders had exact headline and label text across the cream jar, the bar soap (wrapped and bare) and the foaming pump. Gemini 3 Pro Image looked as good but slipped on 2 of 5 labels.

## Decisions (Sean)

| Question | Answer |
|---|---|
| Does the image model render the headline? | **Yes.** The whole graphic, like Everitt's. This reverses the plate-first rule of `ad-studio` for this tool only. |
| Where does the copy come from? | **Sean.** The tool does images only and gets a list of headline/subhead pairs. No copywriting, no ideation. |
| Who picks the scenes? | **A library plus fresh ones.** About 12 per headline come from `data/ad-batch/scenes.json`; the rest are generated for that headline. Sean can pass his own list. |
| Ratio | **4:5 only**, 15-20 per headline (default 16). |
| How it runs | **Sean asks Claude**, and it runs locally. Output goes to `~/Desktop/Ad Batches/`. Nothing publishes to Meta. |
| Where it lives | **A standalone agent.** It does not touch `ad-concepts` or `ad-studio`, which assume code-set type. |
| Compliance bar | **"Flexible while not being deceptive."** Unlabelled props and other generic products are fine ([[feedback_compliance_flexible_not_deceptive]]). |

## Flow

1. **Batch file:** `{ product, variant, count, form, concepts[{headline, subhead}], scenes[] }`. `parseBatch` names every problem at once.
2. **Copy check:** `screenConcepts` runs the fleet's blocking tier on the commercial surface (cure claims, disease positioning, drug words, "antiperspirant"). A failing concept is skipped and named; copy is never rewritten.
3. **Product:** from `data/product-images/manifest.json`:
   - physical description, unit count, and the label strings (`buildLabelStrings`, shared with `ad-concepts`);
   - reference photos: the hand-picked ones in `data/ad-batch/references.json` first, otherwise the first images in the variant folder;
   - the bar soap also has `unwrapped` photos (Sean's six, added 2026-10-06), used by `inUse` scenes.
4. **Scenes:**
   - `selectLibraryScenes` deals round-robin across 7 families (rotated by a hash of the headline), never-used and least-recently-used first. Scenes an earlier headline took this run go last.
   - `generateFreshScenes` asks the standard model for the remainder and requires settings different from the library picks.
   - If the planner fails, the batch is topped up from the library and the run says why.
   - Every scene carries a `typeStyle`. Without one the model sets plain catalogue type, which is what the foam spike showed.
5. **Render:** two `gpt-image-2` tries at 1088×1360 (`/v1/images/edits`, reference photos as `image[]`), then one Gemini 3 Pro Image try at 4:5.
6. **Check:** one vision read (standard model) of the reference photo plus the render. The model only transcribes and counts; `decide()` makes the verdict in code. A render fails on:
   - headline/subhead tokens missing, misspelled or out of order;
   - label name lines wrong (volume figures and URLs are advisory);
   - the wrong count of OUR product;
   - fidelity `MISMATCH`;
   - invented claims in extra text (review counts, stars, "dermatologist", "tested", "#1", "%", "$", the blocking gate);
   - a clearly malformed hand.

   Prop text and hands are notes, not failures.
7. **Output:** `<date> <product>/<NN headline>/` holds the passing images, `_rejected/` (kept with the reason so Sean can overrule), `_contact sheet.jpg` (✋ marks hands) and `scenes.md`. The batch folder holds `run.json`. Rotation history is `~/Desktop/Ad Batches/.scene-usage.json`, outside any worktree.

## Cost

- **OpenAI:** priced from each response's `usage`, at an assumed $8 in / $30 out per 1M image tokens. That is double the listed batch rate, labelled as an estimate. About $0.22 per image.
- **Gemini:** fallback at about $0.13 a render.
- **Checks and scene planning:** go through the Claude subscription, $0.
- **Measured:** the first batch, 16 cream images, cost an estimated $3.52 in 6.7 minutes with all 16 passing on the first render.
- **Cap:** `--max-renders` defaults to 120.

## Not built (YAGNI)

- Ratios other than 4:5.
- A dashboard UI.
- Automatic promotion of fresh scenes into the library. Add a good one by hand.
- Ad copy.
- Uploading to Meta.
