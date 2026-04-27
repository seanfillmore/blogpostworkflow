# content-strategist → Keyword-Index Wiring

**Date:** 2026-04-27
**Goal:** Surface Amazon-validated index entries that have no existing content as the strongest "write next" signal in the strategist's calendar prompt, and stamp `validation_source` on each extracted calendar item so downstream tools can prioritize.

## Current state

`agents/content-strategist/index.js`:
- Loads content-gap report, GSC opportunity report, competitor activity, rank report, cluster performance.
- Builds a giant Claude prompt with all those signals + the existing inventory list.
- Claude returns a calendar markdown (Publishing Schedule + Topical Clusters + Brief Queue).
- Extracts schedule items (regex over markdown table) and writes `data/calendar/calendar.json`.
- With `--generate-briefs`, calls content-researcher per keyword.

After agents #1-#4, `lib/keyword-index/consumer.js` exposes the lookups; the calendar inbox already has `validation_source` items pushed by gsc-opportunity.

## Changes

### 1. New consumer helper: `unmappedIndexEntries`

```js
// Returns index entries whose slug AND normalized keyword are NOT in the
// inventory Set, sorted by:
//   1. validation_source === 'amazon' first (sub-sorted by amazon.purchases desc)
//   2. then validation_source === 'gsc_ga4' (sub-sorted by ga4.conversions desc)
// Cap with `limit`.
export function unmappedIndexEntries(index, inventory, { limit = 20 } = {})
```

`inventory` is the same `Set<string>` produced by the agent's `loadInventory()`.

### 2. New prompt section

Add a section to the calendar prompt right above CONTENT GAP REPORT:

```
## Validated Demand from Keyword Index
The following queries are validated by Amazon (commercial demand) or GSC+GA4
(this site already converts on them) AND we currently have no content for
them. Treat these as **highest-priority new-topic candidates** — they should
land in the next 2 weeks of the schedule.

Amazon-validated:
- "natural deodorant for kids" — 280 amazon purchases (12.4% conv share)
- ...

GSC+GA4-validated:
- "best soap for tattoos" — 18 GA4 conversions / $410 revenue
- ...
```

When the index is missing or `unmappedIndexEntries` returns empty, the section is omitted entirely.

### 3. Stamp calendar items

`extractScheduleItems` extracts items from Claude's markdown table. After extraction, pass each through a tagger that looks up `slugify(keyword)` in the index → adds `validation_source: 'amazon' | 'gsc_ga4' | null` to the item. (Same pattern as agent #1's row annotation.)

This lets the calendar JSON be filtered by validation source on the dashboard, in `daily-summary`, and in the calendar-runner.

### 4. Out of scope

- Replacing the entire gap-report-as-source pipeline. The index is one new signal alongside the gap report — not a replacement (yet). When the index has cluster data v2 + DataForSEO market enrichment, a future spec can shift the strategist toward index-as-primary.
- Generating briefs directly from the index without going through Claude.
- Re-ranking the existing `briefQueue` after extraction — Claude already orders within the markdown.

### 5. Risk + rollout

- Risk: low. Pure prompt enrichment + post-extraction tagging. The agent still produces the same outputs; new fields are additive.
- Rollout: merge → next strategist run picks up the new prompt section.

## Tests

`tests/lib/keyword-index/consumer.test.js` — extend with `unmappedIndexEntries` tests:
- Returns [] when index null.
- Excludes entries whose slug is in inventory.
- Excludes entries whose normalized keyword slugifies to something in inventory.
- Sorts amazon first, then gsc_ga4, with proper sub-sort keys.
- Respects limit.

`tests/agents/content-strategist.test.js` — extend with a `tagCalendarItems(items, index)` test (extract this small helper into the agent for testability).

`main()` gated behind `import.meta.url`.
