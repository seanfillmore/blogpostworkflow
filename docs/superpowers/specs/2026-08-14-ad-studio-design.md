# Ad Studio — design

**Date:** 2026-08-14
**Branch:** `feature/ad-studio`
**Status:** built and running. Stages 1–3 and 5 are as designed. **Stage 4 (verification)
is partial and known-incomplete** — it was rebuilt four times over one day of live running
and still verifies nothing about the rendered product itself. Read
"Verification status — read this before trusting an accept" before judging any batch.

## Goal

Produce publish-ready static ad creatives for Real Skin Care — headline, body copy,
comparison columns and product all baked into one frame — at a volume that can feed
Meta and Google Demand Gen without a manual Photoshop step per asset.

Revenue path: paid social and Demand Gen are the traffic side of the growth plan.
Creative volume is the current bottleneck on running them, because the existing
pipeline emits a backdrop and leaves the persuading half of the ad to hand-finishing.

## What exists today

`agents/creative-packager/` plus `agents/dashboard/routes/creatives.js` provide two
pathways over a shared canvas: **Studio** (one-off prompt + product images) and
**Ad Builder** (upload a reference ad, extract its style as text, generate variations,
export a placement ZIP).

Ad Builder deliberately produces text-free images. `agents/creative-packager/index.js`
appends `No text, logos, or labels` to every generation prompt and ships
`guides/*.png` marking copy zones for a Photoshop composite finish.

That behaviour stays. Ad Studio is a **new agent**, not a rewrite: the packager's job —
turning an approved master into per-placement crops — remains useful downstream.

## Evidence

Five probes were run against `gemini-3-pro-image` @2K using real product photography
from `data/product-images/`. Findings that shaped this design:

1. **Finished text-baked ads are achievable now.** Three deodorant concepts rendered
   at ~27s and roughly $0.13 each. One was ship-ready untouched.

2. **Text integrity fails intermittently, not systematically.** A dense two-column
   deodorant layout produced `THE RLALVJAY` for "THE REAL WAY" and `bactera` for
   "bacteria". The same concept rendered clean on other attempts. This is a hit-rate
   problem, so verify-and-retry is the correct tool.

3. **Naming the exact label string in the prompt appears to fix product-label drift.**
   Probes that did not name it produced `40ml`, `3 fl. oz` and `6 fl oz` against a true
   value of 2 fl oz / 60ml. The lotion probe named `8 fl. oz. - 236ml` literally and
   rendered it correctly in 3 of 3. Two variables differed between those probe sets
   (reference-photo count also changed), so this is the leading explanation rather than
   an isolated result. Reference count alone was ruled out: 1-reference and 4-reference
   renders both produced correct labels.

4. **A second generative pass over a finished plate is net harmful.** Feeding a
   text-free plate back in to typeset copy onto it introduced a `ORGANID COCONUT OIL`
   typo and, critically, **shifted all six ingredient images one row against their
   labels** — jojoba oil captioned as coconut oil, red palm captioned as jojoba. The
   second pass cannot interpret what the first pass drew. Every word was spelled
   correctly, so a spelling-only gate would pass this ad.

5. **Compositing a product cutout is rejected.** `data/brand/cutouts/` holds 19
   transparent product PNGs, but dropping one onto a generated scene produces mismatched
   lighting, contact shadow and perspective — it reads as a sticker. The product is
   generated in-scene, conditioned on real photographs.

## Architecture

New agent at `agents/ad-studio/index.js`. Five stages, one render per variation.

### 1. Angle selection

Model: `claude-opus-4-8`.

Inputs: `data/context/personas.json`, `data/context/voice-of-customer.md`, the product's
live PDP body copy, `data/keyword-index.json`, and the marketing tactic menu projected
from `.claude/skills/marketing-*/SKILL.md` (generated in memory at read time, as
`creative-packager` already does — never a committed copy).

Output: one concept per format in the rotation (6 by default, `--concepts` to narrow),
each naming a format from a **forced rotation** so a batch does not collapse into six
variants of one idea:

| Format | Source |
|---|---|
| Us-vs-them | giv "THE OLD WAY / THE GIV WAY" reference |
| Ingredient callout | giv "CLEAN INGREDIENTS" reference |
| Manifesto / negative framing | Lay's "OUR CHIPS ARE EXPENSIVE" reference |
| Problem-aware educational | Demand Gen doc, angle 2 |
| Top-X / third-party review | Demand Gen doc, angle 3 |
| Offer-focused | Demand Gen doc, angle 1 |

Each concept also records an awareness level, so the same angle can be re-entered at a
different level rather than duplicated.

These six are v1 and the rotation is meant to grow — the table is data, not structure, so
adding a format is a new entry plus its layout brief, not a code change.

### 2. Copy generation

Model: `claude-opus-4-8`. Copy is where revenue is made; this stays on the flagship.

