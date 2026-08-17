# Ad Brief

Generates ad **briefs** — one per persona angle — before any image is rendered.

```bash
node agents/ad-brief/index.js --product coconut-lotion [--variant coconut-breeze] \
                              [--angles p1a1,p5a3] [--dry-run]
```

## Why this exists

Ad Studio used to write copy and immediately spend ~$0.78 rendering it. The copy is
the part that decides whether a concept was ever worth rendering — judging it first
costs roughly a tenth of finding out from pixels, and a copy call is one Anthropic
request instead of an Anthropic call plus several paid Gemini renders and verify passes.

## What a brief is

The FINISHED, gate-passed copy for one persona angle, plus the evidence behind it and a
score. A brief is written to `data/briefs/ad-studio/<product>/<briefId>.json`
(`lib/ad-brief.js`). Approving one renders those exact strings with no second LLM call —
nothing drifts between what a human read and what gets baked into a plate.

Each brief carries:

- `personaId` / `personaName` / `angleId` / `angle` — which voice-of-customer persona
  and angle this brief is for, straight from `data/context/personas.json`.
- `format` — `{ proposed, alternatives }`, resolved by the awareness join (below).
- `zones` / `claims` — the actual generated copy and its sourced claims, present only
  when a format exists and the gates passed.
- `gates` — see "Where strictness lives" below. Absent entirely when there is no
  format to gate.
- `score` — see "Scoring" below.
- `state` — see "State vocabulary" below.

## The awareness join

`agents/ad-studio/formats.js` tags each ad format `problem` / `solution` / `product`
awareness. `data/context/personas.json` angles carry the finer five-level
Schwartz scale: `unaware`, `problem-aware`, `solution-aware`, `product-aware`,
`most-aware`. `formatsForAngle()` is the join between the two — it lets a brief
propose its own format instead of a fixed rotation choosing one for it.

**The known gap:** `unaware` and `most-aware` map to `null` — no format built so far
covers either. As of 2026-08, that is 4 of the 15 angles on file
(`AWARENESS_TO_FORMAT_AWARENESS`). By the headroom argument below, those are among the
most valuable angles this project holds evidence for, and by design this agent does
**not** paper over the gap: an unmatched angle is still recorded (`format.proposed:
null`, `state: 'ready'`, no copy call spent), so the gap stays countable instead of
silently disappearing into "closest available format." The moment a format is built for
either level, `formatsForAngle()`'s test suite (`tests/agents/ad-brief.test.js`) will
start failing the "no format" assertions — that's the signal to widen the map.

## Why the gates are imported, never reimplemented

`buildConcept` (`agents/ad-studio/index.js`) runs `assertNoHealthClaims` then
`assertClaimsSourced`, in that order, on every concept it builds. This agent calls
`buildConcept` directly rather than re-running those checks itself. A second copy of a
compliance gate that could drift from the first — different regex, different claim
matcher, updated in one file and not the other — would be strictly worse than having no
gate at all, because it would look safe.

`gates` is derived from what `buildConcept` returns:

- **Success** (`result.ok === true`): both gates ran and passed —
  `{ health: { ok: true }, claims: { ok: true, unsourced: [] } }`.
- **Rejection** (`result.ok === false`): `buildConcept` runs health BEFORE claims, so on
  a rejection exactly one of the two ever executed — the other never got the chance to
  fail. `gatesFromRejection()` reads `result.error`'s message prefix
  (`"Health claim gate failed"` vs `"Claim gate failed"`, the same strings
  `buildConcept` itself matches on) to tell which one fired, marks that one
  `ok: false` with the violations and the full error text attached, and leaves the
  other `ok: true` — accurate, since it did not fail.

An angle with no matching format never reaches `buildConcept` at all, so it carries no
`gates` block. `lib/ad-brief.js`'s `writeBrief`/`decideBrief` both refuse to approve a
brief whose `gates.health.ok` and `gates.claims.ok` are not both strictly `true` — a
missing `gates` block is correctly unapprovable, because there is no copy behind it to
approve.

**The unrecognised-rejection case.** `gatesFromRejection()` tells health and claims
rejections apart by matching `result.error`'s message prefix against the exact strings
`buildConcept` itself checks (`"Health claim gate failed"` / `"Claim gate failed"`) —
the same coupling `buildConcept` has to `health-claims.js`/`claims.js`'s wording. If a
future rename ever breaks that match, `gatesFromRejection` does not guess which gate
"must have" failed and does not trust the one that didn't obviously fail either — it
marks **both** `ok: false` with `unresolved: true`. A brief whose gate outcome cannot be
determined must never be indistinguishable from one that passed.

