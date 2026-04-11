# Shared Keyword Intelligence Index

**Date:** 2026-04-11
**Goal:** Eliminate keyword data silos by building a unified index from all Ahrefs uploads, generated briefs, and the topical map — making cluster-wide keyword intelligence available to every agent. The researcher uses the index to build briefs from existing data and only requests uploads for niche-specific gaps.

---

## The Module: `lib/keyword-index.js`

### Core API

```javascript
import { loadKeywordIndex } from '../lib/keyword-index.js';

const index = loadKeywordIndex();

// Per-keyword data (merged from all sources)
const kw = index.keywords["natural-bar-soap"];

// Cluster-wide aggregation
const cluster = index.clusters["soap"];
cluster.all_matching_terms;    // deduplicated from every keyword in cluster
cluster.common_competitors;    // SERP domains seen across multiple keywords
cluster.all_semantic_keywords; // from all briefs in cluster

// Gap analysis for a specific keyword
import { analyzeGaps } from '../lib/keyword-index.js';
const gaps = analyzeGaps("best-soap-for-tattoos", index);
// { has_cluster_data: true, cluster_terms: 182, niche_terms: 0,
//   cluster_serp: true, niche_serp: false,
//   missing: ["tattoo-specific matching terms", "tattoo aftercare SERP"],
//   sufficient: false, needs_upload: true }
```

### Data Sources

1. **All `data/ahrefs/*/` directories** — SERP CSVs, matching terms CSVs, volume history
2. **All `data/briefs/*.json`** — semantic keywords, outline keywords, SERP overview
3. **`data/topical-map.json`** — cluster membership (maps URLs to cluster tags)
4. **Latest `data/snapshots/gsc/*.json`** — per-page performance

### Index Structure

```json
{
  "keywords": {
    "natural-bar-soap": {
      "keyword": "natural bar soap",
      "volume": 1200,
      "kd": 5,
      "traffic_potential": 800,
      "cluster": "soap",
      "sources": ["ahrefs", "brief"],
      "matching_terms": [
        { "keyword": "best natural soap", "volume": 900, "kd": 3 }
      ],
      "serp": [
        { "position": 1, "url": "...", "title": "...", "domain_rating": 85 }
      ],
      "semantic_keywords": ["handmade soap", "cold process"],
      "gsc": { "impressions": 500, "position": 22, "ctr": 0.01 }
    }
  },
  "clusters": {
    "soap": {
      "keywords": ["natural-bar-soap", "best-soap-for-tattoos", "castile-soap"],
      "all_matching_terms": [],
      "common_competitors": [
        { "domain": "drbronner.com", "appearances": 4, "avg_position": 3 }
      ],
      "all_semantic_keywords": [],
      "total_ahrefs_keywords": 3,
      "total_briefs": 5
    }
  },
  "meta": {
    "built_at": "ISO timestamp",
    "keyword_count": 50,
    "cluster_count": 13
  }
}
```

### Cluster Assignment

For each keyword, determine its cluster by:
1. Check if keyword slug matches any article URL in `topical-map.json` → use that cluster tag
2. Check if keyword contains a known product category: soap, toothpaste, lotion, deodorant, lip balm, coconut oil, shampoo, conditioner, sunscreen
3. Fall back to "unclustered"

### Index Lifecycle

- Built lazily on first `loadKeywordIndex()` call
- Cached in memory for the process lifetime
- Written to `data/keyword-index.json` for cross-process sharing
- Stale after 24 hours (file mtime check) — auto-rebuilds
- Scheduler rebuilds daily as first step
- Force rebuild: `node lib/keyword-index.js --rebuild`

---

## Gap Analysis: `analyzeGaps(keywordSlug, index)`

Determines what data exists from the cluster vs what's missing for a specific keyword's unique angle.

### Logic

1. Find the keyword's cluster
2. Count cluster-wide matching terms and SERP results
3. Extract "niche terms" — words in the target keyword that are unique to this keyword and not common across the cluster (e.g., "tattoo" in a soap cluster)
4. Check if any matching terms or SERP results contain the niche terms
5. Classify:

```javascript
{
  has_cluster_data: true,      // cluster has any data at all
  cluster_terms: 182,          // total matching terms from cluster
  niche_terms: 0,              // matching terms containing niche words
  niche_words: ["tattoo"],     // the unique angle words
  cluster_serp: true,          // cluster has SERP data
  niche_serp: false,           // SERP data includes niche competitors
  has_own_ahrefs: false,       // this keyword has its own Ahrefs upload
  sufficient: false,           // enough to write a quality brief?
  needs_upload: true,          // should appear in data-needed card?
  missing: [                   // specific gaps to fill
    "tattoo-specific matching terms",
    "tattoo aftercare SERP competitors"
  ]
}
```

### Sufficiency Rules

A keyword has **sufficient** data when:
- It has its own Ahrefs SERP + matching terms data, OR
- Its cluster has ≥50 matching terms AND ≥5 SERP results AND the keyword's niche words appear in ≥10 matching terms

A keyword **needs upload** when:
- Not sufficient AND niche words have <10 matching terms from the cluster
- The upload request shows what's specifically missing, not a blanket "upload everything"

---

## Content Researcher Changes

### Before briefing a keyword:

