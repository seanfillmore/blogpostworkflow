# Voice-of-Customer & Persona Research Agent — Design

**Date:** 2026-07-26
**Status:** Approved design, pending implementation plan
**Branch:** `feature/voice-of-customer-agent`

## Problem

RSC has no durable record of what customers actually say — their objections, the
phrases they use, what triggers a purchase. Every agent that writes persuasive
copy invents its angle from scratch or, worse, borrows one.

The Ad Builder is the concrete case. In
`agents/creative-packager/index.js:244`, the messaging angle handed to the
generator is derived from the **competitor reference ad's**
`analysis.messagingAngle`, sourced via `lib/meta-ads-library.js` and
`agents/competitor-ads/`. The Ad Builder is architecturally a
competitor-ad reverse-engineering machine. Creative strategy that starts from
what competitors are running is the weakest available starting point: it copies
their positioning, their personas, and their mistakes, with no evidence any of
it works for us.

The fix is to build the layer that belongs *before* format and angle selection:
who our customers are, what stops them buying, and what language moves them.

## Prime Directive alignment

This is Offer/AOV-phase work in the `Tracking → CRO → Offer/AOV → Traffic`
sequence, not a Traffic-phase bet. The same objection corpus that would improve
paid-social creative also improves PDPs and collection pages, which is where the
Shopify revenue actually is. The artifacts pay off whether or not Meta ever
launches.

## Scope

**In scope (v1):**

- Skin cluster only — the paid-ready half of the two-businesses thesis
  ($15–25/order), and 293 of our 390 reviews. The cluster is defined as an
  explicit handle list, not a keyword match (see below).
- Sources: Judge.me reviews, Reddit via Tavily, Google page-1 via DataForSEO SERP.
- Three artifacts: `voice-of-customer.md`, `personas.md`, `personas.json`.
- Consumers: `creative-packager`, `blog-post-writer`, `pdp-builder` — plus
  ad-hoc human queries against the files themselves.

**Out of scope (v1), with reasons:**

- **Any dashboard UI.** No picker, no review card, no approval screen. The
  artifacts are files; agents read them and so does a human with a text editor
  or a Claude Code session. Adding UI would be the most expensive part of the
  build for the least benefit.
- **An approval gate.** Without a dashboard there is nowhere to approve, and the
  gate's justification — personas must not change silently beneath a live ad
  account — does not apply while no Meta account is running. The agent writes
  its artifacts directly, per the Autonomy Principle. If a live account later
  makes silent drift a real risk, a gate can be added then; the corpus cache
  and dated report files make any regression diffable in git meanwhile.
- `cro-cta-injector` — injects a static CTA block, not LLM-driven. Consuming
  this research means generating copy, a materially larger job.
- Amazon review mining — SP-API exposes BA/SQP search terms, not review text.
  Would require Firecrawl scraping.
- YouTube comment mining — same scraping fragility, lower signal density.
- Oral-care and deodorant clusters — 41 and 8 reviews respectively. Thin corpora
  produce speculative personas, and both clusters are retention-only economics.
- Ad-comment mining — no ads are running to mine.

## Corpus baseline (measured 2026-07-26)

390 Judge.me reviews, 4.68 average.

| Product | Reviews | Avg |
|---|---|---|
| coconut-lotion | 97 | 4.91 |
| coconut-soap | 59 | 4.56 |
| body-lotion-1 | 58 | 4.72 |
| organic-foaming-hand-soap | 41 | 4.59 |
| coconut-oil-toothpaste | 41 | 4.07 |
| coconut-moisturizer | 38 | 4.66 |
| coconut-breeze | 37 | 4.95 |
| coconut-oil-lip-balm | 11 | 4.64 |
| coconut-oil-deodorant | 8 | 5.00 |

**Skin cluster definition.** An explicit handle list, hardcoded in
`lib/voice-of-customer.js` and asserted in tests — not a keyword match, which
would silently pull in or drop products as the catalog changes:

```
coconut-lotion, body-lotion-1, coconut-moisturizer,
coconut-soap, organic-foaming-hand-soap
```

That is 293 reviews. `organic-foaming-hand-soap` is included deliberately: it is
a skin-contact wash-off product whose reviewers share the sensitive-skin and
ingredient-scrutiny concerns of the lotion buyers, and 41 reviews is meaningful
signal at this corpus size. `coconut-breeze` and `coconut-oil-deodorant` are
deodorant scents and are excluded; `coconut-oil-toothpaste` and
`coconut-oil-lip-balm` are excluded as separate clusters.

