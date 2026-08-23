import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  clusterFamily, productRevenueByFamily, corroborateClusters, buildClusterHold,
  loadClusterHold, holdBanner, windowsFor, WIDE_WINDOW_DAYS, HOLD_FLAG,
} from '../../lib/cluster-hold.js';
import { classifyClusters } from '../../lib/cluster-revenue.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ── the nine real product titles ─────────────────────────────────────────────
// Every product that earned a dollar in the trailing 90 days, verbatim from
// data/snapshots/shopify/*.json `topProducts[].title` on the production server.
// This is the join that decides whether a cluster is really earning, so it is
// tested against the real strings and not against tidied-up ones.

const TITLES = [
  ['Non-Toxic Body Lotion Made With Only 6 Clean Ingredients', 'lotion'],
  ['Coconut Moisturizer | 4oz', 'lotion'],
  ['Best Coconut Oil Deodorant — All Natural Formula | 2oz', 'deodorant'],
  ['Foaming Liquid Coconut Oil Soap | 8oz', 'soap'],
  ['Foam Soap Refill | 32oz', 'soap'],
  ['Natural Coconut Oil Lip Balm | 0.15oz | Four Pack', 'lip balm'],
  ['Sensitive Skin Moisturizing Set', 'lotion'],
  ['Moisturizing Coconut Soap | 3.4oz', 'soap'],
  ['Coconut Oil Toothpaste — Natural Oral Care, Fluoride Free', 'toothpaste'],
];

test('every real product title maps to the family its revenue belongs to', () => {
  for (const [title, family] of TITLES) {
    assert.equal(clusterFamily(title), family, title);
  }
});

test('a soap that is also a moisturizer lands in soap, not lotion', () => {
  // "Moisturizing Coconut Soap" matches BOTH the soap and lotion rules.
  // assignCluster is ordered first-match-wins and soap precedes lotion, which is
  // the only reason $40.70 of soap revenue is not filed as lotion revenue.
  assert.equal(clusterFamily('Moisturizing Coconut Soap | 3.4oz'), 'soap');
});

test('both vocabularies meet in one place — seo-impact cluster names map to the same families', () => {
  // seo-impact splits soap into `soap` + `hand soap` and lotion into
  // `body lotion` + `lotion` + `moisturizer`. Product titles know none of that.
  // Corroboration is only meaningful because BOTH sides go through assignCluster.
  assert.equal(clusterFamily('hand soap'), 'soap');
  assert.equal(clusterFamily('soap'), 'soap');
  assert.equal(clusterFamily('body lotion'), 'lotion');
  assert.equal(clusterFamily('moisturizer'), 'lotion');
  assert.equal(clusterFamily('body cream'), 'lotion');
  assert.equal(clusterFamily('toothpaste'), 'toothpaste');
  assert.equal(clusterFamily('lip balm'), 'lip balm');
});

test('a cluster name that maps to no family is reported as unmappable, not as zero', () => {
  assert.equal(clusterFamily('foaming'), 'unclustered');
  assert.equal(clusterFamily(''), 'unclustered');
});

// ── aggregating snapshots ────────────────────────────────────────────────────

const snap = (date, orders, revenue, products) => ({
  date, orders: { count: orders, revenue }, topProducts: products,
});

// The real 28-day window seo-impact reported on 2026-08-22: 18 orders, $1,079.46.
const WINDOW_SNAPSHOTS = [
  snap('2026-07-30', 1, 90, [{ title: TITLES[0][0], revenue: 90 }]),
  snap('2026-08-09', 1, 60, [{ title: TITLES[5][0], revenue: 60 }]),
  snap('2026-08-17', 1, 93, [
    { title: TITLES[4][0], revenue: 78 },
    { title: TITLES[2][0], revenue: 15 },
  ]),
  snap('2026-08-18', 3, 250, [
    { title: TITLES[0][0], revenue: 113.58 },
    { title: TITLES[3][0], revenue: 78 },
    { title: TITLES[1][0], revenue: 58.42 },
  ]),
];

test('product revenue aggregates by family across a window', () => {
  const agg = productRevenueByFamily(WINDOW_SNAPSHOTS);
  assert.equal(agg.byFamily.soap, 156, 'two different soap SKUs sum into one family');
  assert.equal(agg.byFamily.lotion, 262, '90 + 113.58 + 58.42');
  assert.equal(agg.byFamily['lip balm'], 60);
  assert.equal(agg.byFamily.deodorant, 15);
  assert.equal(agg.byFamily.toothpaste, undefined, 'a family that earned nothing has no row');
  assert.equal(agg.orders, 6);
  assert.equal(agg.revenue, 493);
});

