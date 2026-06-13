import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  pathOf,
  organicByPage,
  buildPageImpacts,
  clusterRollup,
  actionWins,
  rankBy,
} from '../../lib/seo-impact.js';

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

// ── buildPageImpacts: window deltas + action join ─────────────────────────────

const mapOf = (obj) => new Map(Object.entries(obj));

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

// ── rankBy ────────────────────────────────────────────────────────────────────

test('rankBy: sorts descending by the given key and respects limit', () => {
  const rows = [{ r: 1 }, { r: 9 }, { r: 5 }];
  assert.deepEqual(rankBy(rows, 'r').map((x) => x.r), [9, 5, 1]);
  assert.deepEqual(rankBy(rows, 'r', 2).map((x) => x.r), [9, 5]);
});
