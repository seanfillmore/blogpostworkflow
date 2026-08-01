# Handoff — Sensitive Skin Set gallery

**Written:** 2026-08-01, straight after the Reset gallery shipped (PR #401, merged).
**Worktree:** `.claude/worktrees/sensitive-set` on `feature/sensitive-skin-set-gallery`.
**Prerequisite reading:** `docs/bundle-media-plan.md` §6 "Sensitive Skin Set — $46.80",
then the RENDER/GENERATE routing in §3 and the variant-scoping section.

## Why this bundle next

It is the **designated hero offer** ($46.80, compare-at $58), the only bundle that has
sold a unit in three months, and the only one with any search presence at all — 211
impressions at position 34.9. Its gallery is **one image, with no alt text**.

Of everything left in the plan that is the largest gap between a product's importance
and its imagery, and the Prime Directive points straight at it.

It is also the *easiest* of the remaining bundles:

- **One variant** (`Default Title`). No per-scent duplication, and **no alt-text
  scoping at all** — the gang convention only matters where variants exist. That
  removes the single fiddliest thing about the Reset.
- The plan's §6 spec says **"Blocked: none. Every frame here is composable from
  existing assets today."**
- Contents are just two items: 1 × Body Cream and 1 × Body Lotion, both Pure Unscented.

## 🚨 Read this before building anything: the current image is wrong

The single live image (`v20.webp`, 2048², no alt) misrepresents the product in two
independent ways. It is AI-generated and was not audited.

**1. It shows products that are not in the box.** Alongside the lotion and cream it
shows a **hand & body soap** and **four lip balms**, plus props. The roster says the set
contains two items. A buyer looking at that image reasonably expects seven.

**2. Both volumes are fabricated.**

| | On the image | Actually |
|---|---|---|
| Body Lotion | `0 fl. oz · 300ml` | **8 fl. oz · 236ml** |
| Body Cream | `4 fl. oz · 150ml` | **4 fl. oz · 118ml** |

"0 fl. oz" is not even a plausible wrong number.

**This is the hero offer's only image.** Fixing it is worth more than any new frame, and
it should be replaced rather than have alt text added — writing alt text for a
misleading image only makes the misrepresentation machine-readable.

Do not reuse this file as a generation reference. It is exactly the label-fidelity
failure documented in the media plan's §3.

## The frame stack, with corrections

§6 specs five frames. Three need amending in light of what shipped on the Reset:

| # | Spec says | Correction |
|--:|---|---|
| 1 | "two jars, nothing else" | It is a **bottle and a jar**, not two jars |
| 4 | "Beat CeraVe/Vanicream", "Theirs has thirty" | **Do not name anyone.** Sean, 2026-08-01: we contrast against the lotion market in general. Use `data/brand/reference/comparison-lotion.json` — a real published panel, **34** items, brand recorded only in that file and never rendered |
| 5 | "4.84 from 135 reviews" | Correct — `bundle.rating_value` / `rating_count` on this product read 4.84 / 135. Read them at render time anyway |

**Frame 4's "Nine ingredients" checks out** — 9 unique across the set, verified against
`config/ingredients.json`. But see the open question below before printing it.

## Use the pipeline, do not re-derive it

All of this merged with PR #401 and is on `main`:

- `scripts/generate-frame.mjs` — plates from **single-product references only**, staging
  only, no text, no shadows. A multi-product reference makes the model copy that
  composition; asking for product *and* typography in one pass garbles labels.
- `scripts/cutout-product.mjs` — keys a flat backdrop to alpha on **chromaticity**, not
  RGB distance.
- `scripts/render-frame.mjs` — lays down every glyph exactly; frame modules bind figures
  to live metafields and must export a `verify()` that fails the build on a wrong claim.
- `scripts/upload-product-images.mjs` — refuses to upload without alt text.
- `scripts/set-media-variant-scope.mjs` — **not needed here.** Single variant.

Working examples to copy: `data/brand/frames/99-coconut-reset-digital/`. The ingredient
comparison (`ingredients-frame.mjs`) is closest to this bundle's frame 4 and already
carries the self-verifying headline guard.

## Open questions, both for Sean

1. **`grapefruit seed extract` vs `organic grapefruit seed extract`.** The lotion's panel
   says organic, the cream's does not. If they are the same ingredient the set has **8**
   unique, not 9 — and frame 4 prints that number. Worth one check before it goes on an
   image.
2. **Emulsifying wax certification** (carried over from the Reset). The panel calls four
   ingredients "organic" and the wax "plant-based". If the wax is certified organic the
   list should say so; if not, the Field Guide's "100% Organic Ingredients" claim
   overstates by that one item. Unresolved.

## Suggested order

1. **Replace the misleading hero image** — highest value, and it is a correctness fix
   rather than a creative one.
2. Frame 1 (what actually arrives), then 3 (day/night), both COMPOSITE from existing
   component photos.
3. Frame 4 (ingredient comparison) — port from the Reset, swap in the 9-item union.
4. Frame 5 (review proof) — near-identical to the Reset's frame 5, different product.
5. Frame 2 (fragrance-free infographic) — the only GENERATE in the stack.

## Still true across the whole plan

**Frame 3b of the Reset — the 90-day customer skin transformation — is the only
irreversible item anywhere in this document.** A pair started in October cannot exist
before January and there is still no day-0 photograph of anyone who then used the box.
Nothing in this bundle changes that, and no amount of gallery work substitutes for it.
