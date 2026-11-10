# ad-batch

One concept in, 15-20 finished ad images out, each at 4:5 (feed) and 9:16 (Stories and Reels). You write the headlines. The tool varies the scene and designs the headline into each image, the way Everitt Moder's Trybe statics are built.

```bash
npm run ad-batch -- batch.json            # render
npm run ad-batch -- batch.json --dry-run  # plan the scenes, print the first prompt, render nothing
npm run ad-batch -- batch.json --only "Headline A|Headline B"   # re-render just these, into their original NN folders
npm run ad-batch -- --copy-only "<batch dir>" [--rewrite-copy] [--landing /pages/x]   # Meta copy only, no renders
```

```json
{
  "product": "coconut-soap",
  "variant": "pure-unscented",
  "count": 16,
  "form": null,
  "concepts": [
    { "headline": "Pure. Unscented.", "subhead": "Nothing to hide." },
    { "headline": "One bar. One ingredient." }
  ],
  "scenes": []
}
```

- **`product`**: a handle from `data/product-images/manifest.json`.
- **`products`** (instead of `product`): a set of 2-3 `{ "product", "variant" }` entries, shown one of each, side by side, in every image. Add `"title"` to name the set (it names the output folder). Each product's first reference photo goes to the image model and to the check, in order, and the check reads every label and count separately. A set is always shown packaged.
- **`variant`**: the scent folder.
- **`count`**: 1-20 images per headline. Default 16. It is per headline, so total images = concepts × count. Size the total to the ad set and split it between headlines.
- **`form`**: bar soap only. `packaged`, `unwrapped` or `mixed`. The default puts the bare bar in in-use scenes and the wrapped bar everywhere else.
- **`scenes`**: optional. A list of one-line scenes that replaces the library for this batch.
- **`style`**: `photo` (default) or `animated`. Animated is a stylized 3D-animated scene: cartoon characters act out the headline, and OUR product is the one object kept photo-real and exact, at 25-35% of the frame (held by a character or in the foreground) instead of half of it. A character may hold a rival product only if it is generic or carries a made-up parody name. Library scenes are tagged by style, the fresh-scene planner writes character scenes, and the check accepts cartoon hands. The label check is unchanged.
- **`typeStyle`**: optional lettering for a custom `scenes` list, which otherwise gets a generic pairing.
- **`landing`**: optional. The realskincare.com URL or path the ad sends people to. Default: the product page, or for a set the bundle in `config/bundles.json` with exactly those products.
- **`message`**: optional. The message folder the batch files under in the creatives library (for example `"Dry Skin Pain Points"`, `"Short Ingredient List"`). It must match a folder in `MESSAGES` in `output.js` (case-insensitive), which includes the seasonal `Halloween - Body Cream`, `Fall - Body Cream` and `Holiday - Body Cream`. An unknown name never creates a folder: the run warns and the headline rules decide. Without it the first headline the rules recognise decides, and anything unrecognised lands in `_New (to sort)`. Add a new message folder to `MESSAGES` before using it.
- **`concepts[].lines`** and **`concepts[].layout`**: optional, for designed multi-text formats (split screens, checklists, an Instagram-post mockup). `layout` describes the composition in words and replaces the default "headline at the top, product as hero" placement; simple flat graphics it names (check marks, arrows, outline icons, social-app buttons) are allowed. `lines` is every other piece of text in the ad (column labels, checklist rows, a caption), at most 12, each claim-gated like the headline and checked word for word in the render. The check is told to transcribe whole text blocks, one column at a time, so two columns do not interleave. First used 2026-11-02 to adapt Coco & Luna's "What I Ordered / What I Got", "Problem / Solution" and Instagram-post statics: 12 of 12 passed on the first render. Example:
  ```json
  { "headline": "Problem", "lines": ["Solution", "Labels you can't pronounce", "Only 7 ingredients"],
    "layout": "Vertical split screen. LEFT: \"Problem\" at the top, then rows with line icons ... RIGHT: \"Solution\", a dark card of green check-mark rows, an open palm holding the product." }
  ```
- **Product fidelity (2026-11-10):** the check also fails a label whose central illustration is wrong for the scent (manifest `labelGraphics`: leaf on Pure Unscented, coconut on Coconut Breeze), units thinner than 70% of real (manifest `thicknessRatio`, 0.4 for the bar soap), and units that are fused, melted or impossibly balanced. A product whose label photo shows no depth gets a SHAPE reference (references.json `"shape"`), sent after the label references and never used by the check. `scripts/ad-batch-recheck.mjs <batch.json> <theme dir> [--move]` re-runs the current check over images already in the library. Volume and weight print are still not checked in code, so read them yourself ("550ml" and "86g" both got past the check on 2026-11-10).
- **Stars and repeats in a layout:** a `★★★★★` row is allowed only when the concept's own copy carries it (a real 5-star review card, or a rating badge quoting the live PDP figure); otherwise any star is an invented rating and fails. Under a `layout`, any multi-word piece of copy rendered twice fails the check, and the prompt places the headline where the layout says instead of as dominant lettering. Handwritten numerals read ambiguously ("1" as "I"), so spell them out on handwritten notes ("one squeeze").
- **`concepts[].cta`**: optional. A short button line ("See real cream →") set in a pill under the headline. It is gated and checked letter by letter like the headline.

