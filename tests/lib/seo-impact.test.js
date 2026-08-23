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
  residualRollup,
  actionWins,
  rankBy,
  weeklyRevenueTrend,
  entryPageClusterRevenue,
  withWideEntryPageRevenue,
} from '../../lib/seo-impact.js';
import { shopifyRevenueByPage, attributionRows, SEARCH_HOSTS } from '../../lib/order-attribution.js';
// The real Pacific day resolver the agent injects — DST-correct, and the same one the
// daily Shopify snapshots bucket by. Importing the collector is safe: its main() is
// behind a direct-invocation guard (tests/agents/shopify-collector.test.js asserts that).
import { ptDayOf } from '../../agents/shopify-collector/index.js';

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

test('clusterRollup: emits entry_page_organic_revenue as the canonical field', () => {
  // `revenue` read as product revenue for a category, which it never was — that
  // misreading is what let a $430 category be recorded as $0. Both names carry
  // the same number so unmigrated consumers keep working.
  const rollup = clusterRollup([{ path: '/x-soap', revenue: 62.4, revenuePrev: 0 }], () => 'soap');
  assert.equal(rollup[0].entry_page_organic_revenue, 62.4);
  assert.equal(rollup[0].revenue, 62.4);
});

// ── residualRollup ────────────────────────────────────────────────────────────
// clusterRollup skips every page matching no cluster, so the cluster table has
// never summed to totals.organic_revenue and never said so. On the 2026-08-22
// report that gap is $77.94 (the homepage); over 90 days it is $1,152.50, 54% of
// the store. An invisible majority is what makes the table look like it ought to
// reconcile to product revenue.

test('residualRollup: everything the cluster table drops on the floor', () => {
  const impacts = [
    { path: '/', revenue: 77.94, revenuePrev: 10, clicks: 40 },
    { path: '/cart', revenue: 0, revenuePrev: 0, clicks: 3 },
    { path: '/blogs/news/best-soap', revenue: 62.4, revenuePrev: 0, clicks: 4 },
  ];
  const clusterFor = (p) => (p.includes('soap') ? 'soap' : null);
  const r = residualRollup(impacts, clusterFor);
  assert.equal(r.entry_page_organic_revenue, 77.94);
  assert.equal(r.revenue, 77.94);
  assert.equal(r.revenueDelta, 67.94);
  assert.equal(r.pages, 2, 'both unclustered pages are counted, earning or not');
  assert.equal(r.clicks, 43);
  assert.match(r.label, /no cluster/i);
  assert.deepEqual(r.top_pages, [{ path: '/', revenue: 77.94 }]);
});

test('residualRollup + clusterRollup reconcile to the organic total', () => {
  // The real 2026-08-22 numbers: $462.14 clustered + $77.94 residual = $540.08.
  const impacts = [
    { path: '/blogs/news/best-non-toxic-body-lotion-2025', revenue: 262.39, revenuePrev: 0 },
    { path: '/collections/non-toxic-body-lotion', revenue: 51.1, revenuePrev: 0 },
    { path: '/products/organic-foaming-hand-soap', revenue: 62.4, revenuePrev: 0 },
    { path: '/blogs/news/best-vegan-lip-balm-natural-picks-for-soft-lips', revenue: 48, revenuePrev: 0 },
    { path: '/blogs/news/coconut-oil-deodorant-does-it-work-is-it-safe', revenue: 20.99, revenuePrev: 0 },
    { path: '/blogs/news/best-native-deodorant-alternatives-natural-options-that-work', revenue: 17.26, revenuePrev: 0 },
    { path: '/', revenue: 77.94, revenuePrev: 0 },
  ];
  const clusterFor = (p) => (p === '/' ? null : 'x');
  const clustered = clusterRollup(impacts, clusterFor)
    .reduce((s, c) => s + c.entry_page_organic_revenue, 0);
  const residual = residualRollup(impacts, clusterFor).entry_page_organic_revenue;
  assert.equal(Math.round(clustered * 100) / 100, 462.14);
  assert.equal(residual, 77.94);
  assert.equal(Math.round((clustered + residual) * 100) / 100, 540.08);
});

test('residualRollup: no unclustered pages is a clean zero, not a missing key', () => {
  const r = residualRollup([{ path: '/a-soap', revenue: 5 }], () => 'soap');
  assert.equal(r.entry_page_organic_revenue, 0);
  assert.equal(r.pages, 0);
  assert.deepEqual(r.top_pages, []);
});

