# Ad Studio

Generates publish-ready **static ad creatives** for Real Skin Care — headline, body
copy, comparison columns and the product itself baked into one finished frame — for
Meta (feed/Stories/Reels) and Google Demand Gen.

This is not the same job as `agents/creative-packager`. The packager turns an
**approved master** into placement-sized crops for Ad Builder / Studio, and
deliberately produces text-free images with a Photoshop-guide overlay. Ad Studio
produces the finished ad itself, copy included, end to end, with no manual
finishing step.

> **An accepted render is checked, not curated.** The gate checks text, the volume marking,
> whether the rendered product is physically our product, and whether the frame is usable —
> copy clear of the platform's UI chrome, and legible at thumb size. What it does **not** do
> is decide the ad is *good*: that is a 1-5 score recorded on every accepted frame, never a
> pass/fail. Rank by `critique.score`; do not read `ok: true` as "ship it".

Spec: `docs/superpowers/specs/2026-08-14-ad-studio-design.md`
Plan: `docs/superpowers/plans/2026-08-14-ad-studio.md`

## Usage

```bash
node agents/ad-studio/index.js --product <handle> --formats <key1,key2,...> \
  [--variant <name>] [--targets <spec>] [--variations <n>] [--max-renders <n>] [--dry-run]
```

| Flag | Required | Meaning |
|---|---|---|
| `--product` | yes | Product handle — must exist in both `data/product-images/manifest.json` and `data/brand/product-catalog.json`. |
| `--variant` | no | Scent/variant name (e.g. `coconut-breeze`). Selects `data/product-images/<imageDir>/<variant>/` for reference photos and is folded into the product's label strings (see below). Omit for a single-variant product. |
| `--formats` | **yes** | Comma-separated format keys from `agents/ad-studio/formats.js` (`us-vs-them`, `ingredient-callout`, `manifesto`, `problem-aware`, `top-x-review`, `offer-focused`). **Required.** It used to be optional, and omitting it meant the whole six-format rotation — 108 renders ≈ $14 from a flag nobody typed. An unknown key is rejected with the valid list. |
| `--targets` | no | Which platform targets to render. `all`, `meta`, `demand-gen`, or `<platform>=<ratio>` (e.g. `meta=9:16`), comma-separated. Default **`meta=1:1,meta=4:5`** — see below. |
| `--variations` | no | Variations per concept — each is one render per selected target. Default `1`, maximum `10`. |
| `--max-renders` | no | Hard ceiling on render attempts for the whole run, retries included. Default `120` (≈$15.60). On reaching it the run stops rendering, still writes `run.json`, and lists every skipped artifact under `budget`. |
| `--dry-run` | no | Generates copy and runs the claim gate, prints the result, and exits before any image is rendered. See below. |

**The default run is deliberately the cheapest useful one:** one format, one variation,
the two Meta feed ratios — **2 renders ≈ $0.26**. Everything above that is opted into.

