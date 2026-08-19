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

`agents/ad-studio/formats.js` tags each ad format with an awareness level.
`data/context/personas.json` angles carry the five-level Schwartz scale: `unaware`,
`problem-aware`, `solution-aware`, `product-aware`, `most-aware`. `formatsForAngle()` is
the join between the two — it lets a brief propose its own format instead of a fixed
rotation choosing one for it.

**The gap is closed (2026-08-18).** `unaware` and `most-aware` used to map to `null` — no
format covered either, which left 4 of the 15 angles on file briefable but unrenderable,
including the highest-scoring angle this project holds (`p2a2` "125 chemicals a day", 81).
`fact-hook` and `spec-panel` now cover them, tagged with **their own** awareness values
rather than aliased onto the nearest of the original three: routing an `unaware` angle to a
`problem` format would show an ad premised on the reader knowing they have a problem to a
reader who by definition does not, which is exactly the "closest available format"
substitution this section used to refuse.

The mechanism that surfaced it worked as designed — an unmatched angle was recorded
(`format.proposed: null`, `state: 'ready'`, no copy call spent) rather than silently
dropped, so the gap stayed countable until it was worth closing, and
`tests/agents/ad-brief.test.js`'s pinned "no format" assertions are what failed to announce
it. Those assertions are now inverted: **every** Schwartz level must resolve to a format,
and to one tagged for its own level.

**This changed what a run costs.** A copy call is spent per angle *that has a format*, and
now every angle does — so nothing is exempt any more. A full `coconut-soap` run went from 8
paid copy calls to 11. `--dry-run` still prints the count before you authorize it.

## A shipping schedule is not a supply duration

The giveaway block in `agents/ad-studio/copy.js` used to ask the writer for the prize's
"quantity and duration". The first live giveaway run (`coconut-soap`, 2026-08-18) returned
**"Win a three-year supply"** from rules that say only *"thirty-six (36) bars … **shipped
over** three (3) years"*.

**Both gates passed it, correctly.** Every word traced to the rules prose, so `claims.js`
was satisfied, and nothing in it is a health claim. The failure is a *semantic conversion*
no string matcher can see: "shipped over 3 years" is a fact about fulfilment, while "a
3-year supply" is a claim about how fast the winner uses soap — which no source supports,
and which was weakest against the whole-family persona the ad was aimed at. Same class as
the invented 90-day supply on the bundle lander.

The block now names the shipping schedule explicitly and forbids restating it as a duration
of use, spelling out the phrasings rather than gesturing at them ("do not overstate" would
not have stopped that run). **This is prompt guidance, not a gate** — a writer can still
find a new way to phrase a usage claim, so giveaway and bundle copy is still worth reading
for it by hand.

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
| `proof`      | 25  | Whether the angle's `source_quotes` actually appear in real reviews. **25** on a match, **6** when the quotes match nothing, and 0 only when the angle carries no `source_quotes` at all — which `agents/voice-of-customer` never writes, so the zero branch is unreachable on real data. |
| `commercial` | 25  | Whether the product's cluster is earning, per `seo-impact`'s latest report; neutral (12) with no matching cluster, and **also neutral when a matched cluster carries $0 revenue and no revenueDelta in either direction** — that combination is a no-signal state, not a zero-value one (see `lib/ad-brief-score.js`'s `scoreCommercial` header). A matched cluster with genuine negative momentum (revenueDelta < 0) is a real signal and is not neutralised — it scores at the bottom of the range instead. |
| `headroom`   | 20  | Awareness headroom — broad `unaware`/`problem-aware` angles convert slower but keep running longer than narrow `product-aware` ones, which harvest fast and exhaust fast. |

**The score never kills a brief.** There is no ad-performance data behind any of these
weights — `data/meta-ads-insights/` is empty and nothing this pipeline has produced has
ever run as a paid ad, so every number here is an a-priori judgement about evidence, not
a measured outcome. Objective failures (an unsourced claim, a health-claim violation)
are handled as hard floors elsewhere — the `gates` block — and are not scores. The score
only ever **ranks** briefs for a human to triage; a guess dressed up as a threshold is
how good work gets thrown away before anyone looks at it.

**There is no falsified-tactic floor.** `lib/ad-brief-score.js`'s header used to list one
next to those two. Nothing in this agent or in Ad Studio reads the `## Falsified` sections of
`.claude/skills/marketing-*/SKILL.md`, and `buildConcept` does not even pass `tactics` to
`buildCopyPrompt`, so the tactic menu is never offered to the copy writer and never
blocklisted. `creative-packager` is the only agent that reads those skills. Stated here so
nobody relies on a safeguard that is not built.

### What the score actually discriminates on

Honest reading of the 100 points, because two of the four components carry far less signal
than their weights suggest:

- **`commercial` (25) is a constant within any ranking a human sees.** It is a function of
  the product handle alone, and briefs are only ever listed and ranked for one product at a
  time. Those 25 points are therefore a fixed offset on every row of every list — they move
  the totals up or down together and never change the order.
- **Today it is close to a constant ACROSS products too, and that is expected, not a bug.**
  Fixed 2026-08-17: `scoreCommercial` used to score a matched cluster with $0 revenue as a
  flat 0 — reading "commercially worthless" out of what is actually a no-signal state, since
  seo-impact's organic-revenue attribution is directional only (see
  `project_revenue_attribution_unreliable.md`) and every RSC cluster attributed $0 on the
  server the day this was caught. It now scores that combination at the same neutral (12) as
  no match at all. The observable consequence: with every relevant cluster still at $0,
  `commercial` lands on 12 for most products right now, and the live discriminators really
  are `headroom` and `proof`, same conclusion as before the fix, reached honestly instead of
  by accident. The one live exception is informative rather than a leftover bug: a cluster
  that attributes $0 revenue but carries a real `revenueDelta` (the server's "body lotion"
  cluster was -25.2 the day this was found) is not neutralised — `coconut-lotion` scores 0 on
  `commercial`, correctly below every product whose matched cluster shows no movement at all.
  This will stop being nearly-constant automatically, with no further code change, the day
  `seo-impact` starts attributing real organic revenue to these clusters.
