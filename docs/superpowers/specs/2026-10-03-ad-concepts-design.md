# Ad Concepts — concept-first ad creation

**Date:** 2026-10-03 · **Status:** approved in conversation, awaiting written-spec review
**Agent:** `agents/ad-concepts/` (new) · **Reuses:** `agents/ad-studio/` gates, render call, verify, critique, budget, archive

## Why

Ad Studio is organised around a LAYOUT: pick a format from `formats.js`, fill its zones, render a text-free plate, gate it. It is good at what it was built for (the right product, sourced copy, no health claims) and it has no step where anyone has an idea. Three runs on 2026-10-03 showed the cost:

- The `generic-villain` format, written to pass the gates ("an ordinary man", "mild disappointment", "relaxed hands"), passed them and produced stock photography. Sean: *"These images are super generic and do nothing to stop the scroll."*
- The plate rules for templated ads ("no text anywhere", "ordinary scene") turned a receipt joke into lined paper.
- The comp pass lets the image model set type, and it printed "50ml" on a 60ml bottle. Type laid in code on the receipt mockup was exact on the first try.
- The one strong result, "The Receipt", got there in two rounds only by going around the framework.

So the front of the process is rebuilt concept-first, and the back (the gates that have earned their keep) is reused unchanged.

## Decisions (Sean, 2026-10-03)

| Question | Decision |
|---|---|
| What does one run produce? | **One ready-to-launch Meta flexible ad**: 3 finished images from 3 different concepts, 2 primary texts, 2 headlines. |
| How is a run started? | **On demand** (CLI). No schedule in v1. |
| Who picks concepts? | **The system picks unless Sean specifies** (`--concept`). |
| Creative range | **Full range**: scale gags, genre parody, native screenshots, comedy, premium product art. Jabs at a generic CATEGORY are allowed; a named competitor, its brand or packaging never is. |
| Architecture | **A sibling agent** that reuses Ad Studio's modules, rather than a new mode inside `agents/ad-studio/index.js` (2,348 lines, five interacting modes; the template path's safe-by-default assumptions leak into anything built inside it). |

Unchanged constraints: product fidelity, claim sourcing, the ad health-claim gate, the deodorant-never-antiperspirant rule, no before/after imagery of skin or body, no em dashes in published copy, and nothing is ever published to Meta automatically.

## Usage

```bash
node agents/ad-concepts/index.js --product <handle> [--variant <name>] \
  [--concept "<an idea in one sentence>"]...  [--ratio 4:5|1:1] [--max-renders <n>] [--dry-run]
```

- `--concept` is repeatable; each one occupies a slot before the system fills the rest.
- `--ratio` defaults to `4:5`.
- `--max-renders` defaults to `30` (≈$3.90 at `USD_PER_RENDER` $0.13). Every render attempt counts, retries and replacements included.
- `--dry-run` stops after the concept stage and writes `concepts.json`. No image call is made.

## Pipeline

```
evidence ─▶ generate ~18 concepts ─▶ pre-gate (free, deterministic) ─▶ judge (separate model)
        ─▶ auto-pick 3 (distinct families; --concept first)
        ─▶ per concept: shot spec ─▶ 3 takes ─▶ verifyImage ─▶ overlay copy ─▶ typeset ─▶ critique ─▶ best take
        ─▶ flexible-ad copy (2 primary texts, 2 headlines) ─▶ manifest ─▶ run.json ─▶ archive ─▶ notify
```

### 1. Concept stage — `agents/ad-concepts/concepts.js`

**Evidence**, all of it existing and maintained:
- the product's PDP body, catalog entry and the brand kit (the same sources `buildSourceIndex` reads)
- personas through `overlayPersonas` then `sanitizePersonas`, in the same order as the other readers of `personas.json`
- quotable reviews through `selectQuotableReviews`
- the marketing tactic projection and its "Do not propose" blocklist, built the way `creative-packager` builds them (`renderContextMirror(scanSkillInventory(...))`)

**Generation:** one Opus call (`CREATIVE_MODELS.adStudio.angle`) returns about 18 concepts as JSON. Each concept carries:

| field | meaning |
|---|---|
| `id`, `title` | stable slug + short name |
| `picture` | one sentence describing the image |
| `anchor`, `twist` | the instantly recognisable thing, and the unexpected thing it is about |
| `family` | `scale-gag`, `genre-parody`, `native-screenshot`, `product-art`, `identity-comedy` or `template:<ad-studio format key>` |
| `productRole` | where and how our product appears |
| `sceneText` | `none` or `illegible-print` |
| `people` | `none`, `hands` or `face` |
| `typeBand` | `top` or `bottom`, the area kept clear for overlay type |
| `headlineIdea` | draft overlay line |
| `claims[]` | `{ text, sourceId }` for every fact the concept leans on |

A response stopped at `max_tokens` throws (truncated JSON cannot be repaired by a retry at the same ceiling); malformed JSON gets one retry.

