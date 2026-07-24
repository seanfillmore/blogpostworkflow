# Ad Builder — Reference-Driven Variations (Spec Addendum)

- **Date:** 2026-07-23
- **Status:** Approved design (Sean: "Looks good")
- **Supersedes:** the "Ad Builder = product + angle → hero" flow from `2026-07-23-creatives-two-pathways-design.md`. Studio is unchanged.

## Corrected intent

The operator finds an ad they like, **uploads the image**, and the system generates **style-inspired variations featuring our products**, which they **select** and **output** as upload-ready ad packages. This replaces the mis-scoped product+angle Ad Builder.

## Reshaped Ad Builder flow

1. **Upload the reference ad** — the ad the operator likes (an image).
2. **Pick our product(s)** — 1–3 SKUs from the product picker.
3. **Generate ~4 variations** — the system extracts a *style brief* from the uploaded ad (mood, lighting, composition, palette — NOT its layout, product, or text), then generates N fresh scenes featuring our product in that style. The reference image is also passed to the generator as a visual cue.
4. **Variation grid → select** the keeper(s).
5. **Choose placements** — a checklist of the six Meta static sizes (default all checked).
6. **Generate Ad Set** on a selected variation → ZIP.

### Decisions locked

- **Style inspiration, not product-swap** — never reproduces the competitor's product, layout, or copy (avoids fidelity + trademark problems).
- **No baked-in text** — the system never renders ad copy into the image. Text is delivered separately for compositing in Photoshop.
- 4 variations per batch (default; operator can change the count).
- Studio unchanged; product+angle Ad Builder removed.
- Models: reference-ad style extraction on `claude-haiku-4-5` (vision); image generation on `gemini-2.5-flash-image`; ad copy on `claude-opus-4-8`. All via `config/creative-models.js`.

## Output ZIP structure

```
master.webp            full-res clean background (the selected variation, uncropped, high quality)
images/<size>.webp     clean background per SELECTED placement (cover-cropped to exact ad size)
guides/<size>.png      LOW-RES reference comp: copy placed in its zones + Meta safe-zone margins marked
copy.txt               paste-ready headline / body / CTA variations
specs.txt              per-size pixel dimensions + char limits
manifest.json          product, angle, destinationUrl, placements, generatedAt
```

- `images/` are clean plates to composite on; `guides/` are the "where does everything go" map; `copy.txt` is what to paste. Guides are drawn programmatically (crisp, correct positions) — not AI-generated.
- **Safe zones:** for Story/Reel sizes (1080×1920) the guide marks the top ~250 px and bottom ~340 px where platform UI covers art; feed sizes use standard margins. Guides show the first copy variation's headline/body/CTA placed in the lower/safe area as a reference.

## The six Meta static placements

`instagram-feed-1080x1080`, `instagram-feed-1080x1350`, `instagram-stories-1080x1920`, `facebook-feed-1200x628`, `facebook-feed-1080x1080`, `facebook-stories-1080x1920`. The operator checks which to include; the packager builds only those (plus the shared `master.webp`, `copy.txt`, `specs.txt`, `manifest.json`).

## Architecture (reuses the two-pathways build)

- **Reference upload:** existing `POST /api/creatives/reference-images` (stores in `REFERENCE_IMAGES_DIR`, returns a filename).
- **Style extraction:** new `POST /api/creatives/analyze-reference` — Claude Haiku vision on the uploaded ad → `{ stylePrompt }` (describes style only).
- **Variation generation:** existing `POST /api/creatives/generate`, extended to accept `referenceImagePaths` (filenames in `REFERENCE_IMAGES_DIR`) so the reference ad is passed without re-uploading per call. The frontend calls generate N times with the same style prompt + product images + reference; each result is a session version (a variation).
- **Selection:** the variation grid maps to the session's versions; picking one sets `currentVersion`.
- **Placement selection + output:** existing `POST /api/creatives/package`, extended to accept `sizes` (specific size names). The source-agnostic packager (`source: 'session'`) resizes the selected hero to the chosen sizes, adds `master.webp` + `guides/*.png`, generates copy (Opus 4.8), and zips.

## Components & interfaces

- `config/creative-models.js` — add `styleVision: 'claude-haiku-4-5'`.
- `agents/creative-packager/index.js` — new pure exports: `sizesByName(names)` (+ a flattened `ALL_PLACEMENTS`), `safeZonesFor(sizeName)`, `buildGuideSvg(size, copy)`; `main()` gains size-by-name selection, `master.webp`, and `guides/<size>.png` (sharp composite of a downscaled background + the guide SVG).
- `agents/dashboard/routes/creatives.js` — new `analyze-reference` route; `generate` accepts `referenceImagePaths`; `package` accepts `sizes`.
- `agents/dashboard/public/index.html` + `js/dashboard.js` — Ad Builder panel reshaped to reference-driven; `generateVariations()`, variation grid + select, placement checklist; `generateAdSet()` sends the selected version + checked sizes.

## Error handling

- No reference ad uploaded → block "Generate Variations" with a message.
- No product selected → warn (allow lifestyle-only, but recommend at least one).
- `analyze-reference` failure → fall back to a generic style prompt so generation still proceeds; surface a non-blocking notice.
- No placement checked at output → block with a message.
- Guide/master generation failure → best-effort; never fail the whole ZIP for a missing guide (log + include what succeeded).

## Testing

- Unit (`node --test`): `sizesByName`, `safeZonesFor`, `buildGuideSvg` (asserts SVG contains the copy text, the correct width/height, and a safe-zone marker), plus existing packager helpers.
- End-to-end on ONE reference ad (project rule #4): upload an ad → generate 4 variations → select one → check 2 placements → Generate Ad Set → confirm the ZIP contains `master.webp`, the selected `images/*.webp`, matching `guides/*.png`, `copy.txt`, `specs.txt`, `manifest.json`.
- Legacy Ad Intelligence flow regression (source `'ad'` still works).