// ── rankBy ────────────────────────────────────────────────────────────────────

test('rankBy: sorts descending by the given key and respects limit', () => {
  const rows = [{ r: 1 }, { r: 9 }, { r: 5 }];
  assert.deepEqual(rankBy(rows, 'r').map((x) => x.r), [9, 5, 1]);
  assert.deepEqual(rankBy(rows, 'r', 2).map((x) => x.r), [9, 5]);
});

// ── weeklyRevenueTrend ────────────────────────────────────────────────────────
//
// The dashboard's 12-week chart. It was GA4's modelled organic revenue and reported
// $58.50 for a 28-day window Shopify measured at $230.29, sitting directly beside that
// headline. These tests hold the two together.

const REFERRERS = {
  organic: 'https://www.google.com/',
  ai: 'https://chatgpt.com/',
  referral: 'https://www.somepartner.com/',
};

let orderSeq = 5000;
function rawOrder({ at, total = 40, via = 'organic', landing = '/products/deodorant', discount, cancelled }) {
  return {
    id: ++orderSeq,
    name: `#${orderSeq}`,
    created_at: at,
    total_price: String(total),
    source_name: 'web',
    landing_site: landing,
    referring_site: REFERRERS[via] ?? null,
    discount_codes: discount ? [{ code: discount }] : [],
    cancelled_at: cancelled || null,
  };
}
const trendOf = (orders, opts) => weeklyRevenueTrend(attributionRows(orders), { dayOf: ptDayOf, ...opts });

test('weeklyRevenueTrend: buckets are 7 PT days and the newest ends on the window end', () => {
  const t = trendOf([], { endDate: '2026-08-15', weeks: 4 });
  assert.equal(t.length, 4);
  assert.deepEqual(t.map((b) => [b.week, b.week_end]), [
    ['2026-07-19', '2026-07-25'],
    ['2026-07-26', '2026-08-01'],
    ['2026-08-02', '2026-08-08'],
    ['2026-08-09', '2026-08-15'],
  ]);
  // 12 weeks is the production shape: 84 days ending on the window end.
  const twelve = trendOf([], { endDate: '2026-08-15' });
  assert.equal(twelve.length, 12);
  assert.equal(twelve[11].week_end, '2026-08-15');
  assert.equal(twelve[0].week, '2026-05-24');
});

test('weeklyRevenueTrend: organic is the series, all channels ride alongside as context', () => {
  const t = trendOf([
    rawOrder({ at: '2026-08-14T18:00:00Z', total: 50, via: 'organic' }),
    rawOrder({ at: '2026-08-13T18:00:00Z', total: 30, via: 'ai' }),
    rawOrder({ at: '2026-08-12T18:00:00Z', total: 20, via: 'referral' }),
  ], { endDate: '2026-08-15', weeks: 2 });
  const last = t[1];
  assert.equal(last.revenue, 50);                  // organic search only
  assert.equal(last.orders, 1);
  assert.equal(last.revenue_all_channels, 100);    // organic + AI assistant + referral
  assert.equal(last.orders_all_channels, 3);
  // AI-assistant revenue is NOT organic search — it was booked as SEO once already.
  assert.equal(t[0].revenue, 0);
});

test('weeklyRevenueTrend: test, preview, cancelled and $0 orders never reach the chart', () => {
  const t = trendOf([
    rawOrder({ at: '2026-08-14T18:00:00Z', total: 60, via: 'organic' }),
    rawOrder({ at: '2026-08-14T18:00:00Z', total: 99, via: 'organic', landing: '/online_store_preview?x=1' }),
    rawOrder({ at: '2026-08-14T18:00:00Z', total: 99, via: 'organic', discount: 'TEST100' }),
    rawOrder({ at: '2026-08-14T18:00:00Z', total: 99, via: 'organic', cancelled: '2026-08-15T00:00:00Z' }),
    rawOrder({ at: '2026-08-14T18:00:00Z', total: 0, via: 'organic' }),
  ], { endDate: '2026-08-15', weeks: 1 });
  assert.equal(t[0].revenue, 60);
  assert.equal(t[0].orders, 1);
  assert.equal(t[0].revenue_all_channels, 60);
  assert.equal(t[0].orders_all_channels, 1);
});

