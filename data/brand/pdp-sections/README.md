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
| `toothpaste-free-from.*` | `product.landing-page-toothpaste.json` → `free-from-block` | `shopify://shop_images/toothpaste-free-from.webp` |

## Still unfixed

Seven more landing-page templates point `free-from-block.settings.image` at
`shopify://shop_images/free-from-ingredients.webp`, which is **not in Shopify
Files** — so each renders Dawn's grey `media--placeholder` band live, next to
its "What's NOT in this ..." list:

`cream`, `deodorant`, `lip-balm`, `liquid-soap`, `lotion`,
`sensitive-skin-set`, `foaming-soap`.

Each needs its own product photo; the bar soap image is not a stand-in. Note
also that `bar-soap-not-in-it.png` and its siblings already in Shopify Files are
**Amazon listing infographics** — they repeat the same exclusion list the
section already prints on the left — so they are the wrong asset for this slot.
