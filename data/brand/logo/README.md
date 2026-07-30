# Logo files

Drop the transparent logo files here. Expected names (PNG at minimum, SVG preferred
alongside — SVG is what an email template should reference for crispness on retina):

| File | Colorway | Use |
|---|---|---|
| `rsc-logo-black.png` | `#000000` | Default. White and light-sand backgrounds. |
| `rsc-logo-white.png` | `#FFFFFF` | Reversed — black or dark photographic backgrounds. |
| `rsc-logo-sand.png`  | `#EDE5D8` | On black or dark green blocks. |
| `rsc-logo-green.png` | brand green | Accent use only, on white or black. |
| `rsc-logo-grey.png`  | `#EDEDED` | Watermark / low-emphasis only. |

Also useful, if they exist: the standalone `r` monogram in the same colorways
(`rsc-monogram-<colour>.png`) — that's the mark for a favicon, an avatar, or a
compact email header.

You can also drop them in the main checkout at `data/brand/logo/` and they'll be
copied here.

## Two things to confirm once the files land

1. **The green colorway may not be `#C1DF6D`.** The supplied green logo reads as a
   softer sage than the palette green in the brand kit PDF. Sample the actual pixel
   value and reconcile — either the palette gains a second green, or the logo should
   be re-exported at `#C1DF6D`.
2. **Nothing here is referenced by an email template yet.** Klaviyo needs a hosted
   URL, so these will need uploading to Klaviyo (or the Shopify CDN) and the URL
   recorded in `brand-kit.json` before templates can use them.