Emits exact strings per named zone (headline lines, column headers, list items, bottom
bar). **Every factual claim carries a source pointer** — PDP body, `data/brand/brand-kit.json`,
`data/brand/product-catalog.json`, or a review. Claims with no source are rejected before
anything renders.

This gate exists because both a human and a model invented specs during the probes: an
unverified "FOUR INGREDIENTS" headline, and a model-invented `6 fl. oz.` volume. Same
failure class as the Blum/Texas origin drift — a plausible number nobody checked.
`SIX INGREDIENTS` passes the gate: it is the live product title.

### 3. Render

Model: `gemini-3-pro-image` @2K, single pass, one call per variation. 3 variations per
concept by default.

Prompt carries:
- the layout brief for the concept's format
- the exact copy strings from stage 2
- up to 4 real product photographs from `data/product-images/<handle>/<variant>/`
- the product's exact label strings named literally, including the volume marking
- brand palette from `data/brand/brand-kit.json`
- an instruction that the product is generated in-scene, lit and shadowed to match

### 4. Verification gate

Model: `claude-sonnet-5` (vision), one call per rendered artifact. Implemented in
`agents/ad-studio/verify.js`.

**This gate is a text-and-volume proofreader. It is not a quality judge, and it does not
look at the product.** Read both lists below before treating an `ok: true` as a verdict on
an ad. The original design described this stage as four checks; a full day of live running
found four separate defects in it, three of which are fixed and one of which is still open.
What follows is the state as of 2026-08-14, not the intent.

**What the gate verifies, as of now:**

- **Per-string presence.** For each exact string requested in stage 2, a pointed yes/no
  about that exact character sequence, plus the literal text of that region. Deliberately
  **not** an open transcription — see the history below. The model's "yes" is then
  re-checked mechanically against the text it itself quoted, at token boundaries, so a
  corrupted string has to survive two independent answers.
- **The product's volume marking**, on **every format in every mode**, by a dedicated
  check (`volumeVerdict`) rather than by string equality. It compares numbers, so
  separator and punctuation differences (`8 fl. oz. (236ml)` vs `8 fl. oz - 236ml`) never
  fail a render; it accepts `ILLEGIBLE`, because a product rendered small by design cannot
  be read and demanding it would burn every retry; and it fails a value that contradicts
  the truth. When it has no direct reading it falls back to the response's own transcript
  — and **that fallback can only ever fail a render, never pass one.**
- **Semantic image/label pairing**, on `finished` frames of formats that declare
  `pairsImagesWithLabels`. This check exists specifically to catch finding 4, which a text
  diff passes.
- **Obscured, cut-off and garbled text**, on `finished` frames.
- **Stray text on `plate` artifacts.** A plate must carry no text but the product's own
  label. Blank zones on a plate are the specification and are never a defect — the defect
  question is inverted per mode for exactly this reason.

**What the gate does NOT verify:**

- **Product fidelity. Nothing in this pipeline compares the rendered product to the
  reference photographs.** This is the largest open gap in the design. An `offer-focused`
  render of `coconut-lotion / pure-unscented` was **accepted on the first attempt** with a
  substantially redesigned label: the circular badge had moved from the middle of the label
  to the bottom and shrunk, the green leaf illustration was absent entirely, and the black
  band that carries the volume was gone, with the volume set as plain text on white. Every
  string the gate checks was present, and the volume value was correct — so it passed.
  Finding 5 and the render prompt both rest on the promise that *the product is generated
  in-scene, conditioned on real photographs*. That promise governs what we ask for. It is
  verified by nothing.
- **Copy quality and grammar.** The subhead on that same frame read
  `...that sink in instead of sitting on top of it` — "it" has no antecedent. The gate
  confirmed the string was rendered exactly as stage 2 wrote it, which it was.
- **Layout, composition, or aesthetic quality of any kind.** The gate has no opinion on
  whether an ad is worth running.

Failure → regenerate that variation, up to 2 retries (3 render attempts total, ~$0.39
worst case per variation). Variations still failing are marked `rejected` with their proof
report and are not packaged. A concept where all variations fail surfaces in the run report
rather than shipping silently.

#### Verification rebuild (2026-08-14) — the history, because it explains the shape

v1 of this gate shipped and then **passed a corrupted ad on attempt 1**. The rendered
`manifesto` frame read `THE MOISTURIZING CLAIM DOES MORE WORK TTHAN THE FORMLA`, carried
a garbled `CERAMIO OCOCONUT OIL` badge over a `4 FL oz / 118ml` volume on an 8 fl. oz.
product, and had the bottle physically sitting on top of the word "actually" in its own
closing line. `proof.json` recorded a clean transcript, `missing: []`, `ok: true`.

Three independent defects produced that pass:

