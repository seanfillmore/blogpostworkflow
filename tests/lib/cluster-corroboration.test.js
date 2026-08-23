// tests/lib/cluster-corroboration.test.js
//
// THE SAFETY PROPERTY THIS FILE EXISTS TO PIN: no single measurement pipeline may
// condemn a category alone. Held on one source, the rule paused `soap` — which
// sells $324.85/90d, 13% of all revenue and second only to lotion — because
// seo-impact's entry-page attribution filed $62.40 of it under `hand soap` and
// showed `soap` at $0.
//
// WHAT CHANGED ON 2026-08-23 AND WHAT DID NOT. The two sources SWAPPED ROLES and
// a third was retired; the rule itself is unchanged.
//
//              PRIMARY (source A)              CROSS-CHECK (source B)
//   question   what did the CATEGORY SELL?     what did its PAGES EARN?
//   data       raw order LINE ITEMS            raw order TOTALS
//   join key   product title → cluster         landing-page URL → cluster
//   channels   all                             organic search only
//
// The independence that caught the soap bug was never "two databases" — both
// sides always read Shopify orders. It was the JOIN KEY, and A and B still
// differ on exactly that axis. `data/snapshots/shopify/*.json` `topProducts[]`
// was retired as a source because it answers A's question by A's join key and is
// capped at the top 5 products per day: it reported toothpaste at $39.00/90d
// where the raw line items say $71.50. A capped copy of the primary is not
// corroboration, and keeping it would have given the appearance of three sources
// while deleting the one axis of real independence.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  clusterFamily, corroborateClusters, buildClusterHold, loadClusterHold, holdBanner,
  readWideSources, renderDisagreementLines, WIDE_WINDOW_DAYS, HOLD_FLAG,
} from '../../lib/cluster-hold.js';
import { classifyClusters, JUDGING_WINDOW_DAYS } from '../../lib/cluster-revenue.js';
import {
  holdFor, heldScenario, disagreementScenario, impactReport, wideRows,
  PRODUCTION_CLUSTER_ROWS, SOLD_90D, PAGES_EARNED_90D, WIDE_ORDERS, JUDGING_WINDOW,
} from '../helpers/cluster-fixtures.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ── the shared vocabulary ────────────────────────────────────────────────────
// Both sources are compared in ONE taxonomy or the comparison is meaningless.
// These are the nine real product titles that earned a dollar in the trailing 90
// days, verbatim from production — the join source A is keyed on.

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