- **`persona` (30) compresses.** After Task 1's recalibration set the ceilings where the real
  data tops out (15 reviews, intensity 9.0), all five personas on file score **24–30 of 30**.
  Six points of spread across the whole roster.
- **So the live discriminators are `headroom` (5 discrete values, 7–20) and `proof` (6 or
  25).** In practice a brief's position in the list is decided by its awareness level and
  whether its quote matched a review.
- **`proof` also partly measures the SOURCE of a quote, not its truth.** It matches only
  Judge.me reviews for that same product handle (`fetchAdReviews`), so a genuine,
  correctly-attributed Reddit quote scores 6 exactly like an invented one would.

**Rebalancing waits for real outcome data.** The weights were a first guess made with no ad
performance behind them; re-weighting them now, still with none, would be a second guess
dressed up as a correction. The right unlock is `data/meta-ads-insights/` containing runs
these briefs produced. Until then the numbers stay as they are and this section is the
warning label.

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
--product <handle>      required
--variant <name>        optional, e.g. coconut-breeze
--angles p1a1,p5a3      optional; comma-separated angle ids. Default: every angle
                        passing angleRelevance() for this product.
--dry-run               preview only — no Anthropic calls, no writes
--prize-framing soap|full
                        which components of a multi-component prize the ad leads with.
                        Only meaningful while a giveaway is live (it throws otherwise).
                        Omitted, the copy prompt is byte-identical to what it was before
                        this option existed and the writer chooses its own emphasis —
                        there is deliberately no default. An unknown value is rejected by
                        name rather than ignored, because a run that quietly is not the
                        framing you asked for corrupts the A/B it exists to serve.
--job-id <id>           optional; progress reporting into
                        data/reports/ad-studio/jobs/<id>.json, claimed at boot via the
                        same createJobReporter Ad Studio uses. The dashboard's
                        /api/ad-brief/generate route sets it; a human never does. Every
                        reporter call is a no-op without it.
