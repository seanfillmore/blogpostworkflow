# Handoff — bundle galleries, after the two Clean Swaps

**Written:** 2026-08-02, after PR #405 (Sensitive Skin Set), #406 (90-Day Clean Swap)
and #407 (The Clean Swap) all merged and deployed.
**Prerequisite reading:** `docs/bundle-media-plan.md` for the bundle you are building,
then this file, then `docs/handoffs/2026-08-01-sensitive-skin-set.md` for the pipeline.

## Where the roster stands

| Bundle | Price | Gallery | Notes |
|---|--:|---|---|
| Sensitive Skin Set | $46.80 | ✅ 6 frames | PR #405 |
| 90-Day Clean Swap | $144 | ✅ 8 frames × 3 kits = 24 media | PR #406 |
| The Clean Swap | $59 | ✅ 6 frames × 3 kits = 18 media | PR #407 |
| 90-Day Coconut Reset | $121 | ✅ 6 frames × 2 scents | shipped 2026-08-01, PR #401 |
| **Head-to-Toe** | **$87** | ❌ 2 placeholders | **next — see below** |
| Gift Box | $62 | ❌ 0 | |
| Hand Soap Set | $44/59/72 | ❌ 0 | 15 variants — the fiddliest |
| Bar Soap 4-Pack | $39 | ⚠️ 5 images | top-up, not a build |
| Deodorant 4-Pack | $53 | ❌ 0 | replenishment vehicle |
| Toothpaste 3-Pack | $34 | ❌ 0 | replenishment vehicle |

## Start here: Head-to-Toe

$87, two variants (Gentle / Fresh), **seven** products — one of everything RSC makes.
It is the next highest value and draws almost entirely from work already done.

**What already exists for it:** six of its seven components are in the cutout library.
Only `coconut-oil-lip-balm` and `organic-foaming-hand-soap` need cutting, and the lip
balm already has a Pure Unscented cutout from the Sensitive Skin Set
(`data/brand/cutouts/sensitive-set-lip-balm.png`) — rename or re-cut to the
`component-<product>-<variant>` convention.

**Two live corrections to the plan before you build:**

- It repriced to **$87** on 2026-07-31, from $105. The plan's §"Head-to-Toe — $105"
  heading and its frame 3 ("$105. Seven products. $15 each.") are stale — $87 ÷ 7 is
  $12.43 and the frame was cut for that reason. The surfaces table is corrected; the
  section heading is not.
- Its value stack now sums to **$125**, matching compare-at exactly (see below).

## The cutout library

`data/brand/cutouts/component-<product>-<variant>.png` — eight files covering the four
Clean Swap products in every scent they ship. Named per component, not per bundle,
because Head-to-Toe and the Gift Box draw from the same set.

**Cutting a new component — the method, learned the hard way three times:**

1. Flood white from all four corners of the **full** 2000px photo. Low fuzz: 5% is
   right for most, but a **white product on white** (the toothpaste, the Coconut
   Breeze lotion) keys its own body out and needs 2–3%.
2. Find the product's true bounds by reading **opaque spans off a single row** that
   is proven to contain only the product. Estimating from a thumbnail does not work,
   and neither does a "clean band" that turns out to contain the MADE IN THE USA
   badge, a staged cap, or a cream swoosh — all three cost a rebuild.
3. **Cut at the contact line.** Scanning row widths downward, the silhouette narrows
   to a minimum where the product meets its own reflection and widens again into the
   mirror. Cut at that waist and the base keeps its curve; cut below it and you drag
   in the contact shadow, which renders as a flat grey band and reads as a sliced-off
   bottle. Measured examples are in `swap-common.mjs`.
4. Soaps are circular: mask with a circle. Radius ~700 on a 2000px photo — 748 catches
   a neighbouring sud.

## ⚠️ The theme rule that will bite you

`sections/main-product.liquid` scopes gallery media to variants by an alt-text suffix
(`<alt>#<option>_<value>`), and **its `gang_exist` flag is sticky across the media
loop**: an unscoped image sitting after a scoped one is hidden for **every** variant.

So on a multi-variant bundle, **every** media must be scoped, and frames whose content
is identical across variants have to be duplicated per variant. Eight frames × three
kits = 24 media on the 90-Day. There is no way around it short of a theme change.

`scripts/set-media-variant-scope.mjs` refuses the upload and explains, which is the only
reason this was caught before it shipped — it would have surfaced as a nearly empty
gallery on a live page, and only on the storefront.

## Value stacks: shipping is not value

Corrected across all five bundles on 2026-08-02 after Sean spotted The Clean Swap
showing "Total value $75" against a $69 strikethrough.

**Free shipping starts at $45 site-wide** (`brand-kit.json free_shipping_threshold`) and
every bundle is priced above it, so shipping is not incremental value — and counting it
was what made the value-stack total disagree with the compare-at price on every one.

Shipping lines are removed. Four now reconcile exactly ($69, $207, $125, $71). The
Coconut Reset keeps a $34 gap, which is its two digital guides — real added value with no
compare-at counterpart, unlike shipping.

**Rule for any new bundle: the value stack lists products only.** If you add a line that
is not a product, check whether the buyer would get it anyway.

## Frames derive their numbers. Do not type them.

The media plan told anyone building the 90-Day's frame 3 to print **$159** for days after
the bundle moved to $144, because the figure was bound to a config value and a human was
asked to "flag it if it changes". Nobody did.

Every frame now reads price, contents, ratings and value stack at render time and
`verify()` fails the build rather than shipping a stale claim. Guards worth copying:

- the per-unit price must stay under the ~$15 ceiling the VOC file documents, or the
  frame stops building — a version printing $15.50 argues against itself
- an ingredient callout must be provably **on** the competitor panel and **absent** from
  ours (`config/ingredients.json`) before it renders
- a review frame must carry "of the products inside" in the headline, not as a footnote
- no numeric duration or outcome promise on a transition frame
- alt text over 512 characters fails at authoring time, not at upload

## Still open

- **No transformation frames.** Sean, 2026-08-02. Cut wherever the plan specs one.
- **Three shots would upgrade what shipped**, none blocking: the 90-Day's twelve-unit
  flat-lay; The Clean Swap's bathroom-counter headliner (frame 1 shipped as a stand-in
  and says so in its docstring); and a rubbed-in forearm absorption shot for the lotion,
  which does not exist in any of its 11 photos.
- **Per-bundle hero images.** The theme now supports `bundle.hero_desktop` /
  `hero_mobile` per product (PR #406) — six landers shared one hero before that. Nothing
  is set yet; Sean: "we will eventually change the hero image for each bundle."
- **A cross-check script does not exist.** Three live copy errors this session surfaced
  only by looking at a rendered page: phantom ingredients in a meta description, the
  sticky scoping, and the value-stack mismatch. `verify()` guards claims *inside* an
  image; nothing yet checks the numbers a bundle page shows *against each other*. That
  script would have caught the value-stack problem on all five bundles at once.
