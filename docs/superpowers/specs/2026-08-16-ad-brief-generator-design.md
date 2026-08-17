# Ad Brief Generator — design

**Date:** 2026-08-16
**Branch:** `feat/ad-brief-generator`
**Status:** Approved 2026-08-16. Supersedes the "creative steering" scope discussed and declined earlier the same day.

## Why

Ad Studio generates a concept and immediately spends money rendering it. Sean, 2026-08-16:

> *"We should be generating the angles, headlines and everything else before we ever move to
> creatives. We should treat this system as a brief generator then we use the briefs to
> generate creatives. I think we will save money this way by not endlessly generating images
> behind concepts that may not work. We should be measuring the briefs off of data we obtain
> from other agents."*

The cost argument holds. A concept costs one Opus copy call **plus** 6 renders (~$0.78)
plus a Sonnet verify call per render plus a critique call — and the copy is the part that
decides whether the concept was ever worth rendering. Generating and judging copy first is
roughly a tenth of the cost of finding the same thing out from pixels.

There is a second reason, which the operator arrived at independently: the current UI is a
launcher with no creative control. It exposes the CLI's flags and nothing about the actual
advertisement — no persona, no angle, no headline. A brief is the missing artifact.

## The honest data inventory

Read this before designing any scoring, because the obvious signal does not exist.

**There is no ad-performance feedback loop.** `data/meta-ads-insights/` is empty on the
production server as well as locally. Nothing this pipeline has produced has ever run as a
paid Meta ad. There is no "this angle converted at X%".

Note the naming trap: `agents/meta-ab-tracker` and `data/reports/meta-ab/` are **meta
title/description A/B tests for SEO**, not Meta ads. They look like the thing you want and
are not.

What does exist, verified 2026-08-16:

| Source | What it gives a brief |
|---|---|
| `data/context/personas.json` | 5 rank-ordered personas, each with `evidence_count` and `emotional_intensity`; 15 angles total, each with `awareness`, `objection_addressed`, `proof`, `hook_examples` and verbatim `source_quotes` |
| `data/reports/seo-impact/latest.json` | revenue by cluster, `top_revenue`, and a `not_converting` list |
| `data/reports/competitor-ads/latest.json` (server) | competitor ads; longevity is the signal |
| `.claude/skills/marketing-*/SKILL.md` | the tactic menu and the **falsified** blocklist |
| Judge.me reviews via `fetchAdReviews` | the only source that can substantiate a testimonial |
| `agents/ad-studio/formats.js` | 9 formats, each tagged `awareness` |

**`personas.json` contains angles that cannot legally ship as written.** Its top-ranked
angle carries the hook *"I tried prescription strength lotions, steroids, you name it —
until this"* — the exact line `health-claims.js` rejected on 2026-08-16. The brief stage is
the right place to catch that, before anyone has paid for a render.

## Approach

A new agent, `agents/ad-brief/`, which **imports** the gates and the format table from
`agents/ad-studio/` rather than duplicating them. Ad Studio gains a `--brief <id>` mode that
renders an approved brief instead of writing its own copy.

Rejected alternatives:

- **A `--briefs` mode inside Ad Studio.** Puts two unrelated jobs behind one CLI and grows
  `agents/ad-studio/index.js` past its current ~1,500 lines — already the file this project
  has had the most trouble editing safely.
- **Promoting the existing dry run.** Cheapest, but it inherits dry run's shape: per-format,
  not per-persona-angle, which is precisely what is being changed.

The gates are never copied. A second implementation of `claims.js` or `health-claims.js`
that drifts from the first is the worst outcome this design could produce.

## 1. The artifact

One JSON per persona × angle, at `data/briefs/ad-studio/<product>/<briefId>.json`:

```json
{
  "briefId": "coconut-lotion-p1a1-<timestamp>",
  "product": "coconut-lotion",
  "variant": "coconut-breeze",
  "persona": { "id": "p1", "name": "...", "evidenceCount": 18, "emotionalIntensity": 9.2 },
  "angle": {
    "id": "p1a1", "label": "After prescriptions failed", "awareness": "problem-aware",
    "objectionAddressed": "...", "proof": "...", "sourceQuotes": ["..."]
  },
  "format": { "proposed": "problem-aware", "chosen": null, "reason": "awareness match" },
  "zones": { "headline": "...", "body": "...", "...": "..." },
  "claims": [{ "zone": "headline", "text": "...", "factual": true, "sourceId": "reviews", "evidence": "..." }],
  "gates": { "health": { "ok": true }, "claims": { "ok": true, "unsourced": [] } },
  "score": { "total": 74, "evidence": 30, "proof": 20, "cluster": 12, "headroom": 12 },
  "state": "ready",
  "createdAt": "...", "decidedAt": null, "renderedRunIds": []
}
```

`state` is one of `needs-evidence` | `ready` | `approved` | `rejected` | `rendered`.

**The brief carries the finished copy, not a direction.** Approving it renders those exact
strings with no second LLM call, so nothing can drift between what was read and what gets
baked into a plate. This is the whole compliance argument for the feature: the operator
approves literal text that both gates have already passed.

## 2. Generation

On demand — the operator picks a product and asks for briefs. Not scheduled: 11 products ×
15 angles is ~165 Opus calls a week whether or not anyone looks, and `personas.json` only
refreshes monthly, so most runs would regenerate briefs from unchanged inputs.

