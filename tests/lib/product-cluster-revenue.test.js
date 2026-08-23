// tests/lib/product-cluster-revenue.test.js
//
// Product-level cluster attribution: what a CATEGORY sold, from raw order line
// items, as opposed to what landed on a page whose URL contains the category's
// name. The line-item shapes here are copied from live 2026-08-23 orders.

import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyOrder, attributionRows } from '../../lib/order-attribution.js';
import {
  lineRevenue, orderLines, buildBundleIndex, splitLineToClusters,
  clusterProductRevenue, productClusterRows, mergeClusterRows, PRODUCT_REVENUE_BASIS,
} from '../../lib/product-cluster-revenue.js';
import { classifyClusters } from '../../lib/cluster-revenue.js';

// ── fixtures ──────────────────────────────────────────────────────────────────

/** A real 3-line order: subtotal 283.00, order discount 56.60, total 226.40. */
const MULTI_LINE_ORDER = {
  id: 1, name: '#2340', created_at: '2026-08-01T12:00:00-07:00',
  total_price: '226.40', subtotal_price: '226.40', total_discounts: '56.60',
  landing_site: '/', referring_site: 'https://www.google.com/',
  line_items: [
    {
      title: 'Natural Coconut Oil Lip Balm | 0.15oz | Four Pack', product_id: 7644975071402,
      variant_title: 'Vanilla Dream', price: '15.00', quantity: 1, total_discount: '0.00',
      discount_allocations: [{ amount: '3.00' }],
    },
    {
      title: 'Coconut Moisturizer | 4oz', product_id: 7644968911018,
      variant_title: 'Pure Unscented', price: '28.00', quantity: 1, total_discount: '0.00',
      discount_allocations: [{ amount: '5.60' }],
    },
    {
      title: 'Non-Toxic Body Lotion Made With Only 6 Clean Ingredients', product_id: 7691181686954,
      variant_title: 'Pure Unscented', price: '30.00', quantity: 8, total_discount: '0.00',
      discount_allocations: [{ amount: '48.00' }],
    },
  ],
};

/** Soap, bought in a session that entered on the homepage. */
const SOAP_ON_HOMEPAGE = {
  id: 2, name: '#2341', created_at: '2026-08-02T12:00:00-07:00',
  total_price: '46.15', subtotal_price: '39.00',
  landing_site: '/', referring_site: 'https://duckduckgo.com/',
  line_items: [{
    title: 'Foaming Liquid Coconut Oil Soap | 8oz', product_id: 111,
    price: '39.00', quantity: 1, discount_allocations: [],
  }],
};

/** Same soap, but a paid click. */
const SOAP_PAID = {
  id: 3, name: '#2342', created_at: '2026-08-03T12:00:00-07:00',
  total_price: '39.00', subtotal_price: '39.00',
  landing_site: '/products/organic-foaming-hand-soap?gclid=EAIaIQabcdef1234567890',
  referring_site: 'https://www.google.com/',
  line_items: [{
    title: 'Foaming Liquid Coconut Oil Soap | 8oz', product_id: 111,
    price: '39.00', quantity: 1, discount_allocations: [],
  }],
};

/** The bundle config shape, trimmed to what the index needs. */
const BUNDLES = {
  bundles: [
    {
      handle: 'sensitive-skin-starter-set', title: 'Sensitive Skin Moisturizing Set', status: 'live',
      variants: [{
        options: { Title: 'Default Title' }, price: 46.8,
        components: [
          { product: 'coconut-moisturizer', variant: 'Pure Unscented', qty: 1 },
          { product: 'coconut-lotion', variant: 'Pure Unscented', qty: 1 },
        ],
      }],
    },
    {
      handle: 'hand-soap-set', title: 'Hand Soap Set', status: 'live',
      variants: [
        {
          options: { Size: '4 pumps', Scent: 'Pure Unscented' }, price: 52,
          components: [{ product: 'organic-foaming-hand-soap', qty: 4 }],
        },
        {
          options: { Size: '3 pumps + body lotion', Scent: 'Pure Unscented' }, price: 69,
          components: [
            { product: 'organic-foaming-hand-soap', qty: 3 },
            { product: 'coconut-lotion', qty: 1 },
          ],
        },
      ],
    },
    {
      // Title says "Coconut Reset" — assignCluster reads that as `coconut oil`.
      // Its components are entirely lotion, which is the point of expanding it.
      handle: '99-coconut-reset-digital', title: 'The 90-Day Coconut Reset', status: 'live',
      variants: [{
        options: { Scent: 'Pure Unscented' }, price: 99,
        components: [
          { product: 'coconut-lotion', qty: 1 },
          { product: 'coconut-moisturizer', qty: 1 },
        ],
      }],
    },
  ],
};

