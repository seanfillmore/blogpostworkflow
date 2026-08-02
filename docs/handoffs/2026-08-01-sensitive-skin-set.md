# Handoff — Sensitive Skin Set gallery

## ✅ SHIPPED 2026-08-01 — the gallery is live

Six frames uploaded, ordered, and verified on the storefront. `v20.webp` — the
AI-generated image whose every printed figure was fabricated — is **deleted from
the product**; a copy is kept at
`data/backups/products/sensitive-skin-starter-set.v20-replaced-2026-08-01.webp`.

Live gallery order: 1 what-arrives · 2 subscription-gift · 3 day-night ·
4 reviews · 5 fragrance-free · 6 list-length. **All six carry alt text**; the set
had none before. `og:image` now resolves to frame 1, so social shares no longer
serve the broken image.

Two things worth carrying forward:

- **Shopify caches the product page.** The first post-upload fetch still showed
  `og:image` as `v20.webp` and read like a failure. A cache-busting query param
  showed the correct value. Re-check with `?cb=$(date +%s)` before diagnosing.
- **Alt text is capped at 512 characters, and Shopify enforces it at upload** —
  after the frames are rendered and committed, mid-gallery. Frame 2's derived alt
  came to 516 and killed the run with four of six images already live. There is
  now a ceiling in `render-frame.mjs` (authoring time, where it belongs) and a
  second in the uploader's preflight.


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

## ✅ RESOLVED 2026-08-01 — the phantom ingredients are off the live page

Sean confirmed: *"none of those ingredients are in any of our products."* Both the
product description and the SEO meta description have been rewritten from
`config/ingredients.json` and applied to Shopify. **Frames 2 and 4 are unblocked.**

What changed, and what it took to be sure it was really gone:

| Surface | Was | Now |
|---|---|---|
| `descriptionHtml` | "Three ingredients — aloe vera, oat extract, chamomile…", plus a *"gentle cleanser"* the set does not contain and an unqualified "most effective" | Rewritten from the real formulations; both products' ingredients named |
| `global.description_tag` (meta description, og:, twitter:) | "Aloe vera, oat extract & coconut oil — a complete moisturizer…" | "Coconut oil, jojoba & beeswax — a two-step moisturizer…" |

**The meta description was nearly missed.** The first verification pass stripped
tags with `<[^>]+>` before searching, which deletes a `<meta>` tag *including its
`content` attribute* — so the phantom ingredients read as "gone" while they were
still live in the meta description, og:description and twitter:description, i.e.
in exactly what Google and every social share display. **When checking whether a
claim is off a page, search the raw HTML, not the stripped text.**

Backups of both states are in `data/backups/products/`.

**Catalog-wide scan: clean.** Every product's description, meta description and
meta title was checked against `config/ingredients.json` for ingredients no RSC
product contains — no other product names one. One limit worth knowing: the scan
only flags ingredients absent from the *whole* catalog, so it would not catch a
product naming a real ingredient that is absent from *that variant* — which is
precisely the chamomile case here (real, but only as an essential oil in Lavender
& Rose, and this set is Pure Unscented). A variant-aware check does not exist yet.

**Confirmed for frame 4: the union is EIGHT.** Lotion 6 + cream 7, sharing five —
purified spring water, organic virgin coconut oil, organic plant-based
emulsifying wax, organic grapefruit seed extract, organic red palm oil — with
jojoba only in the lotion and palm stearic + beeswax only in the cream.

**Still open, flagged not fixed:** *"handmade in small batches at Real Skin Care"*
survives in the rewritten copy because it was pre-existing and Sean has not been
asked about it — but it is **not** documented in `data/brand/brand-kit.json`,
which records only "made in the USA" and Cheyenne. Worth confirming before it is
repeated in a frame.

## The original finding, kept for the record

Found 2026-08-01 while wiring frame 6's `verify()`. The live `descriptionHtml` for
`sensitive-skin-starter-set` opens:

> "Three ingredients — **aloe vera, oat extract, chamomile** — make this the most effective
> moisturizer for dry skin that sensitive skin can actually tolerate."

Against `config/ingredients.json`, the Body Lotion and Body Cream contain **none of the
three**. The lotion's base is purified spring water, organic virgin coconut oil, organic
jojoba, organic plant-based emulsifying wax, organic grapefruit seed extract and organic
red palm oil. The only chamomile anywhere in the config is *organic essential oil of roman
chamomile*, and it appears solely in the **Lavender & Rose** variation — a scented one.
This set is **Pure Unscented**, which the config defines as having no essential oils at
all, so that route makes the claim worse rather than better.

**Why this blocks frames 2 and 4 specifically.** Frame 2 is specced to prove
"fragrance-free means no masking fragrance either" and frame 4 to print an ingredient
count. Both make an ingredient claim on a page whose own copy currently contradicts the
ingredient file, and shipping a frame that says "eight ingredients" beside body copy
naming three different ones would put the contradiction *inside the gallery*.

