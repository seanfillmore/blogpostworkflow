# PDP section imagery

Backgrounds prepared for the `image-with-text` blocks on the
`product.landing-page-*.json` templates (theme repo: `~/Code/realskincare-theme`).

Each entry is a pair — the `.source.*` file the operator supplied, and the
prepared `.webp` that was uploaded to Shopify Files. The source is kept because
it does not live anywhere else: it arrived as a one-off from outside the repo,
and without it the prepared file cannot be regenerated at a different ratio.

Regenerate with:

```bash
node scripts/prepare-pdp-section-image.mjs \
  data/brand/pdp-sections/<name>.source.jpg \
  data/brand/pdp-sections/<name>.webp
```

The committed `.webp` is byte-for-byte what was sent to Shopify. It is **not**
what the CDN serves — Shopify re-encodes every upload (82 KB served against
69 KB sent for the bar soap image), so do not treat a hash mismatch against
`cdn.shopify.com` as drift.

## Why these are 1920x1160

`image-with-text` at `image_ratio: adapt` takes its height from the image's own
aspect ratio, so the image decides how tall the band is. 1920x1160 (1.655:1) is
the ratio of `founder-landscape.webp`, which is the block immediately below the
free-from block on every one of these templates — matching it keeps the two
full-width bands in step. A square source in a `full_width` half-column would
render ~50vw tall, roughly 720px against ~450px of copy beside it.

See the header of `scripts/prepare-pdp-section-image.mjs` for why the ground is
extended rather than cropped, and for the seam measurement that says whether a
given source is suitable.

## Contents

| file | slot | uploaded as |
|---|---|---|
| `bar-soap-free-from.*` | `product.landing-page-bar-soap.json` → `free-from-block` | `shopify://shop_images/bar-soap-free-from.webp` |
| `cream-free-from.*` | `product.landing-page-cream.json` → `free-from-block` | `shopify://shop_images/cream-free-from.webp` |
| `deodorant-free-from.*` | `product.landing-page-deodorant.json` → `free-from-block` | `shopify://shop_images/deodorant-free-from.webp` |
| `lip-balm-free-from.*` | `product.landing-page-lip-balm.json` → `free-from-block` | `shopify://shop_images/lip-balm-free-from.webp` |
| `liquid-soap-free-from.*` | `product.landing-page-liquid-soap.json` → `free-from-block` | `shopify://shop_images/liquid-soap-free-from.webp` |
| `lotion-free-from.*` | `product.landing-page-lotion.json` → `free-from-block` | `shopify://shop_images/lotion-free-from.webp` |
| `toothpaste-free-from.*` | `product.landing-page-toothpaste.json` → `free-from-block` | `shopify://shop_images/toothpaste-free-from.webp` |

## Status — every live PDP clear, verified 2026-08-30

`grep -c media--placeholder` returns **0** on all eight landing-page PDPs:
`coconut-soap`, `coconut-oil-toothpaste`, `coconut-moisturizer`,
`coconut-oil-deodorant`, `coconut-lotion`, `coconut-oil-lip-balm`,
`organic-foaming-hand-soap`, `foam-soap-refill-32oz`. The dead
`free-from-ingredients.webp` reference is gone from every live template.

**Audit the LIVE template, not this repo's copy.** The theme repo is well behind
live and reading it produced a wrong list twice: it showed `cream` carrying the
dead reference when live had **no `image` key at all** (same placeholder,
opposite fix — an insert, not a replace), and it put `foaming-soap` on the broken
list when that template has no free-from section at all.

```bash
node scripts/update-theme-asset.mjs get templates/product.landing-page-<x>.json /tmp/t.json
curl -sL https://www.realskincare.com/products/<handle> | grep -c media--placeholder
```

All seven bands now render at **507px on desktop / 1920×1160**, so the pattern is
uniform down the page.

### One thing left alone, on purpose

- **`landing-page-liquid-soap` serves TWO products** — `organic-foaming-hand-soap`
  and `foam-soap-refill-32oz` — from one section, so the refill PDP shows the
  8 fl oz **pump bottle**, not the 32 oz jug it sells. The operator chose the
  pump bottle knowing this. Splitting the templates is the fix if it ever
  matters; the exclusion list itself is accurate for both.

`why-1-lotion.webp` (800×800) is no longer referenced by any template. It is
**left in Shopify Files, not deleted** — deleting a Shopify image destroys the
CDN file, and nothing here needed it gone.

**The lotion ground is a deeper tan than the other six**, which run pale
cream/beige. That is the source photograph, not the preparation; re-shoot rather
than recolour if it should match.

### Templates with no free-from section (nothing to fix)

`foaming-soap`, `body-cream`, `body-lotion`, `sensitive-skin-set-lander`,
`99-coconut-reset`. And `landing-page-sensitive-skin-set` still names the dead
file but is **unused** — `sensitive-skin-starter-set` renders through `-lander`.

`layout` differs per template (`image_first` puts the image on the LEFT). That
alternation is the page's existing rhythm — do not normalise it.

## Do not reuse the `*-not-in-it.png` files

`bar-soap-not-in-it.png` and its six siblings already in Shopify Files are
**Amazon listing infographics**: they bake the same exclusion list into the image
as type, which the section already prints in its text column. Dropping one into
this slot doubles the copy.

## Ingredient card images — `hero-ingredient-cards`

