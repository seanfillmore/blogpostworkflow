# ad-batch

One concept in, 15-20 finished 4:5 ad images out. You write the headlines. The tool varies the scene and designs the headline into each image, the way Everitt Moder's Trybe statics are built.

```bash
npm run ad-batch -- batch.json            # render
npm run ad-batch -- batch.json --dry-run  # plan the scenes, print the first prompt, render nothing
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
- **`concepts[].cta`**: optional. A short button line ("See real cream →") set in a pill under the headline. It is gated and checked letter by letter like the headline.

Output goes to `~/Desktop/Ad Batches/<date> <product>/<NN headline>/`:
- passing images;
- `_rejected/`, which holds failed images with the reason in `scenes.md`;
- `_contact sheet.jpg`, where ✋ marks hands;
- `scenes.md`;
- the batch's `run.json`;
- `meta-copy.md`: the Meta ad copy, 4 primary texts (each under 300 characters, at least one under 125) and 4 headlines (40 characters or fewer), the landing page, which copy goes with which folder, and the source of every claim.

**Meta copy.** After rendering, and before the images are queued in the Social tab, the tool writes `meta-copy.md` (`meta-copy.js`). The Social tab's suggested captions are grounded in it. Sources are the live product page, `data/brand/product-catalog.json`, ingredient lists by scent from `config/ingredients.json`, the brand facts in `config/press-facts.json` (no prices, percentages or review counts) and screened 4-5 star reviews. Every string goes through the shared gates: the commercial health-claim gate with one retry (`lib/seo-copy-gate-loop.js`), ad-concepts' `gateCopy` (ad health gate, claim sourcing, competitors, sibling scents, "antiperspirant"), no dashes, no prices, and every number must be quoted in a sourced claim for that field. If the copy fails twice, no file is written and the captions fall back to the image headlines; the batch never fails over copy. An existing `meta-copy.md` is left alone unless you pass `--rewrite-copy` (the old one is kept as `meta-copy.previous-<time>.md`). `--no-copy` skips the step. The outcome is in `run.json` under `metaCopy`.

**Adding scenes:** edit `data/ad-batch/scenes.json`. Give each scene a family, a one-line scene, a type style and the product categories it suits. Add `"style": "animated"` for an animated scene; untagged scenes are photo scenes.

**Adding reference photos:** list them in `data/ad-batch/references.json`. Paths are relative to `data/product-images/`, which is gitignored and lives locally.

Each render gets two `gpt-image-2` tries, then one Gemini try. A vision read transcribes every letter, and code decides pass or fail. See `docs/superpowers/specs/2026-10-06-ad-batch-design.md`.