test('both sources meet in one place — seo-impact cluster names map to the same families', () => {
  // seo-impact once split soap into `soap` + `hand soap` and lotion into
  // `body lotion` + `lotion` + `moisturizer`. Product titles know none of that.
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

// ── reading both sources out of the report ───────────────────────────────────

test('both sources come off `clusters_product_wide[]`, one row per cluster', () => {
  const { productRevenue, entryPageRevenue, judgingWindow, windowOrders } = readWideSources(impactReport());
  assert.equal(productRevenue.soap, 324.85, 'source A: what the category SOLD');
  assert.equal(entryPageRevenue.soap, 110.49, 'source B: what its PAGES earned');
  assert.deepEqual(judgingWindow, JUDGING_WINDOW);
  assert.equal(windowOrders, WIDE_ORDERS);
});

test('an absent wide block yields NULLS, never empty maps', () => {
  // "not measured" and "measured as zero" are different answers: the second is a
  // verdict and the first is a missing input. Collapsing them is how a deploy
  // condemns every category at once.
  const src = readWideSources(impactReport({ wide: null }));
  assert.equal(src.productRevenue, null);
  assert.equal(src.entryPageRevenue, null);
  assert.equal(src.windowOrders, null);
  assert.equal(readWideSources(null).productRevenue, null);
});

test('a report carrying source A but NOT source B reads B as null, never as $0', () => {
  // This shape really exists: `clusters_product_wide` shipped one change before
  // the entry-page column was added to it. Reading the missing field as `|| 0`
  // would make every cluster's cross-check say "its pages earned nothing" —
  // the direction that CREATES holds. It must fail open instead.
  const rows = wideRows({ sold: { toothpaste: 0, lotion: 1757.1 } })
    .map(({ entry_page_organic_revenue, ...r }) => r);
  const src = readWideSources({
    clusters_product_wide: rows, cluster_product_meta: { wide_orders_all_channels: 50 },
  });
  assert.equal(src.entryPageRevenue, null);
  assert.equal(src.productRevenue.toothpaste, 0, 'source A is still read');

  const hold = buildClusterHold(
    classifyClusters([{ cluster: 'toothpaste', revenue: 0, clicks: 640, pages: 24 }],
      { productRevenue: src.productRevenue, windowOrders: src.windowOrders }),
    { entryPageRevenue: src.entryPageRevenue },
  );
  assert.equal(hold.heldSet.size, 0, 'half a report holds nothing');
  assert.equal(hold.uncorroborated.length, 1);
});

test('a row missing ONE of the two fields reads that field as 0, not undefined', () => {
  // The real rows always carry both, but a row built by an older writer may
  // carry only one. Once the entry-page COLUMN exists somewhere in the array,
  // an individual row missing it genuinely earned nothing — the "nothing was
  // measured" case is the whole-column-absent branch above, not this one.
  //
  // Deliberately hand-built rather than via `wideRows`, which writes explicit
  // zeroes into both fields: with those, this coercion is never reached and the
  // test would pass with the `|| 0` deleted.
  const src = readWideSources({
    clusters_product_wide: [
      { cluster: 'soap', product_revenue_all_channels: 100 },              // no entry-page key
      { cluster: 'coconut oil', entry_page_organic_revenue: 25 },          // no product key
    ],
    cluster_product_meta: { wide_orders_all_channels: 50 },
  });
  assert.equal(src.productRevenue['coconut oil'], 0);
  assert.equal(src.entryPageRevenue.soap, 0);
  assert.equal(src.productRevenue.soap, 100);
  assert.equal(src.entryPageRevenue['coconut oil'], 25);
});

// ── the cross-check ──────────────────────────────────────────────────────────

const REAL = classifyClusters(PRODUCTION_CLUSTER_ROWS, {
  productRevenue: SOLD_90D, windowOrders: WIDE_ORDERS,
});

test('SOAP IS NOT HELD — it sold $324.85, so it never reaches the cross-check at all', () => {
  const v = corroborateClusters(REAL, { entryPageRevenue: PAGES_EARNED_90D });
  assert.equal(v.soap.verdict, 'earning');
  assert.equal(v.soap.productRevenue, 324.85);
});

test('and soap no longer depends on a threshold to survive', () => {
  // The old defence was the 400-click bar, which soap's 227 did not clear. That
  // is no longer load-bearing: at any click count it simply sold money.
  const loud = classifyClusters([{ cluster: 'soap', revenue: 0, clicks: 5000, pages: 90 }], {
    productRevenue: SOLD_90D, windowOrders: WIDE_ORDERS,
  });
  assert.equal(loud.soap.status, 'earning');
});

test('SOURCE B WOULD HAVE CAUGHT THE SOAP INCIDENT — on the real click count, not a raised one', () => {
  // Reproduce the 2026-08-19 defect on the new basis: something breaks the
  // product-title join and source A reads soap at $0. Its pages really earned
  // $110.49 over the judging window, so B contradicts A and the hold is blocked.
  // This is the concrete demonstration that B is not redundant — and it works at
  // soap's actual 227 clicks, which the old 400-click bar could not reach.
  const s = disagreementScenario('soap');
  const classified = classifyClusters(s.clusters, { productRevenue: s.sold, windowOrders: WIDE_ORDERS });
  assert.equal(classified.soap.status, 'proven_dud', 'source A alone still condemns it');

  const v = corroborateClusters(classified, { entryPageRevenue: s.earned });
  assert.equal(v.soap.verdict, 'disagreement');
  assert.equal(v.soap.family, 'soap');
  assert.match(v.soap.reason, /110\.49/, 'the reason quotes what the pages earned');
  assert.match(v.soap.reason, /NOT held/);
  assert.match(v.soap.reason, /attribution is broken/i);
});

test('when BOTH sources read $0 the cluster is held, and the reason says both', () => {
  const s = heldScenario('toothpaste');
  const classified = classifyClusters(s.clusters, { productRevenue: s.sold, windowOrders: WIDE_ORDERS });
  const v = corroborateClusters(classified, { entryPageRevenue: s.earned });
  assert.equal(v.toothpaste.verdict, 'held');
  assert.equal(v.toothpaste.family, 'toothpaste');
  assert.match(v.toothpaste.reason, /both sources agree/);
});

test('a cluster that is not a proven dud is never cross-checked at all', () => {
  const v = corroborateClusters(REAL, { entryPageRevenue: PAGES_EARNED_90D });
  assert.equal(v.lotion.verdict, 'earning');
  assert.equal(v['coconut oil'].verdict, 'unproven', '11 clicks is too little to judge');
});

test('but sold-vs-earned is reported on EVERY row, not only the duds', () => {
  // That comparison is what exposes an attribution split before it becomes a
  // verdict, so an operator reading the table needs it on the earning rows too.
  const v = corroborateClusters(REAL, { entryPageRevenue: PAGES_EARNED_90D });
  assert.equal(v.lotion.productRevenue, 1757.1);
  assert.equal(v.lotion.entryPageRevenue, 666.73);
});

test('an unmappable cluster name cannot be cross-checked, so it is not held', () => {
  const odd = classifyClusters([{ cluster: 'foaming', revenue: 0, clicks: 400, pages: 12 }],
    { productRevenue: { ...SOLD_90D, foaming: 0 }, windowOrders: WIDE_ORDERS });
  const v = corroborateClusters(odd, { entryPageRevenue: PAGES_EARNED_90D });
  assert.equal(v.foaming.verdict, 'uncorroborated');
  assert.match(v.foaming.reason, /could not be mapped/i);
});

test('a MISSING cross-check corroborates nothing — the hold fails OPEN', () => {
  const s = heldScenario('toothpaste');
  const classified = classifyClusters(s.clusters, { productRevenue: s.sold, windowOrders: WIDE_ORDERS });
  const v = corroborateClusters(classified, { entryPageRevenue: null });
  assert.equal(v.toothpaste.verdict, 'uncorroborated');
  assert.match(v.toothpaste.reason, /second source\s+is missing entirely/);
});

// ── the hold context built on top ────────────────────────────────────────────

test('buildClusterHold holds only the cross-checked duds and lists the disagreements', () => {
  const held = holdFor(heldScenario('toothpaste'));
  assert.deepEqual([...held.heldSet], ['toothpaste']);
  assert.equal(held.disagreements.length, 0);

  const broken = holdFor(disagreementScenario('soap'));
  assert.equal(broken.heldSet.size, 0);
  assert.equal(broken.disagreements.length, 1);
  assert.equal(broken.disagreements[0].cluster, 'soap');
  assert.equal(broken.disagreements[0].entryPageRevenue, 110.49);
});

test('ON THE REAL 2026-08-23 REPORT nothing is held and nothing disagrees', () => {
  const live = holdFor();
  assert.deepEqual([...live.heldSet], []);
  assert.deepEqual(live.disagreements, []);
  assert.deepEqual(live.uncorroborated, []);
  assert.equal(live.disarmed, null, 'the gate was armed — it simply found nothing');
  assert.equal(holdBanner(live), '', 'a clean report is the one silent case');
});

// ── A DISARMED GATE MUST NOT LOOK LIKE A CLEAN RUN ──────────────────────────
//
// Every fail-open branch produces the same visible outcome as a report on which
// every category earns: nothing held, no banner. Until 2026-08-23 a report
// carrying `clusters_product_wide: []` rendered byte-identically to a clean one
// while `available` still read true — a fully disarmed gate, invisible. That is
// the "quiet loss of capability" the freshness rule exists to make loud.

test('a report with no product reading says the gate is OFF, and why', () => {
  const off = loadClusterHold({ root: ROOT, readJson: () => impactReport({ wide: null }) });
  assert.match(off.disarmed, /no product-revenue reading/);
  assert.match(holdBanner(off), /gate is OFF/);
  assert.match(holdBanner(off), /full pick list/);
});

test('a judging window too thin to judge says so too, rather than reading as clean', () => {
  const thin = holdFor({ ...heldScenario('toothpaste'), orders: 20 });
  assert.match(thin.disarmed, /only 20 order\(s\), below the 45/);
  assert.match(holdBanner(thin), /gate is OFF/);
});

test('a missing cross-check disarms the gate loudly as well', () => {
  const s = heldScenario('toothpaste');
  const noB = holdFor({ ...s, earned: null });
  assert.match(noB.disarmed, /cross-check is missing entirely/);
  assert.match(holdBanner(noB), /gate is OFF/);
});

test('an armed gate that simply holds something is NOT reported as disarmed', () => {
  const held = holdFor(heldScenario('toothpaste'));
  assert.equal(held.disarmed, null);
  assert.doesNotMatch(holdBanner(held), /gate is OFF/);
});

test('with no cross-check data at all, nothing is held', () => {
  const s = heldScenario('toothpaste');
  const blind = buildClusterHold(
    classifyClusters(s.clusters, { productRevenue: s.sold, windowOrders: WIDE_ORDERS }),
    { entryPageRevenue: null },
  );
  assert.equal(blind.heldSet.size, 0);
  assert.equal(blind.uncorroborated.length, 1);
});

// ── the disagreement is a FINDING, and it has to reach a human ───────────────

test('the banner names the disagreement loudly — a broken source is itself the finding', () => {
  const held = holdFor({ ...heldScenario('toothpaste'), generatedAt: 'X' });
  const b = holdBanner(held);
  assert.match(b, /toothpaste/);
  assert.match(b, new RegExp(HOLD_FLAG));

  const broken = holdFor({ ...disagreementScenario('soap'), generatedAt: 'X' });
  const bb = holdBanner(broken);
  assert.match(bb, /SOURCES DISAGREE/);
  assert.match(bb, /soap/);
  assert.match(bb, /110\.49/);
  assert.match(bb, /NOT held/i);
});

test('and it reaches the DIGEST, because these agents run unattended at 3 and 8 AM', () => {
  const lines = renderDisagreementLines(holdFor(disagreementScenario('soap'))).join('\n');
  assert.match(lines, /SOURCES DISAGREE/);
  assert.match(lines, /soap/);
  assert.match(lines, /110\.49/);
  assert.deepEqual(renderDisagreementLines(holdFor(heldScenario('toothpaste'))), [], 'silent when both agree');
  assert.deepEqual(renderDisagreementLines(null), []);
});

test('a category with no SKU behind it is a disagreement, not a dud', () => {
  // `coconut oil` is the shape: RSC ships no coconut-oil SKU, so source A is
  // structurally $0 for it forever. Today it is NOT an example of B firing —
  // measured over the same window its pages earned $0.00 too, and it is spared
  // only by the click precondition at 11 clicks (do not re-assert that its posts
  // "send readers to lotion"; nothing measured says so). The `earned` figure
  // below is therefore HYPOTHETICAL: this is the case as it would arrive if such
  // a cluster's pages did start earning. "There is nothing to sell here" is a
  // different diagnosis from "this content failed", and only B tells them apart.
  const s = {
    clusters: [{ cluster: 'coconut oil', revenue: 0, clicks: 400, pages: 12 }],
    sold: { ...SOLD_90D, 'coconut oil': 0 },
    earned: { ...PAGES_EARNED_90D, 'coconut oil': 41.2 },
  };
  const hold = holdFor(s);
  assert.equal(hold.heldSet.size, 0);
  assert.equal(hold.disagreements[0].cluster, 'coconut oil');
  assert.match(hold.disagreements[0].corroboration, /no SKU behind it/);
});

// ── the window ───────────────────────────────────────────────────────────────

test('the judging window is 90 days, and both modules agree on the number', () => {
  assert.equal(WIDE_WINDOW_DAYS, JUDGING_WINDOW_DAYS);
  assert.equal(JUDGING_WINDOW_DAYS, 90);
});

test('the window is taken from the report, never invented', () => {
  const hold = loadClusterHold({ root: ROOT, readJson: () => impactReport() });
  assert.deepEqual(hold.judgingWindow, JUDGING_WINDOW);
  assert.match(holdBanner(holdFor(disagreementScenario('soap'))), /2026-05-24 → 2026-08-21/);
});

test('loadClusterHold refuses to judge when the report carries no order count', () => {
  const s = heldScenario('toothpaste');
  const hold = loadClusterHold({
    root: ROOT,
    readJson: () => {
      const r = impactReport({ clusters: s.clusters, sold: s.sold, earned: s.earned });
      r.cluster_product_meta.wide_orders_all_channels = null;
      return r;
    },
  });
  assert.equal(hold.heldSet.size, 0);
  assert.match(hold.classified.toothpaste.evidence, /order count was not supplied/i);
});

test('no cluster name is hardcoded in the cross-check either', () => {
  // Executable source only. The module's docstring names the cluster this
  // correction came from, because an incident nobody can name is one that gets
  // repeated — but no cluster may appear in the LOGIC.
  //
  // `lib/cluster-revenue.js` is deliberately NOT on this list: its
  // `PRODUCT_CLUSTERS` names every category RSC sells, which is a catalogue and
  // not a verdict. The rule is that no cluster may be singled out by the hold
  // logic, not that the taxonomy may not exist.
  for (const rel of ['lib/cluster-hold.js', 'scripts/cluster-holds.mjs']) {
    const src = readFileSync(join(ROOT, rel), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
      .toLowerCase();
    assert.ok(!src.includes('toothpaste'), `${rel} must not name a cluster`);
    assert.ok(!src.includes('soap'), `${rel} must not name a cluster`);
  }
});
