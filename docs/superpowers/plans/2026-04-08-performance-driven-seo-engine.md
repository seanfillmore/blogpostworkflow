# Performance-Driven SEO Engine — Implementation Plan

**Goal:** Shift the SEO automation from publish-centric conveyor to a performance-driven optimization engine that uses real data to decide the highest-leverage next action, prioritizes quick-wins and refreshes over net-new content, and closes feedback loops between publishing and ranking.

**Architecture:** Build on top of existing agents. Add a canonical JSON calendar layer underneath the markdown, add new analysis agents that consume rank/GSC/engagement signals, and wire them into the morning digest for visibility. No existing agent is rewritten from scratch — each is extended where it needs performance awareness.

**Tech Stack:** Node.js, existing Ahrefs/GSC/GA4/Shopify/Anthropic libraries in `lib/`. All new agents follow the existing pattern (one directory per agent, reads from `data/`, writes reports).

---

## Order of Operations

1. **JSON calendar as source of truth** — foundational, unblocks everything below
2. **Quick-win targeting loop** — cheapest, highest ROI; finds posts at positions 11–20 and generates rewrite briefs
3. **Post-publish 30/60/90 review** — automated review + Action Required digest entries for flops
4. **Topical authority weighting** — prefer topics that reinforce existing hubs
5. **Daily GSC opportunity report** — surfaces queries with impressions but no clicks, feeds strategy tick
6. **Editor → Writer feedback loop** — editor findings flow back into writer's standing feedback automatically
7. **Competitor watcher** — weekly scan of competitor blogs, spikes priority when they publish in our topics
8. **Refresh pipeline** — rerun pipeline against existing posts on an aging schedule

Each item is a self-contained deliverable. Test locally → commit → deploy → verify → move to next.

---

## Task 1: Canonical JSON calendar

**Rationale:** Markdown calendar is fragile for programmatic edits. Make JSON authoritative; markdown becomes a rendered view.

**Files:**
- Create: `agents/content-strategist/lib/calendar-store.js` — read/write API for canonical calendar JSON
- Create: `data/calendar/calendar.json` — the canonical store (committed, not gitignored)
- Modify: `agents/content-strategist/index.js` — write JSON as primary output, render markdown from JSON
- Modify: `agents/calendar-runner/index.js:55–92` — replace `parseCalendar()` to read JSON first, fall back to markdown parse for legacy data
- Modify: `agents/dashboard/index.js` `parseCalendar()` helper — also prefer JSON

**JSON schema:**
```json
{
  "generated_at": "ISO timestamp",
  "regenerated_at": "ISO timestamp",
  "items": [
    {
      "slug": "natural-deodorant-for-men",
      "keyword": "natural deodorant for men",
      "title": "Best Natural Deodorant for Men",
      "category": "Deodorant",
      "content_type": "Blog Post — TOF",
      "priority": "High",
      "week": 1,
      "publish_date": "2026-04-15T08:00:00-07:00",
      "original_publish_date": "2026-04-15T08:00:00-07:00",
      "kd": 2,
      "volume": 1300,
      "source": "gap_report",
      "topical_hub": "deodorant",
      "status_override": null,
      "priority_score": 85,
      "added_at": "2026-04-08T00:00:00Z",
      "last_updated": "2026-04-08T00:00:00Z"
    }
  ]
}
```

**Test:** Calendar-runner run against new JSON, confirm all existing scheduled items load; dashboard kanban still renders; content-strategist regenerates calendar cleanly.

**Commit message:** `feat(calendar): canonical JSON store with markdown as rendered view`

---

## Task 2: Quick-win targeting loop

**Rationale:** Posts at positions 11–20 are the cheapest way to grow traffic. A small rewrite + internal links can push them to page 1.

