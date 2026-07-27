/**
 * Measured shipping label costs, from Shopify's `shipping_labels` ShopifyQL dataset.
 *
 * Every bundle/offer profitability number in this project used to rest on a
 * hand-fitted shipping curve. That curve was wrong in *shape*, not just
 * calibration: real labels show cost is essentially flat from 0.4 lb to ~3.1 lb
 * (zone and package dominate) and only tracks weight once packages get large.
 * The 14x10x4 box used for 32oz refills averages $21.31 against $6.66 for a
 * bubble envelope — 3.2x, driven by dimensional weight, not poundage.
 *
 * So freight is modelled by PACKAGE, not by weight. This module pulls the real
 * per-package averages so callers never have to guess again.
 *
 * Requires the `read_reports` access scope (shopifyqlQuery). Shopify's Admin API
 * does not expose label cost anywhere else — the `ShippingLabel` object carries
 * tracking and print status but no price.
 *
 * Docs: https://shopify.dev/docs/api/shopifyql/latest/schemas/orders/shipping_labels
 */

import { shopifyGraphQL } from './shopify.js';

/** Fallback averages (365d, 232 labels) used when the API is unavailable. */
export const FALLBACK_PACKAGE_COSTS = {
  'Bubble Envelope': 6.66,
  '10x5x5': 7.83,
  'Sample box': 6.91,
  '4x4x8': 7.04,
  'Custom box': 7.08,
  '4x4x4': 6.58,
  '8x8x4': 7.94,
  '14x10x4': 21.31,
};
export const FALLBACK_AVERAGE = 7.33;

const QUERY = `query LabelCosts($q: String!) {
  shopifyqlQuery(query: $q) {
    parseErrors
    tableData { columns { name } rows }
  }
}`;

/** Run a raw ShopifyQL query against the shipping_labels dataset. */
export async function runShopifyQL(q) {
  const data = await shopifyGraphQL(QUERY, { q });
  const res = data?.shopifyqlQuery;
  if (res?.parseErrors?.length) throw new Error(`ShopifyQL parse error: ${res.parseErrors.join('; ')}`);
  return res?.tableData?.rows ?? [];
}

// ── pure helpers (unit-tested without network) ───────────────────────────────

/**
 * Fold ShopifyQL rows into { packageName: averageCost }.
 * Rows arrive with string-typed numerics, so coerce explicitly.
 */
export function toPackageCostMap(rows) {
  const out = {};
  for (const r of rows) {
    const name = r.package_name;
    const avg = Number(r.average_shipping_label_cost);
    if (!name || !Number.isFinite(avg)) continue;
    out[name] = Math.round(avg * 100) / 100;
  }
  return out;
}

/** Weighted mean label cost across rows (weights by label count, not row count). */
export function weightedAverage(rows) {
  let cost = 0, labels = 0;
  for (const r of rows) {
    const c = Number(r.shipping_label_costs), n = Number(r.shipping_labels);
    if (!Number.isFinite(c) || !Number.isFinite(n)) continue;
    cost += c; labels += n;
  }
  return labels > 0 ? Math.round((cost / labels) * 100) / 100 : null;
}

/**
 * Choose the package a basket ships in, then price it from measured data.
 *
 * The rules encode what the label history actually shows:
 *   - anything containing a 32oz refill goes in the 14x10x4 (dimensional-weight
 *     penalty — this is why refill bundles lose money)
 *   - 1-2 light units go in a bubble envelope
 *   - up to 8 units in a 10x5x5
 *   - larger baskets need a bigger box
 */
export function estimateShipping({ units, pounds, hasOversizeItem = false }, costs = FALLBACK_PACKAGE_COSTS) {
  const pick = (name, fallback) => costs[name] ?? FALLBACK_PACKAGE_COSTS[name] ?? fallback;
  if (hasOversizeItem) return pick('14x10x4', 21.31);
  if (units <= 2 && pounds < 1) return pick('Bubble Envelope', 6.66);
  if (units <= 8 && pounds < 3.5) return pick('10x5x5', 7.83);
  return pick('8x8x4', 9.00);
}

/** Contribution after COGS, measured freight, packaging, and payment fees. */
export function contribution({ price, cogs, shipping, packaging = 0, feeRate = 0.029, feeFixed = 0.30 }) {
  return Math.round((price - cogs - shipping - packaging - (price * feeRate + feeFixed)) * 100) / 100;
}

// ── live fetchers ────────────────────────────────────────────────────────────

/** Measured average label cost per package name. */
export async function fetchPackageCosts({ sinceDays = 365 } = {}) {
  const rows = await runShopifyQL(
    `FROM shipping_labels SHOW shipping_label_costs, average_shipping_label_cost, shipping_labels ` +
    `GROUP BY package_name SINCE -${sinceDays}d ORDER BY shipping_labels DESC`
  );
  return { costs: toPackageCostMap(rows), average: weightedAverage(rows), rows };
}

/** Measured cost per carrier + service — surfaces expensive service drift. */
export async function fetchCarrierCosts({ sinceDays = 365 } = {}) {
  return runShopifyQL(
    `FROM shipping_labels SHOW shipping_label_costs, average_shipping_label_cost, shipping_labels ` +
    `GROUP BY shipping_carrier, shipping_service SINCE -${sinceDays}d ORDER BY shipping_label_costs DESC`
  );
}
