# Signal Manifest

**Purpose:** Every agent in this project either produces signals (writes files other agents read) or consumes them (reads files other agents wrote) — or both. This document lists every signal, what writes it, and what reads it, so the dataflow is visible at a glance.

**Rules going forward:**

1. **No dead-end outputs.** Every signal an agent produces must be consumed by at least one downstream agent. If a signal has zero consumers, either find one or delete the signal. Reports produced for humans only (morning digest, dashboard views) count as consumers, but only if a human actually acts on them.
2. **No blind decisions.** Any agent making a decision must pull every relevant upstream signal — not operate on its own narrow view. Adding a new agent means asking "what existing signals should this read?" before asking "what new signals should this write?"
3. **Every new agent updates this manifest.** Adding a row to the producer column and the consumer column is part of landing the agent, not an afterthought.
4. **Signal with zero consumers = flag.** When auditing, any row with an empty `Consumers` field is a gap to close.

Focus of this manifest: the **SEO + content pipeline**. Ads / campaign / CRO / creative agents have their own loops and are not inventoried here yet.

---

## Signals (shared files agents read and write)

Each signal is a file path. `latest.json` variants are the canonical machine-readable form; dated markdown files are for humans.

### Inputs (external data that agents ingest)

| Signal | Source | Writer | Consumers |
|---|---|---|---|
| `data/ahrefs/**.csv` | Ahrefs manual CSV upload | `routes/uploads.js` (dashboard) | `content-gap`, `keyword-research`, `content-researcher`, `technical-seo` |
| `data/snapshots/gsc/*.json` | Google Search Console API | `gsc-collector` | `gsc-opportunity`, `post-performance`, `rank-tracker`, dashboard `renderGSCSEOPanel` |
| `data/snapshots/ga4/*.json` | Google Analytics 4 API | `ga4-collector` | `dashboard data-loader`, `cro-analyzer` |
| `data/snapshots/shopify/*.json` | Shopify Admin API | `shopify-collector` | `sitemap-indexer`, `topical-mapper`, `blog-post-verifier` |
| `data/snapshots/clarity/*.json` | Microsoft Clarity API | `clarity-collector` | `cro-analyzer` |
| `config/site.json` | manual | n/a (static) | nearly every agent — brand name, domain, etc. |
| `config/ingredients.json` | manual | n/a (static) | `blog-post-writer`, `content-refresher`, `editor` |
| `config/competitors.json` | manual | n/a (static) | `competitor-watcher`, `competitor-intelligence` |
| `.env` | manual | n/a | every agent needing API keys |

### Content state (the canonical "what posts exist")

| Signal | Writer(s) | Consumers |
|---|---|---|
| `data/posts/<slug>.html` | `blog-post-writer`, `content-refresher`, `refresh-runner`, `editor`, `featured-product-injector` | `editor`, `publisher`, `content-refresher`, `blog-post-verifier`, `post-performance`, `rank-tracker` |
| `data/posts/<slug>.json` (metadata) | `blog-post-writer`, `publisher`, `refresh-runner`, `post-performance`, `image-generator` | nearly every downstream agent — it's the source of truth for published state |
| `data/briefs/<slug>.json` | `content-researcher` | `blog-post-writer`, `content-strategist`, `gsc-opportunity` (coverage index) |
| `data/calendar/calendar.json` | `content-strategist`, `unmapped-query-promoter`, `calendar-runner` | `calendar-runner` (reads to schedule), `content-strategist` (reads to avoid duplicates), `gsc-opportunity` / `unmapped-query-promoter` (coverage check), dashboard Pending column |
| `data/rejected-keywords.json` | dashboard `/api/reject-keyword` route, manual edits | `content-strategist`, `quick-win-targeter`, `gsc-opportunity`, `unmapped-query-promoter`, `calendar-runner`, `pipeline-scheduler` |

### SEO signal files (the performance-driven loop)

