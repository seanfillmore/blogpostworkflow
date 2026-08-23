// tests/lib/cluster-efficiency.test.js
//
// The ranking that replaced the hard block for INEFFICIENT clusters (as opposed
// to $0 ones). Everything named PRODUCTION_* here is measured, not invented:
// `tests/helpers/cluster-fixtures.js` carries the 2026-08-23 read-only pull of
// 54 raw Shopify orders, and this file re-derives the ordering from it rather
// than asserting a hand-written list of cluster names.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rankClusters, orderByEfficiency, efficiencyScore, renderEfficiencyLines,
  efficiencyBanner, PRIOR_CLICKS, RESERVE_MIN_LIMIT,
} from '../../lib/cluster-efficiency.js';
import { MIN_CLICKS } from '../../lib/cluster-revenue.js';
import {
  holdFor, heldScenario, PRODUCTION_CLUSTER_ROWS, SOLD_90D,
} from '../helpers/cluster-fixtures.js';

const HOLD = holdFor();
const RANKING = rankClusters(HOLD);
const order = (r) => r.ordered.map((e) => e.cluster);

// ── the measure ───────────────────────────────────────────────────────────────

test('the prior weight IS the fair-shot click bar, not a private constant', () => {
  // A second copy of a derived threshold is a copy that drifts. The whole
  // derivation of MIN_CLICKS lives in lib/cluster-revenue.js.
  assert.equal(PRIOR_CLICKS, MIN_CLICKS);
});

test('the score is revenue over clicks-plus-prior-clicks, computed from the imported bar', () => {
  assert.equal(efficiencyScore(1757.1, 106), 1757.1 / (106 + MIN_CLICKS));
  // A cluster with no clustered entry page at all still scores; no division by zero.
  assert.equal(efficiencyScore(300, 0), 300 / MIN_CLICKS);
  assert.equal(efficiencyScore(0, 640), 0);
});

test('on the real production numbers lotion ranks first and toothpaste second-to-last', () => {
  assert.equal(RANKING.available, true);
  assert.deepEqual(order(RANKING), [
    'lotion', 'soap', 'lip balm', 'deodorant', 'toothpaste', 'coconut oil',
  ]);
});

test('toothpaste ranks below every category that outsells it, on 59% of the clicks', () => {
  const byCluster = Object.fromEntries(RANKING.ordered.map((e) => [e.cluster, e]));
  const tp = byCluster.toothpaste;
  const allClicks = RANKING.ordered.reduce((s, e) => s + e.clicks, 0);
  assert.ok(tp.clicks / allClicks > 0.5, 'toothpaste should hold over half the clustered clicks');
  assert.ok(tp.productRevenue / RANKING.totalRevenue < 0.05, '...for under 5% of the revenue');
  for (const name of ['lotion', 'soap', 'lip balm', 'deodorant']) {
    assert.ok(byCluster[name].rank < tp.rank, `${name} must outrank toothpaste`);
  }
});

// ── the small-sample guard ────────────────────────────────────────────────────

test('RAW revenue-per-click would put a 6-click cluster first — this is the bug being guarded', () => {
  const raw = [...RANKING.ordered]
    .filter((e) => e.clicks > 0)
    .sort((a, b) => b.productRevenue / b.clicks - a.productRevenue / a.clicks);
  assert.equal(raw[0].cluster, 'lip balm');
  assert.equal(raw[0].clicks, 6);
});

test('the guard demotes it: a 6-click cluster is never the best use of budget', () => {
  assert.notEqual(RANKING.ordered[0].cluster, 'lip balm');
  const lipBalm = RANKING.ordered.find((e) => e.cluster === 'lip balm');
  const lotion = RANKING.ordered.find((e) => e.cluster === 'lotion');
  assert.ok(lotion.rank < lipBalm.rank);
  // and it does not outrank a category selling nearly 3x as much on 38x the clicks
  assert.ok(RANKING.ordered.find((e) => e.cluster === 'soap').rank < lipBalm.rank);
});

test('the guard shrinks toward ZERO, never toward the site average', () => {
  // Shrinking a thin sample toward the mean would rank a cluster measured at $0
  // across 50 orders as merely average. Every score is at or below the raw rate.
  for (const e of RANKING.ordered) {
    if (!e.clicks) continue;
    assert.ok(e.score <= e.productRevenue / e.clicks + 1e-9, `${e.cluster} must not be flattered`);
  }
  const coconut = RANKING.ordered.find((e) => e.cluster === 'coconut oil');
  assert.equal(coconut.score, 0);
  assert.equal(coconut.rank, RANKING.ordered.length - 1);
});

test('more clicks for the same money is strictly worse; more money for the same clicks is strictly better', () => {
  assert.ok(efficiencyScore(100, 50) > efficiencyScore(100, 500));
  assert.ok(efficiencyScore(200, 50) > efficiencyScore(100, 50));
});

