// tests/helpers/cluster-fixtures.js
//
// One place the $0-cluster gate's fixtures live, because eleven test files build
// the same hold context and they drifted apart the last time the basis moved.
//
// THE BASIS THESE FIXTURES ARE ON (2026-08-23). A cluster verdict is made on what
// the category's PRODUCTS SOLD over a 90-day window, from raw order line items,
// all channels — `classifyClusters(..., { productRevenue, windowOrders })`. The
// second, independent source is what the cluster's PAGES EARNED from organic
// search over the same window, keyed on the landing-page URL —
// `buildClusterHold(..., { entryPageRevenue })`. Both come off
// `clusters_product_wide[]` in `data/reports/seo-impact/latest.json`. See
// `lib/cluster-hold.js`'s header for why two fields out of one file is still two
// sources.
//
// WHAT IS REAL AND WHAT IS SYNTHETIC, stated once so no test has to guess:
//
//   · `PRODUCTION_CLUSTER_ROWS`, `SOLD_90D` and `PAGES_EARNED_90D` are MEASURED,
//     pulled READ-ONLY from production on 2026-08-23. On that data NOTHING is a
//     dud and nothing is held — every category RSC sells, sells.
//   · Anything built with `heldScenario()` is SYNTHETIC. It exists so the
//     mechanism (partitioning, the digest lines, the override flag, the
//     before-the-cap ordering) stays under test now that production has no held
//     cluster left to exercise it with. A fixture is not a verdict.

import { classifyClusters } from '../../lib/cluster-revenue.js';
import { buildClusterHold } from '../../lib/cluster-hold.js';

/** The report's own window, verbatim from the 2026-08-23 production report. */
export const REPORT_WINDOW = { start: '2026-07-25', end: '2026-08-21' };

/** The 90-day window the gate judges over, ending the same day. */
export const JUDGING_WINDOW = { start: '2026-05-24', end: '2026-08-21' };

/** All-channel Shopify orders inside that judging window. The gate's denominator. */
export const WIDE_ORDERS = 50;

/**
 * `clusters[]` verbatim from `data/reports/seo-impact/latest.json`, generated
 * 2026-08-23T15:58:15Z on root@137.184.119.230. Already folded by the PR #624
 * taxonomy fix — `hand soap` and `body lotion` no longer exist as separate rows.
 * `revenue` / `entry_page_organic_revenue` here are the 28-day ENTRY-PAGE figure
 * and are not what the verdict is made on.
 */
export const PRODUCTION_CLUSTER_ROWS = [
  { cluster: 'lotion', revenue: 313.49, revenuePrev: 31.19, clicks: 106, pages: 39, entry_page_organic_revenue: 313.49, revenueDelta: 282.3 },
  { cluster: 'soap', revenue: 62.4, revenuePrev: 0, clicks: 227, pages: 28, entry_page_organic_revenue: 62.4, revenueDelta: 62.4 },
  { cluster: 'lip balm', revenue: 48, revenuePrev: 0, clicks: 6, pages: 6, entry_page_organic_revenue: 48, revenueDelta: 48 },
  { cluster: 'deodorant', revenue: 38.25, revenuePrev: 0, clicks: 124, pages: 24, entry_page_organic_revenue: 38.25, revenueDelta: 38.25 },
  { cluster: 'toothpaste', revenue: 0, revenuePrev: 18.99, clicks: 640, pages: 24, entry_page_organic_revenue: 0, revenueDelta: -18.99 },
  { cluster: 'coconut oil', revenue: 0, revenuePrev: 0, clicks: 11, pages: 7, entry_page_organic_revenue: 0, revenueDelta: 0 },
];

/**
 * SOURCE A — what each category's products SOLD over 2026-05-24 → 2026-08-21,
 * all channels, from 54 raw Shopify orders pulled read-only on 2026-08-23 and
 * rolled up through `lib/product-cluster-revenue.js` with bundles expanded.
 */
export const SOLD_90D = {
  lotion: 1757.1,
  soap: 324.85,
  deodorant: 165,
  'lip balm': 117,
  toothpaste: 71.5,
};

/**
 * SOURCE B — what each cluster's PAGES earned from organic search over the same
 * window, from the same order pull, keyed on the landing-page URL. $388.43 more
 * landed on `/`, a `/cart/...` path or a subscription order with no landing page
 * at all, which is the residual and belongs to no cluster.
 */
export const PAGES_EARNED_90D = {
  lotion: 666.73,
  soap: 110.49,
  deodorant: 98.23,
  'lip balm': 48,
  toothpaste: 18.99,
};

/** The residual that goes with `PAGES_EARNED_90D`. */
export const WIDE_ENTRY_PAGE_RESIDUAL = 388.43;

/**
 * The `clusters_product_wide[]` rows a report carries, unioned across both
 * sources exactly as `withWideEntryPageRevenue` builds them.
 */