```

No value may start with `-`. `--product --dry-run` and `--angles --job-id` shift the whole
argument list by one, and the second one really happened: it made the agent claim a job file
named `--job-id.json` while the dashboard's real job sat at `pending`, whereupon the 60-second
pending grace let a second click launch a second paid batch. `parseArgs` refuses a
flag-shaped value, and `lib/ad-brief.js`'s `checkSegment` refuses one at the route boundary.

## The format override, and why the dropdown is usually empty

`format.proposed` is the first format whose awareness level matches the angle;
`format.alternatives` are the others at that level, and the Briefs view offers them so an
operator can switch in one click. But **a switch is only allowed between formats with an
identical zone key set** (`lib/ad-brief.js`'s `selectableFormats` / `chooseFormat`), because
`zones` holds finished copy written for the *proposed* format's zone list and a format
override deliberately preserves `state` and `gates`.

Without that rule, switching an **already-approved** brief from `manifesto` (`headline`,
`rows`, `bottomBar`) to `testimonial` (`headline`, `attribution`, `trustLine`) kept the
approval, left two zones with no copy at all, and dropped a written manifesto assertion into
`testimonial`'s quote slot — whose `layoutBrief` says "THE QUOTE MUST BE A REAL CUSTOMER
REVIEW, quoted verbatim from the reviews source — never written", and which the operator then
sets in quotation marks off the comp. The plate carries no text, so no gate downstream could
have caught it; it is the one place in this feature that could present authored copy as a
customer testimonial.

**The dropdown is live for exactly one pair, and empty everywhere else** (updated
2026-08-18):

| Awareness | Proposed | Others at that level |
|---|---|---|
| `unaware` | `fact-hook` | none — sole format at this level |
| `problem-aware` | `manifesto` | refused: `problem-aware` (`subhead`), `testimonial` (`attribution`, `trustLine`), `state-contrast` (`beforeLabel`, `afterLabel`) |
| `solution-aware` | `us-vs-them` | refused: `ingredient-callout` (`listItems`), `top-x-review` (`subhead`), `stat-stack` (`stats`) |
| `product-aware`, giveaway live | `giveaway-entry` | **selectable:** `offer-focused` — identical zone shape, on purpose |
| `product-aware`, no giveaway | `offer-focused` | none offered — `giveaway-entry` is not in the table at all |
| `most-aware` | `spec-panel` | none — sole format at this level |

Everywhere except that one pair the view renders the format as a plain label rather than a
one-option dropdown. That is the correct outcome, not a rule to widen: to run an angle
through another format, generate a brief against it — the copy has to be authored for the
layout. `problem-aware` and `top-x-review` do share a zone shape, but they sit at different
awareness levels and so are never offered together.

`giveaway-entry` was given `offer-focused`'s exact zone list precisely so the switch is
legal: during a giveaway the operator can flip a brief between the entry ad and the sales ad
in one click instead of paying for a regenerate. That is the whole reason the zone shape was
copied rather than designed fresh.

## Giveaways

While an Entry Period is open (`config/giveaway.json`), three things switch on together, and
all three switch off the moment it closes:

1. **A fifth claim source, `giveaway`** — the plain text of the *published* Official Rules
   (`data/giveaway/official-rules.html`), alongside `pdp` / `catalog` / `brandKit` /
   `reviews`. A giveaway claim is traced exactly like a PDP claim: contiguous, verbatim,
   substring-matched, no override. A prize or a date that is not in the published rules is
   still rejected before anything renders.
2. **The copy prompt states the ask** — the prize and the entry deadline are quoted verbatim
   into `buildCopyPrompt`, along with the instruction that the goal is an ENTRY, not a
   purchase, and that no purchase is necessary.
3. **`giveaway-entry` becomes the product-aware format** (see the table above).

**The config and the published rules must agree.** `lib/giveaway-claim-source.js` builds the
source body from the rules prose *only*, and uses `config/giveaway.json` purely as a
cross-check: the entry-open and entry-close **calendar dates** must literally appear in the
published rules or it throws and no giveaway copy is generated at all. Folding the config's
dates into the searchable body instead would let a writer quote a deadline the published
rules contradict, as *sourced* evidence — the claim gate defeated through its own front door.
Disagreement is for a human to reconcile, never for this module to resolve by preferring one
file. `drawAt` is deliberately neither cross-checked nor included: the rules describe the
drawing without naming its date, and a date the published rules do not carry is a date ad
copy must not state.

**Known wart, flagged not fixed:** `config/giveaway.json` stamps `-06:00` and calls it
store-local, while the rules prose says "CT" (`-05:00` in September). The two therefore
describe closing *instants* one hour apart. Nothing here normalises that, because this
module only ever exposes calendar dates — which the two files agree on exactly — and ad copy
states a date, not a UTC instant. It matters to `close-entry-period.mjs`, not to a headline.