test('revenue-per-page is reported for the operator but is not the ranking key', () => {
  const byCluster = Object.fromEntries(RANKING.ordered.map((e) => [e.cluster, e]));
  // 24 toothpaste pages against 6 lip-balm pages is exactly the disparity a
  // per-page key would launder, so the figure is shown and not used.
  assert.equal(byCluster.toothpaste.revenuePerPage, 71.5 / 24);
  assert.equal(byCluster['lip balm'].revenuePerPage, 117 / 6);
  const byPage = [...RANKING.ordered].sort((a, b) => b.revenuePerPage - a.revenuePerPage);
  assert.notDeepEqual(byPage.map((e) => e.cluster), order(RANKING));
});

// ── composition with the hold ─────────────────────────────────────────────────

test('a held cluster still ranks — last — and is flagged, so an override cannot jump the queue', () => {
  const held = holdFor({ ...heldScenario('toothpaste'), generatedAt: '2026-08-23T10:00:00Z' });
  const r = rankClusters(held);
  const last = r.ordered[r.ordered.length - 1];
  assert.equal(last.cluster, 'toothpaste');
  assert.equal(last.held, true);
  assert.ok(r.ordered.slice(0, -1).every((e) => e.held === false));
});

test('the ranking never re-derives the hold — it reads heldSet and nothing else', () => {
  const held = holdFor({ ...heldScenario('toothpaste') });
  const r = rankClusters(held);
  assert.equal(r.ordered.find((e) => e.cluster === 'toothpaste').held, held.heldSet.has('toothpaste'));
  // nothing is held on production, and the ranking agrees rather than inventing one
  assert.equal(RANKING.ordered.some((e) => e.held), false);
});

test('a stale or missing report ranks nothing — it degrades, it does not guess an order', () => {
  const missing = rankClusters({ available: false, classified: {}, heldSet: new Set() });
  assert.equal(missing.available, false);
  assert.match(missing.reason, /report/i);
  assert.deepEqual(missing.ordered, []);
  assert.equal(rankClusters(null).available, false);
});

test('a report with no product-revenue reading ranks nothing rather than falling back to entry-page $', () => {
  // The pre-migration report shape: `clusters[]` with entry-page dollars and no
  // `clusters_product_wide[]`. Ranking on entry-page revenue is the exact
  // misreading that condemned soap; refusing is the only honest answer.
  const noWide = holdFor({ sold: null, earned: null });
  const r = rankClusters(noWide);
  assert.equal(r.available, false);
  assert.match(r.reason, /product-revenue/i);
});

test('the banner is silent on a normal ranked run and speaks when ranking is off', () => {
  assert.equal(efficiencyBanner(RANKING), '');
  assert.match(efficiencyBanner(rankClusters(null)), /not ranked/i);
});

// ── applying the order to a pick list ─────────────────────────────────────────

const item = (slug) => ({ slug });
const slugs = (res) => res.items.map((i) => i.slug);

test('a pick list is reordered so the efficient clusters are reached first', () => {
  const picks = [
    item('no-fluoride-toothpaste'), item('best-natural-deodorant'),
    item('best-coconut-oil-body-lotion'), item('best-soap-for-tattoos'),
  ];
  const res = orderByEfficiency(picks, RANKING, { limit: 4 });
  assert.equal(res.reordered, true);
  assert.deepEqual(slugs(res), [
    'best-coconut-oil-body-lotion', 'best-soap-for-tattoos',
    'best-natural-deodorant', 'no-fluoride-toothpaste',
  ]);
});

test('items in the same cluster keep the picker\'s own order — the sort is stable', () => {
  const picks = ['toothpaste-a', 'toothpaste-b', 'toothpaste-c'].map(item);
  assert.deepEqual(slugs(orderByEfficiency(picks, RANKING, { limit: 3 })), [
    'toothpaste-a', 'toothpaste-b', 'toothpaste-c',
  ]);
});

test('an item that names no cluster is neither promoted nor demoted — it keeps its slot', () => {
  const picks = [item('no-fluoride-toothpaste'), item('q3-roundup-2026'), item('best-coconut-oil-body-lotion')];
  const res = orderByEfficiency(picks, RANKING, { limit: 3 });
  // position 1 is unrankable and is untouched; the two clustered items swap
  assert.deepEqual(slugs(res), ['best-coconut-oil-body-lotion', 'q3-roundup-2026', 'no-fluoride-toothpaste']);
  assert.equal(res.unranked, 1);
});

test('with no usable ranking the pick list comes back byte-identical', () => {
  const picks = [item('no-fluoride-toothpaste'), item('best-coconut-oil-body-lotion')];
  const res = orderByEfficiency(picks, rankClusters(null), { limit: 2 });
  assert.equal(res.reordered, false);
  assert.deepEqual(slugs(res), ['no-fluoride-toothpaste', 'best-coconut-oil-body-lotion']);
});

test('an empty pick list is not an error', () => {
  assert.deepEqual(orderByEfficiency([], RANKING, { limit: 5 }).items, []);
  assert.deepEqual(orderByEfficiency(null, RANKING, { limit: 5 }).items, []);
});

