# ad-concepts

Structure-first ad creation. One run produces one Meta flexible ad built on proven competitor ad STRUCTURES: up to 3 finished images from 3 distinct layouts, all at ONE output ratio (default 4:5), 2 primary texts and 2 headlines. The model fills slots in a structure; it never invents a concept. Nothing is published to Meta. Spec: `docs/superpowers/specs/2026-10-03-ad-structures-design.md`.

Why: on 2026-10-03 three live runs of model-invented concepts (a coconut-shell bar, a lather storm cloud, a melting iceberg) produced nothing anyone wanted to click. The same day, three ads modelled on the STRUCTURES of competitor ads that had run 200-300+ days were approved first time. The invented-concept stage (concept prompt, judge, picker, overlay copy) was retired and deleted.

## Usage

```bash
node agents/ad-concepts/index.js --products coconut-moisturizer,coconut-lotion --variant pure-unscented \
  --landing sensitive-skin-starter-set [--offer "Sensitive Skin Set $46.80 (was $58)"] \
  [--structures comment-card-offer,texture-scoop,they-think-we-sell] [--ratio 4:5|1:1] [--max-renders 30] [--dry-run]
```

- `--products` (required): the products that may APPEAR in the images. Each needs reference photos under `data/product-images/<imageDir>/<variant>/` and label strings in `data/product-images/manifest.json`, or the run refuses before any paid call. A product's kind comes from its manifest description: a squeeze bottle is `lotion`, a jar is `cream`.
- `--landing`: the product page the ad sends people to. Its title, URL and live price are read from `https://www.realskincare.com/products/<handle>.json`. Defaults to the single `--products` entry; required when there are several.
- `--offer`: optional free text naming a price and a was-price. The run aborts before any paid call unless both numbers match a live variant's `price` and `compare_at_price` of the landing product, and unless the resulting band (e.g. `SENSITIVE SKIN MOISTURIZING SET $46.80 (WAS $58)`) passes the copy gate. Without `--offer` every band is an always-true value line (`FREE SHIPPING ON ORDERS OVER $45`, `MADE IN THE USA`, the catalog's `ONLY N CLEAN INGREDIENTS`), gated the same way.
- `--structures`: run these library ids first (any number; more than 3 is honoured). An id that is not eligible this run aborts before any paid call. **Default selection ranks by the source ad's days running**, so without this flag the longest-running structures win (today `product-group-plain` at 386 days comes first). To reproduce the approved trio of 2026-10-03, pass `--structures comment-card-offer,texture-scoop,they-think-we-sell`.
- `--ratio`: the ONE output ratio of every final in the run, `4:5` (default; Meta steers feed to 4:5, and a flexible ad shares one ratio) or `1:1`. Only structures supporting that ratio are selected.
- `--max-renders` caps render attempts (default 30, `USD_PER_RENDER` each).
- `--dry-run` stops after selection and slot filling, writes `plan.json`, makes no render. Run it first.

## The library

`data/ad-structures/library.json` (tracked), with the source screenshots under `data/ad-structures/sources/`. Each structure cites at least one source ad and its days running, names a layout, its run ratios (`ratio`, plus optional `ratios[]` listing every run ratio it supports; each must be one its layout renders), the product kinds it `fits` (in order of preference: a structure is shot on the `--products` entry whose kind comes first), the evidence it `requires` (`review`, `offer`, `catalogFact`, `bundleLanding`), whether people are in frame, the scene recipe (`primary` and `fallback`), and its slots. A multi-plate structure lists `plates[]`, each with its own render `ratio` (1:1, 4:5, 3:4 or 9:16): the split's product-free left plate renders at 9:16 and its product plate at 3:4, as in the approved reference, while the final is laid out at the run ratio. `loadLibrary` validates it at load; an unknown layout, a missing source image or bad label positions throw.

## Pipeline

```
evidence per product (photo + label guards) -> landing page -> offer verified (or abort)
  -> reviews screened (selectQuotableReviews, then screenReviews) -> evidence present this run
  -> eligible structures (approved, evidence present, fits a product) -> select (override, then most days running, distinct layouts; < 2 eligible aborts)
  -> per structure: fill slots
       quote: the model picks a review BY INDEX (one retry on an unusable reply) from reviews OF THE PRODUCT PICTURED, code inserts it verbatim, attributed "Customer review"
       headline-type slots: one gated model call (gateCopy, one regeneration); a slot marked sourceWords: "reviews" (texture-scoop) must use only words its reviews use
       checklist "ours" rows: candidates from the PDP and the catalog title, filtered, gated, then the model picks 3-4 BY INDEX (plan.json records the offered list)
       template slots: deterministic, through screenRows
       band: verified offer, else the structure's bandPreference value line, else the first value line that passes gateCopy
       a structure whose slots cannot be filled (e.g. no review short enough to quote whole) is skipped and replaced
  -> per structure: plate takes, each plate at its own ratio (a single-plate structure's plate at the run ratio)
       product plate: 2 takes on the primary scene, then 2 on the fallback, through Ad Studio's verifyImage (fidelity, label, volume, stray text)
       product-free plate (the split's left panel): rendered without references, 1 take then 1 fallback take only if it failed, through a fail-closed stray-text check
  -> layout in code (layouts/*.js, brand fonts, Puppeteer) -> critique -> occlusion (asked about the layout's own type regions)
  -> a structure with no usable final is replaced by the next eligible structure with an unused layout
  -> flexible copy against the landing product (2 primary texts, 2 headlines, gated) -> flexible-ad.json / .md
```

## Output

