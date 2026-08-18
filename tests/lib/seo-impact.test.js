import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  pathOf,
  isSearchEngineSource,
  isOrganicSessionRow,
  organicSessionsByPage,
  mergeRevenueSources,
  buildPageImpacts,
  clusterRollup,
  actionWins,
  rankBy,
} from '../../lib/seo-impact.js';
import { shopifyRevenueByPage, attributionRows, SEARCH_HOSTS } from '../../lib/order-attribution.js';

// ── pathOf: normalize URLs/paths to a single join key ─────────────────────────

test('pathOf: strips origin and trailing slash, lowercases', () => {
  assert.equal(pathOf('https://www.realskincare.com/blogs/news/x/'), '/blogs/news/x');
  assert.equal(pathOf('/blogs/news/x'), '/blogs/news/x');
  assert.equal(pathOf('https://www.realskincare.com/'), '/');
  assert.equal(pathOf(''), null);
  assert.equal(pathOf(null), null);
});

test('pathOf: GA4 bucket labels are not pages', () => {
  // `(not set)` was reaching the report's "high traffic, $0 revenue" action list with
  // 35 sessions, as though there were a page there to go and fix.
  assert.equal(pathOf('(not set)'), null);
  assert.equal(pathOf('(other)'), null);
  assert.equal(pathOf(' (not set) '), null);
  // A real path that merely contains parentheses is untouched.
  assert.equal(pathOf('/blogs/news/x-(2026)'), '/blogs/news/x-(2026)');
});

test('pathOf: dropping (not set) also keeps it out of the page aggregate', () => {
  const m = organicSessionsByPage([
    { page: '(not set)', channel: 'Organic Search', source: 'google', sessions: 35 },
    { page: '/blogs/news/a', channel: 'Organic Search', source: 'google', sessions: 12 },
  ]);
  assert.deepEqual([...m.keys()], ['/blogs/news/a']);
});

// ── search-source rescue: engines GA4 misfiles as Referral ────────────────────

test('isSearchEngineSource: recognises hosts from order-attribution SEARCH_HOSTS', () => {
  assert.equal(isSearchEngineSource('search.brave.com'), true);
  assert.equal(isSearchEngineSource('duckduckgo.com'), true);
  assert.equal(isSearchEngineSource('www.ecosia.org'), true);
  assert.equal(isSearchEngineSource('https://search.brave.com/'), true);
  // GA4 normalizes some sources to a bare engine name rather than a hostname.
  assert.equal(isSearchEngineSource('brave'), true);
  assert.equal(isSearchEngineSource('google'), true);
  // Not search engines.
  assert.equal(isSearchEngineSource('reddit.com'), false);
  assert.equal(isSearchEngineSource('(direct)'), false);
  assert.equal(isSearchEngineSource(''), false);
  assert.equal(isSearchEngineSource(null), false);
});

test('isSearchEngineSource is driven by SEARCH_HOSTS, not a second hardcoded list', () => {
  // Every host the order classifier calls organic must also make its sessions organic,
  // or a page shows revenue with no traffic behind it.
  for (const host of SEARCH_HOSTS) {
    assert.equal(isSearchEngineSource(host), true, `${host} must count as an organic source`);
  }
});

test('isOrganicSessionRow: Brave arrives as Referral and is still organic', () => {
  assert.equal(isOrganicSessionRow(
    { channel: 'Referral', source: 'search.brave.com' }), true);
  assert.equal(isOrganicSessionRow(
    { channel: 'Organic Search', source: 'google' }), true);
  // A plain referral is still a referral.
  assert.equal(isOrganicSessionRow({ channel: 'Referral', source: 'reddit.com' }), false);
});

test('isOrganicSessionRow: a PAID google click is never rescued as organic', () => {
  // The trap in widening the filter: `google` is a search host, and Paid Search sessions
  // carry it as their source. Only the Referral channel is eligible for rescue.
  assert.equal(isOrganicSessionRow({ channel: 'Paid Search', source: 'google' }), false);
  assert.equal(isOrganicSessionRow({ channel: 'Cross-network', source: 'google' }), false);
  assert.equal(isOrganicSessionRow({ channel: 'Display', source: 'google' }), false);
  assert.equal(isOrganicSessionRow(null), false);
});

// ── organicSessionsByPage: organic SESSIONS per landing page ──────────────────

test('organicSessionsByPage: keeps only organic rows and aggregates by page', () => {
  const rows = [
    { page: '/blogs/news/a', channel: 'Organic Search', source: 'google', sessions: 10 },
    { page: '/blogs/news/a', channel: 'Direct',         source: '(direct)', sessions: 5 },
    { page: '/blogs/news/b', channel: 'Organic Search', source: 'bing', sessions: 8 },
  ];
  const m = organicSessionsByPage(rows);
  assert.equal(m.get('/blogs/news/a').sessions, 10);   // direct row excluded
  assert.equal(m.get('/blogs/news/b').sessions, 8);
});