test('weeklyRevenueTrend: buckets by PACIFIC day, not UTC day', () => {
  // 2026-08-16T05:00:00Z is 22:00 on 2026-08-15 in PT — the last day of the window, and
  // of the newest bucket. Bucketing this by its UTC date would push it out of the trend
  // entirely and understate the newest week.
  const t = trendOf([rawOrder({ at: '2026-08-16T05:00:00Z', total: 45, via: 'organic' })],
    { endDate: '2026-08-15', weeks: 2 });
  assert.equal(t[1].revenue, 45);
  // ...and the mirror: 2026-08-09T06:00:00Z is 23:00 on 2026-08-08 PT, the last day of
  // the OLDER bucket, so it must not slide forward into the newest one.
  const t2 = trendOf([rawOrder({ at: '2026-08-09T06:00:00Z', total: 45, via: 'organic' })],
    { endDate: '2026-08-15', weeks: 2 });
  assert.equal(t2[0].revenue, 45);
  assert.equal(t2[1].revenue, 0);
});

test('weeklyRevenueTrend: bucketing survives the PST/PDT switch', () => {
  // 2026-11-01 is the fall-back day. 2026-11-01T08:30:00Z is 01:30 PDT on 11-01 (the
  // repeated hour is still the 1st); 2026-11-02T07:30:00Z is 23:30 PST on 11-01.
  const t = trendOf([
    rawOrder({ at: '2026-11-01T08:30:00Z', total: 10, via: 'organic' }),
    rawOrder({ at: '2026-11-02T07:30:00Z', total: 15, via: 'organic' }),
    rawOrder({ at: '2026-11-02T08:30:00Z', total: 25, via: 'organic' }), // 00:30 PST on 11-02
  ], { endDate: '2026-11-08', weeks: 2 });
  assert.equal(t[0].week_end, '2026-11-01');
  assert.equal(t[0].revenue, 25);   // both 11-01 PT orders
  assert.equal(t[1].revenue, 25);   // the 11-02 PT order alone
});

test('weeklyRevenueTrend: the newest 4 weeks sum EXACTLY to the 28-day headline', () => {
  // The reconciliation the chart exists to satisfy. Same records, same channel filter,
  // same Pacific days — so summing four buckets must reproduce the headline to the cent.
  const orders = [
    rawOrder({ at: '2026-08-15T16:00:00Z', total: 46.8, via: 'organic' }),
    rawOrder({ at: '2026-08-02T16:00:00Z', total: 30.55, via: 'organic' }),
    rawOrder({ at: '2026-07-25T16:00:00Z', total: 52.99, via: 'organic' }),  // in window (day 1)
    rawOrder({ at: '2026-07-18T16:00:00Z', total: 99.99, via: 'organic' }),  // BEFORE the window
    rawOrder({ at: '2026-08-10T16:00:00Z', total: 61.2, via: 'ai' }),        // not organic
  ];
  const rows = attributionRows(orders);
  const t = weeklyRevenueTrend(rows, { endDate: '2026-08-15', weeks: 12, dayOf: ptDayOf });

  // The headline, computed the way the agent computes it: organic revenue per landing
  // page over the 28 PT days 2026-07-19 → 2026-08-15.
  const inWindow = rows.filter((r) => ptDayOf(r.created_at) >= '2026-07-19' && ptDayOf(r.created_at) <= '2026-08-15');
  const byPage = shopifyRevenueByPage(inWindow, { channels: ['organic-search'] });
  const headline = Math.round([...byPage.values()].reduce((s, v) => s + v.revenue, 0) * 100) / 100;

  const tail = t.slice(-4);
  const tailRevenue = Math.round(tail.reduce((s, b) => s + b.revenue, 0) * 100) / 100;
  assert.equal(headline, 130.34);
  assert.equal(tailRevenue, headline);
  assert.equal(tail.reduce((s, b) => s + b.orders, 0), 3);
  // The out-of-window order is still in the chart's older weeks — it just isn't in the tail.
  assert.equal(Math.round(t.reduce((s, b) => s + b.revenue, 0) * 100) / 100, 230.33);
});

