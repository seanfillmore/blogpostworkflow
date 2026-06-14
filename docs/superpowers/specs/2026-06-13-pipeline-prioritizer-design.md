# Signal-Driven Content Pipeline Reprioritization — Design

**Date:** 2026-06-13
**Status:** Approved (design); pending implementation plan
**Owner:** SEO Claude Team

## Problem

The content pipeline runs on a fixed plan. `calendar-runner` writes and publishes
posts strictly in `publish_date` order, and posts are drafted one to two months
before they go live. Two consequences:

1. **Signals don't move the plan.** ~20 signal sources write
   `data/reports/*/latest.json` (surging unmapped queries, rank/traffic drops,
   revenue-growth clusters, competitor activity, AI-citation gaps), but nothing
   reprioritizes the queue when an opportunity or threat appears. Only
   `unmapped-query-promoter` touches the calendar, and it merely appends new
   posts at `today + 14 days`. There is a `priority_score` field on every calendar
   item — always `null`, read by nothing.
2. **Write-ahead wastes work and ages content.** A post drafted in April against
   April's signals and published in June misses two months of fresh data and
   current-year framing. Once written and scheduled, it can't be reprioritized
   without throwing away the draft.

## Goal

Make the pipeline **signal-aware**: when a signal says an opportunity is worth a
new post, or a money page is losing ground, the engine reprioritizes — moving
work up or back, and injecting new ideas — automatically for strong signals,
surfacing borderline ones for review. Bias the engine toward **defending existing
revenue and growing clusters organically**, following current SEO best practice.

## Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Reaction model | **Event-driven interrupts** — stable plan, occasional fast-tracks (not continuous re-sort) |
| Autonomy | **Auto-apply strong signals (logged to digest), surface weak ones for review** — mirrors cannibalization-resolver |
| Trigger signals | Surging unmapped queries; rank/traffic drops; revenue-growth clusters; competitor + AI-citation gaps |
| Production model | **Just-in-time + small buffer** — backlog holds prioritized *ideas*; write ~2 posts ahead, not 8 weeks |
| Architecture | **Dedicated `lib/` (pure logic) + thin agent** — house pattern (rank-trends, publish-drift, seo-impact) |
| Improvements included | Priority provenance; backlog low-water alert; honor manual pins; re-validate at promotion; interrupt hysteresis; closed-loop weight tuning |
| Deferred | Seasonal `publish_by` deadlines (only if a seasonal roster emerges) |

## Architecture

Two new components plus one small change to an existing agent.

- **`lib/pipeline-priority.js`** — pure, unit-tested functions. No I/O. Takes the
  current calendar + parsed signals + config; returns a *reprioritization plan*
  (scores with provenance, items to move/inject/promote, buffer decisions). The brain.
- **`agents/pipeline-prioritizer/index.js`** — thin runner. Reads signal
  `latest.json` files + `calendar.json`, calls the lib, applies the plan back to
  `calendar.json` via `lib/calendar-store.js`, writes reports + digest entries.
  `--dry-run` prints the plan and writes nothing.
- **`agents/calendar-runner/index.js`** — **one change only**: a write-lead-window
  guard so it drafts a pending item only when its `publish_date` is within
  `BUFFER_DAYS`. Its status state-machine and pipeline orchestration are untouched.

### Daily flow (cron)

```
06:30  signal agents produce latest.json
   ↓
07:00  pipeline-prioritizer   ← NEW: reads signals + calendar → rewrites calendar.json
   ↓
10:00  calendar-runner --run  ← writes the next due item (now lead-window-gated)
```

**Single-writer principle:** only the prioritizer (and content-strategist, which
*generates* the calendar) mutate ordering. Everything downstream is read-or-execute,
so reprioritization is auditable — one place to look when a post moved.

## Data model — backlog & buffer

One file (`calendar.json`), new semantics. The ordering key for the unwritten
portion changes from `publish_date` to `priority_score`.

| State | Meaning | Ordered by | Reorderable |
|---|---|---|---|
| pending, no `publish_date` | **Idea backlog** — keyword + brief metadata only | `priority_score` desc | Yes — freely |
| pending *with* `publish_date` | **Pulled for writing** to fill buffer | `publish_date` | Until written |
| briefed / written / scheduled | **In the buffer** — drafted, awaiting slot | `publish_date` | No (frozen) |
| published | Live | — | No |

