import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildClusterHold, loadClusterHold, clusterForItem, holdDecision, partitionHeld,
  renderHoldLines, holdSummaryFragment, holdBanner, dedupeHeld, HOLD_FLAG, SEO_IMPACT_RELPATH,
} from '../../lib/cluster-hold.js';
import { classifyClusters } from '../../lib/cluster-revenue.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// The real shape of data/reports/seo-impact/latest.json's `clusters` array, from
// the production server on 2026-08-22. toothpaste is the $0 cluster CLAUDE.md
// names (≈268 clicks / $0 over 90d); body lotion earns.
const REPORT = [
  { cluster: 'body lotion', revenue: 313.49, clicks: 35, pages: 20 },
  { cluster: 'hand soap', revenue: 62.4, clicks: 4, pages: 4 },
  { cluster: 'lip balm', revenue: 48, clicks: 4, pages: 6 },
  { cluster: 'deodorant', revenue: 38.25, clicks: 121, pages: 21 },
  { cluster: 'toothpaste', revenue: 0, clicks: 663, pages: 24 },
];
// Real measured product revenue over the same windows — the corroborating
// source. A cluster is held only when BOTH agree it earns nothing, so every
// hold fixture here has to carry it (see tests/lib/cluster-corroboration.test.js
// for the rule itself, and for the soap case that made it necessary).
const MEASURED = [
  { label: 'report window (28d)', available: true, orders: 18, revenue: 1079.46, aov: 59.97, truncatedDays: 0, byFamily: { lotion: 909, 'lip balm': 120, soap: 156, deodorant: 60 } },
  { label: 'wide window (90d)', available: true, orders: 39, revenue: 2118.77, aov: 54.33, truncatedDays: 0, byFamily: { lotion: 1695.3, soap: 365.7, deodorant: 180, 'lip balm': 120, toothpaste: 39 } },
];
const TOTALS = { organic_conversions: 8, organic_sessions: 1067 };  // the real 2026-08-22 window
const withOrders = (clusters, opts = {}) => buildClusterHold(classifyClusters(clusters, { totals: TOTALS }), { measured: MEASURED, ...opts });

const HOLD = withOrders(REPORT, { generatedAt: '2026-08-22T10:00:00Z' });

// ── which clusters are held ──────────────────────────────────────────────────

test('a cluster with traffic across several pages and $0 revenue is held', () => {
  assert.deepEqual([...HOLD.heldSet], ['toothpaste']);
  assert.equal(HOLD.held[0].clicks, 663);
  assert.equal(HOLD.held[0].revenue, 0);
});

test('a cluster that earns ANY money is not held — the rule releases automatically', () => {
  // Same cluster, same traffic, one sale. Nothing else changes.
  const earning = withOrders([{ cluster: 'toothpaste', revenue: 12.5, clicks: 663, pages: 24 }]);
  assert.equal(earning.heldSet.size, 0);
  assert.equal(holdDecision({ slug: 'no-fluoride-toothpaste' }, earning).skip, false);
});

test('a cluster too small to judge is never held — a new category must be able to get tested', () => {
  const young = withOrders([{ cluster: 'lip balm', revenue: 0, clicks: 4, pages: 6 }]);
  assert.equal(young.heldSet.size, 0, 'unproven, not held');
});