It is the same class of failure as the media plan's §2 blocking issue ("no palm oil" /
"vegan" on bundles that contain both) and probably wants resolving in one pass. **Someone
has to decide which is right — the copy or the config — before frames 2 and 4 are built.**
Frames 1, 3, 5 and 6 make no ingredient claim and are unaffected.

## The frame stack, with corrections

§6 specs five frames. Three need amending in light of what shipped on the Reset, and the
stack is now **six** — the gift earns its own frame.

| # | Spec says | Correction |
|--:|---|---|
| 1 | "two jars, nothing else" | It is a **bottle and a jar**, not two jars. "Nothing else" still stands **for this frame** — frame 1 answers "what does $46.80 buy me", and that is two items. The gift is a separate question, answered by the new frame 6 |
| **6** | *(new)* | **The first-subscription gift.** Bottle + jar + bar soap + lip balm four-pack, with the two gift items visibly marked as the gift. Headline names the condition, e.g. *Subscribe: your first box adds $26 free.* **COMPOSITE from real component photos** — `v20.webp` informs the staging only; not one pixel of its product labels survives (see production rule 1) |
| 4 | "Beat CeraVe/Vanicream", "Theirs has thirty" | **Do not name anyone.** Sean, 2026-08-01: we contrast against the lotion market in general. Use `data/brand/reference/comparison-lotion.json` — a real published panel, **34** items, brand recorded only in that file and never rendered |
| 5 | "4.84 from 135 reviews" | Correct — `bundle.rating_value` / `rating_count` on this product read 4.84 / 135. Read them at render time anyway |

**Frame 4 must say EIGHT, not nine.** The spec's "Nine ingredients" was correct against
the old `config/ingredients.json`, which listed the cream's grapefruit seed extract
without "organic" and so counted it as a separate ingredient. Sean confirmed 2026-08-01
that it is the organic one in both products; corrected in the config, and the set's
unique count is now **8**.

## Production rules — from `marketing-product-image-stack` + `marketing-ai-product-imagery`

Consulted 2026-08-01 at Sean's direction. Both skills bear directly on why `v20.webp`
failed and on how frame 6 gets built. What they change:

**1. Frame 6 is a COMPOSITE of real photographs, not a re-plate via generation.**
This is the substantive change. The defects in `v20.webp` are in *product label text* —
baked into the plate — and `render-frame.mjs` cannot repair them, because it lays down
overlay glyphs, not the printing on a jar. Re-generating the plate just re-rolls the same
class of error. `marketing-ai-product-imagery` is explicit: *"prefer a real photo for the
main image where one exists."* One exists for all four items:

| Item | Real Pure Unscented asset |
|---|---|
| Body Lotion | `real_skin_care_body_lotion_unscented_4.png` |
| Body Cream | `real_skin_care_body_cream_unscented.jpg` |
| Bar Soap | `real_skin_care_bar_soap_unscented_1.jpg` |
| Lip Balm four-pack | `AMZRealSkin-lipbalmheros_tomakelarger-show4pack…` |

So: `cutout-product.mjs` on each, composite onto the staging, `render-frame.mjs` for the
headline. **Zero generated product labels means zero label-fidelity risk.** This retires
the whole defect class rather than auditing for it, and it makes the skills' "patch
garbled small text in Canva" step unnecessary — our pipeline already beats that tactic.

**2. One job, one persona per frame.** This is why frame 1 and frame 6 stay separate
rather than merging into one "everything you get" image. Frame 1 answers *what does
$46.80 buy*; frame 6 answers *what does subscribing add*. Merging them is the exact
failure mode the skill names, and it would also blur the contingency the ⚠️ guard exists
to protect.

**3. The 1-second test is run at phone size, not on the desktop canvas.** Before any
frame ships, view it at actual phone dimensions; if the smallest label is not readable at
a glance, oversize the text and cut copy. Add this to the pre-upload check alongside
`verify()`.

**4. Audit every generated frame against the physical product.** Features the product
does not have, the same product rendered at different proportions across panels, wrong
scale. This is precisely the gate that was never run on `v20.webp`. It applies to frames
2 and 4 (the GENERATEs); frames 1, 3 and 6 avoid it by construction under rule 1.

**5. Frame 4 is within the us-vs-them cap.** The skill caps comparison graphics at 3–4
attributes won on. Frame 4 currently carries one (ingredient count, 8 vs 34), so there is
headroom — but any attribute added must be sourced from real competitor complaints, not
invented, and must stay true for both products in the set.

**Not adopted:** the skills' Amazon main-image compliance rule (no stamped-on claims) is a
platform-policy constraint for Amazon listings. These frames are the **Shopify** gallery,
where overlay headlines are normal and expected. Noted so nobody later "fixes" a compliant
Shopify frame against a rule that does not govern it — but if any of these frames is ever
reused on an Amazon listing, that rule starts applying and the headline must come off.

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