**Why 9:16 is not in the default target set.** Meta draws its own UI over the top ~14% and
bottom ~20% of a Stories/Reels frame, and `critique.js` hard-fails ad copy placed there.
All six `layoutBrief`s run a headline to the top edge and a bar to the bottom edge, and
the image model keeps doing so even when the render prompt names the bands explicitly
(`buildRenderPrompt`'s `SAFE ZONE` block). **Measured: 6 of 6 attempts across two live
runs failed**, at 3 paid attempts each. `--targets meta=9:16` still works and is the right
flag the day a vertical-first format exists — it is just not something to pay for by
accident. The gate is correct here; the layouts are what need to change.

Example — the one-concept proving run used before any batch:

```bash
node agents/ad-studio/index.js --product coconut-lotion --variant coconut-breeze \
  --formats ingredient-callout --dry-run
```

## The five stages

1. **Format rotation** (`formats.js`, `selectFormats`) — a forced rotation over data,
   not an LLM call. One concept per selected format so a batch cannot collapse into
   six variants of one idea. Each format also declares `pairsImagesWithLabels`, which
   the verification stage reads.
2. **Copy** (`copy.js`, model: `claude-opus-4-8`) — exact per-zone strings plus a
   `claims` array. Every factual claim must name a `sourceId` (`pdp`, `catalog`,
   `brandKit`, `reviews`) and quote its evidence verbatim.
3. **Claim gate** (`claims.js`, `assertClaimsSourced`) — checks every factual claim's
   evidence actually appears in its named source and **throws, stopping the whole
   run**, if any claim is unsourced or its evidence doesn't match. Runs after every
   copy call, `--dry-run` or not.
4. **Render** (`render.js`, model: `gemini-3-pro-image` @2K) — **one generative pass**
   per variation per platform target, conditioned on up to 4 real reference
   photographs **and the manifest's prose description of the physical product**
   (`PHYSICAL FORM` in the prompt). The product is generated in-scene, never composited.
5. **Verify** (`verify.js`, model: `claude-sonnet-5`) — four checks, all required:

   - **Per-string checks.** For each requested string, a *pointed* question — does this
     exact character sequence appear, yes or no, and what does that region actually
     say. **Not** an open transcription. A vision model asked to transcribe repairs
     misspellings semantically on the way out, so a transcript-driven gate is blind to
     exactly the corruption class it exists to catch; it reported `FORMULA` where the
     pixels said `FORMLA` and passed the ad on attempt 1. The model's "yes" is then
     re-checked against the text it itself quoted, so a corrupted string has to survive
     two independent answers. A transcript is still collected for `proof.json` but
     decides nothing.
   - **Product volume.** Read-or-`ILLEGIBLE`, on **every** format. `ILLEGIBLE` passes
     (the legitimate small-product case), a value agreeing with the real volume passes,
     a value that contradicts it **fails**. Numbers are compared, not strings, so
     punctuation never fails a render and a wrong number always does.
   - **Defects — the question is inverted per mode.** On a **finished frame**, any of the
     ad's own typeset copy that is obscured, cut off at the frame edge, or garbled fails
     the render; a live frame had the product bottle sitting on top of the word "actually"
     in its own closing line and the verifier silently reconstructed it. On a **plate**
     that question has no correct answer — the copy zones are empty *by specification*,
     because Demand Gen mixes the text assets in at serve time — so asking it failed 5 of
     18 plates on a live run for reporting empty header bars and blank list rows as
     "obscured". A plate is asked the opposite question instead: **what text is PRESENT
     that should not be.** Absence is never a defect there; any lettering, word or number
     anywhere but the product's own printed label is, spelled correctly or not (the same
     run rendered `A LIBCDEFGHIJKLM NOPQRSTUVWXYZ` into a bar that was supposed to be
     clean). Stray text on a plate is the more expensive defect of the two — the copy
     layer cannot remove pixels. `normalizeDefects` backstops the prompt: on a plate, a
     defect entry that quotes no rendered characters (a bracketed description of a region,
     or the word "blank") is a report of absence and is dropped. Text printed on the
     *product's* label is out of scope in **both** modes — arc-set badge micro-copy cannot
     be read reliably at any render size, and asking about it made the verifier reject a
     known-good control.
   - **Product fidelity — is the rendered product actually our product?** The verify call
     carries the first **two reference photographs** alongside the render, and asks a
     *pointed* question per attribute: `silhouette`, `closure`, `labelLayout`,
     `labelGraphics`, `containerColour` (`FIDELITY_ATTRIBUTES` in `verify.js`). Never one
     open "does this match?" — R1's finding again: an open question is answered towards
     yes. Answers are three-valued and follow `volumeVerdict`'s proven shape:
     `CANNOT_TELL` **passes** (the small-product case on `manifesto`/`problem-aware`),
     `MISMATCH` **fails**, and a response carrying *no* fidelity answers at all while
     reference photos were sent **fails** — a check that returns nothing is
     indistinguishable from a check that was never wired up. Runs in **both** modes:
     unlike the defect question this one does not invert, and a plate is nothing but the
     product. With no reference photos on file the check is off, never a hard fail.

     Why it exists: a live `ingredient-callout` frame was **accepted on attempt 1** with a
     bottle that had no black accent bar, no leaf illustration, and the badge micro-copy
     set beside a flat glyph instead of inside the circular badge. Every expected string
     was present and correctly spelled, so four text checks had nothing to fail. A human
     rejected it in one glance. `tests/fixtures/ad-studio/accepted-wrong-bottle-2026-08-14.png`
     is that frame.

     **Two narrowings are load-bearing and were each paid for with a false positive.**
     The first cut rejected a *real photograph* of the product, reporting gloss bands and
     a shoulder gradient as label graphics. So: (a) photographic styling — lighting,
     gloss, specular, shadow, background, angle, crop — is named in the prompt as never a
     mismatch; and (b) `labelGraphics` asks only whether the **reference's** elements are
     missing, moved or reshaped, and explicitly not whether extra elements appeared,
     because every false positive found was an "extra" that turned out to be a highlight.
     Do not widen either one back.

   - **Pairing**, on **finished frames** of formats that pair a picture with a label.
     Not applied to Demand Gen plates: a plate is text-free by construction, so it has
     no labels to pair anything with, and demanding pairings there made every plate of
     a pairing format an unavoidable hard fail.

   Text matching is anchored at token boundaries — an unanchored substring match
   accepted `18 fl. oz.` for an expected `8 fl. oz.`, the exact false spec this gate
   exists to stop. `renderWithRetry` retries up to 3 attempts total before accepting
   the failure.

   **The model is Sonnet, not Haiku, on purpose.** Haiku auto-corrected `TTHAN`/`FORMLA`
   into clean text and passed a corrupted ad. This is one vision call guarding a ~$0.13
   render that nobody else reads before it goes live; do not drop it back to save
   pennies on the cheapest call in the pipeline.
