import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  pathOf,
  organicByPage,
  mergeRevenueSources,
  buildPageImpacts,
  clusterRollup,
  actionWins,
  rankBy,
} from '../../lib/seo-impact.js';
import { shopifyRevenueByPage, attributionRows } from '../../lib/order-attribution.js';

// ── pathOf: normalize URLs/paths to a single join key ─────────────────────────

test('pathOf: strips origin and trailing slash, lowercases', () => {
  assert.equal(pathOf('https://www.realskincare.com/blogs/news/x/'), '/blogs/news/x');
  assert.equal(pathOf('/blogs/news/x'), '/blogs/news/x');
  assert.equal(pathOf('https://www.realskincare.com/'), '/');
  assert.equal(pathOf(''), null);
  assert.equal(pathOf(null), null);
});

// ── organicByPage: isolate organic revenue per landing page ───────────────────

test('organicByPage: keeps only the organic channel and aggregates by page', () => {
  const rows = [
    { page: '/blogs/news/a', channel: 'Organic Search', sessions: 10, conversions: 1, revenue: 50 },
    { page: '/blogs/news/a', channel: 'Direct',         sessions: 5,  conversions: 0, revenue: 0 },
    { page: '/blogs/news/b', channel: 'Organic Search', sessions: 8,  conversions: 2, revenue: 80 },
  ];
  const m = organicByPage(rows);
  assert.equal(m.get('/blogs/news/a').revenue, 50);   // direct row excluded
  assert.equal(m.get('/blogs/news/b').revenue, 80);
  assert.equal(m.has('/blogs/news/a'), true);
});

test('organicByPage: sums duplicate organic rows for the same page', () => {
  const rows = [
    { page: '/x', channel: 'Organic Search', sessions: 3, conversions: 1, revenue: 30 },
    { page: '/x', channel: 'Organic Search', sessions: 2, conversions: 0, revenue: 10 },
  ];
  const m = organicByPage(rows);
  assert.equal(m.get('/x').sessions, 5);
  assert.equal(m.get('/x').revenue, 40);
});

// ── mergeRevenueSources: Shopify dollars + GA4 sessions ───────────────────────

const mapOf = (obj) => new Map(Object.entries(obj));

test('mergeRevenueSources: revenue and conversions come from Shopify, sessions from GA4', () => {
  const merged = mergeRevenueSources(
    mapOf({ '/a': { sessions: 120, conversions: 4, revenue: 310.5 } }),   // GA4, modelled
    mapOf({ '/a': { sessions: 0, conversions: 2, revenue: 99.98 } }),     // Shopify, truth
  );
  const a = merged.get('/a');
  assert.equal(a.revenue, 99.98);        // Shopify wins the dollars
  assert.equal(a.conversions, 2);        // Shopify wins the order count
  assert.equal(a.sessions, 120);         // GA4 keeps sessions — Shopify has none
  assert.equal(a.revenueGa4, 310.5);     // GA4 figure preserved, not dropped
  assert.equal(a.conversionsGa4, 4);
});

test('mergeRevenueSources: a page with orders but no GA4 row still reports its revenue', () => {
  // Happens for real: a search engine GA4 does not classify as Organic Search
  // (duckduckgo/brave arriving as referral), so the order exists with no organic session.
  const merged = mergeRevenueSources(
    new Map(),
    mapOf({ '/products/x': { sessions: 0, conversions: 1, revenue: 46.8 } }),
  );
  assert.equal(merged.get('/products/x').revenue, 46.8);
  assert.equal(merged.get('/products/x').sessions, 0);
});

test('mergeRevenueSources: GA4 traffic with no Shopify order is $0, not GA4-modelled dollars', () => {
  const merged = mergeRevenueSources(
    mapOf({ '/blogs/news/toothpaste': { sessions: 240, conversions: 3, revenue: 85 } }),
    new Map(),
  );
  const r = merged.get('/blogs/news/toothpaste');
  assert.equal(r.revenue, 0);          // no order was placed, so no revenue
  assert.equal(r.revenueGa4, 85);      // ...but we can still see what GA4 claimed
  assert.equal(r.sessions, 240);       // and the traffic, so "not converting" still fires
});

