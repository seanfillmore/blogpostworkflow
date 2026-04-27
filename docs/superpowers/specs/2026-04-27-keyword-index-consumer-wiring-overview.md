# Keyword-Index Consumer Wiring — Overview

**Date:** 2026-04-27
**Goal:** Decide the order and shape of how the 9 candidate consumer agents read from `data/keyword-index.json`. Each line item below becomes its own brainstorm → spec → plan → PR cycle.

## Index schema reference (current)

`data/keyword-index.json` produced by `agents/keyword-index-builder/`. Per-entry shape (post-merge):

```js
keywords[slug] = {
  keyword, slug, cluster,                          // 'unclustered' until v2 clustering
  validation_source: 'amazon' | 'gsc_ga4',
  amazon: { query, clicks, purchases, conversion_share, ... } | null,
  gsc:    { top_page, position, ctr, impressions, clicks, ... } | null,
  ga4:    { sessions, conversions, revenue, ... } | null,
  market: null,                                    // null until DataForSEO enrich
}
```

Sibling: `data/category-competitors.json` (cluster-level competitor roll-up).

**Cluster-mate keywords:** derive by filtering `keywords` for entries with the same `cluster` value. The new builder does not produce a top-level `matching_terms` field (that was the old Ahrefs-anchored index); cluster membership is the substitute. Per-keyword variations from DataForSEO will land in `market` once enrichment is wired.

## Sequencing rationale

Read-only consumers first (lowest risk, fastest to validate the integration pattern). Then consumers that act on existing pages with measurable 28-day outcomes via change-log. Then net-new-content consumers (slowest payoff but biggest lever). Money-touching agent (ads) goes after the pattern is proven. Apply-optimization is orthogonal and goes last.

## The 9 consumers

### 1. gsc-opportunity → read-only daily report
- **Current:** Daily MD report of low-CTR, page-2, unmapped queries. Already has a local `loadKeywordIndex` that builds a brief-slug set.
- **Wire-up:** Replace local set with `data/keyword-index.json`. Cross-reference each opportunity to mark `validation_source` (Amazon-validated = ★ priority).
- **Filter:** Already mature — keep existing impression/CTR/position thresholds. Add: tag entries that match the index.
- **Risk:** Lowest. Read-only, no Shopify writes.

### 2. meta-optimizer → existing-page CTR rewrites
- **Current:** GSC high-impr / low-CTR pages → Claude rewrites titles + metas. Has `--apply` and change-log integration.
- **Wire-up:** When rewriting, look up the page's `top_page` URL in the index → pull `keyword`, cluster-mate keywords, `validation_source`. Pass to Claude as keyword grounding.
- **Filter:** Pages whose URL matches an index entry's `gsc.top_page` AND `gsc.position ≤ 30` AND `gsc.ctr < 0.05`.
- **Risk:** Low. 28-day attribution already wired; auto-revert protects against losing variants.

### 3. collection-content-optimizer → 300-500 word descriptions
- **Current:** Collection pages with high GSC impressions → Claude generates 300-500 word descriptions. Queue-then-apply with human approval.
- **Wire-up:** For each candidate collection, find matching index entries by `cluster` (e.g., collection handle "natural-deodorant" → cluster "deodorant"). Pass cluster-mate keywords + `category-competitors[cluster]` as grounding.
- **Filter:** Collections whose handle/title maps to a cluster with ≥1 Amazon-validated entry.
- **Risk:** Low-medium. Human-approval queue is the safety net.