**Files:**
- Create: `agents/quick-win-targeter/index.js` — reads rank-tracker snapshots + GSC, finds posts at positions 11–20, generates rewrite briefs
- Create: `agents/quick-win-targeter/prompts.js` — Claude prompt for rewrite brief generation
- Output: `data/reports/quick-wins/YYYY-MM-DD.md` + `data/briefs/refresh-<slug>.json`
- Modify: `agents/calendar-runner/index.js` — recognize `refresh-<slug>` briefs as refresh jobs, run through a refresh sub-pipeline instead of new-post pipeline
- Modify: `agents/daily-summary/index.js` — add "Quick Win Targets" section to morning digest

**Logic:**
1. Load latest rank snapshot
2. Filter posts where `position` is between 11 and 20
3. Pull GSC data for each URL: impressions, clicks, CTR by query
4. Rank candidates by `impressions × (21 - position) × (1 / CTR+0.01)` — prioritizes high-impression low-CTR posts close to page 1
5. Top 3 candidates per run get a rewrite brief that lists:
   - Current position, impressions, CTR, target query
   - What page 1 competitors do differently (from Ahrefs SERP data if available)
   - Specific sections to add/improve
   - Internal links from 3 highest-authority hub posts in same cluster

**Cron:** Mon 8:00 AM PT (after rank-tracker runs at 7:00)

**Test:** Run manually against current rank data, verify it picks reasonable candidates and produces briefs.

**Commit:** `feat(seo): quick-win targeting loop for positions 11-20`

---

## Task 3: Post-publish 30/60/90 review

**Rationale:** Know within a month whether a post is working. Flag flops for investigation or refresh.

**Files:**
- Create: `agents/post-performance/index.js` — runs daily, checks every published post at 30/60/90 day milestones
- Output: `data/reports/post-performance/YYYY-MM-DD.md` + individual `data/reports/post-performance/<slug>-30d.md` reviews
- Modify: `agents/daily-summary/index.js` — add "Post Performance" and "Action Required — Flops" sections
- Modify: `data/posts/<slug>.json` — add `performance_review: { 30d, 60d, 90d }` tracking fields

**Review criteria per milestone:**
- **30 days:** Indexed in GSC? Any impressions? Any ranking? If all zero → **BLOCKED** (technical or intent mismatch). Flag for investigation.
- **60 days:** Compare impressions/clicks to projection from brief (`traffic_potential` × time factor). Under 25% of projection → **REFRESH** candidate.
- **90 days:** Final verdict. If still under 50% of projection → **DEMOTE** candidate (merge, refresh, or remove).

**Cron:** Daily 6:30 AM PT

**Test:** Run against existing published posts, verify it produces sensible reviews and surfaces the worst performers.

**Commit:** `feat(seo): post-publish 30/60/90 review loop`

---

## Task 4: Topical authority weighting in strategist

**Rationale:** Reinforcing existing page-1 clusters is higher ROI than breaking into new ones. Tell the strategist to prefer topics adjacent to winners.

**Files:**
- Modify: `agents/content-strategist/index.js` — add `loadClusterPerformance()` helper that reads rank-tracker output, identifies page-1 clusters and drag clusters, passes to strategist prompt
- Modify: strategist system prompt — explicit scoring rule: +2 priority weight for topics in page-1 clusters, −3 for topics in drag clusters
- Create: `data/reports/content-strategist/cluster-weights.json` — latest computed weights (for dashboard display)

**Logic:**
- Page-1 cluster = any cluster with ≥1 post at positions 1–10 and no recent flops
- Drag cluster = any cluster where median position >30 and age >30 days
- Weights feed directly into the strategist's prioritization prompt

**Test:** Regenerate calendar, verify priorities shift toward existing hubs.

**Commit:** `feat(seo): topical authority weighting in content strategist`

---

## Task 5: Daily GSC opportunity query report

**Rationale:** GSC is the most real signal you have and it's free. Daily report of queries with impressions but no clicks → direct input for rewrites and new-topic decisions.