// ── the anti-starvation reserve ───────────────────────────────────────────────
//
// A ranking that never reaches the bottom cluster is the hard block again under
// a new name. One slot inside the cap is reserved for the worst-ranked cluster
// the hold has NOT already excluded.

test('the last in-cap slot is reserved for the worst-ranked cluster PRESENT, so it is never starved', () => {
  // Four lotion candidates would otherwise take all four slots and toothpaste
  // would go another week untouched — which is the hard block wearing a ranking.
  const picks = [
    ...[1, 2, 3, 4].map((n) => item(`best-coconut-oil-body-lotion-${n}`)),
    item('no-fluoride-toothpaste'),
  ];
  const res = orderByEfficiency(picks, RANKING, { limit: 4 });
  assert.equal(res.reserved.cluster, 'toothpaste');
  assert.equal(res.reserved.position, 4);
  assert.equal(slugs(res)[3], 'no-fluoride-toothpaste');
  // and the three slots above it still went to the efficient cluster
  assert.equal(slugs(res).slice(0, 3).every((s) => s.includes('lotion')), true);
});

test('the reserved cluster is the worst one PRESENT, not the worst one that exists', () => {
  const picks = [
    ...[1, 2, 3].map((n) => item(`best-coconut-oil-body-lotion-${n}`)),
    item('best-natural-deodorant'),
  ];
  const res = orderByEfficiency(picks, RANKING, { limit: 3 });
  assert.equal(res.reserved.cluster, 'deodorant');
});

test('the reserve does not fire below RESERVE_MIN_LIMIT — a third of a budget is not "what is left"', () => {
  const picks = [
    { slug: 'best-coconut-oil-body-lotion-1' }, { slug: 'best-coconut-oil-body-lotion-2' },
    { slug: 'no-fluoride-toothpaste' },
  ];
  assert.ok(RESERVE_MIN_LIMIT >= 3);
  const res = orderByEfficiency(picks, RANKING, { limit: 2 });
  assert.equal(res.reserved, null);
  assert.equal(slugs(res)[1], 'best-coconut-oil-body-lotion-2');
});

test('the reserve is a no-op when the bottom cluster already has a slot inside the cap', () => {
  const picks = [
    { slug: 'best-coconut-oil-body-lotion' }, { slug: 'no-fluoride-toothpaste' },
    { slug: 'best-natural-deodorant' },
  ];
  const res = orderByEfficiency(picks, RANKING, { limit: 3 });
  assert.equal(res.reserved, null);
});

test('the reserve can NEVER re-admit a held cluster — that would undo the hold', () => {
  const held = holdFor({ ...heldScenario('toothpaste'), generatedAt: '2026-08-23T10:00:00Z' });
  const r = rankClusters(held);
  assert.notEqual(r.reserveCluster, 'toothpaste');
  const picks = [
    { slug: 'best-coconut-oil-body-lotion-1' }, { slug: 'best-coconut-oil-body-lotion-2' },
    { slug: 'best-coconut-oil-body-lotion-3' }, { slug: 'no-fluoride-toothpaste' },
  ];
  const res = orderByEfficiency(picks, r, { limit: 3 });
  assert.equal(slugs(res).slice(0, 3).some((s) => s.includes('toothpaste')), false);
});

test('with only one cluster in the ranking there is nothing to reserve from', () => {
  const one = holdFor({
    clusters: [{ cluster: 'lotion', revenue: 313.49, clicks: 106, pages: 39 }],
    sold: { lotion: SOLD_90D.lotion },
    earned: { lotion: 666.73 },
  });
  const r = rankClusters(one);
  assert.equal(r.reserveCluster, null);
  const picks = [1, 2, 3].map((n) => ({ slug: `best-coconut-oil-body-lotion-${n}` }));
  assert.equal(orderByEfficiency(picks, r, { limit: 3 }).reserved, null);
});

// ── what the operator and the 5 AM digest see ─────────────────────────────────

test('the digest lines name the order and the reserve, and stay quiet when nothing moved', () => {
  const picks = [
    { slug: 'no-fluoride-toothpaste' }, { slug: 'best-coconut-oil-body-lotion' },
    { slug: 'best-soap-for-tattoos' },
  ];
  const res = orderByEfficiency(picks, RANKING, { limit: 3 });
  const lines = renderEfficiencyLines(RANKING, res).join('\n');
  assert.match(lines, /lotion/);
  assert.match(lines, /toothpaste/);
  assert.match(lines, /\$/);
  assert.deepEqual(renderEfficiencyLines(rankClusters(null), res), []);
});

test('every production cluster row survives into the ranking — nothing is silently dropped', () => {
  assert.equal(RANKING.ordered.length, PRODUCTION_CLUSTER_ROWS.length);
  assert.deepEqual(
    new Set(order(RANKING)),
    new Set(PRODUCTION_CLUSTER_ROWS.map((c) => c.cluster)),
  );
});
