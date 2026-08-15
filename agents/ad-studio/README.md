# Ad Studio

Generates publish-ready **static ad creatives** for Real Skin Care — headline, body
copy, comparison columns and the product itself baked into one finished frame — for
Meta (feed/Stories/Reels) and Google Demand Gen.

This is not the same job as `agents/creative-packager`. The packager turns an
**approved master** into placement-sized crops for Ad Builder / Studio, and
deliberately produces text-free images with a Photoshop-guide overlay. Ad Studio
produces the finished ad itself, copy included, end to end, with no manual
finishing step.

Spec: `docs/superpowers/specs/2026-08-14-ad-studio-design.md`
Plan: `docs/superpowers/plans/2026-08-14-ad-studio.md`

## Usage

```bash
node agents/ad-studio/index.js --product <handle> [--variant <name>] \
  [--formats <key1,key2,...>] [--variations <n>] [--max-renders <n>] [--dry-run]
```

| Flag | Required | Meaning |
|---|---|---|
| `--product` | yes | Product handle — must exist in both `data/product-images/manifest.json` and `data/brand/product-catalog.json`. |
| `--variant` | no | Scent/variant name (e.g. `coconut-breeze`). Selects `data/product-images/<imageDir>/<variant>/` for reference photos and is folded into the product's label strings (see below). Omit for a single-variant product. |
| `--formats` | no | Comma-separated format keys from `agents/ad-studio/formats.js` (`us-vs-them`, `ingredient-callout`, `manifesto`, `problem-aware`, `top-x-review`, `offer-focused`). **Pass it.** Omitting it (or passing it empty) renders the **whole six-format rotation** — 108 renders ≈ $14 at the default `--variations 3`. Normal use is one or two keys; the full rotation is a deliberate sweep, not a default you should reach by not typing a flag. |
| `--variations` | no | Variations per concept — each is 6 renders. Default `3`, maximum `10`. |
| `--max-renders` | no | Hard ceiling on render attempts for the whole run, retries included. Default `120` (≈$15.60). On reaching it the run stops rendering, still writes `run.json`, and lists every skipped artifact under `budget`. |
| `--dry-run` | no | Generates copy and runs the claim gate, prints the result, and exits before any image is rendered. See below. |

**Read the Cost section before running without `--dry-run`.** A default invocation —
no `--formats` — is the entire rotation, 108 renders ≈ $14. Scope every real run with
`--formats`.

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
   photographs. The product is generated in-scene, never composited.
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
6. **Package** (`packaging.js`) — writes the six platform artifacts (3 Meta finished
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

`run.json` also carries `cost` (`renders`, `perRenderUsd`, `estimatedUsd`) and `budget`
(`maxRenders`, `stopped`, `skipped[]`).

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
| One variation of one concept (6 targets) | 6 | $0.78 |
| One concept, `--variations 3` | 18 | $2.34 |
| **Default run** — 6 formats × 3 variations × 6 targets | **108** | **$14.04** |
| Default run, worst case (3 verify attempts everywhere) | 324 | $42.12 |
| `--max-renders` default ceiling | 120 | $15.60 |

At ~$0.13 per Gemini 3 Pro 2K render, plus one **Sonnet** vision call per render for the
verify gate — roughly $0.01–0.02 on a 2K frame, so about a tenth of the render it is
guarding and well under 15% on top of the table above. That is the whole argument for
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