**Pull mechanism (JIT):**
- Idea-backlog items carry **no `publish_date`** → calendar-runner ignores them.
- Each run the prioritizer counts the buffer (written/scheduled, not yet
  published). If buffer < `BUFFER_TARGET` (default **2**, ≈1 week at Mon/Thu), it
  **promotes** the top-`priority_score` idea(s), assigning each the next open
  Mon/Thu slot.
- calendar-runner drafts items whose `publish_date` is within `BUFFER_DAYS`
  (default **7**) — the lead-window guard that makes writing just-in-time.

**"Money page"** (used in guardrails) = a page with attributed organic revenue in
`seo-impact`'s `top_revenue`, or a commercial/transactional-intent page. The
refresh-first rule applies when such a page is the one declining.

**Task types.** Each backlog item has `task_type`: `new` (write a new post) or
`refresh` (rewrite an existing one). One queue sequences both; the buffer/pull
logic treats them identically. The prioritizer *sequences* refreshes — it does
not re-decide what quick-win-targeter / legacy-triage already flag.

**Interrupts.** A strong signal raises an item's `priority_score`; a true
emergency promotes it to the next open slot, pushing back other
*promoted-but-unwritten* items. Items already written (buffer, ≤~2) are never
reshuffled — the frozen boundary shrinks from ~8 weeks to ~1 week.

## Scoring model

```
priority_score = base + Σ(signal contributions)
```

**Base** (intrinsic, revenue-first, from keyword-index / idea metadata):

```
base = normalize(traffic_potential or volume) × intentMult × kdMult
       intentMult: transactional 1.4 / commercial 1.2 / informational 1.0
       kdMult:     low-KD easier-win bonus
```

**Signal contributions** (event-driven; the four selected signals):

| Signal (source) | Maps to | Contribution | Hysteresis gate |
|---|---|---|---|
| Surging unmapped query (`gsc-opportunity`) | inject/boost **new** | impressions × rising slope | strong if ≥ impressions cap, else ≥2-day persistence |
| Rank/traffic drop (`rank-alerter`) | inject/boost **refresh** of that post | positions lost / % traffic lost | drop ≥5 pos = strong (act now); smaller = persistence |
| Revenue-growth cluster (`seo-impact`) | boost **new** ideas in that cluster | cluster `revenueDelta` | strong if delta over cap |
| Competitor / AI-citation gap (`competitor-watcher`, `ai-citations`) | inject/boost new or refresh | fixed boost per gap | always needs ≥2-day persistence (noisy/empty feeds) |

**Provenance.** Every score carries a breakdown of base + each signal's
contribution (e.g., `"+18 rank-drop 8 pos, +10 revenue cluster"`), surfaced in the
digest and report. Makes autonomous moves auditable and debuggable.

**Hysteresis.** `data/reports/pipeline-prioritizer/signal-state.json` records when
each (signal, keyword) first appeared. A boost counts only if the signal is
**strong** (over its hard threshold → act today) **or** has **persisted ≥2 runs**.
One-day spikes never move the queue.

**Strong vs. weak → autonomy split.**
- **Strong** (boost ≥ `STRONG_THRESHOLD`, or score now exceeds the next buffer-slot
  item): **auto-applied** — reorder/inject/promote, logged to digest with provenance.
- **Weak/borderline:** **not moved**; listed in the digest's "Suggested
  reprioritizations" for confirmation.

**Signal freshness guard.** Before trusting any signal, check its `latest.json`
`generated_at` via `lib/snapshot-health.js`. A stale signal is skipped, never acted on.

All multipliers/thresholds live in `config/pipeline-priority.json` — tuning never
touches code, and it is the closed-loop tuner's write target.

## Guardrails (SEO best practice)

1. **Phased publishing.** Promotions land on the *next open* Mon/Thu slot; never
   two posts on one day. Enforces "never publish ≥2 posts/day" structurally.
2. **Refresh-first when revenue is at risk.** A declining money page is refreshed
   (existing authority recovers in days–weeks) before a speculative new post (2–3
   months to rank). Defends earned revenue; reflects consolidation > proliferation.
3. **Per-cluster spacing.** Cap new posts in the same cluster at **~2 per rolling
   14 days** — organic growth, each page indexes and gets internal links before the
   next, avoids self-cannibalization. Revenue-cluster "double down" proceeds at a
   sustainable rate.
