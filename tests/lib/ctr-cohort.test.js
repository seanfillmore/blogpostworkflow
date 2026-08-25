import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assignCohorts,
  cohortTotals,
  differenceInDifferences,
  cohortVerdict,
  DEFAULT_COHORT_SIZE,
  partitionByPower,
} from '../../lib/ctr-cohort.js';

const page = (url, cluster, impressions, score = impressions) => ({ url, cluster, impressions, score });

// ── assignCohorts ────────────────────────────────────────────────────────────

test('splits the ranked pool into two arms of the requested size', () => {
  const pool = Array.from({ length: 30 }, (_, i) => page(`p${i}`, 'soap', 10000 - i * 100));
  const { treatment, holdout, unassigned } = assignCohorts(pool, { size: 10 });
  assert.equal(treatment.length, 10);
  assert.equal(holdout.length, 10);
  assert.equal(unassigned.length, 10);
});

test('arms are balanced on impressions, not merely equal in count', () => {
  // A naive top-half/bottom-half split would put every large page in one arm.
  const pool = [
    page('a', 'soap', 40000), page('b', 'soap', 30000),
    page('c', 'soap', 20000), page('d', 'soap', 10000),
  ];
  const { treatment, holdout, balance } = assignCohorts(pool, { size: 2 });
  const t = treatment.reduce((s, p) => s + p.impressions, 0);
  const h = holdout.reduce((s, p) => s + p.impressions, 0);
  assert.equal(t + h, 100000);
  assert.ok(balance.skew < 0.25, `skew was ${balance.skew}`);
  assert.equal(balance.treatmentImpressions, t);
  assert.equal(balance.holdoutImpressions, h);
});

test('arms are balanced on cluster mix, so a cluster cannot land entirely in one', () => {
  const pool = [
    page('t1', 'toothpaste', 40000), page('t2', 'toothpaste', 38000),
    page('s1', 'soap', 20000), page('s2', 'soap', 19000),
    page('d1', 'deodorant', 9000), page('d2', 'deodorant', 8000),
  ];
  const { treatment, holdout } = assignCohorts(pool, { size: 3 });
  for (const c of ['toothpaste', 'soap', 'deodorant']) {
    assert.equal(treatment.filter((p) => p.cluster === c).length, 1, `${c} in treatment`);
    assert.equal(holdout.filter((p) => p.cluster === c).length, 1, `${c} in holdout`);
  }
});

test('cluster mix survives ONE page dominating the corpus', () => {
  // The real 2026-08-21 shape, and the case a pure greedy impression-balance
  // gets wrong: toothpaste-without-sls is 102,816 impressions, 19.7% of the
  // whole blog. Greedy assignment hands it to treatment, treatment is then far
  // ahead on impressions, and EVERY remaining toothpaste page goes to the
  // holdout — measured 1-vs-4 on the real pool. Cluster mix is the axis a DiD
  // actually depends on (differential trends between categories), so it wins
  // the tie against arm size, which only costs power we have to spare.
  const pool = [
    page('huge', 'toothpaste', 102816), page('t2', 'toothpaste', 36238),
    page('t3', 'toothpaste', 19297), page('t4', 'toothpaste', 18929),
    page('s1', 'soap', 37531), page('s2', 'soap', 30892),
    page('s3', 'soap', 9158), page('s4', 'soap', 8943),
    page('d1', 'deodorant', 26184), page('d2', 'deodorant', 14416),
  ];
  const { treatment, holdout } = assignCohorts(pool, { size: 5 });
  for (const c of ['toothpaste', 'soap', 'deodorant']) {
    const t = treatment.filter((p) => p.cluster === c).length;
    const h = holdout.filter((p) => p.cluster === c).length;
    assert.ok(Math.abs(t - h) <= 1, `${c} split ${t}/${h} — arms are not comparable`);
  }
});

test('assignment is deterministic across repeated calls', () => {
  const pool = Array.from({ length: 24 }, (_, i) => page(`p${i}`, i % 3 === 0 ? 'soap' : 'lotion', 5000 + i));
  const a = assignCohorts(pool, { size: 6 });
  const b = assignCohorts(pool, { size: 6 });
  assert.deepEqual(a.treatment.map((p) => p.url), b.treatment.map((p) => p.url));
  assert.deepEqual(a.holdout.map((p) => p.url), b.holdout.map((p) => p.url));
});

test('does not mutate the input pool', () => {
  const pool = [page('a', 'soap', 100), page('b', 'soap', 90)];
  const snapshot = JSON.parse(JSON.stringify(pool));
  assignCohorts(pool, { size: 1 });
  assert.deepEqual(pool, snapshot);
});

test('a pool too small for two full arms still returns balanced, non-overlapping arms', () => {
  const pool = [page('a', 'soap', 100), page('b', 'soap', 90), page('c', 'soap', 80)];
  const { treatment, holdout } = assignCohorts(pool, { size: 10 });
  const urls = new Set([...treatment, ...holdout].map((p) => p.url));
  assert.equal(urls.size, treatment.length + holdout.length, 'no page in both arms');
  assert.ok(treatment.length + holdout.length <= 3);
});

