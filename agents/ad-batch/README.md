# ad-batch

One concept in, 15-20 finished 4:5 ad images out. You write the headlines. The tool varies the scene and designs the headline into each image, the way Everitt Moder's Trybe statics are built.

```bash
npm run ad-batch -- batch.json            # render
npm run ad-batch -- batch.json --dry-run  # plan the scenes, print the first prompt, render nothing
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
- **`concepts[].cta`**: optional. A short button line ("See real cream →") set in a pill under the headline. It is gated and checked letter by letter like the headline.

Output goes to `~/Desktop/Ad Batches/<date> <product>/<NN headline>/`:
- passing images;
- `_rejected/`, which holds failed images with the reason in `scenes.md`;
- `_contact sheet.jpg`, where ✋ marks hands;
- `scenes.md`;
- the batch's `run.json`.

**Adding scenes:** edit `data/ad-batch/scenes.json`. Give each scene a family, a one-line scene, a type style and the product categories it suits. Add `"style": "animated"` for an animated scene; untagged scenes are photo scenes.

**Adding reference photos:** list them in `data/ad-batch/references.json`. Paths are relative to `data/product-images/`, which is gitignored and lives locally.

Each render gets two `gpt-image-2` tries, then one Gemini try. A vision read transcribes every letter, and code decides pass or fail. See `docs/superpowers/specs/2026-10-06-ad-batch-design.md`.
