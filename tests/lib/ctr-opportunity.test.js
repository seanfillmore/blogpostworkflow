// tests/lib/ctr-opportunity.test.js
//
// The page-level CTR opportunity ranking. Two things this file deliberately
// does NOT do: assert a magic number for `recoverable` (every expectation is
// recomputed from `benchmarkCtr` and `CAPTURE_FRACTION`, so a change to the
// curve or the capture constant fails here rather than silently re-basing the
// report), and hand-build a `ranking` object (it comes from the real
// `rankClusters` over the measured 2026-08-23 production fixtures, so the shape
// this module reads is the shape the fleet actually produces).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BENCHMARK_CTR_BY_POSITION, BENCHMARK_FLOOR_CTR, CAPTURE_FRACTION,
  CLUSTER_WEIGHT_DECAY, CLUSTER_WEIGHT_FLOOR,
  benchmarkCtr, recoverableClicks, scoreOpportunity, rankOpportunities,
} from '../../lib/ctr-opportunity.js';
import { rankClusters } from '../../lib/cluster-efficiency.js';
import { holdFor } from '../helpers/cluster-fixtures.js';

// The real thing: lotion, soap, lip balm, deodorant, toothpaste, coconut oil.
const RANKING = rankClusters(holdFor());

const urls = (rows) => rows.map((r) => r.url);

// ── the benchmark curve ───────────────────────────────────────────────────────

test('the table is hit exactly at integer positions', () => {
  assert.equal(benchmarkCtr(1), 0.28);
  assert.equal(benchmarkCtr(8), 0.033);
  assert.equal(benchmarkCtr(20), 0.0065);
  assert.equal(benchmarkCtr(8), BENCHMARK_CTR_BY_POSITION[8]);
});

test('a fractional position interpolates instead of rounding a page up the curve', () => {
  // GSC average positions are ALWAYS fractional, so this is the normal case and
  // not an edge case.
  const mid = benchmarkCtr(8.5);
  assert.ok(mid < benchmarkCtr(8), '8.5 must be worse than 8');
  assert.ok(mid > benchmarkCtr(9), '8.5 must be better than 9');
  assert.equal(mid, (BENCHMARK_CTR_BY_POSITION[8] + BENCHMARK_CTR_BY_POSITION[9]) / 2);
});

test('a missing, zero or nonsense position is treated as position 1, never NaN', () => {
  for (const p of [0, -1, NaN, null, undefined, 'banana', 0.5, 1]) {
    assert.equal(benchmarkCtr(p), BENCHMARK_CTR_BY_POSITION[1], `position ${String(p)}`);
  }
});

test('past the table the curve decays toward the floor without stepping at the seam', () => {
  // Continuity: the decay starts FROM position 20's own value.
  assert.equal(benchmarkCtr(20.0001) < benchmarkCtr(20), true);
  assert.ok(Math.abs(benchmarkCtr(20.0001) - benchmarkCtr(20)) < 1e-5);

  // Strictly between the floor and position 20 — the decay has not bottomed out
  // yet at 30. (It crosses the floor at ~position 45.8, so 60 is already
  // floored; that is asserted below rather than assumed away.)
  const deep = benchmarkCtr(30);
  assert.ok(deep > BENCHMARK_FLOOR_CTR, 'position 30 is still above the floor');
  assert.ok(deep < BENCHMARK_CTR_BY_POSITION[20], 'position 30 is below position 20');

  const veryDeep = benchmarkCtr(60);
  assert.ok(veryDeep >= BENCHMARK_FLOOR_CTR);
  assert.ok(veryDeep < BENCHMARK_CTR_BY_POSITION[20]);
  assert.equal(veryDeep, BENCHMARK_FLOOR_CTR, 'by position 60 the decay has reached the floor');
});

test('the floor actually holds — it is a floor, not a slow decay', () => {
  assert.equal(benchmarkCtr(500), BENCHMARK_FLOOR_CTR);
  assert.equal(benchmarkCtr(100000), BENCHMARK_FLOOR_CTR);
  assert.ok(Number.isFinite(benchmarkCtr(1e9)));
});

// ── recoverable clicks ────────────────────────────────────────────────────────

test('a page already at or above benchmark has NOTHING to recover — never a negative', () => {
  const over = recoverableClicks({ impressions: 1000, clicks: 400, position: 8 });
  assert.equal(over.gapCtr, 0);
  assert.equal(over.recoverable, 0);
  assert.equal(over.ctr, 0.4);
  // exactly at benchmark is also zero, not a rounding artefact
  const at = recoverableClicks({ impressions: 1000, ctr: benchmarkCtr(8), position: 8 });
  assert.equal(at.gapCtr, 0);
  assert.equal(at.recoverable, 0);
});

