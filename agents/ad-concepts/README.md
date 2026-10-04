# ad-concepts

Structure-first ad creation. One run produces one Meta flexible ad built on proven competitor ad STRUCTURES: up to 3 finished images from 3 distinct layouts, 2 primary texts and 2 headlines. The model fills slots in a structure; it never invents a concept. Nothing is published to Meta. Spec: `docs/superpowers/specs/2026-10-03-ad-structures-design.md`.

Why: on 2026-10-03 three live runs of model-invented concepts (a coconut-shell bar, a lather storm cloud, a melting iceberg) produced nothing anyone wanted to click. The same day, three ads modelled on the STRUCTURES of competitor ads that had run 200-300+ days were approved first time. The invented-concept stage (concept prompt, judge, picker, overlay copy) was retired and deleted.

## Usage

```bash
node agents/ad-concepts/index.js --products coconut-moisturizer,coconut-lotion --variant pure-unscented \
  --landing sensitive-skin-starter-set [--offer "Sensitive Skin Set $46.80 (was $58)"] \
  [--structures comment-card-offer,texture-scoop,they-think-we-sell] [--max-renders 30] [--dry-run]
```

- `--products` (required): the products that may APPEAR in the images. Each needs reference photos under `data/product-images/<imageDir>/<variant>/` and label strings in `data/product-images/manifest.json`, or the run refuses before any paid call. A product's kind comes from its manifest description: a squeeze bottle is `lotion`, a jar is `cream`.
- `--landing`: the product page the ad sends people to. Its title, URL and live price are read from `https://www.realskincare.com/products/<handle>.json`. Defaults to the single `--products` entry; required when there are several.
- `--offer`: optional free text naming a price and a was-price. The run aborts before any paid call unless both numbers match a live variant's `price` and `compare_at_price` of the landing product, and unless the resulting band (e.g. `SENSITIVE SKIN MOISTURIZING SET $46.80 (WAS $58)`) passes the copy gate. Without `--offer` every band is an always-true value line (`FREE SHIPPING ON ORDERS OVER $45`, `MADE IN THE USA`, the catalog's `ONLY N CLEAN INGREDIENTS`), gated the same way.
- `--structures`: run these library ids first (any number; more than 3 is honoured). An id that is not eligible this run aborts before any paid call.
- `--max-renders` caps render attempts (default 30, `USD_PER_RENDER` each).
- `--dry-run` stops after selection and slot filling, writes `plan.json`, makes no render. Run it first.

## The library

`data/ad-structures/library.json` (tracked), with the source screenshots under `data/ad-structures/sources/`. Each structure cites at least one source ad and its days running, names a layout, a ratio, the product kinds it `fits` (in order of preference: a structure is shot on the `--products` entry whose kind comes first), the evidence it `requires` (`review`, `offer`, `catalogFact`, `bundleLanding`), whether people are in frame, the scene recipe (`primary` and `fallback`), and its slots. `loadLibrary` validates it at load; an unknown layout, a missing source image or bad label positions throw.

## Pipeline

```
evidence per product (photo + label guards) -> landing page -> offer verified (or abort)
  -> reviews screened (selectQuotableReviews, then screenReviews) -> evidence present this run
  -> eligible structures (approved, evidence present, fits a product) -> select (override, then most days running, distinct layouts; < 2 eligible aborts)
  -> per structure: fill slots
       quote: the model picks a review BY INDEX, code inserts it verbatim, attributed "Customer review"
       headline-type slots: one gated model call (gateCopy, one regeneration)
       template slots and checklist rows: deterministic, every row through screenRows (rows "ours" must be verbatim in the catalog or PDP)
       band: verified offer or value line, through gateCopy
       a structure whose slots cannot be filled (e.g. no review short enough to quote whole) is skipped and replaced
  -> per structure: plate takes (2 on the primary scene, then 2 on the fallback)
       product plate: Ad Studio's verifyImage (fidelity, label, volume, stray text)
       product-free plate (the split's left panel): rendered without references, then a fail-closed stray-text check
  -> layout in code (layouts/*.js, brand fonts, Puppeteer) -> critique -> occlusion (asked about the layout's own type regions)
  -> a structure with no usable final is replaced by the next eligible structure with an unused layout
  -> flexible copy against the landing product (2 primary texts, 2 headlines, gated) -> flexible-ad.json / .md
```

## Output

`data/creatives/ad-studio/structures-<landing>-<variant|default>-<stamp>/`

- `plan.json` the planned structures with every filled slot and the product each is shot on, `skipped` (slots could not be filled, with the reason), `ineligible` (with the reason), `droppedReviews` and `droppedRows` (every review or row a gate rejected, with the reason)
- `<structure>/v1/meta-plate-take<N>-<ratio>.jpg`, `meta-generic-take<N>-<ratio>.jpg` (product-free plates), `meta-final-take<N>-<ratio>.jpg`, `proof.json` (per take: the verdict, and for each final its critique, occlusion and overflow); `<structure>/copy.json`
- `flexible-ad.json` and `flexible-ad.md` with the landing URL and price (absent when fewer than 2 structures finish; `short: true` when fewer than the target)
- `run.json` with `structures` (ids, layouts and source days), `landing`, `offer`, `rejectedStructures`, cost and budget; `error` when something escaped

A take is written to disk the moment it is checked. A throw inside one structure (a render error, a cut-off reply) records `failed: <message>` for that structure and replaces it; the run carries on. Anything that escapes still writes `run.json` with `error` and archives the run before rethrowing. The run is archived to the main checkout on success, on a thrown error and on SIGINT/SIGTERM. One deferred notification per run (`status: 'info'`); `status: 'error'` only when the agent itself broke.

## Gates

Copy: no em dash, no health claim, deodorant never antiperspirant, no named competitor (`config/competitors.json`), every fact sourced verbatim, and the variant gate (`variantConflicts`: a sibling variant's scent term, or "nothing added" on a scented variant). Reviews are screened twice before they can be quoted or cited: `selectQuotableReviews` (health claims) and `screenReviews` (condition words such as diabetic or cuts, competitor names, sibling scents, em dashes, antiperspirant/OTC). The checklist's "theirs" column is a generic category ("Typical drugstore lotion"), never a brand.

Occlusion: `critiqueArtifact` judges the TYPE, never what it sits on, so every final whose type passed critique (and did not overflow) gets `occlusion.js`'s `checkOcclusion`, told where this layout's type, cards and bands sit. It fails closed.

## needsHumanReview

A structure with hands or a face in frame (`texture-scoop`) is flagged for an anatomy check. `verify.js` checks nothing about anatomy, and every output that carries the flag says so: `run.json` and `flexible-ad.json` (`needsHumanReviewNote`), the notification, and a section in `flexible-ad.md` listing the images.

## Not yet built

The research refresh command (`research.js --refresh`) that proposes new candidate structures from the Meta Ad Library is specified but not part of this agent yet; new structures are added to the library by hand, with Sean's approval.
