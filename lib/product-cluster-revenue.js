// lib/product-cluster-revenue.js
//
// PRODUCT-LEVEL cluster attribution: what a CATEGORY actually sold.
//
// ────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS
//
// `lib/seo-impact.js`'s `clusterRollup` answers a LANDING-PAGE question: which
// entry page earned the order, bucketed by a word in that page's URL. That is
// the right answer for "which page earns" and it cannot ever answer "what did
// this category sell", because the two are not the same question:
//
//   Measured over the trailing 90 days (50 orders / $2,606.52 all channels):
//   $388.43 of organic revenue — 29% — landed on a page matching NO cluster at
//   all (`/`, `/cart/c/...`, and subscription orders with landingPath null).
//   Over 180 days it is $1,049.29, 44%. A soap bought in a cart that entered on
//   the homepage is credited to the homepage.
//
//   Concretely, over that same 90 days: entry-page credited `soap` $110.49; the
//   soap PRODUCTS sold $324.85. It credited `toothpaste` $18.99; the toothpaste
//   products sold $71.50. It credited the lotion family $666.73; the lotion
//   products sold $1,757.10.
//
// So the cluster question is answered here, from raw order LINE ITEMS, and the
// page question stays where it is. One number per question, at the granularity
// the question is actually asked at.
//
// ────────────────────────────────────────────────────────────────────────────
// WHAT THIS NUMBER RECONCILES TO — AND WHAT IT DOES NOT
//
// It sums to LINE SUBTOTALS: `price × quantity − allocated discounts`, summed
// over the order's line items. That is `subtotal_price`, and it is NOT
// `total_price`: shipping, tax and any other order-level charge live on the
// ORDER, not on any line. Allocating them across categories would be invention
// — a $6 shipping charge is not $6 of soap — so they are excluded and the gap
// is REPORTED as `nonProductRevenue` rather than silently reconciled.
//
// Verified against 131 live orders (200 days, 2026-08-23): line revenue computed
// this way reconciles to `subtotal_price` to the cent on every single order.
//
// `discount_allocations` is the only discount source. Live orders also carry
// `line_item.total_discount`, and 12 lines in that sample had it non-zero — yet
// the reconciliation is exact WITHOUT it, which proves the allocations already
// contain it. Adding both would understate every discounted line.
//
// Refunds are NOT netted, because `total_price` (what the entry-page number is
// built from) does not net them either. Both figures are gross of refunds, so
// they stay comparable; 9 of those 131 orders carried a refund record.
//
// ────────────────────────────────────────────────────────────────────────────
// CHANNEL IS A PROPERTY OF THE ORDER, NOT OF THE PRODUCT
//
// `lib/order-attribution.js` decides an order's channel from its entry page and
// referrer. That decision never depended on the entry page matching a cluster,
// so filtering product revenue to `organic-search` is well defined and does NOT
// re-inherit the attribution problem: a soap sold in a homepage-entered organic
// session IS organic soap revenue here, which is exactly the case entry-page
// attribution loses. Callers ask for the channels they want; both an
// organic-only and an all-channel rollup are cheap from the same rows.
//
// ────────────────────────────────────────────────────────────────────────────
// BUNDLES
//
// A bundle line is one line item that is several categories. Clustering it by
// its TITLE is wrong twice over: four of the ten live bundles ("The 90-Day
// Clean Swap", "Head-to-Toe", "The Clean Swap", "Gift Box") match no cluster at
// all and would fall into the residual this module exists to eliminate, and
// "The 90-Day Coconut Reset" matches `coconut oil` while its contents are
// entirely lotion.
//
// So a bundle line is EXPANDED into its configured components (from
// `config/bundles.json`) and split pro rata by each component's list value
// (`qty × the component's own price in data/brand/product-catalog.json`). List
// value is the same basis Shopify itself uses to allocate an order discount
// across lines, and the split allocates the line's actual, already-discounted
// revenue — nothing is invented and the parts always sum to the whole. When a
// component's price is unknown the split falls back to quantity share, and when
// the bundle is not in the config at all it falls back to title clustering, so
// a config that goes stale degrades rather than disappears.
//
// Everything here is pure except `loadBundleIndex`, which reads the two config
// files. Callers do the rest of the I/O.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clusterForText } from './cluster-revenue.js';