const CATALOG = {
  products: {
    'coconut-lotion': { title: 'Lightweight Coconut Lotion | 8oz', price: 24 },
    'coconut-moisturizer': { title: 'Coconut Moisturizer | 4oz', price: 28 },
    'organic-foaming-hand-soap': { title: 'Foaming Liquid Coconut Oil Soap | 8oz', price: 13 },
  },
};

const INDEX = buildBundleIndex(BUNDLES, CATALOG);

// ── line revenue ──────────────────────────────────────────────────────────────

test('line revenue is price x quantity net of allocated discounts', () => {
  const [lip, moist, lotion] = MULTI_LINE_ORDER.line_items;
  assert.equal(lineRevenue(lip), 12);
  assert.equal(lineRevenue(moist), 22.4);
  assert.equal(lineRevenue(lotion), 192);
});

test('line revenues sum to the order subtotal, never to total_price', () => {
  const sum = MULTI_LINE_ORDER.line_items.reduce((s, l) => s + lineRevenue(l), 0);
  assert.equal(Math.round(sum * 100) / 100, Number(MULTI_LINE_ORDER.subtotal_price));
  // Shipping and tax live only on the order, so a store where they are nonzero
  // must NOT be expected to reconcile against total_price.
  const shipped = { ...SOAP_ON_HOMEPAGE };
  const lineSum = shipped.line_items.reduce((s, l) => s + lineRevenue(l), 0);
  assert.equal(lineSum, 39);
  assert.notEqual(lineSum, Number(shipped.total_price));
});

test('total_discount is not added on top of discount_allocations', () => {
  // Live orders carry both fields; the allocations already contain the line
  // discount, and double-counting it would understate every discounted line.
  const l = { price: '30.00', quantity: 1, total_discount: '6.00', discount_allocations: [{ amount: '6.00' }] };
  assert.equal(lineRevenue(l), 24);
});

test('lineRevenue survives junk input rather than producing NaN', () => {
  assert.equal(lineRevenue(null), 0);
  assert.equal(lineRevenue({}), 0);
  assert.equal(lineRevenue({ price: 'abc', quantity: 'x' }), 0);
  assert.equal(lineRevenue({ price: '10.00' }), 10, 'a missing quantity means one');
});

// ── PII ───────────────────────────────────────────────────────────────────────

test('order lines carry title, product_id and revenue and nothing else', () => {
  const lines = orderLines(MULTI_LINE_ORDER);
  assert.equal(lines.length, 3);
  for (const l of lines) assert.deepEqual(Object.keys(l), ['title', 'product_id', 'revenue']);
});

test('classifyOrder now carries lines, and still carries no PII', () => {
  const c = classifyOrder({
    ...MULTI_LINE_ORDER,
    email: 'buyer@example.com',
    browser_ip: '203.0.113.9',
    customer: { id: 99, email: 'buyer@example.com', first_name: 'Dana' },
    shipping_address: { address1: '1 Main St', zip: '12345', name: 'Dana Doe' },
    line_items: MULTI_LINE_ORDER.line_items.map((l) => ({
      ...l, sku: 'RSC-LO-PU-08', vendor: 'Real Skin Care', properties: [{ name: 'gift note', value: 'love, Dana' }],
    })),
  });
  assert.equal(c.lines.length, 3);
  const serialized = JSON.stringify(c);
  for (const leak of ['buyer@example.com', '203.0.113.9', '1 Main St', 'Dana', 'love, Dana']) {
    assert.ok(!serialized.includes(leak), `${leak} leaked into the attribution record`);
  }
});

test('an order with no line items yields an empty lines array, not undefined', () => {
  const c = classifyOrder({ id: 9, total_price: '10.00', landing_site: '/' });
  assert.deepEqual(c.lines, []);
});

// ── bundle expansion ──────────────────────────────────────────────────────────

test('a single-cluster bundle is credited wholly to that cluster', () => {
  const split = splitLineToClusters(
    { title: 'Sensitive Skin Moisturizing Set', revenue: 46.8 }, INDEX,
  );
  assert.deepEqual(split, [{ cluster: 'lotion', revenue: 46.8 }]);
});

test('a bundle whose TITLE clusters wrongly is corrected by its components', () => {
  // "The 90-Day Coconut Reset" reads as `coconut oil` from the title alone.
  const split = splitLineToClusters({ title: 'The 90-Day Coconut Reset', revenue: 99 }, INDEX);
  assert.deepEqual(split.map((s) => s.cluster), ['lotion']);
  assert.equal(split[0].revenue, 99);
});

