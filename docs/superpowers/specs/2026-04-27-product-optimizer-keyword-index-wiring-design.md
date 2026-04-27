# product-optimizer → Keyword-Index Wiring

**Date:** 2026-04-27
**Goal:** Prefer products tied to Amazon-validated demand when picking the daily product-meta rewrite queue, and ground Claude's rewrites in cluster-mate keywords + Amazon conversion share.

## Scope

Wire-up applies to `--from-gsc` mode (product meta rewrites). The `--optimize-titles` mode shares structure and gets the same treatment.

`--pages-from-gsc` (static pages) and `--expand-faq` are skipped — they don't fit the product/cluster model and have lower daily volume.

## Current state

`agents/product-optimizer/index.js` `--from-gsc` flow:
1. `getProducts()` — all Shopify products.
2. GSC page performance (`getQuickWinPages` + `getTopPages`).
3. `selectProductMetaCandidates` filters: impressions ≥ 100, CTR < 1%, not in queue. Sorts by impressions desc.
4. `rewriteProductMeta(product, topQueries, gscData)` calls Claude.
5. `buildProductMetaQueueItem` writes the queue item.

`--optimize-titles` mirrors this with `rewriteProductTitle` + `selectTitleCandidates`.

## Changes

### 1. Per-product index lookup

For each product candidate, find an index entry by URL (`lookupByUrl(idx, c.url)`) AND by collection-style cluster mapping (handle + title against cluster keywords, ≥2 token hits — same `clusterForCollection` helper from agent #3).

Both signals matter:
- URL match → strongest, the product page is already known to GSC for a validated query.
- Cluster match → weaker but covers products with no GSC top_page yet.

Surface a `productIndexContext` per candidate:
```js
{
  entry: indexEntry | null,                  // direct URL match
  cluster: 'deodorant' | null,
  clusterEntries: [...top 8 cluster mates],
  validationTag: 'amazon' | 'gsc_ga4' | null,
  amazonPurchases: 0..N,
  conversionShare: 0..1 | null,
}
```

### 2. Re-rank candidates

Replace the existing impressions-desc sort with this composite:

```js
candidates.sort((a, b) => {
  const av = a.idx.validationTag === 'amazon' ? 0 : a.idx.cluster ? 1 : 2;
  const bv = b.idx.validationTag === 'amazon' ? 0 : b.idx.cluster ? 1 : 2;
  if (av !== bv) return av - bv;
  if (av === 0) {
    const ap = (b.idx.amazonPurchases ?? 0) - (a.idx.amazonPurchases ?? 0);
    if (ap !== 0) return ap;
  }
  return b.gsc.impressions - a.gsc.impressions;
});
```

Bands: Amazon-validated → cluster-only → no-signal. Within the Amazon band, sort by `amazon.purchases` desc; everywhere else, by impressions desc.

### 3. Prompt grounding

Extend `rewriteProductMeta` and `rewriteProductTitle` with an optional `ground` parameter (same shape as meta-optimizer's). Inject grounding lines after the existing context block:

- `★ Amazon-validated query — verified commercial demand (X.X% conversion share).`
- `Cluster-mate queries this product should also surface for: a, b, c.`

Reuse `buildPromptGrounding` from `agents/meta-optimizer/lib/grounding.js`. Move it up to `lib/keyword-index/consumer.js` as a public helper so it's not import-crossing-agents.

### 4. Queue item stamping

`buildProductMetaQueueItem` and the title-mode equivalent gain:
- `cluster: ground?.cluster ?? null`
- `validation_source: ground?.validationTag ?? null`
- `amazon_conversion_share: ground?.conversionShare ?? null`

Dashboard approval UI can prioritize ★ items in a future change.

## New helper

`lib/keyword-index/consumer.js` gains `buildPromptGrounding` (moved from `agents/meta-optimizer/lib/grounding.js`). The signature stays the same. The original location keeps a thin re-export for backward compatibility:

```js
// agents/meta-optimizer/lib/grounding.js
export { buildPromptGrounding } from '../../../lib/keyword-index/consumer.js';
```

(Then on a future agent's PR, we can delete the re-export and update the import in meta-optimizer/index.js.)

## Tests

**`tests/lib/keyword-index/consumer.test.js`** — extend with `buildPromptGrounding` cases (one round of unit tests; the existing meta-optimizer tests continue to pass through the re-export).

**`tests/agents/product-optimizer.test.js`** — extend with sort-ordering tests for the new band-and-secondary-key sorter (extract as `sortProductCandidates(rows)` into `agents/product-optimizer/lib/sort.js` for testability).

Gate `main()` behind `import.meta.url`.

## Out of scope

- `--pages-from-gsc`, `--expand-faq` — different shape; later spec.
- Re-architecting `selectProductMetaCandidates` / `selectTitleCandidates` to share code — leave as-is.
- DataForSEO competitor enrichment for products — categories share competitors via `category-competitors.json` (already loadable via consumer.js).

## Risk + rollout

- Risk: low. Queue items remain human-approval gated; the change reorders + grounds them.
- Rollout: merge → next 8 AM PT cron pass produces grounded queue items.