Two consequences drive the design. The corpus fits in a single Claude call
(~30k tokens) — no chunking, sampling, or map-reduce. And at 4.68 stars it is
survivor-biased: it yields golden-nugget phrases and trigger points but almost
no objections. **Objections must come from external sources**, which is why
Reddit and SERP are not optional extras.

## Architecture

Approach chosen: **one agent, two phases, cached corpus.**

```
COLLECT                          ANALYZE                    ARTIFACTS
─────────────────────────────    ──────────────────────    ─────────────────────────
lib/judgeme.js                   one Claude call            data/context/
  fetchAllReviewStats            over the full corpus         voice-of-customer.md
  → 293 skin-cluster reviews     (~45k input tokens:          personas.md
                                  ~30k reviews + external      personas.json
lib/tavily.js                     sources + prompt)
  Reddit threads on natural                                   data/reports/voice-of-customer/
  skincare / coconut oil /       extracts:                      corpus-YYYY-MM-DD.json
  sensitive skin friction          · objections                  latest.json
                                   · golden-nugget phrases
lib/dataforseo.js                  · trigger points
  SERP page-1 for our head         · "not-for" signals
  terms — red flags a first-
  time buyer would hit           personas ranked by
                                 volume AND emotional
                                 intensity
```

**Files:**

- `agents/voice-of-customer/index.js` — orchestration, I/O, notify
- `lib/voice-of-customer.js` — pure brain: source normalization, dedup, cluster
  filtering, prompt assembly, output parsing and schema validation. Follows the
  `lib/seo-opportunities.js` precedent so the logic is unit-testable without
  network or LLM.

**CLI:**

```
node agents/voice-of-customer/index.js              # collect + analyze
node agents/voice-of-customer/index.js --collect    # refresh corpus only
node agents/voice-of-customer/index.js --analyze    # re-synthesize from cached corpus
```

The cached corpus is the durable intermediate. `--analyze` alone re-runs
synthesis against the last corpus, making prompt iteration cost one LLM call
with no refetch. Prompt quality is where the output value lives, so that loop
needs to be cheap.

**Cadence:** monthly, on the 1st, via `scheduler.js`. Reviews accrue a handful a
week and Reddit/SERP sentiment moves slowly. Marginal cost is roughly one
mid-size LLM call plus ~20 Tavily/DataForSEO queries per month.

### Ranking by emotional intensity

Personas are ranked by volume **and** emotional intensity, not volume alone. The
LLM scores each persona cluster on how much affect-laden language its source
quotes carry, and that score is a first-class field in `personas.json` beside
`evidence_count`. A persona appearing in 12 reviews with intense language
outranks one appearing in 40 flat ones. This is what surfaces under-served
segments that a pure frequency count buries.

## Artifact contracts

### `data/context/personas.json`

The only artifact with a schema contract.

```json
{
  "generated_at": "2026-08-01T15:04:00Z",
  "corpus_ref": "corpus-2026-08-01.json",
  "cluster": "skin",
  "partial": false,
  "personas": [{
    "id": "eczema-flare-parent",
    "name": "…",
    "summary": "…",
    "evidence_count": 23,
    "emotional_intensity": 8.4,
    "angles": [{
      "id": "steroid-cream-off-ramp",
      "label": "…",
      "awareness": "unaware | problem-aware | solution-aware | product-aware | most-aware",
      "objection_addressed": "…",
      "proof": "…",
      "hook_examples": ["…"],
      "source_quotes": ["…"]
    }]
  }]
}
```

Two to three angles per persona, each tagged with an awareness level — that
tagging is what makes awareness-gap analysis possible later without re-running
research. Every angle carries `source_quotes`; nothing enters the file
unsourced.

The `personas` array is **ordered by rank, highest first**, combining
`evidence_count` and `emotional_intensity`. Order is part of the contract:
`creative-packager` uses `personas[0].angles[0]` as its default when no persona
is named explicitly.

### `data/context/voice-of-customer.md`

LLM prompt context. Fixed sections, stable across runs:

- `## Objections`
- `## Golden-nugget phrases`
- `## Trigger points`
- `## Who we're not for`
- `## Source notes`

Each entry carries an evidence count and a verbatim quote.

### `data/context/personas.md`