/** The one sentence every report must print next to one of these numbers. */
export const PRODUCT_REVENUE_BASIS =
  'order line items (price × quantity less allocated discounts), summed to line subtotals — '
  + 'shipping and tax are order-level and are excluded';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => { const n = Number.parseFloat(v); return Number.isFinite(n) ? n : 0; };
const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * One line item's revenue: price × quantity, less the discounts allocated to it.
 *
 * A missing `quantity` means one (Shopify always sends it; the default only
 * guards a hand-built record). `total_discount` is deliberately NOT subtracted
 * — see the header: the allocations already contain it.
 */
export function lineRevenue(line) {
  if (!line || typeof line !== 'object') return 0;
  const qty = line.quantity == null ? 1 : num(line.quantity);
  const gross = num(line.price) * qty;
  const allocs = Array.isArray(line.discount_allocations) ? line.discount_allocations : [];
  const discount = allocs.reduce((s, d) => s + num(d?.amount), 0);
  return round2(gross - discount);
}

/**
 * A raw order's line items, reduced to the PII-free record that goes into an
 * attribution row (and therefore into `data/snapshots/`, which is backed up
 * offsite).
 *
 * TITLE AND PRODUCT ID ONLY, per agents/shopify-collector's rule. Never `sku`
 * with a customer reference in it, never `properties` — a gift-note property is
 * free text a buyer typed.
 */
export function orderLines(order) {
  const items = Array.isArray(order?.line_items) ? order.line_items : [];
  return items.map((l) => ({
    title: l?.title ?? null,
    product_id: l?.product_id ?? null,
    revenue: lineRevenue(l),
  }));
}

// ── bundle expansion ──────────────────────────────────────────────────────────

/** Shopify joins a multi-option variant's values with " / ". */
function variantKeyOf(options) {
  return norm(Object.values(options || {}).join(' / '));
}

/**
 * Cluster weights for one configured bundle variant, or null when none of its
 * components maps to a product cluster (in which case title clustering, which
 * at least sometimes works, is left in charge).
 */
function weightsForComponents(components, prices) {
  const byCluster = new Map();
  let total = 0;
  for (const comp of components || []) {
    const cluster = clusterForText(comp?.product);
    if (!cluster) continue;
    const qty = comp?.qty == null ? 1 : num(comp.qty);
    if (qty <= 0) continue;
    // List value when we know the component's price, quantity share otherwise.
    const value = qty * (prices.get(String(comp.product)) ?? 1);
    if (value <= 0) continue;
    byCluster.set(cluster, (byCluster.get(cluster) || 0) + value);
    total += value;
  }
  if (!total) return null;
  return [...byCluster.entries()]
    .map(([cluster, value]) => ({ cluster, weight: value / total }))
    .sort((a, b) => b.weight - a.weight || a.cluster.localeCompare(b.cluster));
}

/** Average a set of per-variant weightings into one fallback weighting. */
function averageWeights(list) {
  const byCluster = new Map();
  const usable = (list || []).filter(Boolean);
  if (!usable.length) return null;
  for (const weights of usable) {
    for (const { cluster, weight } of weights) {
      byCluster.set(cluster, (byCluster.get(cluster) || 0) + weight / usable.length);
    }
  }
  return [...byCluster.entries()]
    .map(([cluster, weight]) => ({ cluster, weight }))
    .sort((a, b) => b.weight - a.weight || a.cluster.localeCompare(b.cluster));
}

/**
 * Build the title → cluster-weights index from `config/bundles.json` and
 * `data/brand/product-catalog.json`.
 *
 * Pure, so the index can be built from fixtures. `catalog` may be null: the
 * split then falls back to quantity share, which is a worse estimate but never
 * a wrong cluster.
 *
 * @returns {Map<string,{byVariant:Map<string,Array>, fallback:Array}>}
 */