6. **Layout critique** (`critique.js`, model: `claude-sonnet-5`) — a **second, separate**
   vision call, run only on a frame that already passed stage 5, and only on **finished
   frames** (a plate carries no typeset copy, so neither check has an answerable question
   and the call is skipped rather than paid for). Split in two on purpose:

   - **Part A — objective, HARD FAIL, feeds the existing retry loop.**
     **Safe zone:** on **9:16 only**, is any of the ad's own copy inside the bands Meta
     draws its UI over? Meta unified Stories and Reels onto one 9:16 safe zone in March
     2026 — top 14%, sides 6%, bottom 20% (Stories) to 35% (Reels). The gate uses the
     **Stories** depth; Reels' bottom 35% plus the top 14% puts half the frame off-limits
     and these six formats were not laid out for that, so a frame that clears Stories but
     not Reels is reported in the notes for a human to weigh. 1:1 and 4:5 are **not**
     gated — nothing is drawn over a feed image, so placement there is a preference, and
     gating a preference costs three paid renders every time it fires. The bands are
     stated to the model as **fractions** ("the top one-seventh"), never percentages: a
     vision model eyeballs a fraction far more reliably than it estimates 14%, and the
     whole check rests on that estimate.
     **Legibility:** on every finished ratio, can the copy be read at thumb size —
     contrast and size only, never typeface or colour taste.
     Both are three-valued; `CANNOT_TELL` passes, the same tolerance `volumeVerdict`
     gives `ILLEGIBLE`.

   - **Part B — subjective, RECORDED, never blocks.** A 1-5 quality score with notes,
     written to `proof.json` and `run.json`. Making "is this a good ad?" a hard fail
     would reject good work and pay for three attempts doing it — the exact
     false-positive class that cost two rounds on the fidelity check. The score exists to
     **rank accepted frames**, which the UI spec says is where the operator's time goes.

   **Why a separate call and not more sections in `buildVerifyPrompt`.** That prompt's
   central instruction is *"You are NOT reading for meaning. Do not repair, complete,
   normalize or auto-correct anything"* — a deliberately literal pixel read, arrived at
   over five fix rounds. Art direction is the opposite instruction. Asking one call to do
   both contradicts its own framing and risks a gate that was expensive to stabilise.

7. **Package** (`packaging.js`) — writes the six platform artifacts (3 Meta finished
   frames + 3 Demand Gen text-free plates) and buckets the concept's copy into Demand
   Gen's headline/long-headline/description fields.

