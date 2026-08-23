import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyClusters, clusterStatus, clusterForText, foldClusterRows,
  MIN_CLICKS, MIN_PAGES, MIN_WINDOW_ORDERS, JUDGING_WINDOW_DAYS,
} from '../../lib/cluster-revenue.js';

// ─────────────────────────────────────────────────────────────────────────────
// THE PRODUCTION REPORT, VERBATIM.
//
// data/reports/seo-impact/latest.json from root@137.184.119.230, generated
// 2026-08-22T15:16:44.241Z over the window 2026-07-24 → 2026-08-20. Kept split
// exactly as the server wrote it, because that is the shape a stale report on
// disk still has: the fold must happen at classification time, not only in
// reports written after the taxonomy was fixed.
//
// `soap` reads $0 on 223 clicks here and was stamped `proven_dud` — a hard block
// in four consumers, one of which deletes brief files. Soap really sold ~$430
// over 90 days, 19% of all revenue, second only to lotion, with a paid giveaway
// campaign live. Two independent defects produced that verdict and both are
// under test below.
// ─────────────────────────────────────────────────────────────────────────────

const PRODUCTION_CLUSTERS = [
  { cluster: 'body lotion', revenue: 313.49, revenuePrev: 31.19, clicks: 35, pages: 20 },
  { cluster: 'hand soap', revenue: 62.4, revenuePrev: 0, clicks: 4, pages: 4 },
  { cluster: 'lip balm', revenue: 48, revenuePrev: 0, clicks: 4, pages: 6 },
  { cluster: 'deodorant', revenue: 38.25, revenuePrev: 0, clicks: 121, pages: 21 },
  { cluster: 'toothpaste', revenue: 0, revenuePrev: 18.99, clicks: 663, pages: 24 },
  { cluster: 'soap', revenue: 0, revenuePrev: 0, clicks: 223, pages: 24 },
  { cluster: 'lotion', revenue: 0, revenuePrev: 0, clicks: 56, pages: 12 },
  { cluster: 'moisturizer', revenue: 0, revenuePrev: 0, clicks: 15, pages: 5 },
  { cluster: 'coconut oil', revenue: 0, revenuePrev: 0, clicks: 11, pages: 7 },
  { cluster: 'body cream', revenue: 0, revenuePrev: 0, clicks: 0, pages: 1 },
];

const PRODUCTION_TOTALS = {
  organic_revenue: 540.08,
  organic_conversions: 8,
  organic_sessions: 1067,
  shopify_orders_all_channels: 18,
};

// ─────────────────────────────────────────────────────────────────────────────
// WHAT THE CATEGORIES ACTUALLY SOLD, over the 90 days to the same 2026-08-20.
//
// Computed from 54 raw Shopify orders pulled READ-ONLY from production on
// 2026-08-23 (50 of them counting as revenue) through the same
// `lib/product-cluster-revenue.js` path `agents/seo-impact` uses, bundles
// expanded. This is SOURCE A — the number the verdict is now made on — and the
// contrast with the entry-page column above is the whole subject of this file:
//
//   cluster       entry-page 28d      products sold 90d, all channels
//   lotion              $313.49       $1,757.10   (34 orders)
//   soap                 $62.40         $324.85   (12 orders)
//   deodorant            $38.25         $165.00   ( 9 orders)
//   lip balm             $48.00         $117.00   ( 4 orders)
//   toothpaste            $0.00          $71.50   ( 5 orders)
//   coconut oil           $0.00           $0.00   ( 0 orders — RSC ships no
//                                                   coconut-oil SKU at all)
// ─────────────────────────────────────────────────────────────────────────────

const PRODUCTION_SOLD_90D = {
  lotion: 1757.1,
  soap: 324.85,
  deodorant: 165,
  'lip balm': 117,
  toothpaste: 71.5,
  'coconut oil': 0,
};

/** All-channel Shopify orders in that 90-day window. The gate's denominator. */
const PRODUCTION_WINDOW_ORDERS = 50;

const LIVE = classifyClusters(PRODUCTION_CLUSTERS, {
  productRevenue: PRODUCTION_SOLD_90D, windowOrders: PRODUCTION_WINDOW_ORDERS,
});

// ── the defect this change exists to fix ─────────────────────────────────────

