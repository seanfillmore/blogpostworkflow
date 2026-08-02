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

The single live image (`v20.webp`, 2048², no alt) is AI-generated and was not audited.
**Its composition is correct — every label on it is not.**

### ✅ Corrected 2026-08-01: the soap and lip balms belong in the frame

An earlier draft of this handoff called the soap and lip balms "products that are not in
the box" and treated that as the headline defect. **That was wrong.** Sean, 2026-08-01:
they are the **free gift with a first subscription**. The live PDP says so verbatim:

> **First-subscription bonus.** Subscribe and your first order ships with a free Pure
> Unscented Lip Balm and a free Unscented Bar Soap.

The count checks out too. `coconut-oil-lip-balm` is sold as **"Natural Coconut Oil Lip
Balm | 0.15oz | Four Pack"** — one unit of that SKU *is* four tubes, so the four balms in
the frame are one gift item, not four. The soap is `coconut-soap` Pure Unscented, whose
real label reads **"pure unscented / hand & body soap"** — exactly what the frame shows.

So the frame depicts: the two-item set **plus** its first-subscription gift. That is a
legitimate and, as noted below, under-used thing to show. Do not "fix" it by deleting
them.

### The real defect: every printed figure on it is fabricated

This is the label-fidelity failure documented in the media plan's §3, and it is worse
than the volume errors alone. Verified against the live PDPs and product photography:

| Element | On the image | Actually |
|---|---|---|
| Body Lotion volume | `0 fl. oz · 300ml` | **8 fl. oz · 236ml** |
| Body Cream volume | `4 fl. oz · 150ml` | **4 fl. oz · 118ml** (oz right, ml wrong) |
| Lotion badge | mirrored gibberish (`ANƨTOIE OROOMOR ЯIE`) | `MADE WITH ORGANIC COCONUT OIL` |
| Bar soap net weight | `2 Lin · 8.ia` | **3.4 oz · 84g** |
| Bar soap wrap text | mirrored, plus a **fabricated barcode** | real wrap text, no barcode needed |
| Lip balm labels (×4) | `moisturizing broom` / `brobm` | `moisturizing balm` |
| Lip balm net weight | `0.11 oz · 3.1719` | **0.15 oz** |

"0 fl. oz" is not a plausible wrong number, and "moisturizing broom" is not a plausible
wrong word. Nothing printed on this image can be trusted.

**This is the hero offer's only image.** Replacing it is still worth more than any new
frame — but it is now a **re-plate of a good composition**, not a rethink. Keep the
staging, the palette and the product mix; regenerate so every glyph is laid down by
`render-frame.mjs` rather than by the image model.

Do not reuse this file as a generation reference for *labels*. Its composition is fine to
reference; its text is poison.

## 💡 The gift is invisible, and that is a conversion finding

The first-subscription gift is worth **$26 at retail** (lip balm four-pack $15 + bar soap
$11) on a $46.80 order. On the live PDP it appears **once**, as the last line inside a
collapsed `<details>` accordion. Nothing above the fold mentions it.

The **only** place it is communicated visually is this one image — and that image is the
one nobody can read because the labels are garbled.

Retention is the documented constraint on this business (18% repeat rate), and this gift
exists precisely to buy a subscription start. Surfacing it in the gallery is the highest
revenue-per-effort item in this bundle, ahead of any frame in the specced stack.

## The frame stack, with corrections

§6 specs five frames. Three need amending in light of what shipped on the Reset, and the
stack is now **six** — the gift earns its own frame.

