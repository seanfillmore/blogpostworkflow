# Archive

Content that is **not recoverable from anywhere else** once a destructive
Shopify API call runs. Originally product imagery only; as of 2026-08-22 it
also holds a full-content snapshot of deleted blog articles, for the same
reason. This directory is committed on purpose, against the usual instinct to
keep binaries/large content out of git.

## Why this exists

Deleting a Shopify product image destroys the underlying CDN file — it is not
merely detached from the product. On 2026-08-12 three two-pump bundle photos were
removed from the foaming soap PDP and the originals were lost: absent from the
Files library, 404 on the CDN, no Wayback capture. Only 600px copies survived,
and only by luck.

The standing rule that came out of that: **download full-resolution/full-content
before any destructive API call, to a durable path outside the session
scratchpad.** This is that path. `DELETE .../articles/{id}.json` has the same
one-way property as the image endpoint — no undelete — which is why
`orphan-drafts-2026-08-22/` follows the same rule for article content instead
of imagery.

## Contents

| Directory | What it is | Recoverable elsewhere? |
|---|---|---|
| `removed-product-images/` | The three two-pump bundle photos removed from `organic-foaming-hand-soap` | **No.** 600px only — the full-res originals are gone. See that folder's README before reusing. |
| `legacy-amazon-heroes/` | The five original Amazon hero images | Four are still live on the CDN and embedded in ~20 blog posts; the lip balm one was removed from its product. |
| `replaced-lotion-frames/` | The six older shared PDP frames replaced on `coconut-lotion` | No — deleted from the product, so the CDN files are gone. |
| `generated-pdp-frames/` | The 24 shared PDP frames generated for 6 SKUs | Live on the CDN, but **not reproducible** — image generation is non-deterministic, so re-running the same prompt returns a different picture. |
| `orphan-drafts-2026-08-22/` | Full Shopify article objects (incl. `body_html`) for 15 abandoned duplicate blog drafts, archived before deletion | No — deleted via the Shopify Admin API, which has no undelete. See that folder's README for the four-criteria evidence and how to restore one. |

## Provenance of `generated-pdp-frames/`

Produced with `gemini-3-pro-image-preview`, grounded in the real 2000px product
photos passed as reference images so bottle geometry and label text match what
actually ships. Every claim in the copy is verbatim from the product's own
`body_html` or `config/ingredients.json` — nothing was invented.

Four frames per SKU, following the format rotation in
`.claude/skills/marketing-product-image-stack/`:

- **mechanism** — the single strongest true claim (e.g. "ONE INGREDIENT SOAP")
- **not-in-it** — exactly four free-from attributes
- **benefits** — four short callouts, one of which is "Made in the USA"
- **how-to-use** — the real usage caveat, which doubles as a retention asset
  (misuse during the switch is a named driver of the low repeat rate)

Plus lifestyle frames for the foaming soap and lotion.

Each render was audited against the physical product before shipping. Defects
caught and corrected included a bottle rendered "3 fl. oz" when the product is
2 fl. oz, a Made-in-USA badge rendered navy when the real one is beige, icons
drawing a rectangular soap bar when the real bar is round, and an invented sage
band on a lip balm cap. One frame was rejected outright for rendering five tubes
under a "FOUR TUBES PER PACK" headline.