## Output layout

```
data/creatives/ad-studio/<run-id>/
  run.json                        # totals, models, per-concept/variation results
  <concept-slug>/                 # concept-slug is the format key, e.g. ingredient-callout
    copy.json                     # { zones, claims } for this concept
    demand-gen-assets.json        # headlines/longHeadlines/descriptions/dropped
    v1/
      finished-1x1.png            # Meta, baked copy
      finished-4x5.png
      finished-9x16.png
      plate-1_91x1.png            # Demand Gen, text-free except the product's own label
      plate-1x1.png
      plate-4x5.png
      proof.json                  # per-artifact { ok, attempts, reasons, missing, transcript, ... }
    v2/ ...
    v3/ ...
```

`run.json` also carries `cost` (`renders`, `perRenderUsd`, `estimatedUsd`), `budget`
(`maxRenders`, `stopped`, `skipped[]`), and:

- **`ranking[]`** — accepted frames, best `critique.score` first. The frame worth looking
  at is the first line of the file, not something found by opening every PNG. Rejected
  frames are excluded: a frame that failed the gate is not a candidate to ship, whatever
  an art director thought of its composition. Unscored accepted frames sort last.
- **`scoreSummary`** — this run's mean against the rolling baseline.

## The score baseline

Every scored frame is appended to **`data/reports/ad-studio/scores.jsonl`** (one row per
frame: run id, product, format, variation, artifact, score, ok). Rejected frames are
included — excluding them would bias the baseline upward by construction.

The baseline is read BEFORE the current run's rows are appended, so a run is never
compared against a baseline containing itself. Below 50 observations the summary says so
rather than reporting a delta: six frames is not a baseline, and a delta off n=6 invites
reading noise as a trend. Scores are only really comparable **within a format** —
`manifesto` renders the product small and understated, `us-vs-them` is a comparison table,
and they are not being judged on the same thing. `byFormat` is the number that means
something.

This file is a few bytes per frame and must outlive the images, which
`scripts/prune-ad-studio.mjs` deletes on a 90-day window.

## Housekeeping