`data/creatives/ad-studio/structures-<landing>-<variant|default>-<stamp>/`

- `plan.json` the planned structures with every filled slot, the product each is shot on and `offered` (the gated checklist rows the model chose from), `skipped` (slots could not be filled, with the reason), `ineligible` (with the reason), `droppedReviews` and `droppedRows` (every review or row a gate rejected, with the reason)
- `<structure>/v1/meta-plate-take<N>-<plate ratio>.jpg`, `meta-generic-take<N>-<plate ratio>.jpg` (product-free plates), `meta-final-take<N>-<run ratio>.jpg`, `proof.json` keyed on each plate's real file name (per take: the verdict; on the product plate, `final`, critique, occlusion and overflow); `<structure>/copy.json`
- `flexible-ad.json` and `flexible-ad.md` with the landing URL and price (absent when fewer than 2 structures finish; `short: true` when fewer than the target)
- `run.json` with `structures` (ids, layouts and source days), `landing`, `offer`, `rejectedStructures`, cost and budget; `error` when something escaped

A take is written to disk the moment it is checked. A throw inside one structure (a render error, a cut-off reply) records `failed: <message>` for that structure and replaces it; the run carries on. Anything that escapes still writes `run.json` with `error` and archives the run before rethrowing. The run is archived to the main checkout on success, on a thrown error and on SIGINT/SIGTERM. One deferred notification per run (`status: 'info'`); `status: 'error'` only when the agent itself broke.

## Gates

What is gated, exactly (and what is not):

- **Every visible string** (slot text, bands, checklist rows, bundle labels, flexible copy) passes `gateCopy`: no em dash, no health claim (Ad Studio's `health-claims.js`), deodorant never antiperspirant, no named competitor (`config/competitors.json`, case-sensitive), and the variant gate (`variantConflicts`: a sibling variant's scent term; "nothing added" on a scented variant; on an unscented variant, any wording that describes or praises a scent, negations such as "no scent" or "no added fragrance" excepted).
- **Claims a model lists** are checked verbatim against a source (`checkClaimsSourced`). This only covers what the model declares as a claim; a model slot's text is not itself proven true, which is why model slots are short and few. A `sourceWords: "reviews"` slot is stricter: every content word must appear in the review evidence.
- **Quotes** are whole reviews, verbatim, chosen by index, only from reviews fetched for the product the structure pictures. Reviews are screened twice first: `selectQuotableReviews` (health claims) and `screenReviews` (condition words such as diabetic, cuts, burning, rash, scarring, competitor names, sibling scents, em dashes, antiperspirant/OTC).
- **Checklist "ours" rows** must be verbatim in the catalog or PDP. Never a candidate: text inside quote marks on the PDP (a quoted review is not our fact), anything under 3 words, the product's own title or name.
- **Value-line bands** come only from an allowlist (`valueLineOptions` in `landing.js`: free shipping threshold, made in the USA, the catalog's ingredient count, and the two joined). An offer band exists only when `--offer` matches a live variant.
- The checklist's "theirs" column is a generic category ("Typical drugstore lotion"), never a brand.

Occlusion: `critiqueArtifact` judges the TYPE, never what it sits on, so every final whose type passed critique (and did not overflow) gets `occlusion.js`'s `checkOcclusion`, told where this layout's type, cards and bands sit. It fails closed.

## needsHumanReview

A structure with hands or a face in frame (`texture-scoop`) is flagged for an anatomy check. `verify.js` checks nothing about anatomy, and every output that carries the flag says so: `run.json` and `flexible-ad.json` (`needsHumanReviewNote`), the notification, and a section in `flexible-ad.md` listing the images.

## Labelled bundle

`labelled-bundle-offer` shows the landing SET itself, never the `--products` standing in for it. It is eligible only when `--offer` is verified AND the landing product has its own entry in `data/product-images/manifest.json` with reference photos (its variant directory, else its image root) and label strings. The labels are the set's components as its manifest description names them (`bundleComponents`: "Body Lotion", "Body Cream", "Hand & Body Soap"), each at most 28 characters and gated. Otherwise it is ineligible with the reason `landing bundle has no photos` (or no label strings, or fewer than 2 components).

## Research refresh (`research.js`)

On demand only, never scheduled. It proposes structures; it never approves one.

```bash
node agents/ad-concepts/research.js --refresh [--brands kopari,native] [--no-keywords] [--min-days 90]
node agents/ad-concepts/research.js --approve <candidate-id>
```

- `--refresh` reads the advertisers and keyword searches in `data/ad-structures/brands.json`, pulls active image ads from the Meta Ad Library with a headful Chrome (headless is blocked), never logs in, paces page loads 3s+, and stops at a login wall or captcha. It keeps body lotion/cream/butter/balm statics that have run `--min-days` (default 90), tags each with one vision call (format and anything non-transferable), and writes `data/ad-structures/candidates/<date>.json`, the compressed images and a `<date>.md` report. It never edits `library.json`. One deferred notification.
- `--approve <id>` appends that candidate to `library.json` with `status: "candidate"` only, never `approved`, and only when a complete, valid entry can be built automatically (atomic write, re-validated with `loadLibrary`). Otherwise it writes `candidates/<id>.needs-human.md` and leaves the library alone. A candidate never runs: only `approved` structures are eligible, and Sean promotes one by hand after looking at it.

**Known gap: carousels.** The refresh treats a CAROUSEL ad as a static and tags only its first card, and this agent builds single images only. A long-running carousel's proof is about the sequence, so a candidate that came from one needs a human look before it is promoted.
