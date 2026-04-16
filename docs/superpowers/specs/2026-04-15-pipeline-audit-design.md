# Content Pipeline Audit & Redesign

**Goal:** Evolve the existing 80+ agents from siloed specialists into a coordinated system where fixes are proportional to post performance, the editor orchestrates specialists instead of blocking, and legacy posts are evaluated against the same quality bar as new ones.

**Scope:** Audit each agent's role, connect agents that should work together, introduce a triage system for existing posts, and evolve the editor from a blocker into an orchestrator. Not in scope: measurement framework, productization (multi-tenant SaaS), net-new agents beyond those listed.

---

## Problem Statement

### 1. Legacy vs. new posts are treated as different systems

The legacy-rebuilder tears down any post missing FAQ schema and reruns the entire pipeline. This is the right move for a thin, poorly-ranked post — and the wrong move for a post ranking #2 that just needs a CTA and FAQ schema injected. Both get the same scorched-earth treatment. There should be one quality bar, with the fix proportional to the gap.

### 2. The editor blocks instead of delegating

The editor detects ~20 categories of issues across deterministic checks, link health, source verification, and LLM-based editorial review. When issues are found, it writes "REQUIRED ACTIONS" and hands them off to a human. But the project already has specialist agents that can fix most of these issues automatically:

- Broken external links → `link-repair` already fixes these
- Broken internal links → `link-repair` cross-references the blog index
- Missing internal links → `internal-linker` already finds natural anchor points
- Missing product CTAs → `featured-product-injector` already handles this
- Missing schema → `schema-injector` already detects and injects
- Stale years in titles → `meta-optimizer` already updates title metafields
- Content rewriting → `content-refresher` handles targeted section rewrites

Today 20 posts are hard-blocked with stale years in their Shopify meta titles. The meta-optimizer can fix this in seconds, but the editor doesn't know how to delegate. This is the core orchestration gap.

### 3. No systematic measurement of impact

(Acknowledged but out of scope for this design — a separate project once the pipeline stabilizes.)

---

## Architecture

### Two flows, shared backbone

**New post flow** (unchanged from today, one refinement):

```
content-calendar → content-researcher → blog-post-writer (with target word count)
  → image-generator → answer-first-rewriter → featured-product-injector
  → schema-injector → editor (orchestrator) → publisher
```

Refinement: writer receives a target word count derived from competitive analysis in the brief.