test('an empty pool yields empty arms rather than throwing', () => {
  const r = assignCohorts([], { size: DEFAULT_COHORT_SIZE });
  assert.deepEqual(r.treatment, []);
  assert.deepEqual(r.holdout, []);
  assert.equal(r.balance.skew, 0);
});

// ── cohortTotals ─────────────────────────────────────────────────────────────

test('cohortTotals sums clicks and impressions and derives CTR', () => {
  const metrics = new Map([
    ['a', { clicks: 10, impressions: 1000 }],
    ['b', { clicks: 5, impressions: 1000 }],
  ]);
  const t = cohortTotals([{ url: 'a' }, { url: 'b' }], metrics);
  assert.equal(t.clicks, 15);
  assert.equal(t.impressions, 2000);
  assert.equal(t.ctr, 0.0075);
});

test('cohortTotals treats a page with no metrics as zero, not as missing', () => {
  const metrics = new Map([['a', { clicks: 10, impressions: 1000 }]]);
  const t = cohortTotals([{ url: 'a' }, { url: 'ghost' }], metrics);
  assert.equal(t.impressions, 1000);
  assert.equal(t.missing, 1);
});

test('cohortTotals on nothing gives a zero CTR, not NaN', () => {
  const t = cohortTotals([], new Map());
  assert.equal(t.ctr, 0);
});

// ── differenceInDifferences ──────────────────────────────────────────────────

const arms = (tPre, tPost, hPre, hPost) => ({
  treatment: { pre: tPre, post: tPost },
  holdout: { pre: hPre, post: hPost },
});

test('a corpus-wide tailwind is subtracted out, not counted as a win', () => {
  // Both arms rise identically — exactly what the real blog corpus did between
  // 2026-03 and 2026-08 (0.166% → 0.505%). The DiD must be zero.
  const r = differenceInDifferences(arms(
    { clicks: 100, impressions: 50000 }, { clicks: 200, impressions: 50000 },
    { clicks: 100, impressions: 50000 }, { clicks: 200, impressions: 50000 },
  ));
  assert.ok(Math.abs(r.did) < 1e-12);
  assert.ok(Math.abs(r.treatmentDelta - r.holdoutDelta) < 1e-12);
  assert.equal(r.outcomeSign, 0);
});

test('a real treatment effect survives the same tailwind', () => {
  const r = differenceInDifferences(arms(
    { clicks: 100, impressions: 50000 }, { clicks: 300, impressions: 50000 },
    { clicks: 100, impressions: 50000 }, { clicks: 200, impressions: 50000 },
  ));
  assert.ok(r.did > 0);
  assert.ok(Math.abs(r.did - 0.002) < 1e-12);
  assert.ok(r.z > 1.96, `z was ${r.z}`);
  assert.ok(r.pValue < 0.05);
});

test('a headwind that hits both arms is not a regression', () => {
  const r = differenceInDifferences(arms(
    { clicks: 300, impressions: 50000 }, { clicks: 150, impressions: 50000 },
    { clicks: 300, impressions: 50000 }, { clicks: 150, impressions: 50000 },
  ));
  assert.ok(Math.abs(r.did) < 1e-12);
});

test('standard error grows as the arms shrink', () => {
  const big = differenceInDifferences(arms(
    { clicks: 100, impressions: 50000 }, { clicks: 150, impressions: 50000 },
    { clicks: 100, impressions: 50000 }, { clicks: 100, impressions: 50000 },
  ));
  const small = differenceInDifferences(arms(
    { clicks: 2, impressions: 1000 }, { clicks: 3, impressions: 1000 },
    { clicks: 2, impressions: 1000 }, { clicks: 2, impressions: 1000 },
  ));
  assert.ok(small.standardError > big.standardError);
});

test('zero-impression arms give a finite, non-significant result', () => {
  const r = differenceInDifferences(arms(
    { clicks: 0, impressions: 0 }, { clicks: 0, impressions: 0 },
    { clicks: 0, impressions: 0 }, { clicks: 0, impressions: 0 },
  ));
  assert.ok(Number.isFinite(r.did));
  assert.equal(r.z, 0);
  assert.equal(r.pValue, 1);
});

// ── cohortVerdict ────────────────────────────────────────────────────────────

test('a significant positive DiD is improved', () => {
  const r = differenceInDifferences(arms(
    { clicks: 100, impressions: 50000 }, { clicks: 300, impressions: 50000 },
    { clicks: 100, impressions: 50000 }, { clicks: 200, impressions: 50000 },
  ));
  const v = cohortVerdict(r);
  assert.equal(v.outcome, 'improved');
  assert.equal(v.significant, true);
  assert.equal(v.shouldRevert, false);
});