test('no cluster name is hardcoded anywhere in the hold rule', () => {
  // The precedent set by lib/queue-autoapply.js: the held set is derived from
  // measured revenue, so it generalises to whatever goes to $0 next.
  for (const rel of ['lib/cluster-hold.js', 'scripts/cluster-holds.mjs']) {
    // Executable source only — the module docstring names the incident cluster
    // on purpose, so the correction stays explicable.
    const src = readFileSync(join(ROOT, rel), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
      .toLowerCase();
    assert.ok(!src.includes('toothpaste'), `${rel} must not name a cluster`);
  }
});

test('a missing seo-impact report holds nothing and says so, rather than guessing', () => {
  const blind = loadClusterHold({ root: ROOT, readJson: () => null, readDir: () => [] });
  assert.equal(blind.available, false);
  assert.equal(blind.heldSet.size, 0);
  assert.match(holdBanner(blind), /cannot fire/i);
  assert.match(holdBanner(blind), new RegExp(SEO_IMPACT_RELPATH.replace(/[/\\]/g, '.')));
});

test('loadClusterHold reads the report AND the orders that corroborate it', () => {
  const seen = [];
  const hold = loadClusterHold({
    root: ROOT,
    readDir: () => ['2026-08-20.json'],
    readJson: (p) => {
      seen.push(p);
      if (p.endsWith(SEO_IMPACT_RELPATH)) {
        return { generated_at: 'X', window: { start: '2026-08-20', end: '2026-08-20' }, totals: TOTALS, clusters: REPORT };
      }
      return { date: '2026-08-20', orders: { count: 2, revenue: 120 }, topProducts: [{ title: 'Non-Toxic Body Lotion Made With Only 6 Clean Ingredients', revenue: 120 }] };
    },
  });
  assert.ok(seen[0].endsWith(SEO_IMPACT_RELPATH));
  assert.ok(seen.some((p) => p.includes('snapshots')), 'the corroborating source is read too');
  assert.equal(hold.available, true);
  assert.equal(hold.generatedAt, 'X');
  assert.deepEqual([...hold.heldSet], ['toothpaste']);
});

// ── mapping an item to a cluster ─────────────────────────────────────────────

test('clusterForItem prefers the target keyword, then the slug, then title and url', () => {
  assert.equal(clusterForItem({ keyword: 'toothpaste without sls', slug: 'x' }), 'toothpaste');
  assert.equal(clusterForItem({ target_keyword: 'best natural deodorant', slug: 'x' }), 'deodorant');
  assert.equal(clusterForItem({ slug: 'no-fluoride-toothpaste' }), 'toothpaste');
  assert.equal(clusterForItem({ title: 'Best Coconut Oil Body Lotion' }), 'lotion');
  assert.equal(clusterForItem({ url: 'https://www.realskincare.com/blogs/news/best-lip-balm' }), 'lip balm');
  assert.equal(clusterForItem({ slug: 'dry-brushing-technique' }), null);
  assert.equal(clusterForItem(null), null);
});

// ── the decision ─────────────────────────────────────────────────────────────

test('an item in a held cluster is skipped, with a reason naming the evidence', () => {
  const d = holdDecision({ slug: 'no-fluoride-toothpaste' }, HOLD);
  assert.equal(d.skip, true);
  assert.equal(d.onHold, true);
  assert.equal(d.cluster, 'toothpaste');
  assert.match(d.reason, /663 clicks/);
  assert.match(d.reason, /\$0/);
  assert.match(d.reason, /stays live/i, 'the reason must say the page is not being removed');
  assert.match(d.reason, new RegExp(HOLD_FLAG), 'the reason must name the override');
});

test('an item in an earning cluster passes through untouched', () => {
  const d = holdDecision({ slug: 'benefits-of-using-coconut-oil-lotion', keyword: 'coconut oil body lotion' }, HOLD);
  assert.equal(d.skip, false);
  assert.equal(d.onHold, false);
  assert.equal(d.cluster, 'lotion');
});

test('an item that maps to no cluster at all is never held', () => {
  assert.equal(holdDecision({ slug: 'dry-brushing-technique' }, HOLD).skip, false);
});

test(`${HOLD_FLAG} runs a held item anyway, and still reports that it was held`, () => {
  const d = holdDecision({ slug: 'no-fluoride-toothpaste' }, HOLD, { includeHeld: true });
  assert.equal(d.skip, false);
  assert.equal(d.onHold, true, 'the override does not pretend the cluster is earning');
  assert.equal(d.overridden, true);
});

// ── partitioning a pick list ─────────────────────────────────────────────────

const PICKS = [
  { slug: 'no-fluoride-toothpaste' },
  { slug: 'toothpaste-without-sls' },
  { slug: 'benefits-of-using-coconut-oil-lotion' },
  { slug: 'dry-brushing-technique' },
];

test('partitionHeld skips and COUNTS held items — it never silently drops them', () => {
  const { kept, held } = partitionHeld(PICKS, HOLD);
  assert.deepEqual(kept.map((k) => k.slug), ['benefits-of-using-coconut-oil-lotion', 'dry-brushing-technique']);
  assert.equal(held.length, 2);
  assert.deepEqual(held.map((h) => h.slug), ['no-fluoride-toothpaste', 'toothpaste-without-sls']);
  assert.equal(held[0].cluster, 'toothpaste');
  assert.ok(held[0].item, 'the original item is carried so a caller can still report on it');
});

test('partitionHeld with the override keeps everything and records the overrides', () => {
  const { kept, held, overridden } = partitionHeld(PICKS, HOLD, { includeHeld: true });
  assert.equal(kept.length, 4);
  assert.equal(held.length, 0);
  assert.equal(overridden.length, 2);
});

test('partitionHeld can describe non-object items (a bare slug list)', () => {
  const { kept, held } = partitionHeld(
    ['no-fluoride-toothpaste', 'best-natural-deodorant'], HOLD, { describe: (s) => ({ slug: s }) },
  );
  assert.deepEqual(kept, ['best-natural-deodorant']);
  assert.equal(held.length, 1);
  assert.equal(held[0].slug, 'no-fluoride-toothpaste');
});

test('partitionHeld holds nothing when the revenue report is unavailable', () => {
  const blind = loadClusterHold({ root: ROOT, readJson: () => null, readDir: () => [] });
  const { kept, held } = partitionHeld(PICKS, blind);
  assert.equal(kept.length, 4, 'no report means no evidence — nothing is paused on a guess');
  assert.equal(held.length, 0);
});

test('partitionHeld tolerates empty and missing input', () => {
  assert.deepEqual(partitionHeld(null, HOLD).kept, []);
  assert.deepEqual(partitionHeld([], HOLD).held, []);
  assert.deepEqual(partitionHeld(PICKS, null).kept, PICKS, 'no hold context = no hold');
});

// ── what the operator sees ───────────────────────────────────────────────────

test('the digest lines name the count, the cluster, and every held slug', () => {
  const { held } = partitionHeld(PICKS, HOLD);
  const lines = renderHoldLines(held).join('\n');
  assert.match(lines, /2 item/);
  assert.match(lines, /toothpaste/);
  assert.match(lines, /no-fluoride-toothpaste/);
  assert.match(lines, /toothpaste-without-sls/);
  assert.match(lines, /still live/i, 'a hold is a spend pause, not a removal');
  assert.match(lines, new RegExp(HOLD_FLAG));
});

test('the per-slug list is capped so the digest does not become a wall of text', () => {
  // A real first run held 20 posts. The count and the per-cluster breakdown stay
  // complete; only the enumeration is trimmed.
  const many = Array.from({ length: 20 }, (_, i) => ({ slug: `p${i}`, cluster: 'toothpaste', reason: 'r' }));
  const lines = renderHoldLines(many);
  assert.match(lines[0], /HELD 20 item\(s\)/);
  assert.match(lines[0], /toothpaste \(20\)/);
  assert.equal(lines.filter((l) => l.includes('[held:')).length, 10);
  assert.match(lines.at(-1), /and 10 more/);
  assert.equal(renderHoldLines(many, { max: 100 }).filter((l) => l.includes('[held:')).length, 20);
});

test('a post held by several pickers at once is reported once, not three times', () => {
  // performance-engine runs four pickers over overlapping reports: one post can
  // be a flop, a quick win and a low-CTR query simultaneously. Counting it three
  // times overstates what the hold is actually withholding.
  const dup = [
    { slug: 'p', cluster: 'toothpaste', reason: 'r' },
    { slug: 'p', cluster: 'toothpaste', reason: 'r' },
    { slug: 'q', cluster: 'toothpaste', reason: 'r' },
  ];
  assert.equal(dedupeHeld(dup).length, 2);
  assert.match(renderHoldLines(dup)[0], /HELD 2 item\(s\)/);
  assert.equal(holdSummaryFragment(dup), ', 2 held');
});

test('the digest lines are empty when nothing was held — no noise on a normal run', () => {
  assert.deepEqual(renderHoldLines([]), []);
  assert.deepEqual(renderHoldLines(null), []);
});

test('the subject fragment is empty when nothing was held and counts when something was', () => {
  assert.equal(holdSummaryFragment([]), '');
  const { held } = partitionHeld(PICKS, HOLD);
  assert.equal(holdSummaryFragment(held), ', 2 held');
});

test('holdBanner lists the currently-held clusters with the evidence behind each', () => {
  const b = holdBanner(HOLD);
  assert.match(b, /toothpaste/);
  assert.match(b, /663/);
  assert.match(b, new RegExp(HOLD_FLAG));
  assert.equal(holdBanner(withOrders([])), '', 'nothing held and nothing disputed → no banner');
});