test('SOAP IS NOT A PROVEN DUD on the real production report', () => {
  assert.notEqual(LIVE.soap.status, 'proven_dud');
  assert.equal(LIVE.soap.status, 'earning');
  // And it is earning on the PRODUCT number, not on a threshold sparing it. This
  // is the point of the migration: soap's survival used to depend on clearing a
  // statistical floor with $0 attributed; now it simply sold $324.85.
  assert.equal(LIVE.soap.productRevenue, 324.85);
  // /products/organic-foaming-hand-soap matched 'hand soap' at list position 9
  // before 'soap' at position 12, so the category's ONLY in-window organic order
  // was credited to a sibling row and soap read $0. Folded, the $62.40 is soap's.
  assert.equal(LIVE.soap.entryPageOrganicRevenue, 62.4);
  assert.deepEqual(LIVE.soap.members.sort(), ['hand soap', 'soap']);
  assert.equal(LIVE.soap.clicks, 227);
  assert.equal(LIVE.soap.pages, 28);
  assert.equal(LIVE['hand soap'], undefined, 'there is no separate hand soap evidence pool any more');
});

test('SOAP survives even with the taxonomy fold undone and the click bar cleared', () => {
  // The old defence rested on two things that could each be undone: the fold,
  // and a 400-click bar soap's 223 did not reach. Neither is load-bearing any
  // more. Split back into its own row, at a click count that clears the CURRENT
  // bar comfortably, soap is still `earning` — because the verdict reads what
  // the category sold rather than what landed on pages named after it.
  const unfolded = classifyClusters([{ cluster: 'soap', revenue: 0, clicks: 900, pages: 24 }], {
    productRevenue: PRODUCTION_SOLD_90D, windowOrders: PRODUCTION_WINDOW_ORDERS,
  });
  assert.equal(unfolded.soap.status, 'earning');
  assert.ok(unfolded.soap.clicks > MIN_CLICKS, 'not spared by the click precondition');
});

test('the lotion family is one cluster, not four rows shredded three ways', () => {
  assert.equal(LIVE.lotion.status, 'earning');
  assert.equal(LIVE.lotion.entryPageOrganicRevenue, 313.49);
  assert.equal(LIVE.lotion.clicks, 106, '35 + 56 + 15 + 0');
  assert.equal(LIVE.lotion.pages, 38, '20 + 12 + 5 + 1');
  assert.deepEqual(LIVE.lotion.members.sort(), ['body cream', 'body lotion', 'lotion', 'moisturizer']);
  for (const gone of ['body lotion', 'moisturizer', 'body cream']) {
    assert.equal(LIVE[gone], undefined, `${gone} no longer holds its own $0 evidence pool`);
  }
});

test('TOOTHPASTE IS NO LONGER A DUD, and that is the honest answer', () => {
  // It was `proven_dud` — and HELD — under the entry-page basis, on $0 across
  // 663 clicks. Its products sold $71.50 across 5 orders in the 90 days to
  // 2026-08-20. $71.50 is not $0, so the verdict falls out. Deliberately NOT
  // preserved by tuning a threshold: `proven_dud` is a $0 verdict, and a
  // category that is merely INEFFICIENT (59% of clustered organic clicks for
  // 2.9% of revenue) is a different finding needing a different mechanism.
  assert.equal(LIVE.toothpaste.status, 'earning');
  assert.equal(LIVE.toothpaste.productRevenue, 71.5);
  assert.ok(LIVE.toothpaste.clicks >= MIN_CLICKS, 'it clears the fair-shot bar comfortably');
  assert.ok(LIVE.toothpaste.pages >= MIN_PAGES);
  assert.equal(LIVE.toothpaste.entryPageOrganicRevenue, 0, 'while entry-page attribution still reads $0');
});

test('NOTHING is a dud on the real report — every category RSC sells, sells', () => {
  const duds = Object.entries(LIVE).filter(([, v]) => v.status === 'proven_dud').map(([k]) => k);
  assert.deepEqual(duds, []);
});