Output goes to the RSC creatives library in Google Drive, `My Drive/Real Skin Care/Creatives/01 Static Ads/<theme>/`, one folder per theme (the batch `message`). Sean, 2026-11-10: "one theme folder, and inside that 4:5 and 9:16 with all of the images open in each to scroll through". Each theme folder holds:
- `4x5/`: every kept feed ad, flat, named `<date> <product> - <NN headline>[ - n].png`;
- `9x16/`: the Stories/Reels version of each, same file name;
- `Ad copy - <date> <product>.md`: the Meta ad copy for that batch (4 primary texts under 300 characters, at least one under 125, and 4 headlines of 40 characters or fewer), the landing page, which copy goes with which headline, and the source of every claim;
- `_records/<date> <product>/`: `run.json`, `meta-copy.md` and, per headline, `scenes.md` and `_rejected/` (failed 4:5 renders, and failed 9:16 renders as `9x16-<file>`). Nobody needs to open it.

"x", not ":", in the size folder names, because macOS shows a colon in a file name as a slash. On a machine without the Drive folder the theme root falls back to `~/Desktop/Ad Batches/`; `--out <dir>` (or `AD_BATCH_OUT`) makes `<dir>` the theme folder. `--copy-only` takes the batch's `_records/<date> <product>/` folder. `scripts/flatten-static-ads.mjs [--apply]` moved the older nested library into this layout on 2026-11-10 (by each image's real pixel ratio, so legacy 1:1 and wide frames went to `Other sizes/`) and rewrote every run.json; it is idempotent.

**9:16 versions (2026-11-07).** Every kept 4:5 ad also gets a 9:16 version in `<headline>/9x16/`, because Reels and Stories took 38% of 30-day spend while every static was 4:5. The 4:5 is not re-rendered: it is placed, centered, on a 1088x1936 canvas and the image model fills only the empty bands above and below it (`vertical.js`, a masked gpt-image-2 edit; Gemini gets grey bands to replace). Asked instead to recompose the ad for a tall frame, both models put the headline at 5-13% from the top every time, inside the 14% band Meta covers with the account name. Centering puts the whole 4:5 between 14.9% and 85.1% of the height. The check reads every 9:16 like a 4:5 and also measures where the text and label sit; any text in the top 14%, or text or label in the bottom 20% (Ad Studio's `SAFE_ZONE_RATIOS`), fails and retries. A failed 9:16 never costs the 4:5: it goes to the headline's `_rejected/` in `_records` and is recorded in `run.json` under each image's `vertical`. About $0.17 per 9:16. The master sheet skips `9x16/` and `_records/`. Upload both ratios to the same Meta ad (placement asset customization).

**Master sheet.** `01 Static Ads/_All Creatives.pdf` shows every creative in the library on one scrollable PDF, a section per message folder, newest batch first, each thumbnail captioned with its file and folder. Every batch filed into the library refreshes it (a failure there never fails the batch). Rebuild by hand with `node agents/ad-batch/master-sheet.js [--root <dir>]`. `_rejected/` and `_`-prefixed files are left out.

**Meta copy.** After rendering, the tool writes `meta-copy.md` (`meta-copy.js`): the primary texts and headlines for the Meta ad. Nothing is queued for the Social tab: ad images are ads, not organic posts (Sean, 2026-11-07). Sources are the live product page, `data/brand/product-catalog.json`, ingredient lists by scent from `config/ingredients.json`, the brand facts in `config/press-facts.json` (no prices, percentages or review counts) and screened 4-5 star reviews. Every string goes through the shared gates: the commercial health-claim gate with one retry (`lib/seo-copy-gate-loop.js`), ad-concepts' `gateCopy` (ad health gate, claim sourcing, competitors, sibling scents, "antiperspirant"), no dashes, no prices, and every number must be quoted in a sourced claim for that field. If the copy fails twice, no file is written and the captions fall back to the image headlines; the batch never fails over copy. An existing `meta-copy.md` is left alone unless you pass `--rewrite-copy` (the old one is kept as `meta-copy.previous-<time>.md`). `--no-copy` skips the step. The outcome is in `run.json` under `metaCopy`.

**Adding scenes:** edit `data/ad-batch/scenes.json`. Give each scene a family, a one-line scene, a type style and the product categories it suits. Add `"style": "animated"` for an animated scene; untagged scenes are photo scenes.

**Adding reference photos:** list them in `data/ad-batch/references.json`. Paths are relative to `data/product-images/`, which is gitignored and lives locally.

Each render gets two `gpt-image-2` tries, then one Gemini try. A vision read transcribes every letter, and code decides pass or fail. See `docs/superpowers/specs/2026-10-06-ad-batch-design.md`.