Human-readable rendering of the JSON. This is the artifact to read when you want
to know who we are selling to, and the one to check first after any run.

### Written for querying, not just parsing

Both markdown files are committed to git and live under `data/context/`
alongside `feedback.md`, so they are greppable, diffable across runs, and
loadable into a Claude Code session by path. Two constraints follow from that
and are binding on the generator:

- **Stable heading text.** Section headings never change wording between runs,
  so `grep`-based lookups and any consumer slicing by heading keep working.
- **Self-contained entries.** Every objection, phrase and trigger point states
  its own context in one line rather than referring to a preceding entry, so a
  single grep hit is useful on its own.

## Consumer wiring

| Consumer | Change |
|---|---|
| `agents/creative-packager/index.js:109` | `job.copyBrief` gains optional `personaId` + `angleId`, set from the job spec or CLI — no UI. When set, `brief.angle` and a new persona line come from `personas.json` and the reference ad drops to style-only. When unset, the default angle becomes `personas[0].angles[0]` instead of the competitor ad's `messagingAngle`. |
| `agents/blog-post-writer/index.js:44` | New `loadVoiceOfCustomer()` alongside `loadAgentFeedback()`; whole doc into the prompt for objection-led openings. |
| `agents/pdp-builder/index.js` | VOC doc fed into `loadFoundation()`. |

Note that `creative-packager`'s behavior *does* change when no persona is named:
that is the point of the build. If `personas.json` is missing or empty it falls
back to the current competitor-derived angle, so the agent never breaks — but
once the file exists, the competitor ad no longer supplies the angle.

With no `personas.json` at all, every consumer degrades to exactly current
behavior. The feature is never half-live.

## Failure modes

| Condition | Behavior |
|---|---|
| Tavily or DataForSEO unavailable | Degrade to Judge.me-only, mark corpus `partial: true`, carry the flag into `personas.json` and print a `## Source notes` line reading "generated without external friction data." Never silently ship a thin corpus as a full one. |
| Malformed or schema-violating LLM output | Validate, retry once, then throw and `notify()` as an error. Errors bypass digest deferral and email immediately. No partial write — the previous artifacts stay in place. |
| Zero new reviews since last run | Skip the LLM call, log, exit 0. Expected on a store averaging ~0.5 orders/day. |
| Bad output survives validation | The artifacts are committed to git, so `git diff data/context/personas.md` shows exactly what changed month over month and reverting is one command. This replaces the approval gate. |
| Judge.me pagination cap | `fetchAllReviewStats` caps at 50 pages / 5000 reviews. Currently 390. The collector logs the count so approaching the cap is visible. |

## Testing

`tests/lib/voice-of-customer.test.js`, following the existing `tests/` layout,
over the pure functions in `lib/voice-of-customer.js`:

- corpus normalization across three source shapes (Judge.me review, Tavily
  result, DataForSEO SERP item) into one record type
- dedup — the same Reddit thread arriving via both Tavily and SERP collapses to
  one record
- skin-cluster filtering by product handle
- schema validation — reject a persona with zero angles, an angle with no
  `source_quotes`, an `awareness` value outside the allowed set
- `partial` flag propagates from corpus into output

Plus `tests/agents/voice-of-customer.test.js`: one smoke test with a stubbed LLM
client asserting all three artifacts are written, and one asserting
`creative-packager` picks `personas[0].angles[0]` when no `personaId` is given
and falls back to the competitor-derived angle when `personas.json` is absent.

The LLM call itself is not unit-tested. The value is in the prompt, and the real
check is reading `personas.md` on the first run.

## Success criteria

1. A single run produces all three artifacts from live data, and `personas.md`
   is good enough to act on without editing.
2. `creative-packager` can generate a creative from a chosen persona + angle
   with no competitor reference ad involved.
3. `voice-of-customer.md` contains at least one objection that did not come from
   our own reviews — proving the external sources are earning their place.
4. Every consumer behaves identically to today when no personas file exists.
5. A question like "what stops people buying our lotion?" is answerable by
   grepping `data/context/voice-of-customer.md`, with quotes attached.

## Follow-on work (not v1)

- Oral-care and deodorant persona sets once those corpora justify it.
- `cro-cta-injector` fed VOC-derived copy rather than a static block.
- Awareness-level and persona **gap analysis** against a running Meta account —
  requires ads to exist first.
- Amazon "Ask AI" persona breakdown, folded in manually.