test('the one $0 category is the one with no SKU behind it, and it is unproven', () => {
  // `coconut oil` sold $0 over 90 days because RSC ships nothing that clusters
  // there — every coconut-* product is a deodorant, toothpaste, lip balm, lotion
  // or soap. Its 11 clicks keep it `unproven` rather than condemned, which is
  // right: "there is nothing to sell here" is a different diagnosis from "this
  // content failed", and lib/cluster-hold.js's second source is what tells them
  // apart once the traffic bar is reached.
  assert.equal(LIVE['coconut oil'].status, 'unproven');
  assert.equal(LIVE['coconut oil'].productRevenue, 0);
  assert.match(LIVE['coconut oil'].evidence, /fair shot/);
});

test('nothing that sold anything is condemned, at any click count', () => {
  for (const [name, v] of Object.entries(LIVE)) {
    if (v.productRevenue > 0) assert.equal(v.status, 'earning', name);
  }
});

// ── the order-count precondition ─────────────────────────────────────────────

test('NO PRODUCT READING AT ALL means no dud — including on a pre-migration report', () => {
  // This is the deploy path: `data/reports/seo-impact/latest.json` on the server
  // was written before `clusters_product_wide` existed, so it carries clicks and
  // entry-page dollars and nothing else. The gate must go quiet rather than fall
  // back to the entry-page number, which is the misreading being fixed.
  const c = classifyClusters(PRODUCTION_CLUSTERS, { windowOrders: PRODUCTION_WINDOW_ORDERS });
  assert.equal(Object.values(c).filter((v) => v.status === 'proven_dud').length, 0);
  assert.equal(c.toothpaste.status, 'unproven');
  assert.match(c.toothpaste.evidence, /no product-revenue reading/i);
  assert.equal(c.toothpaste.productRevenue, null, 'null is "not measured", never 0');
});

test('no window order count means no dud — an unknown denominator is not evidence', () => {
  const c = classifyClusters(PRODUCTION_CLUSTERS, { productRevenue: { ...PRODUCTION_SOLD_90D, toothpaste: 0 } });
  assert.equal(c.toothpaste.status, 'unproven');
  assert.match(c.toothpaste.evidence, /order count was not supplied/i);
  assert.equal(Object.values(c).filter((v) => v.status === 'proven_dud').length, 0);
});

test('a window too thin to have shown a sale condemns nothing', () => {
  const thin = classifyClusters(PRODUCTION_CLUSTERS, {
    productRevenue: { ...PRODUCTION_SOLD_90D, toothpaste: 0 }, windowOrders: MIN_WINDOW_ORDERS - 1,
  });
  assert.equal(thin.toothpaste.status, 'unproven');
  assert.match(thin.toothpaste.evidence, new RegExp(`below the ${MIN_WINDOW_ORDERS} needed`));
});

test('an ALL-ZERO product-revenue map is "not measured" too, and that shape is reachable', () => {
  // `withWideEntryPageRevenue` UNIONS the two rollups, so if the product rollup
  // yields nothing while the entry-page one yields rows, the report carries rows
  // whose product figures are all $0 — a non-empty map of zeroes. Read literally
  // that condemns every high-traffic category in one unattended run.
  //
  // Note the asymmetry that makes this safe even if the judgement is wrong: it
  // can only move a verdict from proven_dud to unproven, never the other way.
  const allZero = classifyClusters(PRODUCTION_CLUSTERS, {
    productRevenue: Object.fromEntries(Object.keys(PRODUCTION_SOLD_90D).map((k) => [k, 0])),
    windowOrders: PRODUCTION_WINDOW_ORDERS,
  });
  assert.equal(Object.values(allZero).filter((v) => v.status === 'proven_dud').length, 0);
  assert.match(allZero.toothpaste.evidence, /no product-revenue reading/i);

  // ...and ONE selling category is enough to make the reading credible again, so
  // this guard cannot quietly switch the gate off on a working report.
  const oneSale = classifyClusters(PRODUCTION_CLUSTERS, {
    productRevenue: { ...PRODUCTION_SOLD_90D, toothpaste: 0, soap: 0, deodorant: 0, 'lip balm': 0 },
    windowOrders: PRODUCTION_WINDOW_ORDERS,
  });
  assert.equal(oneSale.toothpaste.status, 'proven_dud');
});