**Existing post flow** (new — replaces today's "legacy-rebuilder does everything"):

```
post-analyst (research) → post-health-scorer (triage into Protect/Enhance/Rebuild tier)
  ├─ PROTECT tier → editor (orchestrator) → surgical fixes only → publisher
  ├─ ENHANCE tier → content-refresher (targeted sections) → editor (orchestrator) → publisher
  └─ REBUILD tier → legacy-rebuilder (full pipeline) → publisher
```

### Components

#### Post Analyst (NEW)

Pure research. No mutations. Produces a structured analysis JSON per post.

**Reads:**
- GSC: actual ranking keywords for the post (may differ from `target_keyword` in metadata)
- DataForSEO: competitive SERP data for the top 3 results — headings, word count, content format
- Topical map: cluster membership, related posts, orphan status, suggested internal links
- Internal sitemap + blog index: link graph position

**Writes:**
- `data/analysis/<slug>.json` containing: primary ranking keyword, secondary keywords, competitive benchmarks (target word count, competitor headings/topics covered), topical map position, suggested internal links in/out of the post

**Does not:** touch the post, mutate Shopify, or make triage decisions. Analysis only.

#### Post Health Scorer (EVOLVE legacy-triage)

Consumes post-analyst output plus performance data plus structural checks. Produces a tier assignment.

**Evolution of existing legacy-triage:** that agent already buckets posts into winner/rising/flop/broken using device-weighted GSC position data. Extend it with:

**Additional inputs:**
- Shopify conversion/revenue data per landing page (via GA4 join)
- GA4 engagement (bounce rate, time on page, scroll depth per post)
- Structural quality checks (presence of: FAQ schema, product CTA, meta description, featured image, internal links, broken links count)

**Output:**
- `legacy_bucket` → `tier` (Protect | Enhance | Rebuild)
- `tier_reasons` listing the signals that drove the decision
- `suggested_fixes` — specific action list for the orchestrator

**Tier rules:**

| Tier | Criteria | Action |
|---|---|---|
| Protect | Top 25% by traffic OR has conversions OR positions 1-5 on primary keyword | Surgical fixes only. Never rewrite body. |
| Enhance | Positions 5-30, decent impressions, low engagement OR structural gaps | Content-refresher on weak sections + orchestrator for structural fixes |
| Rebuild | Bottom 25% by traffic AND 3+ structural gaps OR position >30 OR thin content | Full legacy-rebuilder pipeline |

Percentiles self-calibrate against the current catalog.

#### Editor Orchestrator (EVOLVE editor)

Transforms the editor from a terminal quality gate into the coordinator that delegates fixes to specialists.

**Flow:**

1. **Pre-review auto-fixes** (always applied, in-place):
   - Stale years in body text, headings (existing)
   - Links to unpublished posts (existing)
   - H1 tags in body (NEW — simple regex removal)
   - Broken external links (PROMOTE from opt-in to always-on)
   - Markdown code fences in HTML (NEW — strip and log)

2. **Run checks** (existing deterministic + editorial review + link health + source verification)

3. **Classify each issue** → ignore / delegate / rebuild-signal

4. **Delegate** — spawn the specialist agent for each delegated issue, wait for completion

5. **Count rebuild signals** — if ≥3 categories of editorial review fail simultaneously, tag `needs_rebuild`, exit

6. **Re-verify** (max 2 iterations):
   - Pass → clear publish gate
   - Still failing → tag `needs_rebuild` with remaining issues, surface for human review

**Delegation map:**

| Issue type | Handler |
|---|---|
| Stale year in post title (Shopify `global.title_tag`) | meta-optimizer |
| Stale year in meta description | meta-optimizer |
| Missing internal links in cluster | internal-linker |
| Missing product/collection CTA | featured-product-injector |
| Broken internal links (wrong URL) | link-repair |
| Source link unreachable | link-repair (alternate-source mode) |
| Source claim unsupported | content-refresher (section rewrite) |
| Product/collection link not in sitemap | link-repair or sitemap-indexer |
| Competitor names in FAQ | content-refresher (narrow Q&A rewrite) |
| Missing FAQ schema | schema-injector |

**Not delegated (ignore):**
- Stale year in slug — slug is immutable for indexed posts, year in URL doesn't affect SEO. Remove this check from the LLM editorial review prompt.

**Rebuild signals** (tag, don't fix):
- Topical relevance failure
- Brand voice systematic failure (multiple paragraphs)
- Ingredient accuracy systematic failure
- Multiple factual concerns (3+)
- 3+ editorial review categories failing simultaneously

**New mode:** when called with `--in-pipeline` by the rebuilder, the orchestrator operates as a pure quality gate (no delegation, no re-tagging) to avoid recursion.

#### Meta-Optimizer — New Mode (EVOLVE)

Add a `--refresh-stale-years` mode that:
- Scans all published posts' Shopify metafields (`global.title_tag`, `global.description_tag`)
- Identifies stale year references (any `20YY` < current year in year-context patterns)
- Rewrites the title/description with current year via Shopify metafield API
- Can be called by the editor orchestrator for a single post OR run in batch mode to clear backlog

This fixes the 20 hard-blocked posts on its first batch run.

#### Link-Repair — New Mode (EVOLVE)

Add an "alternate source" mode that:
- When given a broken external source URL + anchor text + surrounding context
- Searches (via DataForSEO or web search) for equivalent content at a working URL
- If a suitable replacement is found, swaps the URL; if not, removes the `<a>` wrapper and keeps anchor text (current behavior)

This preserves source citations when the original link 404s but equivalent content exists elsewhere.

#### Writer Refinement (EVOLVE blog-post-writer)

Today: fixed 8,000 token output budget for every post.

Change: writer receives a `target_word_count` range from the brief, informed by competitive SERP analysis (what length are top-ranking posts?). Shorter explainers get shorter budgets; comprehensive guides get longer budgets. No change to output quality gates (still throws on max_tokens truncation, still validates unclosed hrefs).

#### Image Regeneration for Legacy Posts (EVOLVE image-generator)

Today: images are generated once and never revisited. Add an `--evaluate-existing` mode that:
- Claude Vision reviews the existing image against: brand fit, quality, relevance to current content focus
- Returns a verdict: keep | regenerate
- The enhance-tier orchestrator can optionally trigger this; rebuild-tier already regenerates as part of the full pipeline

Minor capability. Not a blocker for the broader redesign.

---

## Agent role map

### Core pipeline (new posts)
content-researcher → blog-post-writer → image-generator → answer-first-rewriter → featured-product-injector → schema-injector → editor (orchestrator) → publisher

### Existing post flow
post-analyst → post-health-scorer → tier-specific path → editor (orchestrator) → publisher

### Orchestrators
- **calendar-runner** — new posts through the pipeline
- **pipeline-scheduler** — brief generation from calendar
- **performance-engine** — refresh loop for post-performance flagged content
- **editor (orchestrator)** — coordinates specialist agents per post
- **legacy-rebuilder** — rebuild-tier executor (called by scorer)

### Analysis/scoring
post-analyst (new), post-health-scorer (evolved legacy-triage), post-performance, rank-tracker, rank-alerter, quick-win-targeter, gsc-opportunity, gsc-query-miner, content-gap, competitor-intelligence, competitor-watcher, device-weights

### Fix agents (called by orchestrator)
link-repair, internal-linker, collection-linker, meta-optimizer, cro-cta-injector, content-refresher, answer-first-rewriter, featured-product-injector, schema-injector, cannibalization-resolver, blog-content

### Measurement (validates fixes)
meta-ab-tracker, meta-ab-checker, ga4-content-analyzer, cro-analyzer, cro-deep-dive-content, cro-deep-dive-seo, cro-deep-dive-trust

### Data collectors
gsc-collector, ga4-collector, clarity-collector, shopify-collector

### Feedback loop
editor findings → insight-aggregator → standing rules → writer learns

---

## What's new vs. what already exists

| Component | Change |
|---|---|
| post-analyst | **NEW** — pulls GSC keywords + competitive intel + topical position into analysis JSON |
| post-health-scorer | **EVOLVE** legacy-triage — add Shopify revenue, GA4 engagement, structural checks; map to Protect/Enhance/Rebuild tiers |
| editor orchestrator mode | **EVOLVE** editor — add delegation layer after checks, add `--in-pipeline` mode |
| meta-optimizer `--refresh-stale-years` | **ADD** mode — scans title_tag/description_tag metafields for stale years, rewrites via Shopify |
| link-repair alternate-source mode | **ADD** mode — when source link 404s, search for equivalent content at working URL |
| blog-post-writer target word count | **ADD** — brief includes target_word_count range from competitive analysis |
| image-generator `--evaluate-existing` | **ADD** mode — Claude Vision review of existing image, verdict: keep or regenerate |
| legacy-rebuilder | **EVOLVE** — becomes rebuild-tier executor only; scorer decides when to invoke |
| Everything else | **EXISTS** — just gets wired into the orchestrator |

---

## Data flow

### Analysis phase (post-analyst)

```
Input: post slug + meta
├─ GSC: getPageKeywords(url) → primary + secondary ranking keywords
├─ GSC: getPagePerformance(url, 90) → impressions, clicks, CTR, position
├─ DataForSEO: getSerpResults(primary_keyword) → top-3 competitor URLs
├─ Competitor scrape → headings, word count, topics covered
├─ Topical map lookup → cluster membership, related posts, orphan status
└─ Internal link graph → inbound links count, outbound link targets

Output: data/analysis/<slug>.json
```

### Scoring phase (post-health-scorer)

```
Input: post meta + post-analyst output
├─ Performance signals
│   ├─ Shopify (via GA4 join): conversions, revenue per landing page
│   ├─ GA4: bounce rate, time on page, scroll depth
│   └─ GSC: avg position, CTR vs. position-expected CTR
├─ Structural signals
│   ├─ FAQ schema present?
│   ├─ Product CTA present?
│   ├─ Meta description present and current?
│   ├─ Featured image present?
│   ├─ Inbound internal links count
│   └─ Broken links count
└─ Tier assignment: Protect | Enhance | Rebuild

Output: meta.tier, meta.tier_reasons, meta.suggested_fixes (written back to post meta.json)
```

### Fix phase (editor orchestrator)

```
For each post in Protect or Enhance tier:
  1. Run pre-review auto-fixes (years, H1, broken externals, markdown)
  2. Run editorial review + link health + source verification
  3. Classify issues: ignore / delegate / rebuild-signal
  4. For each delegate: spawn specialist, wait for completion
  5. If ≥3 rebuild signals: tag needs_rebuild, exit
  6. Re-verify (max 2 iterations): pass → publish; still failing → tag for rebuild
```

---

## Error handling

### Delegation failure
If a specialist agent called by the orchestrator fails (API error, timeout, returns error status):
- Log the failure
- Skip the fix for this iteration
- On re-verify, if the issue is still present after 2 iterations, tag `needs_rebuild` with the remaining issue as a reason

### Scorer data gaps
If GSC/GA4/Shopify data is missing for a post (e.g., newly published, not yet indexed):
- Skip performance signals, score on structural signals only
- Default tier: Enhance (cautious middle ground)
- Retry scoring next run

### Orchestrator recursion
The orchestrator passes `--in-pipeline` to itself when called from within the legacy-rebuilder, to prevent:
- The rebuilder's internal editor step re-tagging the post mid-flight
- Infinite loops where a rebuild produces a post that fails the orchestrator's re-verify

### Rebuild tag not clearing
On successful rebuild + publish, the rebuilder explicitly deletes `needs_rebuild` from meta.json. If the rebuild fails, the tag remains, and next week's scheduler run retries.

---

## Testing

### Unit-level
- Post-analyst: given a known post slug, produces expected analysis JSON shape
- Post-health-scorer: given mock signal data, assigns expected tier
- Editor orchestrator delegation: given a simulated broken-link issue, calls link-repair with correct arguments
- Meta-optimizer refresh-stale-years: given a post with "2025" in title_tag, produces correct updated title

### Integration-level
- End-to-end Protect tier: pick a known top-performer, run the flow, verify only structural fixes applied (no body changes)
- End-to-end Enhance tier: pick a known page-2 ranker with structural gaps, run the flow, verify targeted refresh + orchestrator fixes
- End-to-end Rebuild tier: pick a known flop, run the flow, verify full pipeline executes

### Backlog clearance test
Before declaring the design successful:
- Run meta-optimizer `--refresh-stale-years` batch mode → verify all 20 hard-blocked posts clear
- Re-run editor orchestrator on the 78 legacy posts → verify tiers distribute roughly as expected (not 78 Rebuilds)

---

## Implementation order

1. **meta-optimizer `--refresh-stale-years`** — unblocks 20 posts immediately, smallest scope, highest leverage. Ship first.
2. **Editor orchestrator — delegation layer** — wire the existing fix agents into the editor's check/delegate/re-verify loop. Includes removing the slug-year check.
3. **post-analyst** — new agent, pure analysis, no mutations
4. **post-health-scorer** — evolve legacy-triage with new inputs and tier rules
5. **link-repair alternate-source mode** — small capability addition
6. **Writer target word count** — brief includes word count range
7. **image-generator `--evaluate-existing`** — minor mode addition

Each stage produces working software that can be deployed independently. The orchestrator layer (stage 2) makes each subsequent stage immediately useful as it lands.

---

## Out of scope

- Measurement/dashboard framework (separate project; once the pipeline stabilizes, data will reveal which agents need deeper audit)
- Productization / multi-tenant architecture (separate project)
- Auditing every agent's internal LLM prompts line-by-line (this design is orchestration; prompt tuning is a follow-up)
- Refactoring the dashboard (separate ongoing project per memory)
