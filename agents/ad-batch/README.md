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
- **`variant`**: the scent folder.
- **`count`**: 15-20 images per headline. Default 16.
- **`form`**: bar soap only. `packaged`, `unwrapped` or `mixed`. The default puts the bare bar in in-use scenes and the wrapped bar everywhere else.
- **`scenes`**: optional. A list of one-line scenes that replaces the library for this batch.

Output goes to `~/Desktop/Ad Batches/<date> <product>/<NN headline>/`:
- passing images;
- `_rejected/`, which holds failed images with the reason in `scenes.md`;
- `_contact sheet.jpg`, where ✋ marks hands;
- `scenes.md`;
- the batch's `run.json`.

**Adding scenes:** edit `data/ad-batch/scenes.json`. Give each scene a family, a one-line scene, a type style and the product categories it suits.

**Adding reference photos:** list them in `data/ad-batch/references.json`. Paths are relative to `data/product-images/`, which is gitignored and lives locally.

Each render gets two `gpt-image-2` tries, then one Gemini try. A vision read transcribes every letter, and code decides pass or fail. See `docs/superpowers/specs/2026-10-06-ad-batch-design.md`.