test('the materiality floor is one average order, derived from the same snapshots', () => {
  // Not a magic constant: a cluster that has not produced even a single
  // average order over the window is materially a non-channel, and the floor
  // moves with the business instead of ageing into a wrong number.
  const agg = productRevenueByFamily(WINDOW_SNAPSHOTS);
  assert.equal(agg.aov, 493 / 6);
  assert.equal(agg.available, true);
});

test('a window with no orders cannot corroborate anything', () => {
  const agg = productRevenueByFamily([snap('2026-08-01', 0, 0, [])]);
  assert.equal(agg.available, false, 'no orders means no average order, so no floor');
});

test('a day at the collector top-5 cap makes the window a lower bound, not evidence', () => {
  // agents/shopify-collector keeps only the top 5 products per day. That has
  // never happened (max 4 across all history), but if it does, a family showing
  // zero might simply be the part that was cut — which would make a hold an
  // artifact of the cap.
  const capped = [snap('2026-08-18', 6, 300, Array.from({ length: 5 }, (_, i) => ({
    title: TITLES[i][0], revenue: 60,
  })))];
  const agg = productRevenueByFamily(capped);
  assert.equal(agg.truncatedDays, 1);
  assert.equal(agg.available, false, 'a truncated window is refused rather than trusted');
});

test('aggregation tolerates missing and malformed snapshots', () => {
  const agg = productRevenueByFamily([null, {}, snap('2026-08-01', 1, 10, null)]);
  assert.equal(agg.orders, 1);
  assert.deepEqual(agg.byFamily, {});
});

// ── corroboration: the rule that soap broke ──────────────────────────────────

const REPORT_CLUSTERS = classifyClusters([
  { cluster: 'body lotion', revenue: 313.49, clicks: 35, pages: 20 },
  { cluster: 'hand soap', revenue: 62.4, clicks: 4, pages: 4 },
  { cluster: 'lip balm', revenue: 48, clicks: 4, pages: 6 },
  { cluster: 'deodorant', revenue: 38.25, clicks: 121, pages: 21 },
  { cluster: 'toothpaste', revenue: 0, clicks: 663, pages: 24 },
  { cluster: 'soap', revenue: 0, clicks: 223, pages: 24 },
  { cluster: 'lotion', revenue: 0, clicks: 56, pages: 12 },
]);

// Real measured product revenue: soap earns, toothpaste does not.
const MEASURED = [
  { label: 'report window (28d)', start: '2026-07-24', end: '2026-08-20', available: true, orders: 18, revenue: 1079.46, aov: 59.97, truncatedDays: 0, byFamily: { lotion: 909, 'lip balm': 120, soap: 156, deodorant: 60 } },
  { label: 'wide window (90d)', start: '2026-05-24', end: '2026-08-21', available: true, orders: 39, revenue: 2118.77, aov: 54.33, truncatedDays: 0, byFamily: { lotion: 1695.3, soap: 365.7, deodorant: 180, 'lip balm': 120, toothpaste: 39 } },
];

test('SOAP IS NOT HELD — seo-impact says $0, the orders say $365.70', () => {
  const v = corroborateClusters(REPORT_CLUSTERS, MEASURED);
  assert.equal(v.soap.verdict, 'disagreement');
  assert.equal(v.soap.family, 'soap');
  assert.match(v.soap.reason, /365\.7|156/, 'the reason quotes the measured dollars');
  assert.match(v.soap.reason, /attribution/i, 'a disagreement is an attribution defect, and says so');
});

test('TOOTHPASTE IS STILL HELD — both sources agree it earns nothing', () => {
  const v = corroborateClusters(REPORT_CLUSTERS, MEASURED);
  assert.equal(v.toothpaste.verdict, 'held');
  assert.equal(v.toothpaste.family, 'toothpaste');
});

test('one material window is enough to block a hold — unanimity is required', () => {
  // $0 across the report's own 28 days, but real money over 90. A quiet month is
  // not evidence that a category earns nothing.
  const quietRecently = [
    { ...MEASURED[0], byFamily: { ...MEASURED[0].byFamily, soap: 0 } },
    MEASURED[1],
  ];
  assert.equal(corroborateClusters(REPORT_CLUSTERS, quietRecently).soap.verdict, 'disagreement');
});

test('a cluster that is not a proven dud is never corroborated at all', () => {
  const v = corroborateClusters(REPORT_CLUSTERS, MEASURED);
  assert.equal(v['body lotion'].verdict, 'earning');
  assert.equal(v.lotion.verdict, 'unproven', '56 clicks is too little to judge');
});