4. **Per-post refresh cooldown.** No re-refresh of the same post within **~45 days**
   — Google needs time to re-evaluate; rapid repeat edits don't compound.
5. **Quality gate is absolute.** The editor gate is never bypassed to hit a slot.
   If the buffer would hit zero, publish late and alert rather than ship a rushed
   post.
6. **Cadence stays flat.** Emergency promotions **reorder, never add** — total
   weekly output is unchanged; no content-velocity spike.
7. **Cannibalization-safe injection.** Before injecting a `new` task, check the
   topical-map / existing pages; if a page already targets the query, convert to a
   `refresh` of that page.
8. **Product-scope gate.** Injected ideas must pass the hard product-scope gate
   (`publisher_block` / injector). No off-brand posts from a surging unrelated query.
9. **Dedup & rejected-keywords.** Injected ideas filtered against existing
   slugs/published posts and `data/rejected-keywords.json` (same filters as
   content-strategist).
10. **Frozen buffer.** Written items (briefed/written/scheduled) are never reshuffled.
11. **Honor manual pins.** A `status_override` set by Sean pins an item; the
    prioritizer never reorders it.
12. **Interrupt rate-limit.** At most **one emergency promotion per run**
    (`MAX_PROMOTIONS_PER_RUN`). Excess waits for the next run, re-evaluated against
    fresh data.

## Outputs

- `data/reports/pipeline-prioritizer/latest.json` — ranked backlog with scores +
  provenance, moves/injections/promotions this run, buffer state, backlog depth.
  Dashboard + freshness monitor consume this.
- `data/reports/pipeline-prioritizer/YYYY-MM-DD.md` — human-readable run log.
- `data/reports/pipeline-prioritizer/signal-state.json` — hysteresis state.
- `config/pipeline-priority.json` — weights/thresholds; closed-loop tuner's target.

### Digest integration (`lib/notify.js`, deferred → daily-summary)

- **Applied this run:** e.g. `⏫ Fast-tracked natural-deodorant-for-kids → next
  slot (rank-alerter: −8 pos on a money page). Bumped X back one slot.` — each line
  carries provenance.
- **Suggested (weak signals):** borderline items to confirm.
- **Backlog health:** depth + low-water alert when pending ideas run thin.
- Errors (stale signals, scope-gate blocks) bypass deferral, email immediately.

### Closed-loop weight tuning (monthly)

Reads `seo-impact`'s `action_wins` — did fast-tracked posts actually earn
rank/revenue? — and nudges `config/pipeline-priority.json` weights toward signal
types that pay off. Same pattern as `insight-aggregator`. Conservative: bounded
weight deltas, logged to the digest, never a wholesale rewrite.

### Dashboard

A "Pipeline Priority" panel — ranked backlog with provenance, buffer gauge, recent
moves — so the queue's shape is explainable at a glance.

## Testing

- **`tests/lib/pipeline-priority.test.js`** (TDD, `node --test`) — base scoring;
  each signal contribution; provenance sums; hysteresis (spike vs. strong vs.
  persistence); strong/weak split; buffer pull (refill vs. full); guardrails (no
  double-booking, cluster spacing, refresh cooldown, cannibalization-safe,
  dedup/rejected, frozen buffer, one-promotion-per-run); refresh-first;
  stale-signal skip.
- **`tests/agents/pipeline-prioritizer.test.js`** — `--dry-run` writes nothing and
  produces a valid plan; report shape valid.
- **Manual:** `--dry-run` against real signals → eyeball → one live run → confirm
  `calendar.json` + digest → only then add to cron.

## Config defaults (tunable)

```
BUFFER_TARGET        = 2     # ready posts (~1 week at Mon/Thu)
BUFFER_DAYS          = 7     # write-lead window
MAX_PROMOTIONS_PER_RUN = 1
CLUSTER_SPACING_DAYS = 14    # ≤2 new posts per cluster per window
REFRESH_COOLDOWN_DAYS = 45
HYSTERESIS_RUNS      = 2     # persistence requirement for non-strong signals
intentMult           = { transactional: 1.4, commercial: 1.2, informational: 1.0 }
```

## Out of scope

- Seasonal `publish_by` deadlines (deferred).
- Re-deciding *what* to refresh (owned by quick-win-targeter / legacy-triage).
- Changing the writing pipeline stages themselves.
```