export function wideRows({ sold = SOLD_90D, earned = PAGES_EARNED_90D } = {}) {
  const names = [...new Set([...Object.keys(sold || {}), ...Object.keys(earned || {})])];
  return names.map((cluster) => ({
    cluster,
    product_organic_revenue: 0,
    product_organic_orders: 0,
    product_revenue_all_channels: Number(sold?.[cluster]) || 0,
    product_orders_all_channels: 0,
    organic_share: null,
    entry_page_organic_revenue: Number(earned?.[cluster]) || 0,
  }));
}

/**
 * A whole `data/reports/seo-impact/latest.json` in the shape `loadClusterHold`
 * reads.
 *
 * `wide: null` produces a REAL pre-migration report — one written before
 * `clusters_product_wide` existed — which carries no `cluster_product_meta`
 * block AT ALL, not an empty array beside a live order count. Modelling it any
 * other way would conflate two independent fail-open guards (no product reading
 * vs no order count) and let a test pass on whichever fired.
 *
 * `orders: null` is the separate, MID-migration shape: the array is there, so
 * the product reading exists, but the denominator does not.
 */
export function impactReport({
  clusters = PRODUCTION_CLUSTER_ROWS, sold = SOLD_90D, earned = PAGES_EARNED_90D,
  orders = WIDE_ORDERS, generated_at = '2026-08-23T15:58:15.208Z',
  window = REPORT_WINDOW, judgingWindow = JUDGING_WINDOW, wide = undefined,
} = {}) {
  const report = {
    generated_at,
    window,
    totals: { organic_revenue: 540.08, organic_conversions: 8, organic_sessions: 984, shopify_orders_all_channels: 18 },
    clusters,
  };
  if (wide === null) return report;   // pre-migration: neither the array nor the meta
  report.clusters_product_wide = wide || wideRows({ sold, earned });
  report.cluster_product_meta = { wide_window: judgingWindow, wide_orders_all_channels: orders };
  return report;
}

/**
 * The hold context, built the way production builds it. Everything a test wants
 * to vary is a named option; nothing is positional.
 */
export function holdFor({
  clusters = PRODUCTION_CLUSTER_ROWS, sold = SOLD_90D, earned = PAGES_EARNED_90D,
  orders = WIDE_ORDERS, generatedAt = '2026-08-23T15:58:15.208Z',
  judgingWindow = JUDGING_WINDOW, ...rest
} = {}) {
  return buildClusterHold(
    classifyClusters(clusters, { productRevenue: sold, windowOrders: orders }),
    { entryPageRevenue: earned, judgingWindow, windowOrders: orders, generatedAt, ...rest },
  );
}

/**
 * A SYNTHETIC scenario in which `cluster` is genuinely dead on BOTH sources:
 * its products sold $0.00 and its pages earned $0.00 over the judging window,
 * behind enough clicks and pages to count as a fair shot.
 *
 * Production currently has no such cluster — `toothpaste` was the last one and
 * it sells $71.50/90d — so without this the whole held-item machinery would go
 * untested. `toothpaste` is the default only because every gated agent's own
 * fixtures use toothpaste slugs; it is NOT what the live report says about it.
 */
export function heldScenario(cluster = 'toothpaste', { clicks = 640, pages = 24, extra = [] } = {}) {
  const sold = { ...SOLD_90D };
  const earned = { ...PAGES_EARNED_90D };
  delete sold[cluster];
  delete earned[cluster];
  return {
    clusters: [
      { cluster, revenue: 0, clicks, pages },
      { cluster: 'lotion', revenue: 313.49, clicks: 106, pages: 39 },
      ...extra,
    ],
    sold,
    earned,
  };
}

/** `heldScenario` already built into a hold context. */
export function heldHold(cluster = 'toothpaste', opts = {}) {
  const { extra, generatedAt, ...scenarioOpts } = opts;
  return holdFor({ ...heldScenario(cluster, { ...scenarioOpts, extra }), generatedAt });
}

/**
 * A SYNTHETIC scenario in which the two sources DISAGREE about `cluster`: source
 * A reads $0 (a broken product-title join, say) while its pages plainly earn.
 *
 * This is the 2026-08-19 `soap` incident reproduced on the new basis, and it is
 * the case the two-source rule exists for: soap's pages really did earn $110.49
 * over the judging window, so a defect that zeroed its product revenue would be
 * caught and reported rather than condemning a $324.85 category.
 */
export function disagreementScenario(cluster = 'soap', { clicks = 227, pages = 28 } = {}) {
  const sold = { ...SOLD_90D, [cluster]: 0 };
  return {
    clusters: [
      { cluster, revenue: 0, clicks, pages },
      { cluster: 'lotion', revenue: 313.49, clicks: 106, pages: 39 },
    ],
    sold,
    earned: PAGES_EARNED_90D,
  };
}

/** `disagreementScenario` already built into a hold context. */
export function disagreementHold(cluster = 'soap', opts = {}) {
  const { generatedAt, ...scenarioOpts } = opts;
  return holdFor({ ...disagreementScenario(cluster, scenarioOpts), generatedAt });
}