| Signal | Writer | Consumers | Status |
|---|---|---|---|
| `data/rank-snapshots/YYYY-MM-DD.json` | `rank-tracker` | `quick-win-targeter`, `content-strategist` (via cluster analysis), `rank-alerter`, dashboard `renderRankings`, `post-performance` (indirectly via GSC) | healthy |
| `data/reports/rank-tracker/rank-tracker-report.md` | `rank-tracker` | `content-strategist`, dashboard Rankings tab | healthy |
| `data/reports/rank-alerts/YYYY-MM-DD.md` | `rank-alerter` | dashboard rank alert banner, daily-summary | **gap** — should also trigger `post-performance` re-check and `refresh-runner` for sudden drops |
| `data/reports/quick-wins/latest.json` | `quick-win-targeter` | `refresh-runner --from-quick-wins`, `daily-summary`, dashboard Optimize tab | **gap** — `internal-link-auditor` should prioritize adding links to quick-win slugs |
| `data/reports/post-performance/latest.json` | `post-performance` | `refresh-runner --from-post-performance`, `daily-summary`, dashboard Optimize tab | **gap** — `content-refresher` should read the verdict `reason` before refreshing; `content-researcher` should read flop history when briefing similar topics |
| `data/posts/<slug>.json#performance_review` | `post-performance` (stamps verdicts per-post) | `refresh-runner` (aging cooldown), dashboard | **gap** — writer/refresher don't read this when regenerating |
| `data/reports/gsc-opportunity/latest.json` | `gsc-opportunity` | `unmapped-query-promoter`, `content-strategist` (via prompt injection), dashboard Optimize tab | **gap** — `meta-optimizer` should auto-pull low-CTR queries for title/meta rewrites |
| `data/reports/content-strategist/cluster-weights.json` | `content-strategist` (computed during run) | `content-strategist` (self-read next run), dashboard Optimize tab | **gap** — `quick-win-targeter` should weigh cluster score when ranking candidates; `post-performance` should consider cluster authority when verdict borders on REFRESH vs ON_TRACK |
| `data/reports/competitor-watcher/latest.json` | `competitor-watcher` | `content-strategist` (via cluster_boosts), `daily-summary`, dashboard | **gap** — `post-performance` should reduce DEMOTE severity if a competitor just published in the same cluster (ranking drop has an external cause); `quick-win-targeter` should bump priority on clusters where competitors just published |
| `data/reports/content-gap/content-gap-report.md` | `content-gap` | `content-strategist` | healthy |

### Content-quality signals

| Signal | Writer | Consumers | Status |
|---|---|---|---|
| `data/reports/editor/<slug>-editor-report.md` | `editor` | `insight-aggregator`, `publisher` (blocker detection), `daily-summary` (blocked-posts section), `content-refresher` | healthy |
| `data/reports/verifier/<slug>-verifier-report.md` | `blog-post-verifier` | `publisher` (blocker detection) | healthy |
| `data/reports/content-refresh-report.md` | `content-refresher` | `daily-summary` | **gap** — `insight-aggregator` doesn't scan refresh reports for patterns (only editor reports) |
| `data/context/feedback.md` | `insight-aggregator` | `blog-post-writer`, `content-refresher`, `content-researcher`, `editor` (per-agent sections) | healthy |
| `data/context/writer-standing-rules.md` | `insight-aggregator` (append-only) | `blog-post-writer` | **gap** — `editor` and `content-refresher` don't read the standing rules; recurring writer mistakes get added to rules but the editor doesn't know to enforce them the next time around |
| `data/context/writer-standing-rules-changelog.json` | `insight-aggregator` | n/a (audit trail only) | audit-only, no downstream consumer needed |

### Structural signals

| Signal | Writer | Consumers | Status |
|---|---|---|---|
| `data/sitemap-index.json` | `sitemap-indexer` | `internal-link-auditor`, `internal-linker`, `editor`, `content-researcher`, `topical-mapper` | healthy |
| `data/topical-map.json` | `topical-mapper` | `content-researcher`, `internal-linker`, `content-strategist`, `editor` | healthy |
| `data/reports/internal-linker/*.md` | `internal-linker` | `daily-summary`, dashboard | **gap** — doesn't feed back into `blog-post-writer` or `content-refresher` so the writer is unaware which internal links have already been placed |
| `data/reports/technical-seo/*.md` | `technical-seo` | `daily-summary`, dashboard | **gap** — findings don't flow into `blog-post-writer` as "don't introduce this issue" standing rules |

