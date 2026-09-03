#!/usr/bin/env node
/**
 * Hero-product analysis — which entry SKU's first-time buyers come back most often.
 *
 * The question is NOT "which SKU sells the most" and NOT "which has the best
 * front-end ROAS". Both measure the first transaction only. This measures the
 * thing that decides lifetime value: of the customers whose FIRST order contained
 * SKU X, what share ever ordered again?
 *
 * Two guards, both load-bearing at this store's volume:
 *
 * 1. WILSON LOWER BOUND, not the raw percentage. A 40% repeat rate off 12 orders
 *    must not outrank a 30% rate off 400, or the whole ad budget gets re-pointed
 *    at noise. Sorting is on the 95% Wilson lower bound; the raw rate is shown
 *    beside it so the shrinkage is visible.
 *
 * 2. RIGHT-CENSORING. A customer who first ordered last week cannot have
 *    repurchased yet, so including them counts "too recent" as "never came back"
 *    and penalises whichever SKU sold most recently. Customers whose first order
 *    is newer than --censor-days are excluded from the cohort entirely (not
 *    counted as non-repeaters). Default 180 days: deodorant's measured reorder
 *    interval is ~90 d/unit (config/consumption-rates.json), so 180 gives even
 *    the slowest-consumed SKU two intervals to produce a second order.
 *
 * Read-only. Touches nothing but the Shopify orders endpoint and stdout.
 *
 * Usage:
 *   node scripts/hero-product-repurchase.mjs
 *     --censor-days <n>   Exclude customers whose first order is newer than this. Default 180.
 *     --since <YYYY-MM-DD>  Earliest order to pull. Default 2015-01-01 (i.e. all time).
 *     --min-cohort <n>    Do not print a SKU with fewer than n first-time buyers. Default 5.
 *     --json              Machine-readable output.
 *     --out <path>        Also write the JSON to a file.
 */

import { writeFileSync } from 'node:fs';
import { getAllOrders } from '../lib/shopify.js';
import { clusterForText } from '../lib/cluster-revenue.js';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

const CENSOR_DAYS = Number(flag('censor-days', 180));
const SINCE = flag('since', '2015-01-01');
const MIN_COHORT = Number(flag('min-cohort', 5));
const BY = flag('by', 'cluster');
const FIRST_ORDER_SINCE = flag('first-order-since', null);
// Robustness check, not the default view. A customer whose first order held
// lotion AND soap joins both cohorts, and a multi-item first order is itself a
// marker of a higher-intent buyer — so a cluster that mostly rides along in big
// baskets can look sticky on borrowed intent. --single-sku-only keeps only
// customers whose first order mapped to exactly one cluster, which is the
// cohort an ad pointing at one product actually creates. If a cluster's ranking
// survives both views it is not an artifact of basket composition.
const SINGLE_ONLY = has('single-sku-only');
const AS_JSON = has('json');
const OUT = flag('out', null);

if (!['cluster', 'product'].includes(BY)) {
  console.error(`--by must be "cluster" or "product", got "${BY}"`);
  process.exit(64);
}

/**
 * Wilson score interval lower bound for a binomial proportion.
 * Edwin B. Wilson, 1927. At small n it pulls the estimate down hard, which is
 * exactly the property we want: it is a floor on the rate, not the rate.
 */
export function wilsonLowerBound(successes, total, z = 1.96) {
  if (total === 0) return 0;
  const p = successes / total;
  const denom = 1 + (z * z) / total;
  const centre = p + (z * z) / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return Math.max(0, (centre - margin) / denom);
}

/** A purchase, as opposed to a cancelled order, a test order or a $0 giveaway entry. */
function isPurchase(o) {
  if (o.test) return false;
  if (o.cancelled_at) return false;
  if (o.financial_status === 'voided') return false;
  if (parseFloat(o.total_price || 0) <= 0) return false;
  return true;
}

/** Customer identity: id where Shopify has one, else the email. Guest orders still join. */
function identity(o) {
  if (o.customer && o.customer.id) return `id:${o.customer.id}`;
  const email = (o.email || o.contact_email || '').trim().toLowerCase();
  return email ? `em:${email}` : null;
}