test('weeklyRevenueTrend: orders outside the 12-week range are ignored', () => {
  const t = trendOf([
    rawOrder({ at: '2026-05-23T18:00:00Z', total: 500, via: 'organic' }),  // day before the range
    rawOrder({ at: '2026-08-16T18:00:00Z', total: 500, via: 'organic' }),  // day after the range
  ], { endDate: '2026-08-15' });
  assert.equal(t.reduce((s, b) => s + b.revenue_all_channels, 0), 0);
});

test('weeklyRevenueTrend: refuses to guess a timezone or a window end', () => {
  // No UTC default for dayOf: a silent fallback is how a timezone bug hides.
  assert.throws(() => weeklyRevenueTrend([], { endDate: '2026-08-15' }), /dayOf/);
  assert.throws(() => weeklyRevenueTrend([], { dayOf: ptDayOf }), /endDate/);
  assert.throws(() => weeklyRevenueTrend([], { endDate: '15/08/2026', dayOf: ptDayOf }), /endDate/);
});

test('weeklyRevenueTrend: channels:null gives the whole store as the series', () => {
  const t = trendOf([
    rawOrder({ at: '2026-08-14T18:00:00Z', total: 50, via: 'organic' }),
    rawOrder({ at: '2026-08-13T18:00:00Z', total: 30, via: 'ai' }),
  ], { endDate: '2026-08-15', weeks: 1, channels: null });
  assert.equal(t[0].revenue, 80);
  assert.equal(t[0].revenue_all_channels, 80);
});

// ── the report's cluster table ────────────────────────────────────────────────

import { buildReport } from '../../agents/seo-impact/index.js';

test('the cluster table says what its dollars are, and shows the residual', () => {
  const md = buildReport({
    window: { start: '2026-07-24', end: '2026-08-20' },
    prior_window: { start: '2026-06-26', end: '2026-07-23' },
    revenue_source: 'shopify-orders',
    totals: { organic_revenue: 540.08, organic_revenue_delta: 357.9, organic_conversions: 8, organic_sessions: 1067 },
    top_revenue: [], top_growth: [], action_wins: [], not_converting: [], channel_mix: [],
    clusters: [
      { cluster: 'lotion', entry_page_organic_revenue: 313.49, revenue: 313.49, revenueDelta: 282.3, clicks: 106, pages: 38 },
      { cluster: 'soap', entry_page_organic_revenue: 62.4, revenue: 62.4, revenueDelta: 62.4, clicks: 227, pages: 28 },
    ],
    cluster_residual: {
      label: 'no cluster (homepage / cart / subscription)',
      entry_page_organic_revenue: 77.94, revenue: 77.94, revenueDelta: 67.94, clicks: 40, pages: 12,
    },
  });

  // The heading no longer oversells it as a push-harder league table.
  assert.doesNotMatch(md, /where to push harder/i);
  assert.match(md, /Entry-page organic revenue by cluster/);
  assert.match(md, /not product revenue/i);
  assert.match(md, /totals\.organic_revenue/);

  // The residual row: $77.94 of the $540.08 lands on no cluster at all.
  assert.match(md, /no cluster \(homepage \/ cart \/ subscription\)/);
  assert.match(md, /\$77\.94/);
  assert.match(md, /\$62\.40/, 'soap is one row now, carrying its real attributed dollars');
});

// ── the report's PRODUCT cluster table ────────────────────────────────────────

/**
 * Real figures, measured from 131 live orders over the 200 days to 2026-08-23.
 * The 28-day window ending 2026-08-21 is the same one the fixture above uses.
 */