**Which angles apply to a product.** `personas.json` is **cluster-scoped, not
product-scoped** — it carries a top-level `cluster: "skin"` and no per-persona product
linkage. So every angle in the file applies to every product in that cluster, and a product
outside it has no personas at all: `voice-of-customer` has only ever run for `skin`
(generated 2026-07-27).

Asking for briefs on a product outside the covered cluster **aborts with that reason
named** — "no personas on file for cluster X; run `agents/voice-of-customer` for it first".
It does not fall back to the skin personas, and it does not invent one. Inventing a persona
would put fabricated audience reasoning underneath a claim-gated ad, which is the one thing
this whole pipeline exists to prevent.

For each applicable persona angle:

1. **Propose a format by awareness.** `formats.js` tags each format `problem`, `solution` or
   `product`; each persona angle carries `unaware` | `problem-aware` | `solution-aware` |
   `product-aware` | `most-aware`. Match on that. The operator can override at approval.
2. **Write the copy** through the existing copy stage — `claude-opus-4-8`, because per the
   artifact decision the brief *is* the copy that renders.
3. **Run both gates**, health-claims first, then sourcing — the same order and the same
   modules Ad Studio uses.
4. **Score** (below) and persist.

**Model choice is not negotiable downward.** A cheaper model here would mean approving copy
that is worse than what the render path would have produced, which inverts the point.

## 3. Scoring — a rank, plus a hard floor

**The hard floor is objective only.** A brief is floored — never rendered — when a factual
claim cannot be traced to a held source, when `health-claims.js` rejects any zone, or when
the angle depends on a tactic in a `## Falsified` section. Floored briefs go to
`needs-evidence` (fixable) or `rejected` (not).

**The 1-100 score only ranks.** It never auto-kills. Ad Studio already learned this the
expensive way: a subjective judgement wired to a hard fail rejects good work and pays for
three attempts doing it. Four components, each from data actually held:

| Component | Max | Source |
|---|---|---|
| Persona strength | 30 | `evidence_count` × `emotional_intensity` |
| Proof | 25 | does the angle's `proof` trace to a real Judge.me quote |
| Commercial | 25 | the product's cluster revenue and `not_converting` state in `seo-impact` |
| Headroom | 20 | awareness breadth — see below |

**Headroom is a real component, not a tiebreaker.** Per
`.claude/skills/marketing-awareness-level-messaging/SKILL.md`, narrow product-aware angles
harvest fast and exhaust fast, while problem-aware and unaware angles convert more slowly
and keep running. So `unaware` and `problem-aware` score above `solution-aware`, which
scores above `product-aware` and `most-aware`. Without this the queue fills with the angles
that run dry first.

Every component is stored and displayed. A score whose parts are hidden is a black box, and
with no outcome data behind it, a black box is exactly what this must not be.

## 4. The clarification loop

A brief whose claim cannot be verified does not silently die. It lands in `needs-evidence`
naming the exact phrase, the source it searched, and what evidence would satisfy it. The
operator can supply evidence, rewrite the line, or drop the brief.

**Anything the operator writes re-enters through both gates.** There is no path that renders
text which has not passed them. This is the condition the UI spec set when it put copy
editing out of scope: *"If this is ever built, edited copy must re-enter through the claim
gate, not around it."* This design satisfies that condition and is the reason the feature is
now allowed.

## 5. Approve → render

`node agents/ad-studio/index.js --brief <briefId> [--variations n]` renders an approved
brief: it skips concept generation entirely and uses the brief's stored zones and claims.
`--variations 3` therefore means three renders of the *same* approved copy.

This dissolves the "three of one persona or three different" question — that is now a
choice of how many briefs to approve, not a flag. Three personas means approving three
briefs.

The existing `--product --formats` path is unchanged, so the CLI keeps working exactly as
it does today.

## 6. Tagging, so the loop can eventually close

Every rendered artifact records its `briefId`, persona, angle, awareness level and format
into `run.json` and `data/reports/ad-studio/scores.jsonl`.

Per `.claude/skills/marketing-performance-pattern-analysis/SKILL.md`, attributes recorded
**at production time** are what turn a future set of results into explanations. Today this
is bookkeeping. The day Meta ad data exists it is the difference between "ad B won" and
"problem-aware, testimonial, persona 1 won" — and it cannot be reconstructed after the
fact, which is why it goes in now rather than when the data arrives.

## 7. The dashboard

A **Briefs** view alongside New run and Judge. Lists briefs for a product, ranked, showing
the score with its components, the persona and angle, the proposed format, the finished
copy, and each claim with its traced source. Actions: approve, reject, override the format,
and render an approved brief. `needs-evidence` briefs show what is missing.

## Known gap this design surfaces but does not fix

`formats.js` covers `problem` (4 formats), `solution` (4) and `product` (1). **Nothing
covers `unaware` or `most-aware`.** Four of the 15 persona angles — including *"125
chemicals a day"* and *"Ingredients you can actually read"* — therefore have no format that
can render them, and by the headroom argument above they are among the most valuable angles
we hold.

That is evidence for the format-learning project already specced in
`docs/superpowers/specs/2026-08-14-ad-studio-ui-design.md`, not work for this one. Briefs
whose angle has no matching format are generated, scored and marked `no-format`, so the gap
is visible and countable rather than inferred.

## Out of scope

- Building the two missing formats (above).
- Uploading to Meta or Google. Export stays a download.
- Scheduled brief generation. On demand only, until there is evidence a backlog gets used.
- Any scoring component derived from ad performance, because no such data exists yet.
