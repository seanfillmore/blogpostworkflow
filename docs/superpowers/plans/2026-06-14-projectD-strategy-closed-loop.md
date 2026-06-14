# Project D — Strategy & Closed-Loop

> TDD, subagent-driven. Branch: feature/strategy-closed-loop.

**Goal:** Stop cluster cannibalization at planning time, close the loop from post performance back into topic weighting, and make clusters pillar-aware.

**Design (made) — three bounded, testable pieces:**
1. **Semantic cannibalization guard** — pure `lib/cannibalization-guard.js` `findSemanticDuplicate(keyword, existing, {threshold})` (token Jaccard / containment) → the near-duplicate existing keyword or null. content-strategist + content-researcher skip creating a brief whose keyword is a near-duplicate of an existing post/brief (today dedup is exact-match only, so "sls free toothpaste" vs "toothpaste without sls" both get written and compete).
2. **Perf → strategy weighting** — pure `lib/cluster-performance.js` `clusterPenalties(entries, cfg)` where entries=`[{cluster, bucket}]` from legacy-triage (winner/rising/flop/broken) → `{cluster: {flopRate, penalty}}`. content-strategist subtracts the penalty from a cluster's weight, so clusters that keep producing flops get deprioritized automatically (closes the loop the review flagged: perf reports were never read by the strategist).
3. **Pillar/spoke awareness** — pure `lib/cluster-architecture.js` `identifyPillar(posts)` → the cluster's pillar slug (highest impressions, tie-break best position, then shortest keyword). content-strategist annotates each cluster's pillar in its output; internal-linker prefers the cluster pillar as a link target when present.

**Tasks:**
1. The three pure libs + tests.
2. content-strategist: wire cannibalization skip + cluster penalty + pillar annotation.
3. content-researcher: cannibalization skip; internal-linker: prefer pillar target.