**Pre-gate, free and deterministic.** It runs on the concept's text fields (`picture`, `twist`, `headlineIdea`, `claims`). A concept is dropped, with its reason recorded, when:
- `findHealthClaims` hits
- `findProductCategoryMisnomers` hits
- any name in `config/competitors.json` appears
- the picture describes before/after of skin, a body or a face (pattern list in the module, pinned by tests)
- a `claims[]` entry fails `assertClaimsSourced` against `buildSourceIndex`

**Judge, a separate model.** It uses `CREATIVE_MODELS.adStudio.verify`, which is not the generator, because a model grading its own ideas inflates them. The survivors are scored 1–5 on:
1. **thumb-stop:** anchor + twist
2. **one-second read:** one subject, an overlay of 4 words or fewer is enough
3. **product clarity**
4. **renderability**
5. **brand fit**

The total is the sum. The judge returns scores only. It cannot add or rewrite concepts.

**Auto-pick, `pickConcepts(scored, { requested, slots: 3 })`**, pure:
- `--concept` ideas take slots first. They are generated into the same shape by the concept call and still pass the pre-gate. A requested idea that fails the gate is reported and its slot refilled; it is never forced through.
- The remaining slots go to the highest totals, with **no two picks from the same `family`**. Meta clusters near-identical creatives into one delivery entity (`marketing-paid-creative-testing`), so three versions of one idea would waste the format.
- Ranked runners-up are kept as replacements, ordered by score, each from a family not already used.

**Output:** `concepts.json` holds every concept with its verdict: `picked`, `runner-up`, `gated:<reason>` or `outscored`.

### 2. Takes and gates — `agents/ad-concepts/shots.js`

**Shot spec:** one Opus call per picked concept writes the scene portion of the render prompt under the director rules adopted in PR #974:
- a style line
- literal geo-spatial blocking
- acting written as observable behaviour
- no referential language ("same as", "as before")
- the clear `typeBand` stated as empty space

Two blocks are **code, not model output**, so they cannot drift:
- **The product block:** reference photos from `selectReferencePhotos`, plus the manifest's `productDescription`, using the same fidelity wording Ad Studio's `buildRenderPrompt` uses. That wording is extracted into an exported helper in `render.js` so both callers share one copy.
- **The scene-text block** translated from `sceneText`. `none` → "no text anywhere except our product's own label". `illegible-print` → "fine grey hairlines only; no letters, numbers or symbols". Measured 2026-10-03: asking for "illegible receipt print" produced readable gibberish, including our product's scent name, while hairlines produced none.

**Takes:** 3 renders per concept at `--ratio` through `renderVariationWithBackoff` (existing transient backoff), counted against a `createRenderBudget`.

**Gates, via a new `verifyImage` extracted from Ad Studio's `renderWithRetry`** (about 40 lines; `renderWithRetry` then calls it, so the template path keeps one verify implementation):
- **Hard fails, unchanged:** fidelity against the reference photos, the volume/weight marking (`volumeVerdict`), label ink, scent wording, and our unit count.
- **Two new options**, both defaulting to off so the template path is byte-for-byte unchanged:
  - `allowPeople` adds an inventory kind `person`, so people are recorded rather than failed.
  - `allowedSceneText: 'illegible-print'` adds the declaration to the verify prompt's "not defects" list and to `normalizeDefects`. A legible word outside our label still fails.
- **The verify response must be readable, or the take fails** (fail closed, as today).
- **`people !== 'none'`** stamps `needsHumanReview: ['anatomy']` on the take. It still ships. `verify.js` checks nothing about anatomy, and that is stated in every output that carries the flag.

**Repair and replacement:**
- 0 of 3 takes passing → one retry of 2 takes with the failure reasons appended to the prompt.
- Still nothing passes → the next runner-up from an unused family takes the slot.
- Every attempt is billed to the same budget. When the budget stops a run, everything produced so far is still written, and `run.json.budget.skipped` names what did not happen.

### 3. Copy, typesetting and output

**Overlay copy, `agents/ad-concepts/copy.js`.** One Opus call per concept, written against the chosen take's concept (`picture`, `twist`, `headlineIdea`):
- a headline of 6 words or fewer
- an optional sub line of 12 words or fewer
- `claims[]`

**Flexible-ad copy.** It reuses Ad Studio's `writeFlexibleManifest` text path (2 primary texts, 2 headlines, `findGoldenThread` on primary texts). It is called with the three picked concepts' finals as the plates.

**Copy gates, on every string:**
- `assertNoHealthClaims`
- `assertClaimsSourced`
- `findProductCategoryMisnomers`
- a new **no-em-dash check** (U+2014). Sean's standing rule: no em dashes in copy he publishes. Two Ad Studio drafts on 2026-10-03 carried them.

The policy matches Ad Studio's: a failure gets one regeneration with the offending words named, then the concept is dropped. When the dropped concept is a picked one, its runner-up replaces it.