## Per-angle persistence, not a batch write

Each brief is written via `writeBrief()` **immediately** after it is generated, inside
the per-angle loop (`generateBriefs()`), not accumulated in memory and written once the
whole batch finishes. If anything throws that is not a gate rejection — a transient API
error, a malformed copy response — on angle 3 of 5, angles 1 and 2 (already gate-passed,
already paid for) are still on disk afterward; only the angle in flight is lost. This
agent's entire premise is being the cheap, safe-to-interrupt step before real render
spend, so the persistence has to match that premise per-angle, not per-run.

## The cluster-scoping abort

`data/context/personas.json` carries a single top-level `cluster` (currently `"skin"`)
and no per-persona product linkage — the personas were written for a specific product
cluster, not this codebase's whole catalog. This agent maps `cluster` to the handle list
that actually has voice-of-customer evidence behind it
(`lib/voice-of-customer.js`'s `SKIN_CLUSTER_HANDLES`) and **aborts** if the requested
product isn't in that list, naming the cluster and telling the operator to run
`agents/voice-of-customer` for it first.

There is no fallback path and no invented persona. Voice-of-customer evidence is what
keeps ad copy honest about who it's for and why — briefing `coconut-oil-toothpaste`
against the skin cluster's eczema-parent persona would produce confident-sounding
fiction underneath a claim-gated ad, which is exactly what this whole pipeline exists
to prevent.

## Scoring (`lib/ad-brief-score.js`)

Every component is returned, never just the total — a score with hidden parts is a
black box. `scoreBrief()` sums four components, each capped:

| Component    | Max | What it measures |
|---|---|---|
| `persona`    | 30  | Evidence count + emotional intensity behind the persona (voice-of-customer's own fields). |
| `proof`      | 25  | Whether the angle's `source_quotes` actually appear in real reviews — 0 if the angle asserts a benefit no reviewer voiced. |
| `commercial` | 25  | Whether the product's cluster is earning, per `seo-impact`'s latest report; neutral (12) with no matching data. |
| `headroom`   | 20  | Awareness headroom — broad `unaware`/`problem-aware` angles convert slower but keep running longer than narrow `product-aware` ones, which harvest fast and exhaust fast. |

**The score never kills a brief.** There is no ad-performance data behind any of these
weights — `data/meta-ads-insights/` is empty and nothing this pipeline has produced has
ever run as a paid ad, so every number here is an a-priori judgement about evidence, not
a measured outcome. Objective failures (an unsourced claim, a health-claim violation)
are handled as hard floors elsewhere — the `gates` block — and are not scores. The score
only ever **ranks** briefs for a human to triage; a guess dressed up as a threshold is
how good work gets thrown away before anyone looks at it.

## State vocabulary (`lib/ad-brief.js`'s `BRIEF_STATES`)

- **`needs-evidence`** — reserved for gate failures, and nothing else. A health-claim or
  sourcing rejection lands here so the clarification loop can name the phrase and the
  source it searched.
- **`ready`** — nothing failed. Covers both a gate-passed brief with real copy AND an
  angle with no matching format (`format.proposed: null`) — there is simply nowhere to
  render the latter yet, which is not a failure.
- **`approved`** — a human decision (`decideBrief`), gated on `gates.health.ok === true
  && gates.claims.ok === true`. Only an approved brief renders.
- **`rejected`** — a human decision that the angle isn't worth pursuing.
- **`rendered`** — set once Ad Studio has consumed the brief's copy and produced a plate.

## `--dry-run` costs nothing

Unlike Ad Studio's `--dry-run` (which still makes real, paid Anthropic copy calls and
only skips the Gemini render), this agent's `--dry-run` makes **zero** Anthropic calls
and writes nothing to disk. It resolves every selected angle's proposed format, computes
its score, and prints the plan — the count of Anthropic calls it *would* make — so an
operator can see the shape of a run (which angles, which formats, how many calls) before
authorizing the spend. It still performs ordinary read-only network calls (the live PDP
JSON, Judge.me reviews) because those cost nothing and the score and relevance filtering
need real data to mean anything.

## CLI

```
--product <handle>     required
--variant <name>       optional, e.g. coconut-breeze
--angles p1a1,p5a3      optional; comma-separated angle ids. Default: every angle
                        passing angleRelevance() for this product.
--dry-run               preview only — no Anthropic calls, no writes
```
