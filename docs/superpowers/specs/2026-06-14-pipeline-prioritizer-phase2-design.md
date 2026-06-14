# Pipeline Prioritizer Phase 2 — Closed-Loop Weight Tuner, Provenance Ledger & Dashboard Panel

**Date:** 2026-06-14
**Status:** Approved (design); pending implementation plan
**Builds on:** `docs/superpowers/specs/2026-06-13-pipeline-prioritizer-design.md` (Phase 1, shipped in PR #237)

## Problem

Phase 1 made the content pipeline signal-aware: a prioritizer ranks a backlog of
ideas by a signal-driven `priority_score` and writes just-in-time. But the weights
that decide how much each signal type matters (`config/pipeline-priority.json`) are
hand-set and static. We want the system to **learn which signal types actually drive
revenue** and tune itself — the project's closed-loop-feedback signature (cf.
`insight-aggregator`). We also have **no dashboard visibility** into what the
prioritizer is doing.

### The attribution gap (drives the design)

The tuner's premise — "learn which signal type drives revenue" — requires linking a
revenue outcome back to the signal type that caused the post. That link is **not
persisted today**:

- `seo-impact` `action_wins` tag a winning page only with `{ type: 'new-post', date }`
  — no signal type. (`lib/seo-impact.js` `actionWins()` filters impacts with an
  `action` and `revenueDelta>0 || clicksDelta>0`; the `action` is attached purely by
  path + publish-date-in-window, with no causal origin.)
- Post `meta.json` records publish dates, no signal origin.
- The prioritizer's `latest.json` records `injections[].source` (the signal type) but
  is **overwritten every run**, so the link is gone by the time revenue accrues weeks
  later.

Therefore Phase 2 needs a durable **provenance ledger** as a prerequisite, then the
tuner joins ledger × action_wins.

### The data lag (sets expectations)

The tuner cannot tune until the ledger holds weeks of post→signal→outcome data (JIT
write lag + 28-day revenue measurement window). Built now, it **correctly no-ops**
(min-sample guard) until outcomes accrue in ~6-8 weeks. We build all three pieces now
so collection and visibility start immediately; the tuner pays off later.

## Decisions