test('a significant negative DiD is regressed and asks for a revert', () => {
  const r = differenceInDifferences(arms(
    { clicks: 300, impressions: 50000 }, { clicks: 100, impressions: 50000 },
    { clicks: 300, impressions: 50000 }, { clicks: 300, impressions: 50000 },
  ));
  const v = cohortVerdict(r);
  assert.equal(v.outcome, 'regressed');
  assert.equal(v.shouldRevert, true);
});

test('a small non-significant DiD on a big sample is flat, NOT underpowered', () => {
  const r = differenceInDifferences(arms(
    { clicks: 2000, impressions: 400000 }, { clicks: 2010, impressions: 400000 },
    { clicks: 2000, impressions: 400000 }, { clicks: 2000, impressions: 400000 },
  ));
  const v = cohortVerdict(r);
  assert.equal(v.significant, false);
  assert.equal(v.outcome, 'flat');
  assert.equal(v.shouldRevert, false);
});

test('a non-significant DiD on a thin sample is underpowered, and never reverts', () => {
  // The 133-impression shape that was concluded "improved" in the real tracker.
  const r = differenceInDifferences(arms(
    { clicks: 2, impressions: 133 }, { clicks: 3, impressions: 133 },
    { clicks: 2, impressions: 133 }, { clicks: 2, impressions: 133 },
  ));
  const v = cohortVerdict(r);
  assert.equal(v.outcome, 'underpowered');
  assert.equal(v.shouldRevert, false);
  assert.ok(v.mde > v.targetAbsoluteLift);
});

test('cohortVerdict never throws on a degenerate DiD', () => {
  const r = differenceInDifferences(arms(
    { clicks: 0, impressions: 0 }, { clicks: 0, impressions: 0 },
    { clicks: 0, impressions: 0 }, { clicks: 0, impressions: 0 },
  ));
  const v = cohortVerdict(r);
  assert.equal(v.shouldRevert, false);
  assert.ok(typeof v.outcome === 'string');
});

// ── partitionByPower ─────────────────────────────────────────────────────────

test('a page powered on its own is separated from the pool', () => {
  // toothpaste-without-sls: 102,816 imps/90d at 0.79%. It is 19.7% of the whole
  // blog corpus, so pooling it makes the cohort a single-page test wearing a
  // cohort's name — and it does not need pooling, because it clears the bar
  // alone by a wide margin.
  const pool = [
    { url: 'huge', cluster: 'toothpaste', impressions: 102816, clicks: 809, ctr: 809 / 102816 },
    { url: 'small', cluster: 'lotion', impressions: 3826, clicks: 20, ctr: 20 / 3826 },
  ];
  const { individual, pooled } = partitionByPower(pool, { windowDays: 90 });
  assert.deepEqual(individual.map((p) => p.url), ['huge']);
  assert.deepEqual(pooled.map((p) => p.url), ['small']);
  assert.ok(individual[0].power.powered);
  assert.equal(pooled[0].power.powered, false);
});

test('on the real corpus only a handful of pages test individually', () => {
  const real = [
    { url: 'toothpaste-without-sls', cluster: 'toothpaste', impressions: 102816, clicks: 809 },
    { url: 'tattoo-2', cluster: 'soap', impressions: 37531, clicks: 210 },
    { url: 'best-tp-2025', cluster: 'toothpaste', impressions: 36238, clicks: 239 },
    { url: 'tattoo-1', cluster: 'soap', impressions: 30892, clicks: 110 },
    { url: 'coconut-deo', cluster: 'deodorant', impressions: 26184, clicks: 154 },
    { url: 'sensitive-deo', cluster: 'deodorant', impressions: 14416, clicks: 6 },
  ].map((p) => ({ ...p, ctr: p.clicks / p.impressions }));
  const { individual, pooled } = partitionByPower(real, { windowDays: 90 });
  // The three biggest-with-real-CTR clear it; the rest do not.
  assert.deepEqual(individual.map((p) => p.url).sort(), ['best-tp-2025', 'tattoo-2', 'toothpaste-without-sls']);
  assert.equal(pooled.length, 3);
});

test('a zero-click page is never promoted to an individual test', () => {
  // 6,871 impressions and 0 clicks. A near-zero baseline makes the required
  // sample collapse arithmetically; it must not read as "easy to measure".
  const { individual, pooled } = partitionByPower(
    [{ url: 'zero', cluster: 'lotion', impressions: 6871, clicks: 0, ctr: 0 }],
    { windowDays: 90 },
  );
  assert.equal(individual.length, 0);
  assert.equal(pooled.length, 1);
});

test('partitionByPower preserves order, does not mutate, and tolerates junk', () => {
  const pool = [{ url: 'a', impressions: 100, clicks: 1, ctr: 0.01 }, null, { url: 'b' }];
  const snapshot = JSON.stringify(pool);
  const r = partitionByPower(pool, { windowDays: 90 });
  assert.equal(JSON.stringify(pool), snapshot);
  assert.equal(r.individual.length + r.pooled.length, 2, 'null rows are dropped, real ones kept');
  assert.deepEqual(partitionByPower(null, {}).pooled, []);
});
