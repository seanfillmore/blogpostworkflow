# ads-optimizer → Keyword-Index Wiring

**Date:** 2026-04-27
**Goal:** Surface Amazon-validated keywords with measurable conversion data to the ads-optimizer's Claude prompt so it can confidently suggest `keyword_add` with strong commercial evidence, and stamp `validation_source` on every suggestion's target keyword.

## Current state

`agents/ads-optimizer/index.js`:
- Loads Google Ads snapshot + GSC + GA4 + Shopify snapshots (28 days each).
- Loads recent suggestion history.
- Massive Claude prompt with snapshot JSON dumps and rules.
- Parses JSON response, enriches `keyword_add` with DataForSEO `getKeywordMetrics`.
- Saves suggestions, sends email if any.

## Changes

### 1. New consumer helper

```js
// Returns up to `limit` index entries with strong Amazon commercial signal:
//   amazon.purchases > 0 AND amazon.conversion_share > 0
// Sorted by (purchases × conversion_share) desc — best ROI commercial keywords first.
export function topAmazonValidatedForAds(index, { limit = 20 } = {})
```

### 2. New prompt section

Build and inject a "Keyword Index — Amazon-Validated Demand" section:

```
### Keyword Index — Amazon-Validated Demand
The following queries have measured Amazon purchases (this brand's product
sold via this exact query) AND a non-zero conversion share. Use these as
the strongest evidence for `keyword_add` suggestions — they have validated
commercial intent that would not be visible from GSC alone.

| Query | Amazon Purchases | Conversion Share |
|-------|------------------|------------------|
| natural deodorant | 280 | 12.4% |
...
```

When the index is missing or yields no rows, the section is omitted.

### 3. Stamp `validation_source` on every suggestion

After parsing Claude's response, look up each suggestion's `target` in the index. If found, add:

```js
suggestion.validation_source = entry.validation_source;
suggestion.amazon_conversion_share = entry.amazon?.conversion_share ?? null;
```

The dashboard can highlight ★ rows. The history loader naturally carries these forward to next-run prior recommendations.

### 4. Out of scope

- `bid_adjust` formula tweaks based on Amazon CPC — DataForSEO `market.cpc` is null until enrichment lands.
- Auto-applying ads suggestions — human-in-the-loop stays.
- Touching `loadEnv`, `parseSuggestionsResponse`, or `buildAlertEmailBody` shapes.

## Tests

`tests/lib/keyword-index/consumer.test.js` — extend with `topAmazonValidatedForAds` cases.

`tests/agents/ads-optimizer.test.js` — extend the existing file with a structure test for `tagSuggestionsWithIndex(suggestions, idx)` (extracted helper).

## Risk + rollout

- Risk: medium — touches paid-spend recommendations. Mitigation: prompt enrichment is additive; humans approve every change.
- Rollout: merge → next 8 AM PT cron run produces validation-tagged suggestions.
