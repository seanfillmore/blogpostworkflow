# Collection Consolidation and the End of Keyword-Driven Collection Creation

**Date:** 2026-07-27
**Status:** Approved in principle; spec pending review
**Decision owner:** Sean

## Problem

The store has **62 live collections for 9 distinct products**. They were generated to chase
keyword rankings. They are not ranking, and they are splitting the signal of the products
they point at.

90 days of Search Console, live store:

| | URLs | Impressions | Clicks | CTR |
|---|---|---|---|---|
| All collections | 71 | 93,785 | 51 | 0.054% |
| All PDPs | — | 22,257 | 8 | 0.036% |

**57 of the 71 collection URLs earned zero clicks**, carrying 46,926 impressions between
them. The lotion category alone runs 29 collection URLs for 2 products: 59,616 impressions,
38 clicks.

The catalog is 19 products, of which 10 carry a `bundle` / `value-set` tag. That leaves
**9 distinct single products**:

`coconut-lotion`, `coconut-moisturizer`, `coconut-soap`, `organic-foaming-hand-soap`,
`foam-soap-refill-32oz`, `coconut-oil-deodorant`, `coconut-oil-toothpaste`,
`coconut-oil-lip-balm`, `cut-and-scrape`.

## The rule

**A collection exists only where a category holds 2 or more distinct products. Single-product
categories are PDP-only. A collection is never created to chase a keyword.**

Multipacks and value-sets are the same product in a different quantity, not a second product.
`coconut-deodorant-4-pack` does not make deodorant a two-SKU category. The `bundle` /
`value-set` product tag is the machine-readable test.

## Category map

| Category | Distinct SKUs | Verdict | Collections today | 90d impr | 90d clicks |
|---|---|---|---|---|---|
| Lotion | 2 | **Collection** | 29 | 59,616 | 38 |
| Hand soap | 2 (dispenser, refill) | **Collection** | 2 | ~2,500 | 0 |
| Toothpaste | 1 | PDP only | 12 | 9,645 | **0** |
| Lip balm | 1 | PDP only | 5 | 6,356 | 1 |
| Bar soap | 1 | PDP only | 4 identified | ~4,000 | 2 |
| Deodorant | 1 | PDP only | 7 | 2,620 | **0** |
| Cut & scrape | 1 | PDP only | 0 | — | — |

Soap totals 10 collection URLs / 7,773 impressions / 3 clicks; the split above between bar and
hand is derived from handle intent and is the one place the implementation plan must confirm
per-URL rather than inherit from this table.

**Survivors — three collections:**

1. **`non-toxic-body-lotion`** — absorbs all 28 other lotion URLs. Holds `coconut-lotion`
   and `coconut-moisturizer`.
2. **`foaming-hand-soap`** — absorbs the hand-soap URLs. Currently holds 1 product;
   `foam-soap-refill-32oz` must be added, which is what makes it a legitimate two-SKU
   category rather than a PDP duplicate.
3. **`all-products`** — the native catch-all, 19 products, left exactly as it is. It earns
   the best CTR on the site (1,008 impressions, 8 clicks, **0.79%** — roughly 15× the site
   average), which is worth noticing: the one page that behaves like a real browse page is
   the one nobody optimised.

Everything else 301s to its category's survivor, or to the category's PDP where the category
is single-product.

### Why `non-toxic-body-lotion` and not the higher-traffic alternatives

`coconut-oil-lotion` has more impressions (8,045 vs 4,668) and `organic-body-lotion` has more
clicks (13 vs 9). `non-toxic-body-lotion` still wins:

- It matches the product's own title — "Non-Toxic Body Lotion Made With Only 6 Clean
  Ingredients" — so the page, the product, and the query agree.
- The surviving collection must now serve *all* lotion intent. `coconut-oil-lotion` is
  scoped to one ingredient and would be a poor destination for "non-toxic body lotion"
  or "fragrance free lotion" traffic.
- "Organic" is a substantiation risk we should not build the category page's identity on.

The 13 clicks on `organic-body-lotion` are not discarded — that URL 301s into the survivor.

## Mechanism

The pattern already proven in the 2026-07-20 toothpaste consolidation:

1. `updateCustomCollection` / `updateSmartCollection` with `{ published: false }`.
2. `createRedirect` from the old path to the canonical target.
3. **Guard: never redirect to an unpublished or missing target.** Verify the target returns
   200 before writing the redirect.