test('zero, negative, missing or nonsense impressions return zeros and never throw', () => {
  for (const impressions of [0, -1, NaN, null, undefined, 'lots']) {
    const r = recoverableClicks({ impressions, clicks: 10, position: 8 });
    assert.deepEqual(r, { gapCtr: 0, recoverable: 0, benchmark: 0, ctr: 0 }, String(impressions));
  }
  assert.deepEqual(recoverableClicks(), { gapCtr: 0, recoverable: 0, benchmark: 0, ctr: 0 });
  assert.deepEqual(recoverableClicks({}), { gapCtr: 0, recoverable: 0, benchmark: 0, ctr: 0 });
});

test('an explicit ctr wins over the derived one; a missing one is derived', () => {
  const explicit = recoverableClicks({ impressions: 1000, clicks: 5, ctr: 0.02, position: 8 });
  assert.equal(explicit.ctr, 0.02);
  const derived = recoverableClicks({ impressions: 1000, clicks: 5, position: 8 });
  assert.equal(derived.ctr, 0.005);
  const neither = recoverableClicks({ impressions: 1000, position: 8 });
  assert.equal(neither.ctr, 0);
  assert.equal(neither.gapCtr, benchmarkCtr(8));
});

test('the flagship page: the arithmetic is pinned to the formula, not to a number', () => {
  // best-soap-for-tattoos-what-to-use-for-safe-healing-2, 90d to 2026-08-21.
  const row = { impressions: 37531, clicks: 210, position: 8.0 };
  const r = recoverableClicks(row);

  const expectedCtr = 210 / 37531;
  const expectedGap = benchmarkCtr(8) - expectedCtr;
  assert.equal(r.benchmark, benchmarkCtr(8));
  assert.equal(r.ctr, expectedCtr);
  assert.equal(r.gapCtr, expectedGap);
  assert.equal(r.recoverable, 37531 * expectedGap * CAPTURE_FRACTION);
  assert.ok(r.recoverable > 0, 'the site flagship has real headroom');
});

test('the capture fraction scales magnitude and cannot change the order', () => {
  const a = recoverableClicks({ impressions: 37531, clicks: 210, position: 8 });
  const b = recoverableClicks({ impressions: 12000, clicks: 40, position: 8 });
  // both are the same theoretical gap times the same constant times impressions
  assert.equal(a.recoverable / b.recoverable, (37531 * a.gapCtr) / (12000 * b.gapCtr));
  assert.ok(CAPTURE_FRACTION > 0 && CAPTURE_FRACTION < 1);
});

// ── cluster weighting ─────────────────────────────────────────────────────────

test('the best-ranked cluster keeps full weight and each rank below is demoted', () => {
  const lotion = scoreOpportunity({ url: '/a', cluster: 'lotion', impressions: 1000, clicks: 1, position: 8 }, { ranking: RANKING });
  const soap = scoreOpportunity({ url: '/b', cluster: 'soap', impressions: 1000, clicks: 1, position: 8 }, { ranking: RANKING });
  const toothpaste = scoreOpportunity({ url: '/c', cluster: 'toothpaste', impressions: 1000, clicks: 1, position: 8 }, { ranking: RANKING });

  assert.equal(lotion.clusterWeight, 1);
  assert.equal(soap.clusterWeight, CLUSTER_WEIGHT_DECAY);
  assert.equal(toothpaste.clusterWeight, Math.pow(CLUSTER_WEIGHT_DECAY, 4));
  assert.ok(toothpaste.clusterWeight > CLUSTER_WEIGHT_FLOOR, 'the weight demotes, it never drops');
  assert.equal(toothpaste.score, toothpaste.recoverable * toothpaste.clusterWeight);
});

test('missing ranking data is FULL weight, never a penalty, and never throws', () => {
  const page = { url: '/x', cluster: 'lotion', impressions: 1000, clicks: 1, position: 8 };
  for (const ranking of [null, undefined, {}, { available: false }, { available: true, ordered: [] }]) {
    assert.equal(scoreOpportunity(page, { ranking }).clusterWeight, 1, JSON.stringify(ranking));
  }
  // a cluster the ranking has never heard of, and a page with no cluster at all
  assert.equal(scoreOpportunity({ ...page, cluster: 'kombucha' }, { ranking: RANKING }).clusterWeight, 1);
  assert.equal(scoreOpportunity({ ...page, cluster: undefined }, { ranking: RANKING }).clusterWeight, 1);
  assert.equal(scoreOpportunity({}, {}).score, 0);
  assert.equal(scoreOpportunity(null, {}).score, 0);
});

// ── ranking pages ─────────────────────────────────────────────────────────────

