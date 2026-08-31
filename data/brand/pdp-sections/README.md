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
| `toothpaste-free-from.*` | `product.landing-page-toothpaste.json` → `free-from-block` | `shopify://shop_images/toothpaste-free-from.webp` |

## Still unfixed — 3 live PDPs, audited against LIVE templates 2026-08-30

**Audit the LIVE template, not this repo's copy.** The theme repo is well behind
live, and reading it produced a wrong list twice: it says `cream` carried the
dead `free-from-ingredients.webp` reference, when live had **no `image` key at
all** (same placeholder, different cause — the fix is an insert, not a replace),
and it put `foaming-soap` on the broken list when that template has no
free-from section at all.

```bash
node scripts/update-theme-asset.mjs get templates/product.landing-page-<x>.json /tmp/t.json
curl -sL https://www.realskincare.com/products/<handle> | grep -c media--placeholder
```

Measured that way, `free-from-ingredients.webp` is **not in Shopify Files** and
two templates still name it, covering three live PDPs:

| template | PDPs showing a placeholder | layout |
|---|---|---|
| `landing-page-lip-balm` | `coconut-oil-lip-balm` | `text_first` |
| `landing-page-liquid-soap` | `organic-foaming-hand-soap`, `foam-soap-refill-32oz` | `image_first` |

Each needs its own packshot; an image from another product is not a stand-in.

Note `landing-page-liquid-soap` covers **two** products, so one packshot there
fixes two PDPs — but the refill is a 32 oz jug and the hand soap a pump bottle,
so decide which one the section should show.

**Not broken, despite what the repo copy suggests:**

- `landing-page-lotion` names `why-1-lotion.webp`, which **is** in Files (800×800).
  It renders, so it is not urgent — but it is square rather than 1920×1160, so
  that band is taller than its siblings.
- `landing-page-sensitive-skin-set` carries the dead reference and is **unused** —
  `sensitive-skin-starter-set` renders through `landing-page-sensitive-skin-set-lander`.
- `landing-page-foaming-soap`, `-body-cream`, `-body-lotion`,
  `-sensitive-skin-set-lander` and `-99-coconut-reset` have **no free-from
  section**, so there is nothing to fix.

`layout` differs per template (`image_first` puts the image on the LEFT). That
alternation is the page's existing rhythm — do not normalise it.

## Do not reuse the `*-not-in-it.png` files

`bar-soap-not-in-it.png` and its six siblings already in Shopify Files are
**Amazon listing infographics**: they bake the same exclusion list into the image
as type, which the section already prints in its text column. Dropping one into
this slot doubles the copy.