test('mergeRevenueSources: tolerates missing maps', () => {
  assert.equal(mergeRevenueSources(null, null).size, 0);
});

// ── the join that matters: GA4 revenue must never drive a decision ────────────

test('a GA4-only revenue page is still detected as high-traffic-no-sales', () => {
  // The regression this whole change guards against: GA4 crediting a blog post with
  // revenue used to hide it from the "traffic, no sales" list, which is the single
  // report the Prime Directive cares about most.
  const ga4 = organicByPage([
    { page: '/blogs/news/toothpaste', channel: 'Organic Search', sessions: 240, conversions: 3, revenue: 85 },
  ]);
  const shopify = shopifyRevenueByPage(attributionRows([
    // A real organic order — but it landed on the collection, not the blog post.
    {
      id: 1, total_price: '46.80', created_at: '2026-08-01T00:00:00Z', source_name: 'web',
      landing_site: '/collections/sensitive-skin', referring_site: 'https://www.google.com/',
    },
  ]));
  const merged = mergeRevenueSources(ga4, shopify);
  const impacts = buildPageImpacts({ current: merged, prior: new Map() });
  const notConverting = impacts.filter((i) => i.sessions >= 30 && i.revenue === 0);
  assert.deepEqual(notConverting.map((i) => i.path), ['/blogs/news/toothpaste']);
  const collection = impacts.find((i) => i.path === '/collections/sensitive-skin');
  assert.equal(collection.revenue, 46.8);
  assert.equal(collection.conversions, 1);
});

// ── buildPageImpacts: window deltas + action join ─────────────────────────────

test('buildPageImpacts: computes revenue/clicks deltas vs the prior window', () => {
  const impacts = buildPageImpacts({
    current: mapOf({ '/a': { sessions: 10, conversions: 2, revenue: 100 } }),
    prior:   mapOf({ '/a': { sessions: 6,  conversions: 1, revenue: 60 } }),
    gscCurrent: mapOf({ '/a': { clicks: 120, impressions: 3000 } }),
    gscPrior:   mapOf({ '/a': { clicks: 80,  impressions: 2500 } }),
    actionsByPath: new Map(),
  });
  const a = impacts.find((i) => i.path === '/a');
  assert.equal(a.revenue, 100);
  assert.equal(a.revenueDelta, 40);
  assert.equal(a.clicks, 120);
  assert.equal(a.clicksDelta, 40);
});

test('buildPageImpacts: a brand-new page (no prior) shows full revenue as the delta', () => {
  const impacts = buildPageImpacts({
    current: mapOf({ '/new': { sessions: 5, conversions: 1, revenue: 75 } }),
    prior: new Map(),
    gscCurrent: mapOf({ '/new': { clicks: 40, impressions: 900 } }),
    gscPrior: new Map(),
    actionsByPath: new Map(),
  });
  const r = impacts.find((i) => i.path === '/new');
  assert.equal(r.revenuePrev, 0);
  assert.equal(r.revenueDelta, 75);
  assert.equal(r.clicksPrev, 0);
});

test('buildPageImpacts: carries GA4 revenue through both windows without letting it move the delta', () => {
  const impacts = buildPageImpacts({
    current: mapOf({ '/a': { sessions: 10, conversions: 1, revenue: 50, revenueGa4: 400 } }),
    prior:   mapOf({ '/a': { sessions: 8,  conversions: 0, revenue: 0,  revenueGa4: 300 } }),
  });
  const a = impacts[0];
  assert.equal(a.revenue, 50);
  assert.equal(a.revenueDelta, 50);      // driven by Shopify (50-0), NOT GA4 (400-300)
  assert.equal(a.revenueGa4, 400);
  assert.equal(a.revenueGa4Prev, 300);
});