test('one page reached through two queries is ONE row, and the fuller reading wins', () => {
  // This is the concrete fix for query-level ranking: the flagship earns 37,531
  // impressions across 666 queries, and its biggest single query is 1,045.
  const rows = rankOpportunities([
    { url: '/blogs/news/tattoo', cluster: 'soap', impressions: 1045, clicks: 12, position: 8 },
    { url: '/blogs/news/tattoo', cluster: 'soap', impressions: 37531, clicks: 210, position: 8 },
    { url: '/blogs/news/other', cluster: 'soap', impressions: 900, clicks: 3, position: 8 },
  ], { ranking: RANKING });

  assert.equal(rows.length, 2);
  const flagship = rows.find((r) => r.url === '/blogs/news/tattoo');
  assert.equal(flagship.impressions, 37531);
  assert.equal(rows.filter((r) => r.url === '/blogs/news/tattoo').length, 1);
});

test('ties are broken deterministically — impressions, then url', () => {
  const build = () => [
    { url: '/b', cluster: 'lotion', impressions: 1000, clicks: 10, position: 8 },
    { url: '/a', cluster: 'lotion', impressions: 1000, clicks: 10, position: 8 },
    { url: '/c', cluster: 'lotion', impressions: 2000, clicks: 20, position: 8 },
  ];
  const once = urls(rankOpportunities(build(), { ranking: RANKING }));
  assert.deepEqual(once, ['/c', '/a', '/b']);
  // shuffling the input cannot change the answer
  assert.deepEqual(urls(rankOpportunities(build().reverse(), { ranking: RANKING })), once);
});

test('REVENUE WEIGHTING BITES: a bigger toothpaste page loses to a smaller lotion page', () => {
  // Raw impressions say toothpaste first by 2.5x. Toothpaste is 41.4% of blog
  // impressions for 2.9% of revenue, which is exactly the budget capture this
  // score exists to prevent.
  const pages = [
    { url: '/blogs/news/no-fluoride-toothpaste', cluster: 'toothpaste', impressions: 30000, clicks: 100, position: 9 },
    { url: '/blogs/news/coconut-oil-body-lotion', cluster: 'lotion', impressions: 12000, clicks: 40, position: 9 },
  ];
  const byImpressions = [...pages].sort((a, b) => b.impressions - a.impressions).map((p) => p.url);
  assert.equal(byImpressions[0], '/blogs/news/no-fluoride-toothpaste');

  const ranked = rankOpportunities(pages, { ranking: RANKING });
  assert.equal(ranked[0].url, '/blogs/news/coconut-oil-body-lotion');
  // and it wins on the WEIGHT, not on raw headroom — the toothpaste page has more
  assert.ok(ranked[1].recoverable > ranked[0].recoverable);
  assert.ok(ranked[1].score < ranked[0].score);

  // with no ranking at all, the raw order returns — proof the weight is what moved it
  assert.equal(rankOpportunities(pages, { ranking: null })[0].url, '/blogs/news/no-fluoride-toothpaste');
});

test('limit caps the list only when it is a positive finite number', () => {
  const pages = [1, 2, 3, 4, 5].map((n) => ({
    url: `/p${n}`, cluster: 'lotion', impressions: n * 1000, clicks: 1, position: 8,
  }));
  assert.equal(rankOpportunities(pages, { ranking: RANKING, limit: 3 }).length, 3);
  assert.equal(rankOpportunities(pages, { ranking: RANKING, limit: 99 }).length, 5);
  for (const limit of [null, undefined, 0, -1, NaN, Infinity, 'five']) {
    assert.equal(rankOpportunities(pages, { ranking: RANKING, limit }).length, 5, String(limit));
  }
});

test('the input array and its rows are never mutated', () => {
  const pages = [
    { url: '/a', cluster: 'toothpaste', impressions: 1000, clicks: 5, position: 8 },
    { url: '/b', cluster: 'lotion', impressions: 900, clicks: 4, position: 12 },
  ];
  const before = JSON.parse(JSON.stringify(pages));
  const out = rankOpportunities(pages, { ranking: RANKING });
  assert.deepEqual(pages, before);
  assert.equal(pages.length, 2);
  assert.notEqual(out[0], pages[0]);
  assert.ok('score' in out[0] && !('score' in pages[0]));
});

test('empty, null and malformed input rank without throwing', () => {
  assert.deepEqual(rankOpportunities([], { ranking: RANKING }), []);
  assert.deepEqual(rankOpportunities(null, { ranking: RANKING }), []);
  assert.deepEqual(rankOpportunities(undefined), []);
  assert.equal(rankOpportunities([{}, null, { url: '/a' }]).length, 3);
  const junk = rankOpportunities([{ url: '/a', impressions: 'x', clicks: null, position: null }]);
  assert.equal(junk[0].score, 0);
  assert.ok(Number.isFinite(junk[0].score));
});