test('an unmappable cluster name cannot be corroborated, so it is not held', () => {
  const odd = classifyClusters([{ cluster: 'foaming', revenue: 0, clicks: 400, pages: 12 }]);
  const v = corroborateClusters(odd, MEASURED);
  assert.equal(v.foaming.verdict, 'uncorroborated');
  assert.match(v.foaming.reason, /could not be mapped/i);
});

test('missing snapshots corroborate nothing — the hold fails OPEN', () => {
  const blind = [{ label: 'report window (28d)', available: false }, { label: 'wide window (90d)', available: false }];
  const v = corroborateClusters(REPORT_CLUSTERS, blind);
  assert.equal(v.toothpaste.verdict, 'uncorroborated');
  assert.equal(v.soap.verdict, 'uncorroborated');
});

// ── the hold context built on top ────────────────────────────────────────────

test('buildClusterHold holds only the corroborated duds and lists the disagreements', () => {
  const hold = buildClusterHold(REPORT_CLUSTERS, { measured: MEASURED, generatedAt: '2026-08-22T15:16:44.241Z' });
  assert.deepEqual([...hold.heldSet], ['toothpaste'], 'soap is gone from the held set');
  assert.equal(hold.disagreements.length, 1);
  assert.equal(hold.disagreements[0].cluster, 'soap');
  assert.equal(hold.disagreements[0].productRevenue, 365.7);
});

test('with no corroboration data at all, nothing is held', () => {
  const hold = buildClusterHold(REPORT_CLUSTERS, { measured: [] });
  assert.equal(hold.heldSet.size, 0);
});

test('the banner names the disagreement loudly — broken attribution is itself the finding', () => {
  const hold = buildClusterHold(REPORT_CLUSTERS, { measured: MEASURED, generatedAt: 'X' });
  const b = holdBanner(hold);
  assert.match(b, /toothpaste/);
  assert.match(b, /ATTRIBUTION DISAGREEMENT/);
  assert.match(b, /soap/);
  assert.match(b, /365\.7/);
  assert.match(b, /NOT held/i);
  assert.match(b, new RegExp(HOLD_FLAG));
});

// ── window derivation ────────────────────────────────────────────────────────

test('the corroboration window is taken from the report, never invented', () => {
  const w = windowsFor({ start: '2026-07-24', end: '2026-08-20' });
  assert.equal(w[0].start, '2026-07-24');
  assert.equal(w[0].end, '2026-08-20');
  assert.equal(w[1].end, '2026-08-20', 'the wide window ends on the same day');
  assert.equal(w[1].start, '2026-05-23', `${WIDE_WINDOW_DAYS} days INCLUSIVE, ending 2026-08-20`);
});

test('a report with no window block yields no windows, so nothing can be held', () => {
  assert.deepEqual(windowsFor(null), []);
  assert.deepEqual(windowsFor({ start: '2026-07-24' }), []);
});

test('loadClusterHold reads the snapshots for the union of both windows', () => {
  const read = [];
  const hold = loadClusterHold({
    root: ROOT,
    readJson: (p) => {
      read.push(p);
      if (p.endsWith('latest.json')) {
        return { generated_at: 'X', window: { start: '2026-08-18', end: '2026-08-18' }, clusters: [{ cluster: 'toothpaste', revenue: 0, clicks: 663, pages: 24 }] };
      }
      return snap('2026-08-18', 3, 250, [{ title: TITLES[0][0], revenue: 250 }]);
    },
    readDir: () => ['2026-08-18.json', '2026-05-01.json', 'notes.txt'],
  });
  assert.ok(read.some((p) => p.includes('snapshots')), 'snapshots were read');
  assert.ok(!read.some((p) => p.includes('2026-05-01')), 'a snapshot outside both windows is not read');
  assert.deepEqual([...hold.heldSet], ['toothpaste']);
});

test('no cluster name is hardcoded in the corroboration either', () => {
  // Executable source only. The module's docstring names the cluster this
  // correction came from, because an incident nobody can name is one that gets
  // repeated — but no cluster may appear in the LOGIC.
  for (const rel of ['lib/cluster-hold.js', 'scripts/cluster-holds.mjs']) {
    const src = readFileSync(join(ROOT, rel), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
      .toLowerCase();
    assert.ok(!src.includes('toothpaste'), `${rel} must not name a cluster`);
    assert.ok(!src.includes('soap'), `${rel} must not name a cluster`);
  }
});