| Decision | Choice |
|---|---|
| Sequencing | Build all three now (ledger + tuner + dashboard); tuner self-guards until data accrues |
| Tuner autonomy | **Auto-apply bounded changes**, logged to digest (autonomous-by-default; clamped so it can't make a wild move; history log makes any run revertable) |
| Attribution | Append-only ledger written by the prioritizer; post-hoc join by the tuner (slug + date) |
| Cadence | Tuner runs monthly |

## Component 1 — Provenance ledger

**File:** `data/reports/pipeline-prioritizer/attribution.jsonl` (append-only; one JSON
object per line; never rewritten).

**Record shape:**
```json
{"ts":"2026-06-14T00:48:00Z","date":"2026-06-14","slug":"coconut-oil-stretch-marks","keyword":"coconut oil for stretch marks","signal_type":"unmapped","strength":5000,"score":40,"action":"inject","cluster":null}
```
- `action`: `"inject"` (the signal that *created* the idea) or `"promote"` (a signal
  that *boosted* an existing backlog idea when it was scheduled).
- One record per (slug, signal_type, action) the prioritizer acts on this run.

**Writer:** a small tested helper `lib/attribution-log.js`:
- `appendAttribution(records, {path})` — append-only write (one line per record),
  creating the file/dir if absent.
- `readAttribution(path)` — parse JSONL → array (skips malformed lines).

**Integration:** `agents/pipeline-prioritizer/index.js` calls `appendAttribution()` in
its apply step (after injections/promotions are computed), only on live runs (never in
`--dry-run`). For injections it records `signal_type = idea.source` and the injecting
signal's strength/score; for promotions it records the contributing active signals that
matched the promoted slug (type/strength/score from the plan's provenance). If a
promotion had no signal contribution (pure base score), no attribution record is
written for it (nothing to attribute).

## Component 2 — Weight tuner

**Pure brain:** `lib/priority-tuning.js`. **Thin agent:** `agents/priority-tuner/index.js`.
**Cadence:** monthly cron.

### Pure functions (`lib/priority-tuning.js`)

- `aggregatePerformance(ledger, actionWins, {today, measureLagDays})` →
  `{ [signal_type]: { measured, wins, revenue, score } }`.
  - Consider only ledger records whose `date` is ≥ `measureLagDays` ago (old enough to
    measure). `measured` = count of such attributed posts; `wins` = those whose slug
    matches an action_win path with `revenueDelta>0`; `revenue` = sum of those
    `revenueDelta`; `score` = revenue per measured post (`revenue / measured`), the
    per-signal performance metric.
  - Dedup: a (slug, signal_type) pair counts once even if it appears for both inject and
    promote.
  - Matching slug→action_win path: an action_win `path` like `/blogs/news/<slug>` or
    `/blogs/<blog>/<slug>` matches the ledger `slug` by suffix; helper `pathMatchesSlug`.
- `proposeWeightChanges(perf, cfg)` →
  `[{ signal_type, param, from, to, reason }]`.
  - The tuned knob per signal_type: `unmapped.perImpression`, `rank_drop.perPosition`,
    `revenue_cluster.perDollar`, `competitor_gap.boost`, `ai_gap.boost`.
  - Compute the mean `score` across signal types that meet `minSamplesPerSignal`.
    For each qualifying signal, nudge its knob toward the mean-relative performance:
    `delta = clamp((score/mean - 1), -1, 1) * maxStepPct`; `to = clamp(from*(1+delta),
    bounds.min, bounds.max)`. Round sensibly.
  - Signals with `measured < minSamplesPerSignal` are **not** changed (omitted from
    output).
  - If fewer than 2 signals qualify (no mean to compare against) or total `measured`
    across all signals `< totalFloor`, return `[]` (whole-run no-op).
- `applyWeightChanges(cfg, changes)` → new cfg object (pure; does not write disk).

### Agent (`agents/priority-tuner/index.js`)

1. Load `config/pipeline-priority.json`, the attribution ledger, and `seo-impact`
   `latest.json` `action_wins` (skip via `snapshot-health` freshness if seo-impact is
   stale).
2. `aggregatePerformance` → `proposeWeightChanges`.
3. If changes: `applyWeightChanges`, write the config back, append before→after to
   `data/reports/priority-tuner/tuning-history.jsonl`, write `latest.json` +
   `YYYY-MM-DD.md`, and emit a digest entry (info). If no changes: write a report
   noting the no-op + why (insufficient data), no config write.
4. `--dry-run`: compute + print, write nothing.

### Config additions (`config/pipeline-priority.json`)

```json
"tuning": {
  "minSamplesPerSignal": 3,
  "totalFloor": 8,
  "maxStepPct": 0.10,
  "measureLagDays": 28,
  "paramBounds": {
    "unmapped.perImpression":     { "min": 0.002, "max": 0.05 },
    "rank_drop.perPosition":      { "min": 1,     "max": 8 },
    "revenue_cluster.perDollar":  { "min": 0.05,  "max": 0.6 },
    "competitor_gap.boost":       { "min": 5,     "max": 30 },
    "ai_gap.boost":               { "min": 4,     "max": 24 }
  }
}
```

### Safety

Bounded step (≤`maxStepPct` per run), absolute clamps per param, never zeroes a signal
(`min > 0`), min-sample + total-floor guards, full `tuning-history.jsonl` audit trail
for manual revert, monthly cadence. Auto-applied because no single run can move a knob
more than 10% within hard bounds.

## Component 3 — Dashboard panel

- Extend `agents/dashboard/lib/data-loader.js`: load
  `data/reports/pipeline-prioritizer/latest.json` (and optionally
  `priority-tuner/latest.json`) with the existing `readJsonIfExists` pattern; add to the
  returned object.
- Add a "Pipeline Priority" card in `agents/dashboard/public/` (HTML + `dashboard.js`),
  matching the existing `renderSeoImpact` card style: backlog depth, buffer gauge
  (`buffer_ready/buffer_target`), fast-tracked promotions with their `reason`/why,
  injected ideas, suggestions, and alerts. If a tuner report exists, show its last
  weight changes (before→after) as a small sub-section.
- Follows the dashboard convention: browser JS in `public/` edited directly; remember
  `\n` → `\\n` escaping rule for any JS strings inside the HTML template literal.

## Testing

- `lib/attribution-log.js` — append creates/extends JSONL; read parses + skips
  malformed lines; round-trip.
- `lib/priority-tuning.js` (TDD, `node --test`) — `aggregatePerformance` (lag filter,
  win/revenue sums, inject+promote dedup, slug↔path matching); `proposeWeightChanges`
  (nudge direction toward above-mean, bounded step, clamps, never below min,
  min-sample omission, <2-qualifying / total-floor no-op); `applyWeightChanges` (pure
  merge, untouched params preserved).
- `agents/priority-tuner` — `--dry-run` writes nothing; no-op path writes a report but
  not the config.
- Dashboard — data-loader returns the new key; card renders with mock data; absent file
  → graceful omission.
- Manual: run prioritizer live once to seed `attribution.jsonl`; run priority-tuner
  `--dry-run` and confirm it no-ops with "insufficient data" against current empty
  action_wins.

## Out of scope

- Tuning the `cap`, `strongThreshold`, `intentMult`, or base-score knobs (only the
  per-signal magnitude knobs are tuned this phase).
- Changing how `seo-impact` computes `action_wins` (we consume it as-is; the
  ledger+slug join is what supplies signal attribution).
- Auto-revert of a bad tuning month (history log enables manual revert; automated
  revert is a possible future phase).