A different section from the free-from block above, on the same templates: the
`multicolumn` row headed "Three ingredients, three jobs" (soaps: "One base.
Three things to know."). `scripts/fix-ingredient-card-images.mjs` (dry by
default, `--apply`) points each card at the ingredient it names; read its header
before changing one. It is idempotent and asserts each card's prior value, so a
card someone has since edited is SKIPPED rather than overwritten.

**The original library was the LOTION's ingredient list, and that is why the
other products were wrong.** Files held exactly seven ingredient photographs —
`Spring_Water`, `coconut_oil`, `Coconut_Oil_Extract`, `Jojoba`, `Wax`,
`Grapefruit`, `red-palm-oil` — one for one the body lotion's ingredients. Every
PDP template was then seeded from three of them dealt out **by card position**,
so a card saying "Organic Jojoba" showed a pond and one saying "Baking Soda"
showed wax pellets. Coconut oil was right everywhere only because it is card 1.
The unpublished `page.landing-page-design.json` had all seven wired correctly
the whole time — corroboration that the shortcut was the PDPs', not the shoot's.

| card | image | note |
|---|---|---|
| Organic Virgin Coconut Oil | `Coconut_Oil_Extract.webp` | was already correct |
| Organic Beeswax | `Wax.webp` | white wax pellets; also serves the lotion's plant emulsifying wax |
| Organic Jojoba | `Jojoba.webp` | fixed 2026-08-31 (lotion, deodorant) |
| Organic Red Palm Oil | `red-palm-fruit.webp` | operator-supplied 2026-08-31 (lotion, cream, lip balm, draft page) |
| Baking Soda | `baking-soda.webp` | operator-supplied 2026-08-31 (deodorant, toothpaste) |
| Wildcrafted Myrrh | `myrrh-resin.webp` | operator-supplied 2026-08-31 (toothpaste) |
| Variation Essential Oils | `essential-oils.webp` | operator-supplied 2026-08-31 (bar soap, liquid soap) — **unlabelled on purpose** |

`red-palm-oil.webp` (a mint/teal lab flask) is **retired and has zero referrers**
— accurate, but visibly foreign beside the warm naturals. It is left in Files
rather than deleted; nothing here needs it.

### Every card is correct — verified 2026-08-31

All 8 landing-page PDPs render their own ingredient on every card
(`coconut-lotion`, `coconut-moisturizer`, `coconut-oil-lip-balm`,
`coconut-oil-deodorant`, `coconut-oil-toothpaste`, `coconut-soap`,
`organic-foaming-hand-soap`, `foam-soap-refill-32oz`). The script's `BLOCKED`
list is **empty and kept** — an empty list is a measured state it prints on
every run, and the next card added to a template starts there.

Two cards are **not** ingredients and are left alone: bar soap's "Naturally
Lathering" and liquid soap's "Built for the Foaming Dispenser", both showing
`Spring_Water.webp`, which reads as lather and as dilution. The soaps are the
family where a three-ingredient list does not apply — Pure Unscented is
saponified coconut oil and nothing else.

### The essential-oils card must stay UNLABELLED

The first supplied shot had nine **labelled** bottles and was rejected: one
headline read **FRANKINCENBE**, every Latin binomial was gibberish
(`Lecendule engustifate`, `Eocelyptis glebeloe`, `Cldos bergamia`), volumes read
`1burt` / `Tord` / `10nd`, and bergamot was drawn with green limes. It could not
be cropped clean because the labelled bottles were the subject. It is kept at
`essential-oils.REJECTED.source.jpg`.

**The fix was to remove the labels, not to fix the words** — and that is the
durable reason, not just an expedient one. Bare amber glass cannot misspell
anything, and it cannot contradict the copy beside it either: that copy lists a
different blend per variation (Orange Zest is orange, bergamot, spearmint, lemon
and grapefruit; Calming Lavender is lavender; Coconut Breeze is coconut oil
extract; Pure Unscented has none). **Any** set of named bottles would be wrong
for most variations even spelled perfectly. If this card is ever reshot, keep
the bottles blank or turned away from camera.

### Preparing a supplied image

All four supplied shots arrived **1024x1024**. The row cover-crops to 1.5113:1,
which cuts **34% off a square, top and bottom, sight unseen** — so they are
pre-cropped to **1200x794 exactly** (the incumbent geometry) and reviewed at
that crop, rather than uploaded square. `myrrh-resin.webp` is cropped *below*
its source's jar, which is what removes a label misspelling **MYRRRH** (three
R's) from the frame — a crop can rescue an image whose text is incidental, and
cannot rescue one whose text is the subject.

**Verify supplied artwork by zooming each string and reading it letter by
letter.** At a glance all five looked clean; `MYRRRH` and `FRANKINCENBE` both
survived a first read, and both were only caught at 4x zoom.

### The row's height is `1 / the widest image` — check that, not the position

`sections/multicolumn.liquid` under `image_ratio: adapt` takes
`max(aspect_ratio)` across every block and renders one
`--image-ratio-percent: 1 / that` on all the cards, cover-cropping each into it.
The incumbent maximum is 1.5113 (`Coconut_Oil_Extract.webp`, 1200x794), which is
the 66.1666% the PDPs render. An image **wider** than that shortens the whole row
and crops every sibling harder; a taller one changes nothing but its own crop.
Every image added sits at or below the max, verified on the rendered pages after
each apply.