| # | Spec says | Correction |
|--:|---|---|
| 1 | "two jars, nothing else" | It is a **bottle and a jar**, not two jars. "Nothing else" still stands **for this frame** — frame 1 answers "what does $46.80 buy me", and that is two items. The gift is a separate question, answered by the new frame 6 |
| **6** | *(new)* | **The first-subscription gift.** Bottle + jar + bar soap + lip balm four-pack, with the two gift items visibly marked as the gift. Headline names the condition, e.g. *Subscribe: your first box adds $26 free.* COMPOSITE — this is a re-plate of `v20.webp`'s composition with honest labels |
| 4 | "Beat CeraVe/Vanicream", "Theirs has thirty" | **Do not name anyone.** Sean, 2026-08-01: we contrast against the lotion market in general. Use `data/brand/reference/comparison-lotion.json` — a real published panel, **34** items, brand recorded only in that file and never rendered |
| 5 | "4.84 from 135 reviews" | Correct — `bundle.rating_value` / `rating_count` on this product read 4.84 / 135. Read them at render time anyway |

**Frame 4 must say EIGHT, not nine.** The spec's "Nine ingredients" was correct against
the old `config/ingredients.json`, which listed the cream's grapefruit seed extract
without "organic" and so counted it as a separate ingredient. Sean confirmed 2026-08-01
that it is the organic one in both products; corrected in the config, and the set's
unique count is now **8**.

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

## The ingredient panel is settled

Sean, 2026-08-01, in two passes:

- The grapefruit seed extract is **organic in every product**.
- The emulsifying wax **is certified organic**.
- **Palm stearic is organic as well.**
- The governing rule: *"We use the same ingredients throughout our product line — if one
  is organic, they are all organic."* So an ingredient written organic in one product and
  plain in another is an inconsistency in the file, not a real difference.

`config/ingredients.json` now reads organic for the wax (lotion, cream, deodorant), the
grapefruit seed extract (cream, deodorant) and palm stearic (cream).

**What that settles:** the Body Lotion and Body Cream are now entirely organic except
purified spring water — and water is excluded from the organic-percentage calculation
outright (USDA NOP, 7 CFR 205.302). **"100% Organic Ingredients" is therefore supportable
for both**, which closes the Field Guide page 15 question raised during the Reset work.
The frames deliberately do not lean on it; nothing needs to change, but the claim is no
longer a liability.

**What is still not written organic, and why it was left alone:**

| Ingredient | Why |
|---|---|
| `purified spring water` (4 products) | Water cannot be certified organic |
| `sodium bicarbonate (baking soda)` (deodorant), `baking soda` (toothpaste) | A mineral — not eligible for organic certification |
| `xanthan gum`, `stevia` (toothpaste only) | **Open.** Both *can* be organic, but neither appears in another product, so the same-ingredient rule does not decide them and Sean did not name them |
| `wildcrafted myrrh powder` (toothpaste) | "Wildcrafted" is a deliberate and different designation — wild-harvested rather than farmed. Almost certainly correct as written |

Only the toothpaste has anything left to ask about, and it is outside this bundle.

**Frame 4 must say EIGHT.** The set's unique list: purified spring water, organic virgin
coconut oil, organic jojoba, organic plant-based emulsifying wax, organic grapefruit seed
extract, organic red palm oil, organic palm stearic, organic beeswax.

## Suggested order

1. **Re-plate the hero image as frame 6** — highest value, and it does double duty: it
   retires the garbled-label liability *and* it is the first honest, above-the-fold
   statement of a $26 gift that is currently buried in an accordion. Same composition,
   every glyph laid down by `render-frame.mjs`.
2. Frame 1 (what actually arrives — the two items only), then 3 (day/night), both
   COMPOSITE from existing component photos.
3. Frame 4 (ingredient comparison) — port from the Reset, swap in the 8-item union.
4. Frame 5 (review proof) — near-identical to the Reset's frame 5, different product.
5. Frame 2 (fragrance-free infographic) — the only GENERATE in the stack.

## Still true across the whole plan

**Frame 3b of the Reset — the 90-day customer skin transformation — is the only
irreversible item anywhere in this document.** A pair started in October cannot exist
before January and there is still no day-0 photograph of anyone who then used the box.
Nothing in this bundle changes that, and no amount of gallery work substitutes for it.