/**
 * The distinct entry products in an order.
 *
 * `--by cluster` is the default and it is not a convenience. This store carries
 * ~40 historical Shopify product records for 12 live SKUs — deodorant alone is
 * split across six product_ids from successive relistings — so a per-product_id
 * cohort splits one category's evidence six ways and reports five near-empty
 * rows plus one real one. Folding on lib/keyword-index/cluster.js's assignCluster
 * (via clusterForText, the same wrapper lib/product-cluster-revenue.js already
 * applies to line-item titles) is the fleet's single taxonomy and puts the
 * evidence back in one pool. `--by product` keeps the raw records for auditing.
 */
function lineProducts(o, by) {
  const seen = new Map();
  for (const li of o.line_items || []) {
    if (by === 'cluster') {
      const cluster = clusterForText(li.title);
      const key = cluster ? `c:${cluster}` : 't:unclustered';
      if (!seen.has(key)) seen.set(key, cluster || 'unclustered');
    } else {
      const key = li.product_id ? `p:${li.product_id}` : `t:${li.title}`;
      if (!seen.has(key)) seen.set(key, li.title);
    }
  }
  return [...seen.entries()].map(([key, title]) => ({ key, title }));
}

async function main() {
  const today = new Date();
  const until = today.toISOString().slice(0, 10);

  const { orders, pages, truncated } = await getAllOrders(SINCE, until, { maxPages: 60 });
  if (truncated) {
    throw new Error(`Order pull hit the page cap after ${pages} pages — orders are MISSING. Raise maxPages.`);
  }

  const purchases = orders.filter(isPurchase);
  const identified = purchases.filter((o) => identity(o));

  // Group by customer, chronological.
  const byCustomer = new Map();
  for (const o of identified) {
    const id = identity(o);
    if (!byCustomer.has(id)) byCustomer.set(id, []);
    byCustomer.get(id).push(o);
  }
  for (const list of byCustomer.values()) {
    list.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  }

  const censorCutoff = new Date(today.getTime() - CENSOR_DAYS * 86400000);
  // Optional floor on cohort age. The store has traded since 2019 and the
  // catalogue, price and positioning have all moved; --first-order-since lets
  // the same question be asked of the recent business without pretending the
  // older orders never happened.
  const cohortFloor = FIRST_ORDER_SINCE ? new Date(`${FIRST_ORDER_SINCE}T00:00:00Z`) : null;
  let tooOld = 0;
  let multiSku = 0;

  // Cohort each customer onto every distinct product in their FIRST order.
  const skus = new Map(); // key -> { title, cohort, repeat, laterRevenue, firstRevenue }
  let censored = 0;
  let cohortCustomers = 0;

  for (const list of byCustomer.values()) {
    const first = list[0];
    if (new Date(first.created_at) > censorCutoff) {
      censored += 1;
      continue;
    }
    if (cohortFloor && new Date(first.created_at) < cohortFloor) {
      tooOld += 1;
      continue;
    }
    const entries = lineProducts(first, BY);
    if (SINGLE_ONLY && entries.length !== 1) {
      multiSku += 1;
      continue;
    }
    cohortCustomers += 1;

    const repeated = list.length > 1;
    const laterRevenue = list
      .slice(1)
      .reduce((s, o) => s + parseFloat(o.total_price || 0), 0);
    const firstRevenue = parseFloat(first.total_price || 0);

    for (const { key, title } of entries) {
      if (!skus.has(key)) {
        skus.set(key, { key, title, cohort: 0, repeat: 0, laterRevenue: 0, firstRevenue: 0 });
      }
      const row = skus.get(key);
      row.cohort += 1;
      if (repeated) row.repeat += 1;
      row.laterRevenue += laterRevenue;
      row.firstRevenue += firstRevenue;
    }
  }

  const rows = [...skus.values()]
    .map((r) => ({
      ...r,
      rate: r.cohort ? r.repeat / r.cohort : 0,
      wilson: wilsonLowerBound(r.repeat, r.cohort),
      laterRevenue: Math.round(r.laterRevenue * 100) / 100,
      firstRevenue: Math.round(r.firstRevenue * 100) / 100,
    }))
    .sort((a, b) => b.wilson - a.wilson);

  const shown = rows.filter((r) => r.cohort >= MIN_COHORT);
  const hidden = rows.filter((r) => r.cohort < MIN_COHORT);

  const inCohort = (l) => {
    const t = new Date(l[0].created_at);
    if (t > censorCutoff) return false;
    if (cohortFloor && t < cohortFloor) return false;
    if (SINGLE_ONLY && lineProducts(l[0], BY).length !== 1) return false;
    return true;
  };
  const overallRepeat = cohortCustomers
    ? [...byCustomer.values()].filter((l) => inCohort(l) && l.length > 1).length / cohortCustomers
    : 0;

  const result = {
    generated_at: new Date().toISOString(),
    grouped_by: BY,
    window: {
      since: SINCE,
      until,
      censor_days: CENSOR_DAYS,
      first_order_since: FIRST_ORDER_SINCE,
    },
    counts: {
      orders_pulled: orders.length,
      pages,
      purchases: purchases.length,
      excluded_non_purchase: orders.length - purchases.length,
      excluded_no_identity: purchases.length - identified.length,
      customers_total: byCustomer.size,
      customers_censored_too_recent: censored,
      customers_excluded_too_old: tooOld,
      customers_excluded_multi_sku_first_order: multiSku,
      customers_in_cohort: cohortCustomers,
    },
    overall_repeat_rate: Math.round(overallRepeat * 10000) / 10000,
    min_cohort: MIN_COHORT,
    skus: shown,
    below_min_cohort: hidden,
  };

  if (OUT) writeFileSync(OUT, JSON.stringify(result, null, 2));
  if (AS_JSON) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const c = result.counts;
  console.log(`\nHero-product analysis — entry ${BY} by first-time-buyer repurchase`);
  console.log(`Orders ${SINCE} → ${until}: ${c.orders_pulled} pulled, ${c.purchases} real purchases`);
  console.log(`  excluded: ${c.excluded_non_purchase} non-purchase (test/cancelled/$0), ${c.excluded_no_identity} with no customer identity`);
  console.log(
    `Customers: ${c.customers_total} total · ${c.customers_censored_too_recent} censored (first order < ${CENSOR_DAYS}d ago)` +
      (FIRST_ORDER_SINCE ? ` · ${c.customers_excluded_too_old} first ordered before ${FIRST_ORDER_SINCE}` : '') +
      (SINGLE_ONLY ? ` · ${c.customers_excluded_multi_sku_first_order} multi-${BY} first orders dropped` : '') +
      ` · ${c.customers_in_cohort} in cohort`
  );
  console.log(`Store-wide repeat rate on that cohort: ${(overallRepeat * 100).toFixed(1)}%\n`);

  const pad = (s, n) => String(s).padEnd(n);
  const lpad = (s, n) => String(s).padStart(n);
  console.log(
    `${pad('entry SKU', 44)} ${lpad('cohort', 7)} ${lpad('repeat', 7)} ${lpad('raw', 7)} ${lpad('WILSON', 8)} ${lpad('later $', 10)}`
  );
  console.log('-'.repeat(88));
  for (const r of shown) {
    console.log(
      `${pad(r.title.slice(0, 43), 44)} ${lpad(r.cohort, 7)} ${lpad(r.repeat, 7)} ${lpad((r.rate * 100).toFixed(1) + '%', 7)} ${lpad((r.wilson * 100).toFixed(1) + '%', 8)} ${lpad('$' + r.laterRevenue.toFixed(2), 10)}`
    );
  }
  if (hidden.length) {
    console.log(`\nBelow the ${MIN_COHORT}-buyer floor (shown for completeness, do not rank on these):`);
    for (const r of hidden) {
      console.log(
        `  ${pad(r.title.slice(0, 50), 52)} cohort ${lpad(r.cohort, 3)} · repeat ${r.repeat} · raw ${(r.rate * 100).toFixed(0)}%`
      );
    }
  }
  console.log('');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
