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
| `data/snapshots/ga4/*.json` | Google Analytics 4 API | `ga4-collector` | `dashboard data-loader`, `cro-analyzer`, `ga4-content-analyzer` |
| `data/snapshots/shopify/*.json` | Shopify Admin API | `shopify-collector` | `sitemap-indexer`, `topical-mapper`, `blog-post-verifier` |
| `data/snapshots/clarity/*.json` | Microsoft Clarity API | `clarity-collector` | `cro-analyzer` |
| `config/site.json` | manual | n/a (static) | nearly every agent — brand name, domain, etc. |
| `config/ingredients.json` | manual | n/a (static) | `blog-post-writer`, `content-refresher`, `editor`, `collection-content-optimizer` |
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
| `data/topical-map.json` | `topical-mapper` | `content-researcher`, `internal-linker`, `content-strategist`, `editor`, `collection-content-optimizer`, `ga4-content-analyzer` | healthy |
| `data/reports/internal-linker/*.md` | `internal-linker` | `daily-summary`, dashboard | **gap** — doesn't feed back into `blog-post-writer` or `content-refresher` so the writer is unaware which internal links have already been placed |
| `data/reports/technical-seo/*.md` | `technical-seo` | `daily-summary`, dashboard | **gap** — findings don't flow into `blog-post-writer` as "don't introduce this issue" standing rules |

### Review / approval state (performance-engine, not yet built)

| Signal | Writer | Consumers | Status |
|---|---|---|---|
| `data/performance-queue/<slug>.json` | `performance-engine`, `product-optimizer --from-gsc`, `collection-content-optimizer` | `daily-summary`, dashboard Optimize tab, `publisher` (approve flag), `product-optimizer --publish-approved`, `collection-content-optimizer --publish-approved` | healthy |
| `data/collection-content/<handle>.html` | `collection-content-optimizer` | dashboard preview, `collection-content-optimizer --publish-approved` | healthy |
| `data/performance-queue/<handle>.json` (trigger: `collection-gap`) | `collection-creator --from-opportunities` | dashboard, `collection-creator --publish-approved` | healthy |
| `data/performance-queue/indexing-submissions.json` | `indexing-fixer` | dashboard Optimize tab (Indexing Status card), `indexing-fixer --approve <slug>` | healthy |
| `data/reports/cannibalization/latest.json` | `cannibalization-resolver --report-json` | dashboard Optimize tab (cannibalization card) | healthy |
| `data/reports/ga4-content-feedback/latest.json` | `ga4-content-analyzer` | `content-strategist` (cluster weighting), `cro-cta-injector --from-ga4` | healthy |

### Indexing signals

| Signal | Writer | Consumers | Status |
|---|---|---|---|
| `data/reports/indexing/latest.json` | `indexing-checker` | `indexing-fixer`, `post-performance` (distinguishes NOT_INDEXED from BLOCKED), `refresh-runner` (suppresses refresh of non-indexed posts), dashboard Indexing Status card | healthy |
| `data/reports/indexing/history.json` | `indexing-checker` (append-only) | audit trail; future use for tracking time-to-index | audit-only |
| `data/posts/<slug>.json#indexing_state` | `indexing-checker` | `post-performance`, `refresh-runner`, `indexing-fixer` | healthy |
| `data/posts/<slug>.json#indexing_submissions` | `indexing-fixer` | `indexing-fixer` (for escalation to Tier 3) | healthy |
| `data/posts/<slug>.json#indexing_blocked` | `indexing-fixer` (Tier 3 manual flag) | dashboard (Action Required), `refresh-runner` (don't refresh blocked) | healthy |
| `data/quota/indexing-api.json` | `lib/gsc-indexing.js` | `indexing-checker`, `indexing-fixer` | healthy |

### Legacy triage signals

| Signal | Writer | Consumers | Status |
|---|---|---|---|
| `data/reports/legacy-triage/latest.json` | `legacy-triage` | `performance-engine` (picks legacy flops), `meta-optimizer` (picks rising), dashboard Optimize tab | healthy |
| `data/posts/<slug>.json#legacy_bucket` | `legacy-triage` | `performance-engine`, `content-refresher`, `refresh-runner`, `meta-optimizer` | healthy |
| `data/posts/<slug>.json#legacy_locked` | `legacy-triage` (auto-lock winners) | `content-refresher`, `refresh-runner`, `meta-optimizer` (skip if locked) | healthy |

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

**Update 2026-04-09:** The gaps listed below were all closed in a single pass — see PR landing commit. The table below is preserved as the historical list of closed gaps. Review this section any time a new agent is added.

| Gap | Status | What changed |
|---|---|---|
| `content-refresher` → `post-performance` verdict reason | ✅ closed | `loadPerformanceVerdict(slug)` injects the verdict into the refresh prompt so the rewrite targets the specific cause, not a generic refresh |
| `content-refresher` → `writer-standing-rules.md` | ✅ closed | `loadAgentFeedback` now appends writer standing rules to the refresher prompt |
| `editor` → `writer-standing-rules.md` | ✅ closed | `loadAgentFeedback` in editor also appends writer standing rules with "enforce these" instructions |
| `quick-win-targeter` → `cluster-weights.json` | ✅ closed | `scoreOpportunity` accepts `clusterWeight`, applies 15%-per-unit multiplier (page-1 cluster = 1.3× boost, drag cluster = 0.55× penalty) |
| `quick-win-targeter` → `competitor-watcher/latest.json` | ✅ closed | Same `scoreOpportunity` change — `competitorBoost` adds 10% per new competitor post in cluster |
| `post-performance` → `competitor-watcher/latest.json` | ✅ closed | DEMOTE verdicts soften to REFRESH when competitor activity is detected in the same cluster (external pressure, not content rot) |
| `post-performance` → `rank-alerts/*.md` | ✅ closed | `loadExternalContext()` reads the last 7 days of alerts; `rankDrops` set is available for future off-cycle triggers |
| `post-performance` → `cluster-weights.json` | ✅ closed | DEMOTE also softens to REFRESH if the post is in a page-1 cluster (weight ≥ 2) |
| `content-researcher` → `performance_review` history for related flops | ✅ closed | `loadRelatedFlops(keyword)` scans same-cluster posts for non-ON_TRACK verdicts and injects them into the brief prompt as "do not repeat these patterns" |
| `internal-link-auditor` → `quick-wins/latest.json` | ✅ closed | Report has a new "Quick-Win Under-Linked Posts" section showing quick-win slugs and their inbound link counts |
| `internal-linker` → `quick-wins/latest.json` | ✅ closed | `pickTopTargets` applies a 2× bonus to candidates whose slug is on the quick-win list |
| `meta-optimizer` → `gsc-opportunity/latest.json` | ✅ closed | Prefers the rejection-filtered low-CTR list from gsc-opportunity; falls back to a live GSC query only if the file is missing |
| `insight-aggregator` → `content-refresh-report.md` | ✅ already closed | `walkReports` recursively reads every `*.md` under `data/reports/`, including refresh reports, so the main Claude analysis pass already consumed them |
| `blog-post-writer` → `technical-seo/*.md` | deferred | Lower impact, not addressed in this pass |
| `rank-alerter` → `post-performance` trigger | partial | `rankDrops` set is loaded by post-performance; a cron-triggered off-cycle run is still a future enhancement |

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