test('an EMPTY product-revenue map is "not measured", never "every category sold $0"', () => {
  // The window can hold 50 orders while the line-item join yields nothing — a
  // failed product fetch, or the `orders_without_lines` case the report already
  // counts — so `windowOrders` cannot catch this shape. Read as a map of zeroes
  // it would condemn every high-traffic category in one unattended run.
  const broken = classifyClusters(PRODUCTION_CLUSTERS, {
    productRevenue: {}, windowOrders: PRODUCTION_WINDOW_ORDERS,
  });
  assert.equal(Object.values(broken).filter((v) => v.status === 'proven_dud').length, 0);
  assert.equal(broken.toothpaste.productRevenue, null, 'null is "not measured", never 0');
  assert.match(broken.toothpaste.evidence, /no product-revenue reading/i);
});

test('a broken order pull cannot condemn every cluster at once', () => {
  // A trashed GA4 property 204'd every hit for 8 days once; a Shopify page that
  // silently returns nothing does the same thing here. Zero orders across the
  // whole store reads as $0 in every category simultaneously, and without the
  // order-count floor that stamps every high-traffic one a dud in a single
  // unattended run.
  const outage = classifyClusters(PRODUCTION_CLUSTERS, {
    productRevenue: Object.fromEntries(Object.keys(PRODUCTION_SOLD_90D).map((k) => [k, 0])),
    windowOrders: 0,
  });
  assert.equal(Object.values(outage).filter((v) => v.status === 'proven_dud').length, 0);
});

// ── the thresholds themselves ────────────────────────────────────────────────

test('THE WINDOW carries the statistical load now, and 28 days cannot bear it', () => {
  // The materiality floor, stated as a RATE: a category we would refuse to
  // condemn sells at least ONE AVERAGE ORDER PER 28 DAYS. Over a W-day window it
  // expects W/28 orders, so P(it records zero) = e^−(W/28).
  const pZero = (days) => Math.exp(-days / 28);
  assert.ok(pZero(28) > 0.35, 'the report\'s own window: a coin toss and a half (36.8%)');
  assert.ok(pZero(84) <= 0.051, '84 days is the first point that reaches 5%');
  assert.ok(pZero(JUDGING_WINDOW_DAYS) <= 0.041, '90 days gives 4.0% — what the gate uses');
  assert.equal(JUDGING_WINDOW_DAYS, 90);
});

test('MIN_WINDOW_ORDERS is the same statement in orders, with headroom on purpose', () => {
  // A floor-rate category takes share s of the store's orders:
  //   s = (1 order / 28d) ÷ (50 orders / 90d) = 0.0357 / 0.5556 = 6.41%.
  // It is absent from N orders with probability (1−s)^N.
  const s = (1 / 28) / (PRODUCTION_WINDOW_ORDERS / JUDGING_WINDOW_DAYS);
  const pAbsent = (n) => (1 - s) ** n;
  assert.ok(pAbsent(25) > 0.15, '25 orders is 19% — nowhere near enough to condemn');
  assert.ok(pAbsent(MIN_WINDOW_ORDERS) <= 0.051, `${MIN_WINDOW_ORDERS} orders is the 5% point`);
  assert.ok(pAbsent(PRODUCTION_WINDOW_ORDERS) <= 0.04, 'the observed window passes, barely');
  assert.equal(MIN_WINDOW_ORDERS, 45);
  // Eight orders of headroom is deliberate, and BOTH sides matter. Too little
  // and a slow quarter condemns on thinner evidence than the derivation allows;
  // too much and the gate can never fire on a window this store actually
  // produces. Raising MIN_WINDOW_ORDERS to 55 must fail this, not pass it.
  const headroom = PRODUCTION_WINDOW_ORDERS - MIN_WINDOW_ORDERS;
  assert.ok(headroom > 0, 'the bar must be reachable by the observed window');
  assert.ok(headroom < 10, 'and not so loose that a genuinely slow quarter still condemns');
});

