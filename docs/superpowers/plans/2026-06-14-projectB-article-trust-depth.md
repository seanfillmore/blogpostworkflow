# Project B — Article Trust & Depth

> TDD, subagent-driven. Branch: feature/article-trust-depth.

**Goal:** Ground article depth in real competitor data, and add a deterministic fact-check/citation gate (addresses the 21/30 factual-flag rate + thin-depth guesses).

**Design (made):**
- **Competitor benchmark:** new pure `lib/content-benchmark.js` `computeCompetitorBenchmark(pages)` → `{ count, medianWordCount, avgHeadings, targetWordCount }` from the top competitor pages the researcher already scrapes (each has `word_count` + `headings[]`). content-researcher injects these concrete numbers into the brief prompt and attaches `competitor_benchmark` to the brief; blog-post-writer uses the data-driven word-count/section-depth target instead of a guessed tier.
- **Citation/fact-check gate:** new pure `lib/citation-check.js` `findUncitedClaims(html)` → flags claim-like sentences (statistics/percentages, "studies show / research", strong health/efficacy claims) that have no outbound citation link nearby. editor consumes it: lists findings in the report and contributes to `needs_rebuild`. content-researcher brief + writer prompt gain `citation_guidance` (support stats/health claims with credible outbound links; no unsupported absolutes).

**Tasks:**
1. `lib/content-benchmark.js` + tests; wire into content-researcher (brief prompt numbers + `competitor_benchmark` output field + `citation_guidance`).
2. `lib/citation-check.js` + tests; wire into editor (report section + needs_rebuild).
3. blog-post-writer prompt: consume `competitor_benchmark` (word/section depth) + `citation_guidance`.