test('organicSessionsByPage: sums duplicate organic rows for the same page', () => {
  const rows = [
    { page: '/x', channel: 'Organic Search', source: 'google', sessions: 3 },
    { page: '/x', channel: 'Organic Search', source: 'bing', sessions: 2 },
  ];
  assert.equal(organicSessionsByPage(rows).get('/x').sessions, 5);
});

test('organicSessionsByPage: Brave sessions land on the same page as its Google sessions', () => {
  // The defect: Brave revenue was counted (Shopify) while Brave traffic was not (GA4),
  // so the page reported dollars against a session count that was too low.
  const rows = [
    { page: '/collections/sensitive-skin', channel: 'Organic Search', source: 'google', sessions: 40 },
    { page: '/collections/sensitive-skin', channel: 'Referral', source: 'search.brave.com', sessions: 6 },
    { page: '/collections/sensitive-skin', channel: 'Referral', source: 'reddit.com', sessions: 25 },
  ];
  assert.equal(organicSessionsByPage(rows).get('/collections/sensitive-skin').sessions, 46);
});

// ── mergeRevenueSources: Shopify dollars + GA4 sessions ───────────────────────

const mapOf = (obj) => new Map(Object.entries(obj));

test('mergeRevenueSources: revenue and conversions come from Shopify, sessions from GA4', () => {
  const merged = mergeRevenueSources(
    mapOf({ '/a': { sessions: 120 } }),                                  // GA4: traffic only
    mapOf({ '/a': { sessions: 0, conversions: 2, revenue: 99.98 } }),     // Shopify, truth
  );
  const a = merged.get('/a');
  assert.equal(a.revenue, 99.98);        // Shopify wins the dollars
  assert.equal(a.conversions, 2);        // Shopify wins the order count
  assert.equal(a.sessions, 120);         // GA4 keeps sessions — Shopify has none
});

test('mergeRevenueSources: GA4 revenue is not carried, even when the map still has it', () => {
  // The modelled figure rode along for one release so the gap could be measured. It was
  // (GA4 understated 28d organic revenue by 71%), so nothing downstream may read it again.
  const merged = mergeRevenueSources(
    mapOf({ '/a': { sessions: 120, conversions: 4, revenue: 310.5 } }),
    mapOf({ '/a': { conversions: 2, revenue: 99.98 } }),
  );
  const a = merged.get('/a');
  assert.equal(a.revenueGa4, undefined);
  assert.equal(a.conversionsGa4, undefined);
  assert.deepEqual(Object.keys(a).sort(), ['conversions', 'revenue', 'sessions']);
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
  assert.equal(r.sessions, 240);       // the traffic survives, so "not converting" fires
});

test('mergeRevenueSources: tolerates missing maps', () => {
  assert.equal(mergeRevenueSources(null, null).size, 0);
});

// ── the join that matters: GA4 revenue must never drive a decision ────────────

test('a GA4-only revenue page is still detected as high-traffic-no-sales', () => {
  // The regression this whole change guards against: GA4 crediting a blog post with
  // revenue used to hide it from the "traffic, no sales" list, which is the single
  // report the Prime Directive cares about most.
  const ga4 = organicSessionsByPage([
    { page: '/blogs/news/toothpaste', channel: 'Organic Search', source: 'google', sessions: 240 },
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

test('buildPageImpacts: emits no GA4 revenue fields for any consumer to read', () => {
  const impacts = buildPageImpacts({
    current: mapOf({ '/a': { sessions: 10, conversions: 1, revenue: 50, revenueGa4: 400 } }),
    prior:   mapOf({ '/a': { sessions: 8,  conversions: 0, revenue: 0,  revenueGa4: 300 } }),
  });
  const a = impacts[0];
  assert.equal(a.revenue, 50);
  assert.equal(a.revenueDelta, 50);      // driven by Shopify (50-0), NOT GA4 (400-300)
  assert.equal('revenueGa4' in a, false);
  assert.equal('revenueGa4Prev' in a, false);
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

test('clusterRollup: reports clicks beside revenue, and no GA4 figure', () => {
  const impacts = [
    { path: '/blogs/news/best-toothpaste', revenue: 0, revenuePrev: 0, revenueGa4: 120, clicks: 200 },
    { path: '/blogs/news/sls-free-toothpaste', revenue: 0, revenuePrev: 0, revenueGa4: 30, clicks: 68 },
  ];
  const rollup = clusterRollup(impacts, (p) => (p.includes('toothpaste') ? 'toothpaste' : null));
  assert.equal(rollup[0].revenue, 0);        // the real number: this cluster earns nothing
  assert.equal(rollup[0].clicks, 268);       // ...on this much visibility
  assert.equal('revenueGa4' in rollup[0], false);
});

// ── rankBy ────────────────────────────────────────────────────────────────────

test('rankBy: sorts descending by the given key and respects limit', () => {
  const rows = [{ r: 1 }, { r: 9 }, { r: 5 }];
  assert.deepEqual(rankBy(rows, 'r').map((x) => x.r), [9, 5, 1]);
  assert.deepEqual(rankBy(rows, 'r', 2).map((x) => x.r), [9, 5]);
});
