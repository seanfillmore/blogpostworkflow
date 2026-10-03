# ad-concepts

Concept-first ad creation. One run produces one Meta flexible ad: 3 finished images from 3 distinct concepts, 2 primary texts and 2 headlines. Nothing is published to Meta. Spec: `docs/superpowers/specs/2026-10-03-ad-concepts-design.md`.

## Usage

```bash
node agents/ad-concepts/index.js --product <handle> [--variant <name>] \
  [--concept "<idea>"]... [--ratio 4:5|1:1] [--max-renders 30] [--dry-run]
```

- `--concept` may repeat. Requested concepts lead the picks but still face every gate. If the concept call returns fewer requested concepts than asked, `run.json` carries `requestedMissing` and the notification says so. Without `--concept`, nothing is treated as requested.
- `--ratio` defaults to `4:5`. `--max-renders` caps render attempts (default 30, `USD_PER_RENDER` each).
- Tip: run `--dry-run` first. It generates, gates and judges concepts, writes `concepts.json`, and spends no render budget.

## Pipeline

```
evidence -> generate concepts -> pre-gate -> judge -> pick 3 (distinct families)
  -> per concept: shot spec -> 3 takes (+2 retry) -> verifyImage gate
       -> overlay copy (gated) -> typeset in code -> critique -> occlusion check
       -> on failure, next runner-up from an unused family
  -> flexible copy (2 primary texts, 2 headlines, gated) -> flexible-ad.json / .md
```

## Output

`data/creatives/ad-studio/concepts-<product>-<variant|default>-<stamp>/`

- `concepts.json` every concept with its verdict
- `<concept>/v1/meta-plate-take<N>-<ratio>.jpg`, `meta-final-take<N>-<ratio>.jpg`, `proof.json`
- `<concept>/copy.json`
- `flexible-ad.json` and `flexible-ad.md` (absent when fewer than 2 concepts finish; `short: true` when only 2)
- `run.json` totals, cost and budget (`budget.stopped`, `budget.skipped`); `error` when something escaped

A take is written to disk the moment it is verified. A throw inside one concept (a render error, a cut-off model reply, typesetting) records `failed: <message>` for that concept and replaces it; the run carries on. Anything that escapes still writes `run.json` with `error` and archives the run before rethrowing. The run is archived to the main checkout on success, on a thrown error and on SIGINT/SIGTERM.

Copy gates: no em dash, no health claim, deodorant never antiperspirant, no named competitor (`config/competitors.json`), every fact sourced verbatim. Reviews carrying health-claim language are withheld up front (`selectQuotableReviews`). Flexible primary texts get Ad Studio's advisory golden-thread check (recorded as `goldenThread` in `flexible-ad.json`).

## Occlusion check

`critiqueArtifact` judges the TYPE, never what the type sits on. The first live run (2026-10-03) passed, at score 4, a caption final whose sand strip covered the top of the soap bar and clipped its logo. So every final whose type passed critique (and did not overflow) gets one more vision call, `occlusion.js`'s `checkOcclusion` (`CREATIVE_MODELS.adStudio.verify`): is any part of our product, described by `physicalDescription`, covered by the overlay type or caption strip, or cut off by the frame edge?

- The `band` treatment is tried first; an occluded band final is retried as `caption`. A take still occluded (or whose type fails critique or overflows) yields no usable final, exactly like a critique failure. A concept with no usable final is replaced; when occlusion was the reason, the verdict says `overlay occludes our product on both treatments: <detail>`.
- It fails CLOSED: a reply that is not JSON with three real booleans is a failure. A cut-off reply throws, and that concept is recorded as `failed`.
- `proof.json` carries, per plate, `critique`, `occlusion`, `treatment` (of the final on disk) and `attempts[]` (every treatment tried, with its critique and occlusion verdict).

The dashboard's Ad Studio screen lists these runs.

## needsHumanReview

A concept with people in frame is flagged for an anatomy check (hands, faces). `verify.js` checks nothing about anatomy, and every output that carries the flag says so: `run.json` and `flexible-ad.json` (`needsHumanReviewNote`), the notification, and a section in `flexible-ad.md` listing the images. Look at those images before shipping.
