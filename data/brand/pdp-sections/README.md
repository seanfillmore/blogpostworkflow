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
