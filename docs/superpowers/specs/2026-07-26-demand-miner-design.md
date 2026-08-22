# Demand Miner — Top-of-Funnel Demand Data — Design

**Date:** 2026-07-26
**Status:** Implemented — see `docs/superpowers/plans/2026-08-21-demand-miner.md`
**Depends on:** `docs/superpowers/specs/2026-07-26-voice-of-customer-agent-design.md` (PR #355)

## Problem

RSC has no top-of-funnel demand data, and the voice-of-customer corpus built in PR #355
structurally cannot produce it: Judge.me reviews come from people who already bought
(most-aware), and the Reddit queries seeded there are product-shaped, so they reach
people already shopping the category (solution-aware). The resulting persona set skews
accordingly — of 15 angles, 5 are problem-aware, 5 solution-aware, 2 most-aware,
1 product-aware, and only 2 unaware.

Meanwhile the fleet already collects top-of-funnel data and throws it away:

- `lib/dataforseo.js` `getSerpResults` filters SERP items to `type === 'organic'` and
  reduces everything else to a list of *type names* in `serpFeatures`. **Every People
  Also Ask question and related search the fleet has ever fetched has been discarded.**
  PAA is Google stating the question behind the query — the purest top-of-funnel signal
  available, already paid for on every call.
- `agents/gsc-query-miner` computes "impression leaks" (≥50 impressions, 0 clicks) as
  structured in-memory data, then persists them only as rows in an LLM-written markdown
  report. An impression leak is usually a funnel-stage mismatch: Google thinks we answer
  a question our commercial page does not.

This spec captures both, into an artifact that later joins to personas.

## Scope

**In scope:**
- Additive `paa` and `relatedSearches` on `getSerpResults`.
- `gsc-query-miner` emits `impression-leaks.json`.
- A new `demand-miner` agent producing `data/context/demand-questions.{md,json}`.
- Seeds from GSC impression leaks + persona objections.

**Out of scope, with reasons:**
- **Top-of-funnel content.** Content is Traffic phase — the last of the
  `Tracking → CRO → Offer/AOV → Traffic` gates, and currently blocked behind three
  others. Data is cheap and informs the Offer/AOV work in flight; content is not.
- **The funnel matrix** (persona × stage × demand × page × revenue). This spec produces
  one of its inputs. The join is its own project.
- **Stage-level / assisted attribution.** `seo-impact` is last-click, which structurally
  makes top-of-funnel look worthless. Needed before any content decision, not before
  this.
- **Hand-written problem seeds.** Genuinely-unaware demand is unreachable from empirical
  sources, but guessed seeds are the exact failure mode the VOC work was built to avoid.
- **Any dashboard UI.** Same reasoning as the VOC agent: the artifacts are files.

## The trap this must not repeat

The toothpaste cluster is 32 pages, ~268 clicks, **$0 revenue**. That was not a traffic
failure — it worked as traffic. It was a funnel with no floor. Demand data is safe to
build now precisely because it commits us to no content; the gate ("no top-of-funnel
page ships without a named destination collection or PDP above the fold") belongs to
whichever project writes the content.

## Architecture

```
SEEDS                          HARVEST                    ARTIFACTS
────────────────────────────   ───────────────────────    ──────────────────────────
gsc-query-miner                getSerpResults(seed)       data/context/
  emits impression-leaks.json    → paa[]                    demand-questions.md
  (new; mirrors the existing     → relatedSearches[]        demand-questions.json
   untapped-candidates.json)     → organic (ignored here)
                                                          data/reports/demand-miner/
data/context/personas.json     one Claude call:             seeds-YYYY-MM-DD.json
  → each angle's                 dedupe, classify by         latest.json
    objection_addressed          funnel stage, attribute
                                 to persona where the
                                 seed came from one
```

**Files:**
- `lib/demand-questions.js` — pure brain: seed derivation and capping, PAA
  normalization, dedup, stage validation, markdown rendering. No I/O, no network.
- `agents/demand-miner/index.js` — I/O shell: reads seeds, harvests, one LLM call,
  writes artifacts, `notify()`.
- `lib/dataforseo.js` — additive change only (see below).
- `agents/gsc-query-miner/index.js` — emit `impression-leaks.json`.

Follows the `lib/seo-opportunities.js` / `lib/voice-of-customer.js` precedent: pure brain
paired with a thin agent shell.

### ⚠️ The `getSerpResults` change is ADDITIVE ONLY

`getSerpResults` returns `{ organic, serpFeatures }` and has **nine production callers**,
every one destructuring `{ organic }`:

`content-researcher/keyword-data.js`, `content-gap`, `voice-of-customer`,
`cro-deep-dive-seo`, `post-analyst`, `competitor-intelligence`, `collection-creator`,
`product-verifier`, `scripts/test-reddit-serp.js`

Adding `paa` and `relatedSearches` is safe. Renaming, reshaping, or filtering either
existing field breaks all nine. A regression test asserting `organic` and `serpFeatures`
are unchanged is mandatory — this function's return shape already caused one live
failure during the VOC build (the agent treated it as a bare array).

### Cadence

Monthly, on the 1st, in the existing `scheduler.js` monthly block, **immediately after
`voice-of-customer`** — it reads `personas.json` and must run after that file is
refreshed.

### Seed cap: 40 per run, hard

GSC leaks taken highest-impression-first; persona objections round-robin across personas
so one persona cannot monopolize the budget. Cost is one DataForSEO SERP call per seed
plus one Claude call per run. Without the cap, a bad GSC week silently becomes hundreds
of unattended API calls.

## Artifact contract

### `data/context/demand-questions.json`

```json
{
  "generated_at": "2026-08-01T15:10:00Z",
  "cluster": "skin",
  "seed_count": 28,
  "partial": false,
  "questions": [{
    "text": "Does coconut oil clog pores?",
    "stage": "problem-aware",
    "source": "paa",
    "seed": "coconut oil lotion breakout",
    "seed_origin": "persona_objection",
    "persona_id": "p4",
    "seen_count": 3
  }]
}
```

- `stage` uses the **same five awareness levels as `personas.json`**
  (`unaware` | `problem-aware` | `solution-aware` | `product-aware` | `most-aware`), so
  the two artifacts join on `stage` and `persona_id`. That join is the funnel matrix in
  embryo — matching the vocabulary now avoids retrofitting it later.
- `source` is `paa` or `related_search`.
- `seed_origin` is `gsc_leak` or `persona_objection`, and is load-bearing: it separates
  "demand we already rank for and fumble" from "demand our buyers have that Google does
  not associate with us." Those imply different actions.
- `persona_id` is set only when the seed came from a persona objection; `null` otherwise.
- `seen_count` is how many distinct seeds surfaced the same question — a crude but real
  importance signal.

### `data/context/demand-questions.md`

Human-readable and greppable, under the same two rules as `voice-of-customer.md`:
**stable heading text** across runs, and **self-contained entries** so a single grep hit
is useful alone. Grouped by funnel stage, with counts.

## Failure modes

| Condition | Behavior |
|---|---|
| `personas.json` absent (VOC never ran) | Seed from GSC leaks only; `partial: true`. Never blocks. |
| `impression-leaks.json` absent | Seed from persona objections only; `partial: true`. |
| Both absent | Log, exit 0, write nothing. No seeds is not an error. |
| DataForSEO fails on a seed | Skip that seed, `partial: true`, continue. Per-item degradation, as in the VOC agent. |
| A seed returns no PAA | Normal, not a failure — many SERPs have no PAA box. |
| Malformed or schema-violating LLM output | Validate, retry once, then throw and `notify({ status: 'error', immediate: true })`. No partial write. |
| Existing artifacts | Rendered fully in memory before the first `writeFileSync`, so a renderer throw cannot leave one file new and the others stale. |

## Testing

`tests/lib/demand-questions.test.js` over the pure functions:
- seed derivation from both origins, and the 40-seed cap with round-robin fairness
- PAA and related-search normalization into one record shape
- dedup of the same question surfaced by different seeds, incrementing `seen_count`
- stage validation rejects a value outside the five awareness levels
- `partial` propagates into the output
- markdown renders the stable headings and self-contained entries

`tests/agents/demand-miner.test.js`: agent smoke test with injected deps and a stubbed
LLM client, asserting both artifacts are written and each degradation path sets
`partial`.

`tests/lib/dataforseo-serp-shape.test.js`: **regression test that `getSerpResults` still
returns `organic` and `serpFeatures` unchanged**, plus that `paa` and `relatedSearches`
are populated from a fixture SERP response.

## Success criteria

1. A single run produces both artifacts from live data.
2. `demand-questions.md` contains at least one genuinely `unaware` or `problem-aware`
   question that does not appear anywhere in `voice-of-customer.md` — proving this
   reaches a funnel stage the VOC corpus could not.
3. All nine existing `getSerpResults` callers behave identically (suite green).
4. Questions carrying `seed_origin: "gsc_leak"` can be traced back to a real query in
   `impression-leaks.json`.
5. A question like "what are people asking that we don't answer?" is answerable by
   grepping `data/context/demand-questions.md`.

## Known first-run limitation

`data/reports/gsc-query-miner/` in a local checkout dates from 2026-03-09 — leak data is
cron-written on the server and not synced. The first local run will therefore seed almost
entirely from persona objections and report `partial: true`. That is the designed
degradation, not a bug, but the first meaningful run should happen on the server or after
syncing that report.

## Follow-on work (not this spec)

- The funnel matrix: persona × stage × demand × existing page × revenue.
- Stage-level / assisted-conversion attribution, before any content decision.
- Problem-shaped Reddit queries as a third seed origin, once the empirical two are proven.
- Top-of-funnel content, gated on a conversion path, after the Traffic gate opens.
