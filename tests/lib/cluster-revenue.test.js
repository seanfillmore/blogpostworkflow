import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyClusters, clusterStatus, clusterForText, foldClusterRows,
  MIN_CLICKS, MIN_PAGES, MIN_WINDOW_ORDERS,
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

const LIVE = classifyClusters(PRODUCTION_CLUSTERS, { totals: PRODUCTION_TOTALS });

// ── the defect this change exists to fix ─────────────────────────────────────

test('SOAP IS NOT A PROVEN DUD on the real production report', () => {
  assert.notEqual(LIVE.soap.status, 'proven_dud');
  assert.equal(LIVE.soap.status, 'earning');
  // /products/organic-foaming-hand-soap matched 'hand soap' at list position 9
  // before 'soap' at position 12, so the category's ONLY in-window organic order
  // was credited to a sibling row and soap read $0. Folded, the $62.40 is soap's.
  assert.equal(LIVE.soap.entryPageOrganicRevenue, 62.4);
  assert.deepEqual(LIVE.soap.members.sort(), ['hand soap', 'soap']);
  assert.equal(LIVE.soap.clicks, 227);
  assert.equal(LIVE.soap.pages, 28);
  assert.equal(LIVE['hand soap'], undefined, 'there is no separate hand soap evidence pool any more');
});