**Typesetting, `agents/ad-concepts/typeset.js`.** An HTML template rendered by Puppeteer with the real brand faces, then encoded with sharp:
- The `@font-face` inlining in `scripts/render-frame.mjs` is extracted to `lib/brand-fonts.js`; `render-frame.mjs` imports it.
- Two v1 layouts: **headline band** (in the concept's `typeBand`) and **caption strip**.
- Text colour is chosen from the mean luminance of the band region of the take.
- Ad Studio's finished-frame critique Part A (phone-size legibility, a hard fail) runs on the typeset result; a failure retries once with the other colour treatment.
- Type on an object in the scene is out of scope for v1.

**Picking the take:** every passing take is typeset and scored with `critiqueArtifact` (Part B, 1–5). The highest score per concept wins, because type can rescue or ruin a frame. Ties go to the earlier take.

**Output:** `data/creatives/ad-studio/concepts-<product>-<variant>-<timestamp>/`

| file | contents |
|---|---|
| `concepts.json` | every concept, its scores and verdict |
| `<concept-id>/take-N-plate.jpg` | the take, no type (kept for Photoshop) |
| `<concept-id>/take-N-final.jpg` | the typeset ad |
| `<concept-id>/proof.json` | per take: gate verdicts, critique, `needsHumanReview`; Ad Studio's proof shape, so the dashboard reads it |
| `<concept-id>/copy.json` | overlay `{ zones, claims }` |
| `flexible-ad.json`, `flexible-ad.md` | the 3 chosen finals, 2 primary texts, 2 headlines and the product URL |
| `run.json` | Ad Studio's run shape plus `kind: 'concepts'`, cost, budget and `needsHumanReview` |

Plates are named with `-plate-`, so `agents/dashboard/lib/ad-studio-runs.js` lists the run. Teaching it to prefer `-final-` over the comp is a small change in the same PR. The run is archived to the main checkout through `lib/archive-run-output.js` on success, on a thrown error and on SIGINT/SIGTERM, as Ad Studio does.

**A short run:** with only 2 concepts completing, `flexible-ad.json` is written with 2 images and `short: true`, and the summary says so. With fewer than 2 there is no manifest at all; `run.json` says why.

**Notify:** one deferred `notify()`, never `immediate: true`. The subject names the product, the image count and `NEEDS HUMAN REVIEW` when any final carries the flag. `status: 'error'` only when the agent itself broke.

## Module boundaries

| unit | does | depends on |
|---|---|---|
| `concepts.js` | build the generation prompt, parse, pre-gate, judge prompt/parse, `pickConcepts` | ad-studio claims + health, product-category-terms, competitors config |
| `shots.js` | shot-spec prompt, scene-text block, take loop, repair/replace | ad-studio `render.js`, `verifyImage`, budget |
| `copy.js` | overlay copy prompt/parse, copy gates, em-dash check | ad-studio claims + health, product-category-terms |
| `typeset.js` | layout HTML, colour choice, Puppeteer + sharp | `lib/brand-fonts.js` |
| `index.js` | args, orchestration, output, archive, notify (`isDirectRun` guarded) | all of the above |

Every model and image call is injected, so every unit is testable without spending.

## Changes outside the new agent (each pinned so the template path cannot regress)

- `agents/ad-studio/index.js`: extract `verifyImage` out of `renderWithRetry`.
- `agents/ad-studio/verify.js`: `allowPeople` and `allowedSceneText`, both off by default.
- `agents/ad-studio/render.js`: export the product fidelity block as a helper.
- `scripts/render-frame.mjs` → `lib/brand-fonts.js` for the font-face CSS.
- `agents/dashboard/lib/ad-studio-runs.js`: prefer `-final-` images when present.

The existing Ad Studio test suite must pass with no edits to its assertions.

## Testing (TDD)

- **Pre-gate:** fixtures for a health claim, "our antiperspirant", a competitor name, a skin before/after and an unsourced fact are each dropped with the right reason; "your soap's ingredient list" (a category jab) passes.
- **`pickConcepts`:** distinct families; `--concept` first; a gated `--concept` refilled; runner-up promotion skips used families.
- **`verifyImage` options:** off → identical verdicts to today on recorded fixtures; on → people and declared illegible print are not failures, while a legible stray word still is.
- **Scene-text block and product block:** exact wording pinned.
- **Copy gates:** an em dash fails; one regeneration then drop.
- **Typesetter:** exact strings in the HTML; output pixel size equals the take; colour flips on light vs dark bands.
- **Budget:** retries and replacements stop at the ceiling; `run.json.budget.skipped` lists the rest.
- **End to end:** all models stubbed → a complete run folder, a manifest and a `run.json` the dashboard's `listRuns` reads.
- **Acceptance (live, by eye):** one real run on `coconut-soap`, judged by Sean.

## Out of scope for v1

Type on objects in the scene, scheduled runs, 9:16 Stories versions, video, dashboard launch buttons, and any publishing to Meta (manual, always).