test('MIN_CLICKS is a fair-shot PRECONDITION, and is lower than the old bar on purpose', () => {
  // Under the entry-page basis clicks WERE the statistical evidence, so they had
  // to carry the whole load alone (400 clicks → 5%). Under the product basis the
  // window carries it, and clicks only answer "has this category's content ever
  // been read". A cluster with k clicks in the 28-day GSC window sees ~3.214k
  // over the 90-day judging window, expecting 3.214k × 0.0075 orders from its
  // OWN pages; 125 is where that expectation reaches 3 — the same 5% point.
  const rate = PRODUCTION_TOTALS.organic_conversions / PRODUCTION_TOTALS.organic_sessions;
  const expected = (k) => k * (JUDGING_WINDOW_DAYS / 28) * rate;
  assert.ok(Math.exp(-expected(MIN_CLICKS)) <= 0.055, 'the bar is the ~5% point');
  assert.equal(MIN_CLICKS, 125);
  assert.ok(MIN_CLICKS < 400, 'lower than the entry-page bar, because clicks no longer carry the load alone');
  // And it is honest about what it is NOT: the measured click→category-sales
  // relationship is far weaker than this model in both directions (toothpaste
  // turned 663 clicks into 5 orders where the model predicts 30; lip balm turned
  // 6 clicks into 4 orders), so 125 is a floor on exposure, not a probability.
  assert.ok(LIVE['lip balm'].clicks < MIN_CLICKS && LIVE['lip balm'].status === 'earning');
});

test('a cluster needs BOTH enough clicks and enough pages before it can be a dud', () => {
  const c = classifyClusters([
    { cluster: 'few pages', revenue: 0, clicks: 900, pages: 2 },
    { cluster: 'few clicks', revenue: 0, clicks: 4, pages: 30 },
  ], { productRevenue: { 'few pages': 0, 'few clicks': 0 }, windowOrders: PRODUCTION_WINDOW_ORDERS });
  assert.equal(c['few pages'].status, 'unproven', 'one viral page is not a tested cluster');
  assert.equal(c['few clicks'].status, 'unproven', 'pages nobody visits prove nothing');
  assert.equal(MIN_PAGES, 5);
});

test('thresholds are configurable', () => {
  const c = classifyClusters([{ cluster: 'x', revenue: 0, clicks: 50, pages: 6 }],
    { minClicks: 40, minPages: 5, minWindowOrders: 10, productRevenue: { x: 0, lotion: 90 }, windowOrders: 12 });
  assert.equal(c.x.status, 'proven_dud');
});

test('a cluster earning revenue is earning, however few clicks it took', () => {
  assert.equal(LIVE['lip balm'].status, 'earning', '$117 on 6 clicks is exactly what we want more of');
  assert.equal(LIVE.deodorant.status, 'earning');
});

// ── the field name ───────────────────────────────────────────────────────────

test('the canonical field is entry_page_organic_revenue; `revenue` is an alias', () => {
  // Both names, one number — and NEITHER is what the verdict is made on any
  // more. The field is passed through so the report can still show which PAGE
  // earned; `classifyClusters` reads `productRevenue` for the verdict.
  const canonical = classifyClusters(
    [{ cluster: 'toothpaste', entry_page_organic_revenue: 12.5, clicks: 663, pages: 24 }],
    { productRevenue: { ...PRODUCTION_SOLD_90D, toothpaste: 0 }, windowOrders: PRODUCTION_WINDOW_ORDERS },
  );
  assert.equal(canonical.toothpaste.entryPageOrganicRevenue, 12.5);
  assert.equal(canonical.toothpaste.revenue, 12.5, 'both names, one number');
  assert.equal(canonical.toothpaste.status, 'proven_dud',
    '$12.50 landing on a toothpaste PAGE does not mean the toothpaste PRODUCTS sold');

  // A report written before the rename still reads the same.
  const legacy = classifyClusters([{ cluster: 'toothpaste', revenue: 12.5, clicks: 663, pages: 24 }],
    { productRevenue: { ...PRODUCTION_SOLD_90D, toothpaste: 0 }, windowOrders: PRODUCTION_WINDOW_ORDERS });
  assert.equal(legacy.toothpaste.entryPageOrganicRevenue, 12.5);
  assert.equal(legacy.toothpaste.status, 'proven_dud');
});

// ── plumbing ─────────────────────────────────────────────────────────────────

test('classifyClusters is case- and whitespace-insensitive on cluster names', () => {
  const c = classifyClusters([{ cluster: '  ToothPaste ', revenue: 0, clicks: 725, pages: 26 }],
    { productRevenue: { ...PRODUCTION_SOLD_90D, toothpaste: 0 }, windowOrders: PRODUCTION_WINDOW_ORDERS });
  assert.equal(c.toothpaste.status, 'proven_dud');
});