1. **Open transcription invites auto-correction.** v1 asked the model to transcribe
   everything and then searched the transcript for the expected strings. A vision model
   reading text *semantically* repairs misspellings on the way out — it reported
   `FORMULA` where the pixels said `FORMLA`, and reconstructed an occluded word. The
   prompt already said "Do not correct spelling"; it did not help, because the request
   itself is a reading task and the repair happens in the reading. The verdict is now
   driven by a pointed per-string question, and the model's "yes" is re-checked against
   the text it itself quoted for that region. A transcript is still collected for
   `proof.json` as secondary diagnostic output and decides nothing.
2. **`productProminent: false` disabled the label check entirely.** The flag existed for
   a real reason — a 6pt label on a deliberately tiny product cannot be transcribed, and
   demanding it fails every attempt and burns the retries — but it removed `labelStrings`
   from the expected set wholesale, so a *wrong* label went unchecked, which is how the
   garbled badge and the false volume shipped. The volume is now checked on every format
   in a shape that tolerates illegibility and not falsehood. **The flag survives, narrowed
   to the non-volume label strings only. It must never be widened back into an off switch
   for the volume.**
3. **No occlusion or truncation check.** Added; any obscured, cropped or garbled piece of
   the ad's own copy fails the render. Text printed on the product's own label is out of
   scope — arc-set badge micro-copy is unreadable at any render size and asking about it
   made the verifier reject a known-good control frame.

The model was raised from Haiku to Sonnet in the same change. Haiku is what auto-corrected
`TTHAN`/`FORMLA` on the way out. This is one vision call per render, roughly a tenth the
cost of the render it guards, and it is the only thing that reads the ad before it goes
live — do not drop it back.

Regression-tested against both saved artifacts: the corrupted `manifesto` frame now
returns `ok: false` naming `TTHAN THE FORMLA` and the occluded closing line; a clean
`offer-focused` frame from the same product still returns `ok: true`. Re-judging a saved
12-frame batch under the rebuilt gate turned **12/12 accepted into 10 pass / 2 fail** —
one of the two carried a wrong volume on the product label.

Two further defects surfaced on the next live run, and are fixed:

4. **The occlusion check over-rejected on plates.** A Demand Gen plate is rendered
   text-free on purpose; its empty header bars and blank list rows are the deliverable.
   Asked what copy was illegible, the verifier answered honestly — "the header bars are
   empty" — and the gate failed 5 of 18 plates for being exactly right. **The defect
   question is now inverted per mode:** a finished frame is asked what copy is obscured,
   cut off or garbled; a plate is asked what text is *present* that should not be. Absence
   is never a defect on a plate; stray glyphs always are, and are the more expensive of
   the two defects, because the copy layer cannot remove pixels.
5. **The volume was asserted twice, by two mechanisms of different strictness.** The
   per-string check demanded the manifest's literal spelling while `volumeVerdict`
   compared numbers; one live run rejected three targets whose volume `volumeVerdict` had
   just reported as `match`. The volume was removed from the per-string expected set so it
   is asserted once, by the mechanism that owns it. That briefly opened a hole — a plate
   reported `productVolume: "ILLEGIBLE"` while transcribing a readable `0 fl. oz. • 236ml`
   (a misrendered `8`) elsewhere in the same response, and nothing was left to catch it.
   The transcript fallback described above closes it, in the fail-only direction.

Every one of these five was found by opening the rendered images. None was found by the
test suite, which stayed green at 1301–1308 passing throughout.

### 5. Platform packaging

| Platform | Ratios | Artifact |
|---|---|---|
| Meta feed / Stories / Reels | 1:1, 4:5, 9:16 | finished baked frame |
| Google Demand Gen | 1.91:1, 1:1, 4:5 | text-free plate + headlines and descriptions as separate upload fields |

Demand Gen mixes images, headlines and descriptions into combinations at serve time, so
the text-free plate is its **native** artifact, not a fallback. The plate is an
independent render from the same brief — composition will be close to the finished frame
but not pixel-identical. Pixel alignment was the one thing two-pass bought, and finding 4
shows it costs more than it returns.

Meta safe margins applied per the existing packager conventions.

## Verification status — read this before trusting an accept

The gate works, and it is not finished. An `ok: true` on an artifact means **"the text and
the volume check out"**. It does not mean "this ad is good", and it does not mean "this is
our product". Treat that sentence as the standing definition of an accept.

### Known open

1. **Product fidelity — the largest gap.** Nothing compares the rendered product to the
   reference photographs in `data/product-images/`. A first-attempt accept has already
   shipped a lotion bottle with the badge moved and shrunk, the leaf illustration missing,
   and the volume band deleted. Every gate the design has, that render passed. Until
   something reads the product, the accepted output of this pipeline needs a human looking
   at the bottle.