test('SOAP would be spared by the evidence bar alone, even unfolded', () => {
  // The two defects are independent, so the fix must not depend on either one
  // alone holding. At 223 clicks and the measured 0.75% conversion rate, a
  // genuinely-selling category records zero orders ~19% of the time.
  const unfolded = classifyClusters([{ cluster: 'soap', revenue: 0, clicks: 223, pages: 24 }],
    { totals: PRODUCTION_TOTALS });
  assert.equal(unfolded.soap.status, 'unproven');
  assert.match(unfolded.soap.evidence, /below the 400 clicks/);
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

test('TOOTHPASTE is still a dud, and the new evidence justifies it', () => {
  assert.equal(LIVE.toothpaste.status, 'proven_dud');
  // Not by accident of a low bar: 663 clicks at 0.75% is an expected 4.97 orders,
  // so a true zero has a 0.7% chance of happening to a category that sells.
  assert.ok(LIVE.toothpaste.clicks >= MIN_CLICKS);
  assert.ok(LIVE.toothpaste.pages >= MIN_PAGES);
  assert.match(LIVE.toothpaste.evidence, /8 organic orders/);
});

test('exactly one cluster is a dud on the real report', () => {
  const duds = Object.entries(LIVE).filter(([, v]) => v.status === 'proven_dud').map(([k]) => k);
  assert.deepEqual(duds, ['toothpaste']);
});

test('merging did not merely move the false dud somewhere else', () => {
  // A merged cluster accumulates clicks and pages faster while $0 stays $0, so
  // the fold makes proven_dud fire MORE easily. Nothing that earns is condemned.
  for (const [name, v] of Object.entries(LIVE)) {
    if (v.entryPageOrganicRevenue > 0) assert.equal(v.status, 'earning', name);
  }
  assert.equal(LIVE['coconut oil'].status, 'unproven', '11 clicks is not a fair shot');
});

// ── the order-count precondition ─────────────────────────────────────────────

test('no totals block means no dud — an unknown denominator is not evidence', () => {
  const c = classifyClusters(PRODUCTION_CLUSTERS);
  assert.equal(c.toothpaste.status, 'unproven');
  assert.match(c.toothpaste.evidence, /order count was not supplied/i);
  assert.equal(Object.values(c).filter((v) => v.status === 'proven_dud').length, 0);
});

test('a window too thin to have shown a sale condemns nothing', () => {
  const thin = classifyClusters(PRODUCTION_CLUSTERS,
    { totals: { ...PRODUCTION_TOTALS, organic_conversions: MIN_WINDOW_ORDERS - 1 } });
  assert.equal(thin.toothpaste.status, 'unproven');
  assert.match(thin.toothpaste.evidence, /below the 5 needed/);
});

test('a store-wide measurement outage cannot condemn every cluster at once', () => {
  // A trashed GA4 property 204'd every hit for 8 days once. Zero orders across
  // the whole store reads as $0 in every cluster; under a clicks-only bar that
  // stamps every high-traffic category a dud in a single unattended run.
  const outage = classifyClusters(
    PRODUCTION_CLUSTERS.map((c) => ({ ...c, revenue: 0 })),
    { totals: { ...PRODUCTION_TOTALS, organic_conversions: 0 } },
  );
  assert.equal(Object.values(outage).filter((v) => v.status === 'proven_dud').length, 0);
});

// ── the thresholds themselves ────────────────────────────────────────────────

test('the click bar is where a $0 stops being the likely outcome of a healthy cluster', () => {
  // λ = clicks × 0.0075 (8 organic orders / 1,067 organic sessions).
  // P(zero) = e^-λ. The bar is the point where that falls to 5%.
  const p0 = (clicks) => Math.exp(-clicks * (PRODUCTION_TOTALS.organic_conversions / PRODUCTION_TOTALS.organic_sessions));
  assert.ok(p0(100) > 0.4, 'the OLD 100-click bar was a coin flip (47%)');
  assert.ok(p0(223) > 0.15, 'what condemned soap had a ~19% chance of happening anyway');
  assert.ok(p0(MIN_CLICKS) <= 0.06, 'the new bar is ~5%');
  assert.ok(p0(663) < 0.01, 'toothpaste is 0.7% — a real finding');
});

test('a cluster needs BOTH enough clicks and enough pages before it can be a dud', () => {
  const c = classifyClusters([
    { cluster: 'few pages', revenue: 0, clicks: 900, pages: 2 },
    { cluster: 'few clicks', revenue: 0, clicks: 4, pages: 30 },
  ], { totals: PRODUCTION_TOTALS });
  assert.equal(c['few pages'].status, 'unproven', 'one viral page is not a tested cluster');
  assert.equal(c['few clicks'].status, 'unproven', 'pages nobody visits prove nothing');
});

test('thresholds are configurable', () => {
  const c = classifyClusters([{ cluster: 'x', revenue: 0, clicks: 50, pages: 6 }],
    { minClicks: 40, minPages: 5, totals: PRODUCTION_TOTALS });
  assert.equal(c.x.status, 'proven_dud');
});

test('a cluster earning revenue is earning, however few clicks it took', () => {
  assert.equal(LIVE['lip balm'].status, 'earning', '$48 on 4 clicks is exactly what we want more of');
  assert.equal(LIVE.deodorant.status, 'earning');
});

// ── the field name ───────────────────────────────────────────────────────────

test('the canonical field is entry_page_organic_revenue; `revenue` is an alias', () => {
  const canonical = classifyClusters(
    [{ cluster: 'toothpaste', entry_page_organic_revenue: 12.5, clicks: 663, pages: 24 }],
    { totals: PRODUCTION_TOTALS },
  );
  assert.equal(canonical.toothpaste.status, 'earning');
  assert.equal(canonical.toothpaste.entryPageOrganicRevenue, 12.5);
  assert.equal(canonical.toothpaste.revenue, 12.5, 'both names, one number');

  // A report written before the rename still classifies correctly.
  const legacy = classifyClusters([{ cluster: 'toothpaste', revenue: 12.5, clicks: 663, pages: 24 }],
    { totals: PRODUCTION_TOTALS });
  assert.equal(legacy.toothpaste.status, 'earning');
  assert.equal(legacy.toothpaste.entryPageOrganicRevenue, 12.5);
});

// ── plumbing ─────────────────────────────────────────────────────────────────

test('classifyClusters is case- and whitespace-insensitive on cluster names', () => {
  const c = classifyClusters([{ cluster: '  ToothPaste ', revenue: 0, clicks: 725, pages: 26 }],
    { totals: PRODUCTION_TOTALS });
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
  assert.equal(clusterStatus(LIVE, 'Toothpaste'), 'proven_dud');
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