**Files:**
- Create: `agents/gsc-opportunity/index.js` — daily job that calls `getLowCTRKeywords()` and `getPage2Keywords()`, produces report
- Output: `data/reports/gsc-opportunity/YYYY-MM-DD.md` + `data/reports/gsc-opportunity/latest.json`
- Modify: `agents/daily-summary/index.js` — "GSC Opportunities" section in digest (top 5 by volume)
- Modify: `agents/content-strategist/index.js` — read `latest.json` as additional input signal

**Report structure:**
- **Low-CTR queries** (impressions ≥100, CTR ≤2%): which page currently serves? Rewrite title/meta candidate
- **Page 2 queries** (positions 11–30): which pages? Quick-win candidates (feeds Task 2)
- **Unmapped queries**: high impressions, no page targeting this keyword → new-topic candidate (feeds strategist)

**Cron:** Daily 6:30 AM PT (after gsc-collector)

**Commit:** `feat(seo): daily GSC opportunity query report`

---

## Task 6: Editor → Writer feedback loop

**Rationale:** Today, recurring writer mistakes only get corrected when I notice a pattern across multiple posts. Automate it.

**Files:**
- Modify: `agents/insight-aggregator/index.js` — scan recent editor reports, detect patterns ("X posts flagged same issue in last 30 days"), update writer section of `data/context/feedback.md` with new standing rules
- Add safety: never remove existing rules, only append or update; maintain a changelog in the feedback file

**Logic:**
- Pull last 30 days of editor reports
- Group findings by category (CTA, sources, H1, structure, etc.)
- If ≥3 posts show the same specific issue → generate a standing rule
- Append to writer feedback section with a date stamp
- Commit changes via git (human-visible)

**Cron:** Weekly Mon 8:00 AM PT

**Commit:** `feat(seo): automated writer feedback from editor findings`

---

## Task 7: Competitor watcher

**Rationale:** If a competitor publishes in our target cluster, we want to know and react.

**Files:**
- Create: `agents/competitor-watcher/index.js` — weekly scan of 3–5 competitor blog feeds (RSS/sitemap)
- Create: `config/competitors.json` — list of competitors with feed URLs
- Output: `data/reports/competitor-watcher/YYYY-MM-DD.md` — new posts, their topics, how they map to our clusters
- Modify: `agents/daily-summary/index.js` — "Competitor Activity" section (if any new posts)
- Modify: `agents/content-strategist/index.js` — accept competitor signals as a priority boost

**Cron:** Weekly Sun 7:00 PM PT

**Commit:** `feat(seo): weekly competitor blog watcher`

---

## Task 8: Refresh pipeline

**Rationale:** Aging content needs periodic updates. Build a workflow that re-runs the pipeline for existing posts.

**Files:**
- Create: `agents/refresh-runner/index.js` — takes a slug, loads existing post, runs: rank-tracker check → gap analysis (what's missing vs current SERP leaders) → writer in "refresh mode" (preserves structure, updates claims/sources/examples) → editor → publisher (updates existing article)
- Modify: `agents/blog-post-writer/index.js` — add `--refresh <slug>` mode that reads existing post as input and edits in place
- Modify: `agents/publisher/index.js` — support updating existing article without creating new one (already supported, just confirm the path)

**Trigger sources:**
- Manual: `node agents/refresh-runner/index.js <slug>`
- Automatic: triggered by post-performance review (Task 3) when a post flops
- Automatic: triggered by quick-win-targeter (Task 2) for top candidates
- Aging schedule: posts >180 days old that have traffic auto-refresh quarterly

**Commit:** `feat(seo): refresh pipeline for existing content`

---

## Deployment + Verification

After each task:
1. Run locally against real data
2. Commit, merge to main, push
3. Deploy to server
4. Verify via morning digest or direct output inspection
5. Update the plan file with lessons learned if anything surprising happened

## Success criteria

- Morning digest surfaces 3–5 quick-win candidates weekly
- At least 1 refresh per week is triggered automatically
- No manual keyword selection needed between Ahrefs uploads
- Posts flagged as flops within 30 days of publish
- Calendar priorities visibly shift toward existing hubs
