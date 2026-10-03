# ad-concepts

Concept-first ad creation. One run produces one Meta flexible ad: 3 finished images from 3 distinct concepts, 2 primary texts and 2 headlines. Nothing is published to Meta. Spec: `docs/superpowers/specs/2026-10-03-ad-concepts-design.md`.

## Usage

```bash
node agents/ad-concepts/index.js --product <handle> [--variant <name>] \
  [--concept "<idea>"]... [--ratio 4:5|1:1] [--max-renders 30] [--dry-run]
```

- `--concept` may repeat. Requested concepts lead the picks but still face every gate.
- `--ratio` defaults to `4:5`. `--max-renders` caps render attempts (default 30, `USD_PER_RENDER` each).
- Tip: run `--dry-run` first. It generates, gates and judges concepts, writes `concepts.json`, and spends no render budget.

## Pipeline

```
evidence -> generate concepts -> pre-gate -> judge -> pick 3 (distinct families)
  -> per concept: shot spec -> 3 takes (+2 retry) -> verifyImage gate
       -> overlay copy (gated) -> typeset in code -> critique
       -> on failure, next runner-up from an unused family
  -> flexible copy (2 primary texts, 2 headlines, gated) -> flexible-ad.json / .md
```

## Output

`data/creatives/ad-studio/concepts-<product>-<variant|default>-<stamp>/`

- `concepts.json` every concept with its verdict
- `<concept>/v1/meta-plate-take<N>-<ratio>.jpg`, `meta-final-take<N>-<ratio>.jpg`, `proof.json`
- `<concept>/copy.json`
- `flexible-ad.json` and `flexible-ad.md` (absent when fewer than 2 concepts finish; `short: true` when only 2)
- `run.json` totals, cost and budget (`budget.stopped`, `budget.skipped`)

The dashboard's Ad Studio screen lists these runs.

## needsHumanReview

A concept with people in frame is flagged for an anatomy check (hands, faces). The ids are in `run.json`, in `flexible-ad.json`, and the notification subject reads `NEEDS HUMAN REVIEW`. Look at those images before shipping.
