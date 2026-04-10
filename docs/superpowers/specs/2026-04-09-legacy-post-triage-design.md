# Legacy Post Triage — Design Spec

**Date:** 2026-04-09
**Status:** Approved
**Goal:** Sort 94 legacy published posts into actionable buckets using existing SEO signals, then route each bucket through the right treatment — protect winners, meta-optimize risers, rewrite flops, fix broken pages — all through the existing performance-queue approval workflow.

## Context

The site has 94 legacy posts published on Shopify that predate the current pipeline. They have no `target_keyword`, no brief, no editor report, and no performance-review data. Some are ranking well and driving traffic; others are thin, stale, or not indexed. Without triage, the system treats them all the same (ignores them), wasting the traffic already flowing to winners and missing obvious improvement opportunities on flops.

## The 4 buckets

### Winners — auto-locked, do not touch
- **Criteria:** indexed AND ranking positions 1–10 for any keyword AND ≥10 impressions in the last 90 days of GSC data
- **Treatment:** Stamp `legacy_bucket: 'winner'` and `legacy_locked: true` on the post JSON. No agent (refresher, rewriter, meta-optimizer) is allowed to modify a locked post. The dashboard shows them with a lock icon.
- **Unlock:** Manual only — human removes the `legacy_locked` flag via a dashboard button if they decide a winner needs updating.

### Rising — meta-only optimization
- **Criteria:** indexed AND ranking positions 11–30 AND ≥10 impressions
- **Treatment:** Stamp `legacy_bucket: 'rising'`. Route to `meta-optimizer` for title/meta_description rewrite. Do NOT rewrite the body — these posts are close enough that a title fix alone can move them to page 1. Meta rewrites go through the performance-queue approval flow (same Approve/Feedback/Dismiss pattern).

### Flops — full rewrite
- **Criteria:** any of:
  - Indexed but zero impressions after 30+ days (content isn't matching any query)
  - Thin content (<800 words)
  - `crawled_not_indexed` state from indexing-checker (Google rejected it)
  - Ranking position >50 or no ranking data at all after 30+ days
- **Treatment:** Stamp `legacy_bucket: 'flop'`. Route to the `answer-first` rewriter (already built) or `content-refresher`. Rewrites go through performance-queue approval. **Cap: 3 per day.**

### Broken — fix the technical issue
- **Criteria:** indexing-checker state is `not_found`, `excluded_noindex`, `excluded_robots`, `excluded_canonical`, or `indexing_blocked: true`
- **Treatment:** Stamp `legacy_bucket: 'broken'`. These skip the content pipeline entirely — the problem is technical (404, noindex tag, robots.txt block, canonical mismatch). Surface on the dashboard as Action Required cards with the specific diagnostic from indexing-checker. No automated fix; human resolves.

### Retirement candidates (sub-bucket of flops)
- **Criteria:** Flop that has been rewritten once, re-evaluated at 30 days post-rewrite, and still has zero impressions or `crawled_not_indexed`
- **Treatment:** Stamp `legacy_bucket: 'retire'`. Surface on dashboard with a proposed 301 redirect target (the closest related published post by keyword similarity). Human approves the redirect; agent creates it via `lib/shopify.js createRedirect()` and unpublishes the article.

## Architecture

### New agent: `agents/legacy-triage/index.js`

Runs on demand (not on a cron — triage is a one-time classification pass with periodic re-evaluation, not a daily job). Re-run manually or when new signal data arrives.

**Reads:**
- `data/posts/*.json` — all posts with `legacy_source` or `legacy_synced_at` (or empty `target_keyword`)
- `data/reports/indexing/latest.json` — indexing state per URL
- `data/rank-snapshots/latest.json` — current position data
- GSC page performance via `lib/gsc.js getPagePerformance()` — impressions/clicks per URL
- `data/posts/*.html` — word count for thin-content detection
- `data/rejected-keywords.json` — skip rejected posts

**Writes:**
- `data/reports/legacy-triage/latest.json` — bucket assignments with counts and per-post detail
- `data/reports/legacy-triage/YYYY-MM-DD.md` — human-readable summary
- Stamps `legacy_bucket` and `legacy_triage_reason` on each post's JSON
- Stamps `legacy_locked: true` on winners

**Signal manifest entry:** Producer of `legacy_bucket` field, consumed by:
- `content-refresher` / `answer-first` rewriter — reads `legacy_bucket: 'flop'` to pick candidates
- `meta-optimizer` — reads `legacy_bucket: 'rising'` to prioritize
- `refresh-runner` — respects `legacy_locked: true` (won't refresh winners)
- `performance-engine` — reads `legacy_bucket` to prioritize flops in its nightly picks
- Dashboard Optimize tab — new Legacy Triage card showing bucket counts and top candidates

### Dashboard integration

New card on the Optimize tab: **Legacy Post Triage**
- Shows bucket counts: Winners (locked icon), Rising, Flops, Broken
- Top 5 flops with word count, age, and indexing state
- Top 5 rising with position, impressions, CTR
- Broken posts with diagnostic reason
- "Run triage" button that triggers the agent via `/run-agent`

### Performance-engine integration

The performance engine's candidate pickers already read signal files. Add one more picker: `pickLegacyFlops(blocked)` that reads `data/reports/legacy-triage/latest.json` and picks posts with `legacy_bucket: 'flop'` that haven't been rewritten yet. These compete for the same 6-item daily budget (3 flop slots) alongside the existing post-performance flops.

### Winner protection

Every agent that modifies post content must check `legacy_locked` before proceeding:
- `content-refresher` — skip if locked
- `refresh-runner` — skip if locked
- `answer-first` rewriter — skip if locked (if it exists)
- `meta-optimizer` — skip if locked
- `performance-engine` — skip if locked

This is a 1-line check at the top of each agent's per-post processing loop.

## Non-goals

- Not building a new rewriter. The `answer-first` rewriter and `content-refresher` already exist. Triage just routes posts to the right one.
- Not auto-deleting anything. Retirement is always human-approved.
- Not running triage on a cron. It's a classification pass that runs when you want fresh data, not a daily job.
- Not touching the 21 scheduled posts or 24 drafts. Triage only operates on posts with `shopify_status === 'published'` AND (`legacy_source` OR empty `target_keyword`).

## Success criteria

- Every legacy post has a `legacy_bucket` assignment after one triage run
- Winners are locked and no agent touches them
- Rising posts flow to meta-optimizer via the performance queue
- Flops flow to the rewriter at max 3/day via the performance queue
- Broken posts surface as Action Required on the dashboard with diagnostics
- Dashboard shows accurate bucket counts
- Running triage twice produces identical results (idempotent)
