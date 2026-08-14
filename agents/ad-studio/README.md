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
  [--formats <key1,key2,...>] [--variations <n>] [--dry-run]
```

| Flag | Required | Meaning |
|---|---|---|
| `--product` | yes | Product handle — must exist in both `data/product-images/manifest.json` and `data/brand/product-catalog.json`. |
| `--variant` | no | Scent/variant name (e.g. `coconut-breeze`). Selects `data/product-images/<imageDir>/<variant>/` for reference photos and is folded into the product's label strings (see below). Omit for a single-variant product. |
| `--formats` | no | Comma-separated format keys from `agents/ad-studio/formats.js` (`us-vs-them`, `ingredient-callout`, `manifesto`, `problem-aware`, `top-x-review`, `offer-focused`). Omitted or empty → the full six-format rotation. |
| `--variations` | no | Renders per concept. Default `3`. |
| `--dry-run` | no | Generates copy and runs the claim gate, prints the result, and exits before any image is rendered. See below. |

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
5. **Verify** (`verify.js`, model: `claude-haiku-4-5`) — transcribes every visible
   string and, for formats that pair a picture with a label, checks the pairing too.
   `renderWithRetry` retries up to 3 attempts total before accepting the failure.
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

## Global constraints (non-obvious, do not relax)

- **Single-pass render only.** A rendered image (finished or plate) is never fed back
  into a second generative pass. Design-probe evidence: a second pass over a
  text-free plate spelled every word correctly while shifting the supporting
  ingredient photos one row against their labels — jojoba captioned as coconut oil.
  A text-only gate would have shipped that ad.
- **No cutout compositing.** `data/brand/cutouts/` is never read by this agent. The
  product is generated in-scene, conditioned on real reference photographs, so
  lighting, contact shadow and perspective match the rest of the frame.
- **Exact label strings, every time.** `product.labelStrings` (built in `index.js`
  from quoted label text and the volume marking in the manifest's
  `productDescription`, plus `--variant`) is named literally in every render prompt
  and is also folded into the verification gate's expected-text list for finished
  frames. **`main()` aborts if this list comes back empty** — an empty list is
  exactly how the image model invents a volume that was never on the bottle (a
  design probe rendered `6 fl. oz.` on a 2 fl oz bottle when the label text wasn't
  named). There is no flag to skip this check. `product.labelStrings` deliberately
  excludes the catalog title (`data/brand/product-catalog.json`) — that's
  marketing/SEO copy, not text printed on the physical label, and feeding it in
  both told the image model to print it on the bottle and made the verify gate
  require it to appear.
- **The claim gate hard-blocks, with no override.** `assertClaimsSourced` is never
  wrapped in try/catch. An unsourced factual claim stops the entire run before
  anything is rendered — money is never spent on a concept with an unverifiable
  claim in it.

## Requires

`ANTHROPIC_API_KEY` in `.env` always (copy + claim gate run even under `--dry-run`).
`GEMINI_API_KEY` only when not running `--dry-run`.