test('classifyClusters tolerates missing input', () => {
  assert.deepEqual(classifyClusters(null), {});
  assert.deepEqual(classifyClusters([{ revenue: 5 }]), {}, 'an entry with no cluster name is skipped');
});

test('a row that maps to no product family is kept, not silently dropped', () => {
  // `foaming` was a cluster name in the old hand-maintained list and maps to
  // nothing in the fleet taxonomy. Losing it would shrink the report without
  // saying so; it survives under its own name and, because lib/cluster-hold.js
  // cannot map it to a product family, can never reach a blocking decision.
  const folded = foldClusterRows([{ cluster: 'foaming', revenue: 9, clicks: 5, pages: 2 }]);
  assert.equal(folded.foaming.entryPageOrganicRevenue, 9);
});

test('clusterStatus looks a category up leniently and defaults to unproven', () => {
  assert.equal(clusterStatus(LIVE, 'Toothpaste'), 'earning', '$71.50 of product sales is not $0');
  assert.equal(clusterStatus(LIVE, 'Body Lotion'), 'earning', 'folded to lotion, which earns');
  assert.equal(clusterStatus(LIVE, 'Hand Soap'), 'earning', 'folded to soap, which earns');
  assert.equal(clusterStatus(LIVE, 'Something New'), 'unproven');
  assert.equal(clusterStatus(LIVE, null), 'unproven');
});

// ── clusterForText: ONE taxonomy, shared with lib/keyword-index/cluster.js ────

test('clusterForText maps a keyword to the same cluster seo-impact reports on', () => {
  assert.equal(clusterForText('toothpaste for canker sores'), 'toothpaste');
  assert.equal(clusterForText('oatmeal soap'), 'soap');
  assert.equal(clusterForText('best natural deodorant for men'), 'deodorant');
});

test('clusterForText is ordered, first-match-wins', () => {
  assert.equal(clusterForText('coconut oil deodorant for men'), 'deodorant');
  assert.equal(clusterForText('coconut oil soap benefits'), 'soap', 'soap before the ingredient cluster');
  assert.equal(clusterForText('Moisturizing Coconut Soap | 3.4oz'), 'soap', 'soap before lotion');
});

test('every soap is ONE soap: hand, bar, foaming', () => {
  // Kept apart, they split one category's evidence into pools too small to judge
  // and too small to defend. 'hand soap' before bare 'soap' is what mis-filed
  // soap's only in-window order and got the category stamped a dud.
  assert.equal(clusterForText('natural liquid hand soap'), 'soap');
  assert.equal(clusterForText('/products/organic-foaming-hand-soap'), 'soap');
  assert.equal(clusterForText('organic bar soap'), 'soap');
  assert.equal(clusterForText('best natural bar soap for men'), 'soap');
});

test('every lotion is ONE lotion: body lotion, moisturizer, cream, butter', () => {
  assert.equal(clusterForText('best non toxic body lotion'), 'lotion');
  assert.equal(clusterForText('coconut moisturizer'), 'lotion');
  assert.equal(clusterForText('body cream for dry skin'), 'lotion');
  assert.equal(clusterForText('/collections/coconut-body-butter'), 'lotion');
});

test('a path is matched after its separators are normalised to words', () => {
  assert.equal(clusterForText('/blogs/news/best-lip-balm-2026'), 'lip balm');
  assert.equal(clusterForText('/collections/non-toxic-body-lotion'), 'lotion');
});

test('the brand name in a path does not make it a brand page', () => {
  // assignCluster's first rule is navigational-brand, which is right for a
  // search QUERY and wrong for a page PATH, where the brand name is decoration.
  // Left alone this real lotion page classified as 'brand' → null and dropped
  // out of the lotion cluster entirely.
  assert.equal(clusterForText('/blogs/news/best-clean-body-lotion-soft-skin-zero-toxins-real-skin-care'), 'lotion');
});

test('clusterForText returns null for anything that is not a product cluster', () => {
  assert.equal(clusterForText('dry brushing technique'), null);
  assert.equal(clusterForText('is coconut oil good for your hair'), null, 'RSC sells no hair products');
  assert.equal(clusterForText('real skin care'), null, 'a bare brand lookup is navigational');
  assert.equal(clusterForText(''), null);
  assert.equal(clusterForText(null), null);
});