const PRODUCT_REPORT = {
  window: { start: '2026-07-24', end: '2026-08-20' },
  prior_window: { start: '2026-06-26', end: '2026-07-23' },
  revenue_source: 'shopify-orders',
  totals: { organic_revenue: 540.08, organic_revenue_delta: 357.9, organic_conversions: 8, organic_sessions: 1067 },
  top_revenue: [], top_growth: [], action_wins: [], not_converting: [], channel_mix: [],
  clusters: [
    {
      cluster: 'lotion', entry_page_organic_revenue: 313.49, revenue: 313.49, revenueDelta: 282.3, clicks: 106, pages: 38,
      product_organic_revenue: 357, product_organic_revenue_prev: 300, product_organic_revenue_delta: 57,
      product_revenue_all_channels: 755.3, product_orders_all_channels: 9, organic_share: 47.3,
    },
    {
      cluster: 'soap', entry_page_organic_revenue: 62.4, revenue: 62.4, revenueDelta: 62.4, clicks: 227, pages: 28,
      product_organic_revenue: 62.4, product_organic_revenue_prev: 0, product_organic_revenue_delta: 62.4,
      product_revenue_all_channels: 123.5, product_orders_all_channels: 3, organic_share: 50.5,
    },
    {
      // Never had a clustered entry page this window; entry-page attribution
      // could not see it at all.
      cluster: 'deodorant', entry_page_organic_revenue: 0, revenue: 0, revenueDelta: 0, clicks: 0, pages: 0,
      product_organic_revenue: 36, product_organic_revenue_prev: 0, product_organic_revenue_delta: 36,
      product_revenue_all_channels: 46.5, product_orders_all_channels: 2, organic_share: 77.4,
    },
  ],
  cluster_residual: {
    label: 'no cluster (homepage / cart / subscription)',
    entry_page_organic_revenue: 77.94, revenue: 77.94, revenueDelta: 67.94, clicks: 40, pages: 12,
  },
  clusters_product_wide: [
    { cluster: 'lotion', product_organic_revenue: 875.7, product_revenue_all_channels: 1757.1, product_orders_all_channels: 24 },
    { cluster: 'toothpaste', product_organic_revenue: 35.1, product_revenue_all_channels: 71.5, product_orders_all_channels: 3 },
  ],
  cluster_product_meta: {
    source: 'shopify-orders',
    basis: 'order line items (price × quantity less allocated discounts), summed to line subtotals — shipping and tax are order-level and are excluded',
    window: { start: '2026-07-24', end: '2026-08-20' },
    wide_window: { start: '2026-05-24', end: '2026-08-20' },
    wide_window_days: 90,
    reconciles_to: 'line subtotals over the window, NOT totals.organic_revenue',
    product_subtotal_organic: 515.4,
    product_subtotal_all_channels: 1021.3,
    unclustered_line_revenue_organic: 0,
    unclustered_line_revenue_all_channels: 0,
    non_product_revenue_organic: 24.68,
    non_product_revenue_all_channels: 58.16,
    orders_without_lines_organic: 0,
    orders_without_lines_all_channels: 1,
    wide_orders_all_channels: 50,
  },
};

test('the product cluster table leads, and says what its dollars are', () => {
  const md = buildReport(PRODUCT_REPORT);
  assert.match(md, /What each category actually SOLD/);
  assert.match(md, /line items/i);
  // The two tables must be distinguishable at a glance and in that order.
  assert.ok(
    md.indexOf('What each category actually SOLD') < md.indexOf('Entry-page organic revenue by cluster'),
    'the category answer comes before the landing-page answer',
  );
  assert.match(md, /Entry-page organic revenue by cluster — the LANDING-PAGE view/);
  assert.match(md, /different question/i);
});

test('the product table states that it does NOT reconcile to organic_revenue', () => {
  const md = buildReport(PRODUCT_REPORT);
  // The gap is shipping and tax, named and quantified, never silently closed.
  assert.match(md, /line subtotals/);
  assert.match(md, /shipping and tax/i);
  assert.match(md, /\$24\.68/);
  assert.match(md, /do \*\*not\*\*\s*\n?\s*reconcile to `totals\.organic_revenue`/);
});

test('a category with no clustered entry page appears in the product table', () => {
  const md = buildReport(PRODUCT_REPORT);
  const section = md.slice(md.indexOf('What each category actually SOLD'), md.indexOf('### Over 90 days'));
  assert.match(section, /\| deodorant \|/);
  assert.match(section, /\$46\.50/);
});

test('orders with no line items are declared, never counted as a category selling nothing', () => {
  const md = buildReport(PRODUCT_REPORT);
  assert.match(md, /carried no line items/);
  assert.match(md, /not\*\* counted as a category selling nothing/);
});