### Review / approval state (performance-engine, not yet built)

| Signal | Writer | Consumers | Status |
|---|---|---|---|
| `data/performance-queue/<slug>.json` | `performance-engine` (planned) | `daily-summary`, dashboard Optimize tab, `publisher` (approve flag) | **planned** — see `docs/superpowers/plans/2026-04-09-performance-engine-approval-loop.md` |

---

## Producer / consumer matrix (SEO + content agents only)

A compact view: rows are agents, columns show what they produce and consume. Empty rows (e.g., `internal-link-auditor` producing nothing the rest of the system reads) are gaps to close.

### Producers

| Agent | Produces | Consumed by |
|---|---|---|
| `rank-tracker` | `data/rank-snapshots/*.json`, `data/reports/rank-tracker/rank-tracker-report.md` | `quick-win-targeter`, `content-strategist`, `rank-alerter`, dashboard |
| `rank-alerter` | `data/reports/rank-alerts/*.md` | dashboard, `daily-summary` |
| `post-performance` | `data/reports/post-performance/latest.json`, per-post `performance_review` field | `refresh-runner`, `daily-summary`, dashboard |
| `quick-win-targeter` | `data/reports/quick-wins/latest.json` | `refresh-runner`, `daily-summary`, dashboard |
| `gsc-opportunity` | `data/reports/gsc-opportunity/latest.json` | `unmapped-query-promoter`, `content-strategist`, dashboard |
| `unmapped-query-promoter` | rows appended to `data/calendar/calendar.json` | `content-strategist`, dashboard Pending column, downstream pipeline (via calendar) |
| `competitor-watcher` | `data/reports/competitor-watcher/latest.json` | `content-strategist`, `daily-summary`, dashboard |
| `content-gap` | `data/reports/content-gap/content-gap-report.md` | `content-strategist` |
| `content-strategist` | `data/calendar/calendar.json`, `data/reports/content-strategist/cluster-weights.json`, `data/reports/content-strategist/content-calendar.md` | `calendar-runner`, `content-researcher`, dashboard |
| `content-researcher` | `data/briefs/<slug>.json` | `blog-post-writer`, dashboard |
| `blog-post-writer` | `data/posts/<slug>.html`, `data/posts/<slug>.json` | nearly everything downstream |
| `content-refresher` | updated `data/posts/<slug>.html`, `data/reports/content-refresh-report.md` | `editor`, `publisher`, `daily-summary` |
| `refresh-runner` | triggers `content-refresher` + `editor` + publisher for specific slugs | n/a (orchestrator, not a data producer) |
| `editor` | `data/reports/editor/<slug>-editor-report.md` | `insight-aggregator`, `publisher`, `daily-summary`, `content-refresher` |
| `blog-post-verifier` | `data/reports/verifier/<slug>-verifier-report.md` | `publisher` |
| `publisher` | updated `data/posts/<slug>.json` (Shopify IDs, status) | everything downstream |
| `insight-aggregator` | `data/context/feedback.md`, `data/context/writer-standing-rules.md` | `blog-post-writer`, `content-refresher`, `content-researcher`, `editor` (partial) |
| `sitemap-indexer` | `data/sitemap-index.json` | `internal-link-auditor`, `internal-linker`, `editor`, `content-researcher`, `topical-mapper` |
| `topical-mapper` | `data/topical-map.json` | `content-researcher`, `internal-linker`, `content-strategist`, `editor` |
| `internal-link-auditor` | `data/reports/internal-link-auditor/*.md` | dashboard, `daily-summary` |
| `internal-linker` | `data/reports/internal-linker/*.md`, updates to `data/posts/<slug>.html` | `daily-summary`, dashboard |
| `technical-seo` | `data/reports/technical-seo/*.md`, applied fixes on Shopify | `daily-summary`, dashboard |
| `meta-optimizer` | `data/reports/meta-optimizer-report.md` | dashboard |
| `keyword-research` | ad-hoc reports | `content-researcher`, `content-strategist` (indirect) |
| `pipeline-scheduler` | `data/posts/<slug>.json` schedule timestamps | `publisher`, dashboard |
| `calendar-runner` | triggers downstream pipeline per calendar item | n/a (orchestrator) |