export function buildBundleIndex(bundlesConfig, catalog) {
  const prices = new Map();
  const products = catalog?.products;
  if (products && typeof products === 'object') {
    for (const [handle, p] of Object.entries(products)) {
      const price = num(p?.price);
      if (price > 0) prices.set(handle, price);
    }
  }

  const index = new Map();
  for (const b of (bundlesConfig?.bundles || [])) {
    const title = norm(b?.title);
    if (!title) continue;
    const byVariant = new Map();
    const all = [];
    for (const v of (b.variants || [])) {
      const w = weightsForComponents(v?.components, prices);
      if (!w) continue;
      byVariant.set(variantKeyOf(v?.options), w);
      all.push(w);
    }
    const fallback = averageWeights(all);
    if (!fallback) continue;   // nothing usable — leave it to title clustering
    index.set(title, { byVariant, fallback });
  }
  return index;
}

/** Read the two config files and build the index. The only I/O in this module. */
export function loadBundleIndex({ root = process.cwd(), read = defaultRead } = {}) {
  return buildBundleIndex(
    read(join(root, 'config', 'bundles.json')),
    read(join(root, 'data', 'brand', 'product-catalog.json')),
  );
}

function defaultRead(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

/**
 * Split one line into `[{ cluster, revenue }]`.
 *
 * A line that maps to no cluster is returned with `cluster: null` — reported as
 * unclustered by the rollup, never dropped, because a silently shrinking total
 * is the failure mode this whole module is a response to.
 *
 * The last share absorbs the rounding remainder so the parts sum to the line to
 * the cent. Cent-accurate is not fussiness here: these numbers are compared
 * against an average order value to decide whether to stop spending on a
 * category.
 */
export function splitLineToClusters(line, bundleIndex) {
  const revenue = round2(line?.revenue);
  const entry = bundleIndex?.get?.(norm(line?.title));
  const weights = entry
    ? (entry.byVariant.get(norm(line?.variant_title)) || entry.fallback)
    : null;

  if (!weights || !weights.length) {
    return [{ cluster: clusterForText(line?.title), revenue }];
  }
  const out = weights.map((w) => ({ cluster: w.cluster, revenue: round2(revenue * w.weight) }));
  const drift = round2(revenue - out.reduce((s, o) => s + o.revenue, 0));
  if (drift) out[out.length - 1].revenue = round2(out[out.length - 1].revenue + drift);
  return out;
}

// ── the rollup ────────────────────────────────────────────────────────────────

/**
 * Product revenue per cluster over a set of attribution rows.
 *
 * @param {Array<object>} rows  from `attributionRows()`; each must carry `lines`
 * @param {{channels?: string[]|null, bundleIndex?: Map}} opts
 *        `channels` null means every channel. The default matches
 *        `shopifyRevenueByPage`: organic search only.
 * @returns {{byCluster: Record<string,{cluster:string,revenue:number,orders:number}>,
 *            unclustered:number, subtotal:number, orderTotals:number,
 *            nonProductRevenue:number, orders:number, ordersWithoutLines:number,
 *            basis:string}}
 */
export function clusterProductRevenue(rows, { channels = ['organic-search'], bundleIndex = null } = {}) {
  const allow = channels === null ? null : new Set(channels);
  const byCluster = {};
  let unclustered = 0; let subtotal = 0; let orderTotals = 0;
  let orders = 0; let ordersWithoutLines = 0;

  for (const r of rows || []) {
    // The same exclusion every other revenue figure in the fleet uses: no admin
    // previews, no TEST-discount orders, nothing cancelled, nothing at $0.
    if (!r?.countsAsRevenue) continue;
    if (allow && !allow.has(r.channel)) continue;
    orders += 1;
    orderTotals = round2(orderTotals + (Number(r.total) || 0));

    const lines = Array.isArray(r.lines) ? r.lines : [];
    // An order with no captured lines is NOT $0 of product revenue — it is an
    // order we cannot attribute. Counted separately so a snapshot written
    // before line capture can never read as a category selling nothing.
    if (!lines.length) { ordersWithoutLines += 1; continue; }

    const touched = new Set();
    for (const line of lines) {
      for (const part of splitLineToClusters(line, bundleIndex)) {
        subtotal = round2(subtotal + part.revenue);
        if (!part.cluster) { unclustered = round2(unclustered + part.revenue); continue; }
        const cur = byCluster[part.cluster] || { cluster: part.cluster, revenue: 0, orders: 0 };
        cur.revenue = round2(cur.revenue + part.revenue);
        byCluster[part.cluster] = cur;
        touched.add(part.cluster);
      }
    }
    // One order counts once per cluster it touched, never once per line — a
    // three-bottle lotion order is one lotion order.
    for (const c of touched) byCluster[c].orders += 1;
  }

  return {
    byCluster,
    unclustered,
    subtotal,
    orderTotals,
    // Shipping, tax and any other order-level charge. Reported, never allocated.
    nonProductRevenue: round2(orderTotals - subtotal),
    orders,
    ordersWithoutLines,
    basis: PRODUCT_REVENUE_BASIS,
  };
}

/**
 * The per-cluster report rows: organic, all-channel and the prior-window
 * comparison, unioned so a category that sold with no clustered entry page
 * still gets a row.
 *
 * A `null` cluster never becomes a row — it is not a category, exactly as
 * `residualRollup` refuses to make the residual one.
 */
export function productClusterRows({ organic, allChannels, priorOrganic } = {}) {
  const names = new Set([
    ...Object.keys(organic?.byCluster || {}),
    ...Object.keys(allChannels?.byCluster || {}),
    ...Object.keys(priorOrganic?.byCluster || {}),
  ]);
  const rows = [...names].filter(Boolean).map((cluster) => {
    const cur = organic?.byCluster?.[cluster];
    const all = allChannels?.byCluster?.[cluster];
    const prev = priorOrganic?.byCluster?.[cluster];
    const revenue = round2(cur?.revenue);
    const prevRevenue = round2(prev?.revenue);
    const allRevenue = round2(all?.revenue);
    return {
      cluster,
      product_organic_revenue: revenue,
      product_organic_revenue_prev: prevRevenue,
      product_organic_revenue_delta: round2(revenue - prevRevenue),
      product_organic_orders: cur?.orders || 0,
      product_revenue_all_channels: allRevenue,
      product_orders_all_channels: all?.orders || 0,
      // How much of what this category sold, search actually reached. The share
      // is the point of showing both: a category selling well on other channels
      // is an SEO OPPORTUNITY, not a dud.
      organic_share: allRevenue > 0 ? Math.round((revenue / allRevenue) * 1000) / 10 : null,
    };
  });
  return rows.sort((a, b) => b.product_revenue_all_channels - a.product_revenue_all_channels
    || b.product_organic_revenue - a.product_organic_revenue
    || a.cluster.localeCompare(b.cluster));
}

/**
 * The report's `clusters[]`: entry-page rows with the product figures merged on.
 *
 * PRESERVING, NOT REPLACING. `entry_page_organic_revenue` (and its
 * back-compatible alias `revenue`, and `revenueDelta`, `clicks`, `pages`) keep
 * their exact meaning and value, because eleven consumers read them to decide
 * whether to block content, defer a calendar item or archive a paid-for brief.
 * The product figures land beside them as new, differently-named fields, so a
 * consumer switches basis only when someone deliberately migrates it.
 *
 * A cluster that SOLD but has no clustered entry page still gets a row, with
 * zero clicks and zero pages. That is the whole point — such a category was
 * previously invisible — and it is safe: `classifyClusters` needs 400 clicks
 * across 5 pages before a $0 counts as evidence, so a 0/0 row can only ever be
 * `unproven`.
 *
 * Sorted by all-channel product revenue: the consumers that slice the head of
 * this array (the dashboard's six chips, the digest's four) are asking which
 * categories matter, and that is the number which answers it.
 */
export function mergeClusterRows(entryRows, productRows) {
  const byCluster = new Map();
  for (const r of entryRows || []) byCluster.set(r.cluster, { ...r });
  for (const p of productRows || []) {
    const cur = byCluster.get(p.cluster) || {
      cluster: p.cluster,
      revenue: 0,
      entry_page_organic_revenue: 0,
      revenuePrev: 0,
      revenueDelta: 0,
      clicks: 0,
      pages: 0,
    };
    byCluster.set(p.cluster, { ...cur, ...p });
  }
  return [...byCluster.values()].sort(
    (a, b) => (b.product_revenue_all_channels || 0) - (a.product_revenue_all_channels || 0)
      || (b.product_organic_revenue || 0) - (a.product_organic_revenue || 0)
      || (b.entry_page_organic_revenue || 0) - (a.entry_page_organic_revenue || 0)
      || String(a.cluster).localeCompare(String(b.cluster)),
  );
}