test('the 90-day table is labelled as a different window, not more columns', () => {
  const md = buildReport(PRODUCT_REPORT);
  assert.match(md, /### Over 90 days/);
  assert.match(md, /THE TABLE THE \$0-CLUSTER GATE JUDGES ON/,
    'it is not a companion view any more — it is the one the verdict is made on');
  assert.match(md, /2026-05-24 → 2026-08-20/);
  assert.match(md, /\$71\.50/, 'toothpaste sold $71.50 over 90 days — it reads $0 at 28');
});

test('the 90-day table shows BOTH sources of the hold rule, side by side', () => {
  // A reader has to be able to see the two numbers a hold rests on without
  // opening a second report. `Pages earned` is source B.
  const md = buildReport(PRODUCT_REPORT);
  assert.match(md, /\| Pages earned \(organic\) \|/);
  assert.match(md, /BOTH are\s*\n?\s*\$0\.00/, 'and the rule is stated next to the table');
});

test('a report with no product figures renders exactly as it did before', () => {
  const { clusters_product_wide, cluster_product_meta, ...legacy } = PRODUCT_REPORT;
  const md = buildReport({
    ...legacy,
    clusters: legacy.clusters.map(({
      product_organic_revenue, product_organic_revenue_prev, product_organic_revenue_delta,
      product_revenue_all_channels, product_orders_all_channels, organic_share, ...row
    }) => row),
  });
  assert.doesNotMatch(md, /What each category actually SOLD/);
  assert.match(md, /Entry-page organic revenue by cluster/);
});


// ── source B of the $0-cluster hold rule ─────────────────────────────────────
//
// What a cluster's PAGES earned from organic search over the 90-day judging
// window, keyed on the landing-page URL. `clusterRollup` answers the same
// question for the report's own window, but only as a by-product of the impact
// rows, which exist only where GSC has data. The wide window has no GSC pull
// behind it and does not need one: the landing path is on the ORDER.

const clusterOf = (path) => {
  if (/lotion|moistur/.test(path)) return 'lotion';
  if (/soap/.test(path)) return 'soap';
  return null;
};

test('entryPageClusterRevenue buckets order revenue by the landing page, no GSC needed', () => {
  const byPage = new Map([
    ['/blogs/news/best-body-lotion', { revenue: 313.49 }],
    ['/products/coconut-moisturizer', { revenue: 353.24 }],
    ['/products/organic-foaming-hand-soap', { revenue: 110.49 }],
    ['/', { revenue: 388.43 }],
  ]);
  const { byCluster, residual } = entryPageClusterRevenue(byPage, clusterOf);
  assert.equal(byCluster.lotion, 666.73, 'two lotion pages sum into one cluster');
  assert.equal(byCluster.soap, 110.49);
  assert.equal(residual, 388.43, 'a path matching no cluster is the residual, never a row');
  assert.deepEqual(entryPageClusterRevenue(null, clusterOf), { byCluster: {}, residual: 0 });
});

test('withWideEntryPageRevenue UNIONS the two sources — it does not just decorate one', () => {
  // A cluster whose pages earned while its products sold nothing must get a row.
  // That row is the single most important one in the array: it is exactly the
  // case that has to block a hold, and decorating instead of unioning would make
  // it invisible to the cross-check.
  const rows = withWideEntryPageRevenue(
    [{ cluster: 'soap', product_revenue_all_channels: 324.85, product_organic_revenue: 123.7 }],
    { byCluster: { soap: 110.49, 'coconut oil': 41.2 } },
  );
  assert.deepEqual(rows.map((r) => r.cluster), ['soap', 'coconut oil']);
  assert.equal(rows[0].entry_page_organic_revenue, 110.49);
  const noSku = rows[1];
  assert.equal(noSku.product_revenue_all_channels, 0, 'a category with no SKU sold nothing, and says so');
  assert.equal(noSku.entry_page_organic_revenue, 41.2);
});

test('withWideEntryPageRevenue with NO source B emits nothing at all', () => {
  // Not "every row at $0" — that would bake an unmeasured zero into the report on
  // disk, where no reader can tell it from a real one, and it is the direction
  // that CREATES holds. Emitting nothing switches the gate off for the run.
  assert.deepEqual(withWideEntryPageRevenue([{ cluster: 'soap', product_revenue_all_channels: 324.85 }], null), []);
  assert.deepEqual(withWideEntryPageRevenue([{ cluster: 'soap' }], {}), []);
  assert.deepEqual(withWideEntryPageRevenue([{ cluster: 'soap' }], { byCluster: {} })[0].entry_page_organic_revenue, 0,
    'a MEASURED empty result is different — it is a real zero and does emit');
});
