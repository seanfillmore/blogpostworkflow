# Ad Studio — design

**Date:** 2026-08-14
**Branch:** `feature/ad-studio`
**Status:** approved design, pending implementation plan

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

Model: `claude-haiku-4-5` (vision).

Two checks, both required:

- **Text diff** — transcribe every word visible in the render and diff against the exact
  strings requested in stage 2, including the product's own label.
- **Semantic pairing** — where a layout pairs a supporting image with a label (ingredient
  rows, comparison columns), confirm each image depicts what its label says.

The pairing check exists specifically to catch finding 4, which a text diff passes.

Failure → regenerate that variation, up to 2 retries (3 render attempts total, ~$0.39
worst case per variation). Variations still failing are marked `rejected` with their proof
report and are not packaged. A concept where all variations fail surfaces in the run report
rather than shipping silently.

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

~$0.13 per 2K render. 3 variations across 3 ratios ≈ $1.20 per concept before retries.
Verification adds a Haiku vision call per render. Metered through the existing
`lib/llm-usage` path so it lands in `scripts/llm-cost.mjs --week`.