test('buildPageImpacts: a page with no GA4 figure reports revenueGa4 0, not undefined', () => {
  const impacts = buildPageImpacts({
    current: mapOf({ '/a': { sessions: 0, conversions: 1, revenue: 25 } }),
    prior: new Map(),
  });
  assert.equal(impacts[0].revenueGa4, 0);
  assert.equal(impacts[0].revenueGa4Prev, 0);
});

test('buildPageImpacts: attaches the SEO action taken on a page during the window', () => {
  const impacts = buildPageImpacts({
    current: mapOf({ '/a': { sessions: 10, conversions: 2, revenue: 100 } }),
    prior:   mapOf({ '/a': { sessions: 6,  conversions: 1, revenue: 60 } }),
    gscCurrent: new Map(), gscPrior: new Map(),
    actionsByPath: mapOf({ '/a': { type: 'refresh', date: '2026-06-01' } }),
  });
  assert.deepEqual(impacts[0].action, { type: 'refresh', date: '2026-06-01' });
});

// ── actionWins: actions that were followed by a lift ──────────────────────────

test('actionWins: surfaces pages with an action AND a positive revenue or clicks delta', () => {
  const impacts = [
    { path: '/a', action: { type: 'refresh' }, revenueDelta: 40, clicksDelta: 10 },
    { path: '/b', action: { type: 'refresh' }, revenueDelta: -5, clicksDelta: -2 }, // acted, no lift
    { path: '/c', action: null, revenueDelta: 99, clicksDelta: 50 },                // lift, no action
    { path: '/d', action: { type: 'new-post' }, revenueDelta: 0, clicksDelta: 30 }, // clicks lift only
  ];
  const wins = actionWins(impacts);
  assert.deepEqual(wins.map((w) => w.path).sort(), ['/a', '/d']);
});

// ── clusterRollup ─────────────────────────────────────────────────────────────

test('clusterRollup: aggregates revenue by cluster and sorts by revenue', () => {
  const impacts = [
    { path: '/blogs/news/best-toothpaste', revenue: 100, revenuePrev: 60 },
    { path: '/blogs/news/sls-free-toothpaste', revenue: 50, revenuePrev: 40 },
    { path: '/blogs/news/best-deodorant', revenue: 200, revenuePrev: 150 },
  ];
  const clusterFor = (p) => (p.includes('toothpaste') ? 'toothpaste' : p.includes('deodorant') ? 'deodorant' : null);
  const rollup = clusterRollup(impacts, clusterFor);
  assert.equal(rollup[0].cluster, 'deodorant');     // highest revenue first
  assert.equal(rollup[0].revenue, 200);
  const toothpaste = rollup.find((r) => r.cluster === 'toothpaste');
  assert.equal(toothpaste.revenue, 150);
  assert.equal(toothpaste.revenueDelta, 50);        // (100-60)+(50-40)
  assert.equal(toothpaste.pages, 2);
});

test('clusterRollup: aggregates the GA4 comparison figure alongside Shopify revenue', () => {
  const impacts = [
    { path: '/blogs/news/best-toothpaste', revenue: 0, revenuePrev: 0, revenueGa4: 120 },
    { path: '/blogs/news/sls-free-toothpaste', revenue: 0, revenuePrev: 0, revenueGa4: 30 },
  ];
  const rollup = clusterRollup(impacts, (p) => (p.includes('toothpaste') ? 'toothpaste' : null));
  assert.equal(rollup[0].revenue, 0);        // the real number: this cluster earns nothing
  assert.equal(rollup[0].revenueGa4, 150);   // what GA4 claimed it earned
});

// ── rankBy ────────────────────────────────────────────────────────────────────

test('rankBy: sorts descending by the given key and respects limit', () => {
  const rows = [{ r: 1 }, { r: 9 }, { r: 5 }];
  assert.deepEqual(rankBy(rows, 'r').map((x) => x.r), [9, 5, 1]);
  assert.deepEqual(rankBy(rows, 'r', 2).map((x) => x.r), [9, 5]);
});