`data/creatives/ad-studio/` is gitignored (one default run is ~137 MB of 2K renders) and
accumulates with every run. The production box has a 24 GB disk and a full one has
already cost this project four days of cron (see CLAUDE.md's Server Deployment notes) —
`scripts/prune-ad-studio.mjs` exists so this directory doesn't do that again.

Policy — "keep what we need, ditch the rest":

- **Keep forever, any age:** every JSON file (`run.json`, `copy.json`, `proof.json`,
  `demand-gen-assets.json`). A few KB each, and the permanent record of what happened —
  a run stays auditable at a few KB even after its images are gone.
- **Delete, after a grace period (default 7 days):** image artifacts belonging to a
  **rejected** variation. Inspect a failure the day it happens, not a month later — the
  rejected frame's `proof.json` survives regardless, so the reason is never lost.
- **Delete, unconditionally (default 90 days):** image artifacts from runs older than
  the retention window, accepted or not.

Accepted vs. rejected is read from `run.json`'s `results[].variations[].ok`, never
inferred from filenames. A run with no readable `run.json` (aborted mid-run) has its
images treated as rejected and subject to the grace period — never treated as accepted,
never skipped.

```bash
node scripts/prune-ad-studio.mjs                                    # dry run (default) — prints the plan, deletes nothing
node scripts/prune-ad-studio.mjs --apply                            # actually delete
node scripts/prune-ad-studio.mjs --rejected-days 3 --run-days 60 --apply
```

**Dry-run is the default, not `--apply`.** This inverts the repo's usual
apply-by-default agent convention (see CLAUDE.md's Autonomy Principle) on purpose — the
directory is gitignored, so deleted bytes are gone for good, and the safe mode has to be
the one you get by accident.

## Cost

Every platform target is an **independent render** — the three Demand Gen plates are not
free crops of the Meta frames.

| | renders | ≈ cost |
|---|---|---|
| **Default** — one format, one variation, Meta feed | **2** | **$0.26** |
| One format, `--variations 3`, Meta feed | 6 | $0.78 |
| One format, one variation, `--targets all` | 6 | $0.78 |
| One format, `--variations 3`, `--targets all` | 18 | $2.34 |
| Six formats, `--variations 3`, `--targets all` (the old default) | 108 | $14.04 |
| `--max-renders` default ceiling | 120 | $15.60 |

Retries are charged. A frame that needs all 3 attempts costs 3 renders, so a nominally
2-render run can bill 6 in the worst case.

**The Gemini image model has a hard quota of 250 renders per project per day.** A default
full-rotation run is 108, so two of them plus retries exhausts the day — the API then
returns 429 with a ~19h retry delay and every remaining target of the run errors out
(per-target resilience keeps the run alive and still writes `run.json`). Scope runs with
`--formats`; do not discover this ceiling mid-batch.

The **layout critique** adds one more Sonnet call, but only on finished frames that
already passed verify — roughly **$0.01 each, under $1 on a default run**.

At ~$0.13 per Gemini 3 Pro 2K render, plus one **Sonnet** vision call per render for the
verify gate — ~$0.04 on a 2K frame now that the call also carries two reference
photographs for the fidelity check (~14k input tokens), so still under a third of the
render it is guarding. That is the whole argument for
raising it off Haiku: the gate is the cheapest thing in the pipeline and the only thing
between a corrupted headline and a live ad. `--dry-run` costs one Opus copy call per
format and renders nothing. Scope a run with `--formats` and `--variations` rather than
relying on the ceiling.

## Global constraints (non-obvious, do not relax)

- **Single-pass render only.** A rendered image (finished or plate) is never fed back
  into a second generative pass. Design-probe evidence: a second pass over a
  text-free plate spelled every word correctly while shifting the supporting
  ingredient photos one row against their labels — jojoba captioned as coconut oil.
  A text-only gate would have shipped that ad.
- **No cutout compositing.** `data/brand/cutouts/` is never read by this agent. The
  product is generated in-scene, conditioned on real reference photographs, so
  lighting, contact shadow and perspective match the rest of the frame.
- **The manifest's physical description reaches BOTH the renderer and the gate.**
  `manifestEntry.productDescription` was being mined for label strings and volume
  markings and then dropped — so the renderer was told exactly what the label *said* and
  nothing about what the bottle *was*, while the description on file already read "tall,
  slim lotion bottle shape" and "a black horizontal accent bar behind the variant name
  text". It rendered neither, and the gate had no shape to compare against. It now flows
  through `product.physicalDescription` into `buildRenderPrompt`'s `PHYSICAL FORM` block
  and into `buildVerifyPrompt`'s fidelity section. The sister agent learned this first
  (PR #314, "faithful product renders … pass product descriptions"); do not un-learn it
  here. A product whose manifest entry has a thin `productDescription` gets a weaker
  render and a weaker check — improving that prose is the cheapest quality lever in this
  pipeline.
- **Exact label strings, every time.** `product.labelStrings` (built by
  `buildLabelStrings` in `index.js` from quoted label text and the volume marking in
  the manifest's `productDescription`, plus `--variant`) is named literally in every
  render prompt — every format, both modes — and is additionally folded into the
  verification gate's expected-text list for formats that declare
  `productProminent: true`. That flag is a **legibility** judgement, not a priority
  one: `manifesto` renders the product "small and understated at the bottom center"
  and `problem-aware` "present but not dominant", and no vision model can read a 6pt
  brand mark off those, so demanding it back would fail every attempt and burn the
  retries. The model is still told exactly what the label says on those formats, so it
  still cannot invent a volume.

  **The flag no longer switches the label check off — only the hard expected strings.**
  It used to strip `labelStrings` out of the gate's expected set wholesale, so on
  `manifesto` and `problem-aware` a wrong label was not merely un-demanded, it was
  *un-checked*. That is how a live frame shipped `4 FL oz / 118ml` on an 8 fl. oz.
  bottle with `ok: true` on attempt 1. The **volume marking** is now verified on every
  format regardless of the flag, tolerant of illegibility and intolerant of falsehood
  (`verify.js`'s `volumeVerdict`, wired through `expectedForFormat`'s `volumeStrings`).
  Do not widen the flag back into an off switch for the volume.

  **The volume is checked once, and never by the per-string check.**
  `expectedForFormat` subtracts the volume markings from the expected set in *both*
  modes; every other label string (brand mark, product type, variant name) is demanded
  back exactly as before on a `productProminent` format. The two mechanisms have
  different strictness and were contradicting each other inside one verdict:
  `volumeVerdict` compares numbers and tolerates punctuation, because the manifest
  writes `8 fl. oz. (236ml)` while the bottle prints `8 fl. oz - 236ml`; the per-string
  check demands the literal sequence and failed it. A live run rejected three targets
  whose volume `volumeVerdict` had just reported as `"status": "match"`. If the volume
  gate ever needs to be stricter, make `volumeVerdict` stricter — do not re-add the
  volume to the expected set.

  One thing the duplicate was accidentally covering moved into `volumeVerdict` with it:
  the verifier answering `"productVolume": "ILLEGIBLE"` while transcribing a readable,
  wrong volume elsewhere in the same response (a live plate reported `ILLEGIBLE` and
  transcribed `0 fl. oz. • 236ml` — a misrendered `8`). `volumeVerdict` falls back to
  the response's transcript when, and only when, it has no direct reading, and that
  fallback can only *fail* a render, never pass one.

  **`main()` aborts if this list comes back empty** — an empty
  list is exactly how the image model invents a volume that was never on the bottle
  (a design probe rendered `6 fl. oz.` on a 2 fl oz bottle when the label text
  wasn't named). There is no flag to skip this check.

  **Net weight counts as a volume marking.** `readVolume` understood fluid ounces and
  millilitres only, so the lip balm (`0.15 oz • 4.25g`) and the bar soap (`3.4 oz • 84g`)
  were invisible to `volumeVerdict` — it reported `no-volume-on-file` and passed any
  weight the model invented. Worse, since `expectedForFormat` only subtracts *recognised*
  markings from the expected set, those two stayed in it and were checked by the strict
  literal matcher instead — the exact mechanism R2b removed for the lotion after it
  rejected three correct renders over punctuation. Weight is now parsed alongside volume
  (`wtOz`, `g`). The weight pattern deliberately cannot match a *fluid* ounce marking:
  `8 fl. oz.` puts `fl.` between the number and `oz`, which `\s*` cannot cross.

  It holds only **spec-bearing** label text — brand mark, product type, variant name
  and above all the volume marking. Two things are deliberately excluded:

  - **The catalog title** (`data/brand/product-catalog.json`) — marketing/SEO copy,
    not text printed on the physical label. Feeding it in both told the image model
    to print it on the bottle and made the verify gate require it to appear.
  - **Badge inscriptions** — the "Organic Coconut Oil + Essential Oils" style
    micro-copy set on a curved arc inside a small circular badge. It is decorative,
    no product spec is falsifiable through it, and at roughly 8px on a curve the
    verify gate's vision model cannot transcribe it reliably (on a plate that was in
    fact correct it read `["ORGANIC","COCONUT","ESSENTIAL OIL"]` — a dropped word
    and a lost plural). Requiring text that cannot be read back rejects good renders
    and burns three paid attempts per target.

  The badge rule keys on the manifest naming the element next to the quote — either
  `...circular badge noting "..."` or `..."..." badge, ...` — and is anchored tight
  on both sides. **Do not loosen it.** An earlier unanchored version reached past the
  previous quote and silently ate `"hand soap"` and `"toothpaste"`, which are product
  types and very much spec-bearing; `tests/agents/ad-studio-orchestrator.test.js`
  now pins the volume marking and the variant name against exactly that.
- **The claim gate hard-blocks, with no override.** `assertClaimsSourced` is never
  wrapped in try/catch. An unsourced factual claim stops the entire run before
  anything is rendered — money is never spent on a concept with an unverifiable
  claim in it.

## Requires

`ANTHROPIC_API_KEY` in `.env` always (copy + claim gate run even under `--dry-run`).
`GEMINI_API_KEY` only when not running `--dry-run`.
