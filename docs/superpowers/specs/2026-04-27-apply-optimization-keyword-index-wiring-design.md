# apply-optimization → Keyword-Index Wiring (final)

**Date:** 2026-04-27
**Goal:** Stamp `validation_source` and the matched-keyword from the keyword-index onto each applied change and the brief root, so the change-diff-detector and downstream attribution see validation metadata when it picks up the diff.

## Current state

`agents/apply-optimization/index.js`:
- Loads brief from `data/competitor-intelligence/briefs/<slug>.json`.
- Filters approved `proposed_changes`.
- Calls `applyChange(change, brief)` for each — pushes to Shopify via `updateProduct` / `updateCustomCollection` / `upsertMetafield`.
- Marks each change `status: 'applied'`, sets `brief.status = 'applied'` if all done.
- Writes the brief back. Sends a notify email.

The change-log system (`change-diff-detector`) runs daily and picks up any Shopify diffs since the last snapshot — including the ones written by this agent. Stamping the brief with index metadata BEFORE writeback means change-diff-detector can see the validation tag when it scans the apply path.

## Changes

### 1. Resolve the index entry once per run

Construct the page URL from the brief: `${config.url}/${page_type === 'product' ? 'products' : 'collections'}/${handle}`. (Agent currently doesn't load `config.url` — add a minimal `config/site.json` read.) Fall back to `brief.target_keyword` when URL lookup misses.

```js
const idx = loadIndex(ROOT);
const pageUrl = `${config.url}/${brief.page_type === 'product' ? 'products' : 'collections'}/${brief.handle}`;
const indexEntry = lookupByUrl(idx, pageUrl) || lookupByKeyword(idx, brief.target_keyword);
const validationTag = indexEntry?.validation_source ?? null;
const indexKeyword = indexEntry?.keyword ?? null;
```

### 2. Stamp every applied change + brief root

Inside the apply loop, after `change.status = 'applied'`:

```js
change.validation_source = validationTag;
change.index_keyword = indexKeyword;
change.applied_at = new Date().toISOString();
```

After the loop, before writing the brief:

```js
if (validationTag) brief.validation_source = validationTag;
if (indexKeyword) brief.index_keyword = indexKeyword;
brief.applied_at = brief.applied_at || new Date().toISOString();
```

### 3. Email subject reflects validation

`Optimization applied: ★ ${slug} — ...` when amazon, `✓ ${slug}` when gsc_ga4, plain `${slug}` otherwise.

## Out of scope

- Modifying `change-diff-detector` to read the new fields (separate spec — first ship the producer side).
- Adding a brand-new change-log event from this agent — the existing snapshot-diff flow already covers it.
- Auto-applying suggestions without human approval — stays as-is.

## Tests

`tests/agents/apply-optimization.test.js` — extend with:
- A `applyValidationMetadata(brief, changes, indexEntry)` helper test (extract for testability).

Gate `main()` already exists.

## Risk + rollout

- Risk: lowest of all 9. Pure metadata enrichment; no behavior change for non-matching URLs/keywords.
- Rollout: merge → next applied change carries the validation tag. Change-diff-detector consumes it in a follow-up.
