import { test } from 'node:test';
import assert from 'node:assert/strict';
import { concentration, byCluster, reDecideTracker } from '../../agents/ctr-program/lib/summarise.js';

const page = (url, cluster, impressions, clicks = 0) => ({ url, cluster, impressions, clicks });

// ── concentration ────────────────────────────────────────────────────────────

test('reproduces the measured blog concentration shape', () => {
  // Not the real 190 rows, but the same shape: a long tail behind a heavy head.
  const pages = [
    page('a', 'toothpaste', 102816), page('b', 'soap', 37531), page('c', 'toothpaste', 36238),
    page('d', 'soap', 30892), page('e', 'deodorant', 26184),
    ...Array.from({ length: 45 }, (_, i) => page(`t${i}`, 'lotion', 1000 - i * 10)),
  ];
  const c = concentration(pages);
  assert.equal(c.totalPages, 50);
  const top5 = c.rows.find((r) => r.topN === 5);
  assert.ok(top5.share > 0.85, `top 5 held ${top5.share}`);
  // Cumulative and monotonically non-decreasing.
  const shares = c.rows.map((r) => r.share);
  for (let i = 1; i < shares.length; i++) assert.ok(shares[i] >= shares[i - 1]);
});

test('the last mark reaches 100% when it covers every page', () => {
  const pages = [page('a', 'soap', 10), page('b', 'soap', 5)];
  const c = concentration(pages);
  assert.ok(Math.abs(c.rows.at(-1).share - 1) < 1e-12);
});

test('concentration on nothing is zeros, not NaN', () => {
  const c = concentration([]);
  assert.equal(c.totalImpressions, 0);
  assert.equal(c.totalPages, 0);
  for (const r of c.rows) assert.equal(r.share, 0);
});

test('concentration ignores rows with no usable impressions and does not mutate', () => {
  const pages = [page('a', 'soap', 10), { url: 'b' }, null];
  const snapshot = JSON.stringify(pages);
  const c = concentration(pages);
  assert.equal(c.totalPages, 1);
  assert.equal(JSON.stringify(pages), snapshot);
});

// ── byCluster ────────────────────────────────────────────────────────────────

test('rolls up by cluster, biggest first, with CTR derived', () => {
  const rows = byCluster([
    page('a', 'toothpaste', 100000, 600),
    page('b', 'toothpaste', 15000, 100),
    page('c', 'soap', 50000, 200),
  ]);
  assert.equal(rows[0].cluster, 'toothpaste');
  assert.equal(rows[0].pages, 2);
  assert.equal(rows[0].impressions, 115000);
  assert.equal(rows[0].clicks, 700);
  assert.ok(Math.abs(rows[0].ctr - 700 / 115000) < 1e-12);
  assert.equal(rows[1].cluster, 'soap');
});

test('a page with no cluster is bucketed, never dropped', () => {
  const rows = byCluster([page('a', null, 100, 1)]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cluster, 'unclustered');
});

test('byCluster on nothing is an empty list', () => {
  assert.deepEqual(byCluster([]), []);
  assert.deepEqual(byCluster(null), []);
});

// ── reDecideTracker ──────────────────────────────────────────────────────────

// The four real 2026-03-09 tests the tracker records as `improved`, plus the
// 2026-06-22 one. Verbatim numbers from data/reports/meta-ab/meta-ab-tracker.json.
const REAL_IMPROVED = [
  { keyword: "tom's of maine toothpaste alternative", status: 'concluded', outcome: 'improved', testedAt: '2026-03-09', baselineCtr: 0.01504, currentCtr: 0.01884, baselineImpressions: 133 },
  { keyword: 'coconut oil for stretch marks', status: 'concluded', outcome: 'improved', testedAt: '2026-03-09', baselineCtr: 0.0005, currentCtr: 0.00179, baselineImpressions: 1996 },
  { keyword: 'dr bronner alternative', status: 'concluded', outcome: 'improved', testedAt: '2026-03-09', baselineCtr: 0.00148, currentCtr: 0.00243, baselineImpressions: 674 },
  { keyword: 'coconut oil soap benefits', status: 'concluded', outcome: 'improved', testedAt: '2026-06-22', baselineCtr: 0.00446, currentCtr: 0.00633, baselineImpressions: 673 },
];

test('NOT ONE of the recorded "improved" verdicts survives re-decision', () => {
  const audit = reDecideTracker(REAL_IMPROVED);
  assert.equal(audit.concluded, 4);
  assert.equal(audit.survivingVerdicts, 0);
  assert.equal(audit.downgraded, 4);
  for (const r of audit.rows) {
    assert.notEqual(r.reDecided, 'improved', `${r.keyword} still reads improved`);
  }
});

test('the 133-impression test is specifically re-decided as underpowered', () => {
  const audit = reDecideTracker([REAL_IMPROVED[0]]);
  assert.equal(audit.rows[0].reDecided, 'underpowered');
  assert.ok(audit.rows[0].mde > audit.rows[0].delta, 'the smallest readable move exceeds the delta');
});

test('a decisive verdict on a real sample survives and is counted', () => {
  const audit = reDecideTracker([{
    keyword: 'big and real', status: 'concluded', outcome: 'improved', testedAt: '2026-01-01',
    baselinePageCtr: 0.004, currentCtr: 0.012, baselinePageImpressions: 200000, baselineImpressions: 9,
  }]);
  assert.equal(audit.rows[0].reDecided, 'improved');
  assert.equal(audit.survivingVerdicts, 1);
  assert.equal(audit.downgraded, 0);
  assert.equal(audit.rows[0].impressionsPerArm, 200000, 'prefers the page-basis arm when present');
});

test('a flat verdict never counts as a surviving verdict, even when unchanged', () => {
  const audit = reDecideTracker([{
    keyword: 'nothing happened', status: 'concluded', outcome: 'flat', testedAt: '2026-01-01',
    baselinePageCtr: 0.004, currentCtr: 0.0041, baselinePageImpressions: 400000,
  }]);
  assert.equal(audit.rows[0].changed, false);
  assert.equal(audit.survivingVerdicts, 0, 'consistency is not evidence');
});

test('open tests are counted but never re-decided', () => {
  const audit = reDecideTracker([
    REAL_IMPROVED[0],
    { keyword: 'still running', testedAt: '2026-08-24', baselineCtr: 0.005, baselineImpressions: 2000 },
  ]);
  assert.equal(audit.total, 2);
  assert.equal(audit.concluded, 1);
  assert.equal(audit.open, 1);
  assert.equal(audit.rows.length, 1);
});

test('re-decision never throws on junk and never mutates the tracker', () => {
  const input = [{ status: 'concluded' }, null, { status: 'concluded', baselineCtr: 'x', currentCtr: undefined }];
  const snapshot = JSON.stringify(input);
  const audit = reDecideTracker(input);
  assert.equal(JSON.stringify(input), snapshot);
  assert.ok(audit.rows.every((r) => typeof r.reDecided === 'string'));
  assert.deepEqual(reDecideTracker(null).rows, []);
});