### Consumers that currently read less than they should

These are the gaps from the "Status" columns above, consolidated:

| Agent | What it should also read | Why |
|---|---|---|
| `content-refresher` | `data/reports/post-performance/latest.json` → the specific verdict `reason` for the slug being refreshed | So the refresh is targeted at the actual cause of the flop, not a generic rewrite |
| `content-refresher` | `data/context/writer-standing-rules.md` | So refreshes don't reintroduce the same mistakes the writer is already avoiding |
| `editor` | `data/context/writer-standing-rules.md` | So the editor enforces the rules that the writer was just told about |
| `quick-win-targeter` | `data/reports/content-strategist/cluster-weights.json` | So position-14 in a page-1 cluster outranks position-14 in a drag cluster |
| `quick-win-targeter` | `data/reports/competitor-watcher/latest.json` | So clusters with fresh competitor posts get priority bumps |
| `post-performance` | `data/reports/competitor-watcher/latest.json` | So DEMOTE verdicts account for external ranking pressure, not just projection miss |
| `post-performance` | `data/reports/rank-alerts/*.md` | So sudden drops trigger an off-cycle review |
| `post-performance` | `data/reports/content-strategist/cluster-weights.json` | So borderline verdicts defer to cluster context |
| `content-researcher` | `data/reports/post-performance/latest.json` — past flop verdicts for slugs in same cluster | So briefs avoid patterns that already failed |
| `internal-link-auditor` | `data/reports/quick-wins/latest.json` | So link equity flows toward posts one rank from page 1 |
| `internal-linker` | `data/reports/quick-wins/latest.json` | Same reason — link from fresh posts into quick-win targets |
| `meta-optimizer` | `data/reports/gsc-opportunity/latest.json` → `low_ctr` section | So title/meta rewrites target real low-CTR queries with demand |
| `blog-post-writer` | `data/reports/technical-seo/*.md` | So structural SEO lessons become standing instructions |
| `insight-aggregator` | `data/reports/content-refresh-report.md` in addition to editor reports | So refresher patterns also become standing rules |
| `unmapped-query-promoter` (itself) | should stamp GSC context onto the calendar item it creates so `content-researcher` can read the original query pattern when briefing | Closes the loop from GSC → brief → writer |
| `rank-alerter` | should trigger `post-performance` re-check for posts with sudden drops | Currently fires-and-forgets |

---

## Rules for future agents

When adding or modifying an agent, work through this checklist before merging:

1. **Inputs** — what signals does this agent read? List every file path it depends on. If a signal you need doesn't exist yet, either the upstream agent should be extended, or this agent shouldn't exist in this form.
2. **Outputs** — what signal does this agent produce? Who reads it? If no one reads it, either the output is for humans (in which case it should flow into the daily digest or dashboard) or the agent shouldn't produce it at all.
3. **Manifest update** — every new input or output means a row gets added, edited, or moved in this file. The manifest is the source of truth.
4. **Context cross-check** — before the agent makes a decision, does it have every relevant context signal? A decision made without consulting `rejected-keywords.json`, `post-performance/latest.json`, `cluster-weights.json`, `writer-standing-rules.md`, or whatever else applies, is a bug.

## Review cadence

- After every new agent lands, update the manifest and flag anything newly orphaned.
- Monthly: grep for any `data/reports/*/latest.json` files and confirm at least one consumer exists for each. Remove any orphaned reports.
- When reviewing a PR, read the PR against this manifest: does the change touch a signal? If yes, all upstream and downstream edges must still work.