test('a multi-cluster bundle is split pro rata by component list value', () => {
  // 3 x hand soap @ $13 = $39 soap, 1 x lotion @ $24 = $24 lotion. Total $63.
  const split = splitLineToClusters(
    { title: 'Hand Soap Set', variant_title: '3 pumps + body lotion / Pure Unscented', revenue: 69 }, INDEX,
  );
  const by = Object.fromEntries(split.map((s) => [s.cluster, s.revenue]));
  assert.equal(Math.round(by.soap * 100) / 100, 42.71);   // 69 * 39/63
  assert.equal(Math.round(by.lotion * 100) / 100, 26.29); // 69 * 24/63
  assert.equal(Math.round((by.soap + by.lotion) * 100) / 100, 69, 'the split must allocate the whole line');
});

test('the variant decides the split when a bundle mixes categories per variant', () => {
  const soapOnly = splitLineToClusters(
    { title: 'Hand Soap Set', variant_title: '4 pumps / Pure Unscented', revenue: 52 }, INDEX,
  );
  assert.deepEqual(soapOnly, [{ cluster: 'soap', revenue: 52 }]);
});

test('an unrecognised variant falls back to the bundle average, never to nothing', () => {
  const split = splitLineToClusters(
    { title: 'Hand Soap Set', variant_title: 'a variant nobody configured', revenue: 60 }, INDEX,
  );
  assert.ok(split.length >= 1);
  assert.equal(Math.round(split.reduce((s, r) => s + r.revenue, 0) * 100) / 100, 60);
  assert.ok(split.every((s) => s.cluster));
});

test('a non-bundle line is clustered from its title', () => {
  assert.deepEqual(
    splitLineToClusters({ title: 'Foaming Liquid Coconut Oil Soap | 8oz', revenue: 39 }, INDEX),
    [{ cluster: 'soap', revenue: 39 }],
  );
});

test('a line that matches no cluster is reported as null, not dropped', () => {
  const split = splitLineToClusters({ title: 'Cut and Scrape', revenue: 4.5 }, INDEX);
  assert.deepEqual(split, [{ cluster: null, revenue: 4.5 }]);
});

test('buildBundleIndex tolerates a missing catalog and weights by quantity', () => {
  const idx = buildBundleIndex(BUNDLES, null);
  const split = splitLineToClusters(
    { title: 'Hand Soap Set', variant_title: '3 pumps + body lotion / Pure Unscented', revenue: 80 }, idx,
  );
  const by = Object.fromEntries(split.map((s) => [s.cluster, s.revenue]));
  assert.equal(by.soap, 60);   // 3 of 4 units
  assert.equal(by.lotion, 20); // 1 of 4 units
});

test('buildBundleIndex on empty/absent config yields an index that never expands', () => {
  for (const cfg of [null, {}, { bundles: [] }]) {
    const idx = buildBundleIndex(cfg, CATALOG);
    assert.deepEqual(
      splitLineToClusters({ title: 'Hand Soap Set', revenue: 52 }, idx),
      [{ cluster: 'soap', revenue: 52 }], 'falls back to title clustering',
    );
  }
});

// ── the rollup ────────────────────────────────────────────────────────────────

const ROWS = attributionRows([MULTI_LINE_ORDER, SOAP_ON_HOMEPAGE, SOAP_PAID]);

test('a soap bought in a homepage-entered organic session is soap revenue', () => {
  const r = clusterProductRevenue(ROWS, { channels: ['organic-search'], bundleIndex: INDEX });
  // Entry-page attribution puts this order's $46.15 on `/`, which matches no
  // cluster at all. Product attribution puts its $39 subtotal on soap.
  assert.equal(r.byCluster.soap.revenue, 39);
  assert.equal(r.byCluster.soap.orders, 1);
});

test('channel is a property of the ORDER, so the paid soap order is excluded from organic', () => {
  const organic = clusterProductRevenue(ROWS, { channels: ['organic-search'], bundleIndex: INDEX });
  const all = clusterProductRevenue(ROWS, { channels: null, bundleIndex: INDEX });
  assert.equal(organic.byCluster.soap.revenue, 39);
  assert.equal(all.byCluster.soap.revenue, 78);
});

test('a multi-line order splits across clusters by line revenue', () => {
  const r = clusterProductRevenue([ROWS[0]], { channels: null, bundleIndex: INDEX });
  assert.equal(r.byCluster.lotion.revenue, 214.4); // 22.40 moisturizer + 192.00 lotion
  assert.equal(r.byCluster['lip balm'].revenue, 12);
  // One order, counted once per cluster it touched — never once per line.
  assert.equal(r.byCluster.lotion.orders, 1);
  assert.equal(r.orders, 1);
});