### 4. product-optimizer → product copy + meta
- **Current:** Products + collections, GSC cross-ref, thin-content flag, Claude rewrites. Multiple modes (`--from-gsc`, `--optimize-titles`, `--pages-from-gsc`).
- **Wire-up:** For each product, find index entries where `amazon.purchases > 0` and the product's keyword matches. Use Amazon `conversion_share` to rank products to optimize first.
- **Filter:** Products tied to ≥1 Amazon-validated entry with `amazon.purchases > 0`.
- **Risk:** Medium. Products are the highest-conversion pages — do after the pattern is proven on collections (#3).

### 5. content-strategist → calendar prioritization
- **Current:** Content-gap report + post inventory → calendar + brief generation.
- **Wire-up:** Replace gap-report-as-source with index-as-source. Prioritize entries where `validation_source === 'amazon'` AND no existing brief/post slug matches. Strategist becomes the "find next post to write" engine.
- **Filter:** Index entries with no matching post slug, sorted by `amazon.purchases` desc, then `gsc.impressions` desc.
- **Risk:** Medium. Net-new content is slow to attribute; calendar already gates publishing pace (per `feedback_phased_publishing`).

### 6. content-researcher → brief pre-fill
- **Current:** Per keyword: live DataForSEO calls (related, SERP, headings) → JSON brief.
- **Wire-up:** Before live DataForSEO calls, check the index for the keyword. If present, pre-fill cluster-mate keywords + `category-competitors[cluster]`. Live calls only fill what's missing.
- **Filter:** Any keyword passed to the agent — index lookup is just an enrichment short-circuit.
- **Risk:** Low. Pure additive — falls back to existing live path if index miss.

### 7. gsc-query-miner → bidirectional
- **Current:** Mines GSC for impression-leaks, near-misses, cannibalization, untapped clusters. Claude writes the analysis.
- **Wire-up (read):** Cross-reference miner candidates against the index. Tag Amazon-validated candidates as ★ priority in the report.
- **Wire-up (write):** "Untapped clusters" output becomes a candidate source for the next index build (input to `agents/keyword-index-builder/`).
- **Filter:** Existing miner thresholds; add validation-source tagging.
- **Risk:** Low (read), medium (write — needs careful integration with the builder's source-of-truth model).

### 8. ads-optimizer → bid + keyword recs
- **Current:** Google Ads + GSC + GA4 + Shopify + Ahrefs → Claude suggestions. Currently uses `getSearchVolume` from DataForSEO.
- **Wire-up:** For each ad-group keyword, look up the index. Suggest:
  - `keyword_add`: high-CVR Amazon-validated index entries not currently bid on.
  - `bid_adjust`: validate proposed bids against `amazon.conversion_share` and `gsc.ctr`.
  - `keyword_pause`: ads keywords with no index entry AND poor CVR (organic doesn't validate the spend).
- **Filter:** Index entries with `amazon.conversion_share > 0`. Use `market.cpc` once DataForSEO enrichment lands.
- **Risk:** Higher — touches paid spend. Do after #1-7 prove the integration pattern.

### 9. apply-optimization → attribution stamp
- **Current:** Reads a brief, applies approved Shopify changes, writes back status.
- **Wire-up:** When applying, look up the affected URL's keyword in the index and stamp `target_keyword` on the change-log event. Improves outcome-attribution accuracy.
- **Filter:** All applied changes — lookup is best-effort.
- **Risk:** Lowest. Pure metadata enrichment; no behavior change for non-matching URLs.

## Out of scope for the consumer-wiring phase

- **Index v2 clustering** (similarity-based replacement for "unclustered") — separate spec, prerequisite for high-quality cluster lookups in #3 and #5.
- **Market enrichment via DataForSEO `getKeywordIdeas`** to fill `market.keyword_difficulty` and `market.cpc` — separate spec, unlocks better filtering in #5 and #8.
- **Per-consumer dashboard surfacing** of index-driven recommendations.

## Per-consumer cycle template

Each line item gets:
1. Brainstorm session → focused spec at `docs/superpowers/specs/YYYY-MM-DD-<agent>-keyword-index-wiring-design.md`
2. Plan at `docs/superpowers/plans/YYYY-MM-DD-<agent>-keyword-index-wiring-plan.md`
3. Branch: `feature/<agent>-keyword-index`
4. TDD on any new lib helpers; structure tests on the agent itself
5. PR with verdict-window callout (so change-log can measure the wired-up version)