1. Load the keyword index
2. Run gap analysis
3. If `sufficient`:
   - Build the brief using cluster data merged with any keyword-specific data
   - Matching terms = keyword's own + cluster's (deduplicated, sorted by volume)
   - SERP = keyword's own if available, else cluster's
   - Semantic keywords = from sibling briefs in the cluster
   - Note data sources in the brief: `"data_sources": { "cluster": "soap (4 keywords)", "own_ahrefs": false, "gaps": [] }`
4. If `needs_upload`:
   - Don't block — still generate a brief using available cluster data
   - Include `"data_sources": { "gaps": ["tattoo-specific matching terms"] }` in the brief
   - The brief quality is lower but usable; the gap is noted for future improvement
5. If no cluster data at all:
   - Show in data-needed card as today (full upload needed)

### Brief enrichment

When building a brief, the researcher injects cluster context:

```
CLUSTER KEYWORD INTELLIGENCE (from sibling research in the "{cluster}" cluster):
- {N} matching terms available from {M} researched keywords
- Top competitors in this space: {domains with appearances}
- Semantic keywords covered by sibling posts: {list}
- GAP: No data on {niche_words} specifically — brief may need supplementation
```

---

## Dashboard Changes

### Data-needed card

Replace the current binary "has data / needs data" with gap-aware display:

```
✓ soap cluster (182 terms, 4 SERPs)  ✗ tattoo-specific terms
best soap for tattoos                May 11, 2026    ↑ Upload

✓ Full data
coconut oil deodorant               Apr 23, 2026    ✓ Ready
```

Keywords with sufficient cluster data disappear from the card entirely. Keywords that need niche data show what's missing specifically. Keywords with no cluster data show the standard upload prompt.

### Data-needed count

The badge count drops as cluster data covers more keywords. Uploading data for one keyword in a cluster may satisfy several sibling keywords.

---

## Agent Integration

Each agent that consumes keyword data gets a small change to load from the index:

| Agent | Change |
|---|---|
| **content-researcher** | Uses cluster matching terms + SERP + semantic keywords when briefing. Gap analysis gates uploads. |
| **blog-post-writer** | Receives cluster semantic keywords via enriched brief (no direct index call needed — brief already contains the data) |
| **content-refresher** | Loads index to get cluster keyword context for the post being refreshed. Adds "CLUSTER KEYWORDS" section to the refresh prompt. |
| **editor** | Loads index to check keyword coverage — flags if a post misses high-volume cluster terms. |
| **collection-content-optimizer** | Loads index for matching terms relevant to the collection's cluster. |
| **product-optimizer** | Loads index for cluster keyword context when rewriting product descriptions. |
| **meta-optimizer** | Loads index to pick the highest-value keyword variant for title rewrites. |
| **content-strategist** | Loads index to see cluster data coverage — prioritizes clusters with strong data. |

### Integration pattern (same for all agents)

```javascript
import { loadKeywordIndex } from '../../lib/keyword-index.js';

// In the agent's main flow, when it needs keyword context:
const index = loadKeywordIndex();
const cluster = index.clusters[clusterName];
if (cluster) {
  // Use cluster.all_matching_terms, cluster.all_semantic_keywords, etc.
}
```

No agent needs to parse Ahrefs CSVs or scan brief directories. The index is the single source of truth.

---

## Scheduler Integration

Add as the very first step (before review-monitor), since other agents depend on it:

```javascript
// Step -1: rebuild keyword index
runStep('keyword-index', `"${NODE}" lib/keyword-index.js --rebuild`);
```

---

## Files

| Action | File | Responsibility |
|---|---|---|
| Create | `lib/keyword-index.js` | Build, cache, and query the unified keyword index |
| Create | `tests/lib/keyword-index.test.js` | Tests for index building, cluster assignment, gap analysis |
| Modify | `agents/content-researcher/index.js` | Use index for cluster data, gap analysis gates uploads |
| Modify | `agents/content-refresher/index.js` | Load cluster keywords for refresh context |
| Modify | `agents/editor/index.js` | Check keyword coverage against cluster terms |
| Modify | `agents/collection-content-optimizer/index.js` | Use cluster matching terms |
| Modify | `agents/product-optimizer/index.js` | Use cluster keyword context |
| Modify | `agents/meta-optimizer/index.js` | Use index for best keyword variant |
| Modify | `agents/content-strategist/index.js` | Use index for cluster coverage analysis |
| Modify | `agents/dashboard/lib/data-parsers.js` | Replace `checkAhrefsData` with gap-aware check |
| Modify | `agents/dashboard/public/js/dashboard.js` | Gap-aware data-needed card |
| Modify | `scheduler.js` | Add index rebuild step |
| Modify | `docs/signal-manifest.md` | Add keyword-index signal |

---

## What's NOT in scope

- Live Ahrefs API calls (MCP is documentation only, not live data)
- Automated keyword discovery (the index aggregates existing data, doesn't find new keywords)
- Cross-site keyword intelligence (single site only)
- Keyword cannibalization detection (handled by cannibalization-resolver separately)

---

## Success metrics

- Data-needed card shows fewer items (cluster data satisfies sibling keywords)
- Uploading data for one keyword in a cluster reduces the upload count for siblings
- Briefs include richer matching terms and competitor context from cluster data
- Content-refresher and editor have keyword context they didn't have before