4. Cloudflare caches collection URLs for ~10s, so a post-mutation `curl` can still return the
   old 200. Confirm via the API's `published_at` and the redirect's existence, then re-curl.

Two conditions in the current data need handling beyond a plain redirect:

- **Live collections with zero products** (e.g. `best-coconut-body-lotion`, 279 impressions).
  Empty published collections are the landmine from the June cleanup. They redirect like any
  other source.
- **Draft collections still earning impressions** — `best-non-toxic-lotion` carries 1,851
  impressions and `coconut-scented-body-lotion` 864, both unpublished. Google is still
  serving pages that now 404. These need redirects *more* urgently than the live ones,
  because they are actively bleeding.

Each of the three survivors then gets a prominent above-the-fold link to its primary PDP.
That is what makes this "focus clicks on the PDP" rather than merely tidier collections.

## The operating change

The cleanup is worthless without this. Three changes, or the fleet regenerates the sprawl
within weeks:

1. **`scheduler.js`** — remove `collection-creator --from-opportunities --queue` and
   `collection-creator --publish-approved` from the Sunday block. The agent stays in the
   repo for deliberate manual use; it stops running on a timer.
2. **`lib/seo-opportunities.js`** — `COLLECTION_BOOST = 1.6` currently ranks "build another
   collection" above every other opportunity type, ahead of `PRODUCT_BOOST = 1.5`. Drop it
   below product so the analyzer stops steering here.
3. **`CLAUDE.md`** — the Prime Directive section instructs agents to "prioritize
   creating/optimizing collection and product pages" on the strength of "collections ≈80% of
   ecommerce SEO revenue." That statistic describes stores with hundreds of SKUs, where
   collections are genuine browse pages. With 9 products it does not transfer, and following
   it produced 62 collections. Replace it with the rule above.

## What this does not promise

Consolidation alone will not convert 93,785 impressions into revenue. Site-wide CTR is 0.054%
because these pages rank at positions 25–62, and PDPs are no better at 0.036%. Nothing on page
3+ gets clicked regardless of page type.

The bet is that concentrating 29 lotion URLs into 1 lifts position enough to matter. That is
well-founded and cheap to test, but it is a hypothesis. If the survivor still lands at position
40, the outcome is a cleaner site earning the same $0. The structural case for doing it stands
either way: 62 near-duplicate pages for 9 products is indefensible on its own terms.

## Risk

The exposure is almost entirely in lotion. The three PDP-only categories with the loudest
keyword histories — toothpaste, lip balm, deodorant — together carry **18,621 impressions and
1 click across 24 URLs**. Redirecting them costs nothing measurable.

This corrects an earlier assessment in the conversation that called deodorant the riskiest move
because it is the strongest organic cluster. Deodorant's *collections* earn zero; whatever
strength that cluster has lives in its blog posts and PDP.

## Measurement

Already wired, no new instrumentation:

- `rank-tracker` (DataForSEO) tracks the target queries daily; `rank-alerter` notifies on
  movement.
- `logChangeEvent({ url, slug, category: 'seo', targetQuery })` per survivor gives
  `change-verdict` a 28-day window.
- Caveat carried from the toothpaste work: `change-log captureBaseline` reads GSC daily
  snapshots, which store only top pages, so low-ranking collections get an `impr=0` baseline.
  **The trustworthy signal is rank-tracker on the query, not the change-log window.**

## Out of scope

- Collection-scoped product URLs (`/collections/rose-lotion/products/coconut-moisturizer?variant=…`)
  are duplicating PDPs, but that is a canonical-tag question, not a consolidation one.
- The bundle products (10 of them) have landing pages already and no collection. Creating one
  would be defensible under the rule — bundles are a 10-SKU category — but creating a new
  collection while simultaneously banning collection creation deserves its own decision.
  Deferred, not forgotten.
- Non-lotion, non-soap collections with zero impressions and zero products are swept by the
  same redirect pass but are not individually analysed here.

## Success criteria

1. Live collection count drops from 62 to 3.
2. Every redirected source returns 301 to a target returning 200. No redirect points at an
   unpublished or missing target.
3. No live collection has zero products.
4. No unpublished collection is left 404ing on non-zero impressions.
5. `scheduler.js` no longer invokes `collection-creator` on a timer, and
   `COLLECTION_BOOST < PRODUCT_BOOST`.
6. At 28 days: the lotion survivor's average position on its target queries has improved
   against the rank-tracker baseline. This is the hypothesis under test — a null result is
   an acceptable outcome to learn, not a failure to hide.
