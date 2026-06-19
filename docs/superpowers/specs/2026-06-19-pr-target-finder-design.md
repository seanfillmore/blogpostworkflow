# pr-target-finder — Design

**Date:** 2026-06-19
**Status:** Approved (design), pending implementation plan
**Author:** SEO Claude

## Problem

Real Skin Care is effectively invisible in standalone LLMs. Latest AI-citation tracking: ~4 of 180 responses mention us (~2%), almost all from Google AI Overviews; ChatGPT / Perplexity / Gemini / Claude are ~0% mention. Competitors (Native, Schmidt's, Tom's of Maine) get cited repeatedly for our money prompts.

LLMs cite based on third-party corroboration (roundups, review sites, Reddit) and entity authority — not a brand's own blog. Our on-site GEO is good (answer-first, citations, llms.txt, schema), which is why Google AI Overviews picks us up, but our off-site footprint is ~0. Generic PR has been tried and failed.

**Goal:** turn broad PR into *targeted* PR by identifying the specific third-party pages that drive competitor LLM citations and handing the user a ranked, actionable target list.

## What already exists (data foundations — reuse, don't rebuild)

- `agents/ai-citation-tracker/index.js` runs weekly (Sundays), querying 5 engines (Perplexity, ChatGPT, Gemini, Claude, Google AI Overview) with 36 prompts from `config/ai-citation-prompts.json` (also holds 22 competitors with domains/aliases).
- Per-prompt, per-engine results are stored in `data/reports/ai-citations/YYYY-MM-DD.json` as:
  `responses[engine] = { cited, mentioned, citations: string[] (domains), competitor_mentions: string[], competitor_citations: string[] }`.
  **`citations` is the raw material** — the actual domains each engine pulled from.
- `lib/judgeme.js` — `fetchProductReviews`, `resolveExternalId`, review bodies/ratings per product (for pitch proof).
- Conventions to mirror: pure logic in `lib/<name>.js`; agent in `agents/<name>/index.js`; report to `data/reports/<name>/latest.json` + markdown; surfaced in `agents/daily-summary` digest and a dashboard panel; weekly step in `scheduler.js`. Reference pattern: `agents/seo-opportunity-analyzer` + `lib/seo-opportunities.js`.

## Goals / Non-goals

**Goals**
- Aggregate cited sources across the last N weekly snapshots; rank by leverage.
- Classify each source: **pitch** (editorial/blog/review w/ byline) · **engage** (Reddit/forum) · **exclude** (platform/retailer/competitor-owned/our-own).
- Keep only sources that cite a competitor but **not** us (addressable gap).
- For pitch targets: fetch the page, extract **author name + publication**, attach the money-prompt(s) + competitor(s) it lists + a Judge.me-backed pitch angle.
- Output ranked JSON + markdown, a dashboard panel, and a weekly digest line.

**Non-goals (YAGNI for v1)**
- No email/phone/contact discovery beyond author name + publication.
- No automated outreach/sending.
- No fresh LLM "source discovery" queries — mine existing tracker data only.
- No auto-apply; this is a human-action recommendation list.

## Architecture

Two units:

### `lib/pr-targets.js` (pure, testable — no I/O)
- `aggregateCitations(snapshots, { brand, competitors })` → for every cited domain, tally `{ engines:Set, prompts:Set, competitorsListed:Set, citesUs:bool }`.
- `classifySource(domain, { competitors })` → `'pitch' | 'engage' | 'exclude'` using:
  - **exclude:** static platform/retailer set (`google, youtube, facebook, instagram, tiktok, pinterest, amazon, target, walmart, …`), our own domain, and any competitor domain from config.
  - **engage:** `reddit.com`, `quora.com`, known forums.
  - **pitch:** everything else (verified later by byline presence).
- `scoreTarget(agg, { commercialValueByPrompt })` → `breadth(engines×prompts) × commercialValue × competitorGap`. Returns a number + the components (for display/debug).
- `commercialValueForPrompt(prompt, gscClusterData)` → weight a prompt by the GSC clicks/impressions (or search volume) of its cluster; default 1 when unknown.
- All functions deterministic and unit-tested with fixtures.

### `agents/pr-target-finder/index.js` (orchestration + I/O)
1. Load last N (default 4) `ai-citations/*.json` snapshots + `ai-citation-prompts.json`.
2. `aggregateCitations` → `classifySource` → drop excludes → keep `!citesUs && competitorsListed.size > 0`.
3. Split into `pitch` and `engage` lists.
4. **Enrich pitch targets** (top M by raw breadth, default 20, to bound fetches): fetch the most-cited URL/domain, extract author + publication (`lib/html-byline.js` helper: `<meta name="author">`, JSON-LD `author`/`publisher`, `rel=author`, common byline selectors). If no byline and the page looks like a store/product (no article schema), **reclassify to exclude** (filters brand stores like `palmers.com` that slip past the static list).
5. Attach a Judge.me-backed `angle` per pitch target (most-relevant product by the prompt's category → rating + review count → one-sentence pitch).
6. Score, rank, write `data/reports/pr-targets/latest.json` + `pr-targets-report.md`.
7. `notify(...)` digest summary (deferred).

### Output schema (`latest.json`)
```
{
  generated_at, weeks_covered,
  pitch_targets: [{
    domain, url, title, author, publication,
    engines: string[], prompts: string[], competitors_listed: string[],
    angle, score, score_components
  }],
  community_targets: [{ domain, url, prompts, engines, competitors_listed, note }],
  excluded_count, summary: { pitch:n, engage:n }
}
```

## Dashboard + digest
- Dashboard panel "PR Targets — where to focus" (Optimize tab), pitch list first (author · publication · why · angle), then community bucket. Reuses the existing card/render conventions in `agents/dashboard/public/js/dashboard.js` + `data-loader.js`.
- Digest: one line — "PR Targets: N new pitch targets (top: <publication> for <prompt>)".

## Integration / cadence
- `scheduler.js` weekly (Sunday), **after** `ai-citation-tracker` so it consumes that day's fresh snapshot.
- Idempotent; safe to re-run.

## Testing
- `lib/pr-targets.js`: unit tests with snapshot fixtures — aggregation tally, classify taxonomy (platform/retailer/competitor/reddit/editorial), gap filter (`citesUs` excludes), scoring math + ordering, commercial weighting.
- `lib/html-byline.js`: unit tests over sample HTML (meta author, JSON-LD author/publisher, byline selector, none → null).
- Agent: smoke test that it runs against a fixture snapshot dir and writes a well-formed report (no network in the test — enrichment fetch injected/mocked).

## Risks / edge cases
- **Byline extraction is best-effort** — varies by site. Fallback: publication = domain, author = null; still actionable ("pitch the editor at <publication>"). Never block a target on a missing author.
- **Brand stores slipping past the exclude list** (e.g. `palmers.com`) — caught by the no-byline/store-shape reclassification in enrichment.
- **Fetch cost/politeness** — bound to top M targets, 1 fetch each, short timeout, fail-soft.
- **ChatGPT 429 (separate bug)** — one engine currently blank from quota; the agent still works on the other four. Flag separately; not in scope here.
- **Stale/thin weeks** — N-week window smooths a single sparse run.

## Rollout
1. `lib/pr-targets.js` + `lib/html-byline.js` + tests.
2. `agents/pr-target-finder/index.js`; run once locally against real snapshots; eyeball the ranked list.
3. Dashboard panel + digest line.
4. Wire into `scheduler.js`; deploy.