2. **Per-channel acceptance.** A concept is currently accepted only when **all six**
   platform targets pass. Meta and Demand Gen are different channels with different
   artifacts, and one bad Demand Gen plate marks a whole concept rejected even when its
   three Meta frames are publishable — which is throwing away paid renders that are ready
   to run. Acceptance should be reported per channel: Meta frames and Demand Gen plates
   pass or fail independently.
3. **Copy quality is unverified.** Stage 2 writes the strings, stage 4 confirms those exact
   strings were rendered. Nothing between them asks whether the sentence is good, or even
   grammatical — a live subhead ended `...instead of sitting on top of it` with no
   antecedent for "it".
4. **The standing rule.** Accept = text present, volume correct. Nothing more is claimed.

### How to judge a batch

The accept verdict is **necessary, not sufficient**. Open the images.

Every gate defect found so far — the auto-corrected headline, the disabled label check,
the missing occlusion check, the over-rejected plates, the double-asserted volume, and the
redesigned product label that is still unguarded — was found by looking at output. Not one
was found by the test suite, which stayed green at 1301–1308 passing through all of it. A
green suite here means the code does what it was written to do; it says nothing about
whether what it was written to do is enough.

Read `proof.json` when a frame fails, and look at the frame when it passes.

## Output layout

```
data/creatives/ad-studio/<run-id>/
  run.json                    # concepts, angles, sources, model IDs, costs
  <concept-slug>/
    copy.json                 # exact strings + per-claim source pointers
    v1/finished-1x1.png
    v1/finished-4x5.png
    v1/finished-9x16.png
    v1/plate-1x1.png          # Demand Gen
    v1/proof.json             # transcript, diff result, pairing result, verdict
    v2/ ...
    v3/ ...
```

## Model configuration

`config/creative-models.js` gains an `adStudio` block. Existing keys are untouched so
Studio and Ad Builder behaviour does not shift.

Separately, both image-model IDs in the repo are stale and are corrected in the same PR:

- `config/creative-models.js` — `imageGen` is `gemini-2.5-flash-image`
- `agents/dashboard/lib/creatives-store.js` — lists `gemini-3.1-flash-image-preview` and
  `gemini-3-pro-image-preview`

`gemini-3-pro-image` and `gemini-3.1-flash-image` are both GA. Verified against the
models endpoint on 2026-08-14.

## Out of scope

- **Veo 3.1 video.** Reachable on the same API key; composes later by feeding an approved
  finished static in as a first frame. Deferred until static is landing across both channels.
- **Amazon listing images.** Distinct compliance rules (main image must be product on pure
  white, no text or graphics). Covered by `marketing-product-image-stack`.
- **Cutout compositing.** Rejected, see finding 5.
- **Changes to Studio or Ad Builder behaviour**, beyond the model-ID correction.

## First target

Lotion (`coconut-lotion`, $30) — the revenue leader. `coconut-breeze` has four reference
photographs available and the PDP carries strong mechanism copy plus a live, sourced
"only 6 clean ingredients" claim.

## Testing

- Pure functions unit-tested: format rotation, claim-source validation, text diffing,
  proof-report shaping.
- Gemini and Anthropic calls stubbed. Note that a stubbed-fetch test on Node 22 can hang
  and report `cancelled` rather than `fail` — check the cancelled count in `node --test`
  output, not just the fail count.
- One end-to-end run against the lotion before any batch run, per the repo rule that a fix
  is proven on one item first.
- `nvm use` before testing. Server is Node 22 LTS.

## Cost

~$0.13 per 2K render. **Every platform target is an independent render — the three
Demand Gen plates are not free copies of the Meta frames**, which an earlier version of
this section missed, understating the true cost by roughly 2x.

Per concept: 6 platform targets × 3 variations = **18 renders ≈ $2.34** before retries,
up to $7.02 if every artifact needs all 3 attempts.

A default invocation (`--product <handle>` with no other flags) runs the full six-format
rotation:

| | renders | ≈ cost |
|---|---|---|
| Default run, no retries | 6 formats × 3 variations × 6 targets = **108** | **$14.04** |
| Default run, worst case (3 attempts everywhere) | 324 | $42.12 |
| Ceiling — `--max-renders`, default 120 | 120 | $15.60 |

`--max-renders` counts every render attempt, retries included. When the ceiling is
reached the run stops rendering, still writes `run.json`, and records the stop plus the
name of every skipped artifact under `budget` — it never truncates silently.
`--variations` is capped at 10 for the same reason.

Verification adds a **Sonnet** vision call per render (raised from Haiku on 2026-08-14 —
see the verification rebuild above). At 2K that is roughly $0.01–0.02 a call, about a
tenth of the $0.13 render it guards, so under ~15% on top of every figure in the table.
Metered through the existing `lib/llm-usage` path so it lands in
`scripts/llm-cost.mjs --week`.