test('the rollup reconciles to line subtotals and says so, and never to order totals', () => {
  const r = clusterProductRevenue(ROWS, { channels: null, bundleIndex: INDEX });
  const clusterSum = Object.values(r.byCluster).reduce((s, c) => s + c.revenue, 0);
  assert.equal(Math.round((clusterSum + r.unclustered) * 100) / 100, r.subtotal);
  assert.equal(r.subtotal, 304.4); // 226.40 + 39.00 + 39.00
  assert.equal(r.orderTotals, 311.55); // 226.40 + 46.15 + 39.00
  // The gap is shipping/tax/etc. Reported, never reconciled away.
  assert.equal(r.nonProductRevenue, 7.15);
  assert.equal(r.basis, PRODUCT_REVENUE_BASIS);
});

test('test, cancelled and $0 orders are excluded exactly as elsewhere', () => {
  const rows = attributionRows([
    SOAP_ON_HOMEPAGE,
    { ...SOAP_ON_HOMEPAGE, id: 20, cancelled_at: '2026-08-02T13:00:00-07:00' },
    { ...SOAP_ON_HOMEPAGE, id: 21, discount_codes: [{ code: 'TEST50' }] },
  ]);
  const r = clusterProductRevenue(rows, { channels: null, bundleIndex: INDEX });
  assert.equal(r.byCluster.soap.revenue, 39);
  assert.equal(r.orders, 1);
});

test('a row with no lines contributes orders but no product revenue', () => {
  // Subscription orders arrive with landingPath null; some legacy rows predate
  // line capture entirely. Neither may silently become $0 in a cluster.
  const rows = [{ ...ROWS[1], lines: [] }];
  const r = clusterProductRevenue(rows, { channels: null, bundleIndex: INDEX });
  assert.deepEqual(r.byCluster, {});
  assert.equal(r.ordersWithoutLines, 1);
});

// ── report rows ───────────────────────────────────────────────────────────────

test('productClusterRows unions organic, all-channel and prior windows per cluster', () => {
  const cur = clusterProductRevenue(ROWS, { channels: ['organic-search'], bundleIndex: INDEX });
  const curAll = clusterProductRevenue(ROWS, { channels: null, bundleIndex: INDEX });
  const prior = clusterProductRevenue([ROWS[1]], { channels: ['organic-search'], bundleIndex: INDEX });
  const rows = productClusterRows({ organic: cur, allChannels: curAll, priorOrganic: prior });
  const soap = rows.find((r) => r.cluster === 'soap');
  assert.equal(soap.product_organic_revenue, 39);
  assert.equal(soap.product_revenue_all_channels, 78);
  assert.equal(soap.product_organic_revenue_prev, 39);
  assert.equal(soap.product_organic_revenue_delta, 0);
  const lotion = rows.find((r) => r.cluster === 'lotion');
  assert.equal(lotion.product_organic_revenue_prev, 0);
  assert.equal(lotion.product_organic_revenue_delta, 214.4);
  assert.deepEqual(rows.map((r) => r.cluster), ['lotion', 'soap', 'lip balm'], 'sorted by all-channel revenue');
});

test('productClusterRows never emits a null cluster row', () => {
  const cur = clusterProductRevenue(
    attributionRows([{ ...SOAP_ON_HOMEPAGE, id: 30, line_items: [{ title: 'Cut and Scrape', price: '5.00', quantity: 1 }] }]),
    { channels: null, bundleIndex: INDEX },
  );
  assert.deepEqual(productClusterRows({ organic: cur, allChannels: cur, priorOrganic: cur }), []);
});

// ── merging into the report's clusters[] ──────────────────────────────────────

const ENTRY_ROWS = [
  {
    cluster: 'lotion', revenue: 313.49, entry_page_organic_revenue: 313.49,
    revenuePrev: 100, revenueDelta: 213.49, clicks: 900, pages: 30,
  },
  {
    cluster: 'toothpaste', revenue: 0, entry_page_organic_revenue: 0,
    revenuePrev: 0, revenueDelta: 0, clicks: 663, pages: 24,
  },
];

test('merging preserves every entry-page field byte for byte', () => {
  const merged = mergeClusterRows(ENTRY_ROWS, [
    { cluster: 'lotion', product_organic_revenue: 357, product_revenue_all_channels: 755.3 },
  ]);
  const lotion = merged.find((r) => r.cluster === 'lotion');
  for (const k of ['revenue', 'entry_page_organic_revenue', 'revenuePrev', 'revenueDelta', 'clicks', 'pages']) {
    assert.equal(lotion[k], ENTRY_ROWS[0][k], `${k} must not move`);
  }
  assert.equal(lotion.product_revenue_all_channels, 755.3);
});

test('a cluster that sold with no clustered entry page still gets a row', () => {
  const merged = mergeClusterRows(ENTRY_ROWS, [
    { cluster: 'deodorant', product_organic_revenue: 36, product_revenue_all_channels: 46.5 },
  ]);
  const deo = merged.find((r) => r.cluster === 'deodorant');
  assert.ok(deo, 'a category that sold must not be invisible');
  assert.equal(deo.entry_page_organic_revenue, 0);
  assert.equal(deo.clicks, 0);
  assert.equal(deo.pages, 0);
});

test('a new zero-click row can never become a proven_dud', () => {
  // The dud gate is a hard block in four consumers, one of which archives
  // paid-for research. Adding rows must not hand it new victims.
  const merged = mergeClusterRows(ENTRY_ROWS, [
    { cluster: 'deodorant', product_organic_revenue: 0, product_revenue_all_channels: 0 },
  ]);
  const classified = classifyClusters(merged, { totals: { organic_conversions: 8 } });
  assert.equal(classified.deodorant.status, 'unproven');
  // ...and the pre-existing verdicts are untouched.
  assert.equal(classified.toothpaste.status, 'proven_dud');
  assert.equal(classified.lotion.status, 'earning');
});

test('clusters[] is ordered by what the category actually sold', () => {
  const merged = mergeClusterRows(ENTRY_ROWS, [
    { cluster: 'lotion', product_organic_revenue: 357, product_revenue_all_channels: 755.3 },
    { cluster: 'toothpaste', product_organic_revenue: 35.1, product_revenue_all_channels: 71.5 },
    { cluster: 'soap', product_organic_revenue: 62.4, product_revenue_all_channels: 123.5 },
  ]);
  assert.deepEqual(merged.map((r) => r.cluster), ['lotion', 'soap', 'toothpaste']);
});

// ── the real product catalogue ────────────────────────────────────────────────

test('every product Real Skin Care actually sells maps to a product cluster', async () => {
  // The nine titles that carried revenue over the trailing 200 days, verbatim
  // from live orders on 2026-08-23. If a rename breaks one of these, the whole
  // cluster silently reads low — which is the class of bug this module fixes.
  const LIVE_TITLES = {
    'Non-Toxic Body Lotion Made With Only 6 Clean Ingredients': 'lotion',
    'Coconut Moisturizer | 4oz': 'lotion',
    'Lightweight Coconut Lotion | 8oz': 'lotion',
    'Foaming Liquid Coconut Oil Soap | 8oz': 'soap',
    'Foam Soap Refill | 32oz': 'soap',
    'Moisturizing Coconut Soap | 3.4oz': 'soap',
    'Natural Coconut Oil Lip Balm | 0.15oz | Four Pack': 'lip balm',
    'Best Coconut Oil Deodorant — All Natural Formula | 2oz': 'deodorant',
    'All Natural Coconut Oil Deodorant | 2oz': 'deodorant',
    'Coconut Oil Toothpaste — Natural Oral Care, Fluoride Free': 'toothpaste',
    'Coconut Oil Toothpaste | Fluoride Free | 4oz': 'toothpaste',
    'Sensitive Skin Moisturizing Set': 'lotion',
  };
  for (const [title, expected] of Object.entries(LIVE_TITLES)) {
    const split = splitLineToClusters({ title, revenue: 10 }, INDEX);
    assert.equal(split.length, 1, `${title} should not split`);
    assert.equal(split[0].cluster, expected, `${title} → ${split[0].cluster}, expected ${expected}`);
  }
});

test('every LIVE bundle in config/bundles.json resolves to at least one product cluster', async () => {
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const bundles = JSON.parse(readFileSync(join(root, 'config', 'bundles.json'), 'utf8'));
  const catalog = JSON.parse(readFileSync(join(root, 'data', 'brand', 'product-catalog.json'), 'utf8'));
  const idx = buildBundleIndex(bundles, catalog);
  for (const b of bundles.bundles.filter((x) => x.status === 'live')) {
    const split = splitLineToClusters({ title: b.title, revenue: 100 }, idx);
    assert.ok(split.length && split.every((s) => s.cluster),
      `live bundle "${b.title}" resolves to ${JSON.stringify(split)}`);
    assert.equal(Math.round(split.reduce((s, r) => s + r.revenue, 0) * 100) / 100, 100,
      `live bundle "${b.title}" must allocate its whole line`);
  }
});
