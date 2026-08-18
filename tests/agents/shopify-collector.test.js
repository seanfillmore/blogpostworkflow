import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildSnapshot, buildAttribution, buildTopProducts, buildOrderTotals,
  ptOffsetFor, ptDayBounds, ptDayOf, getYesterdayPT, ATTRIBUTION_VERSION,
} from '../../agents/shopify-collector/index.js';
import {
  datesInWindow, bucketOrdersByPtDay, mergeAttribution,
} from '../../scripts/backfill-order-attribution.mjs';
import {
  planCleanRevenue, excludedOrders, parseArgs,
} from '../../scripts/backfill-clean-order-revenue.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Live shapes from 2026-08-17, carrying the PII fields Shopify really returns so the
// no-PII assertion below is testing something real.
const ORGANIC_ORDER = {
  id: 6001, name: '#2334', created_at: '2026-08-17T05:02:58-06:00', total_price: '62.40',
  source_name: 'web',
  landing_site: '/products/organic-foaming-hand-soap?srsltid=AfmBOoo3pft2LsJxYxeiSv45mZDlTOXjHDB5YG24PHlBoUkWWI3RvyCt',
  referring_site: 'https://www.google.com/',
  discount_codes: [], note_attributes: [],
  email: 'buyer@example.com', browser_ip: '203.0.113.9',
  customer: { id: 99, email: 'buyer@example.com', first_name: 'Dana' },
  billing_address: { address1: '1 Main St', city: 'Austin' },
  line_items: [{ title: 'Organic Foaming Hand Soap', price: '31.20', quantity: 2 }],
};

const PAID_ORDER = {
  id: 6002, name: '#2332', created_at: '2026-08-17T13:38:16-06:00', total_price: '37.49',
  source_name: 'web',
  landing_site: '/products/coconut-lotion?utm_content=sag_organic&gad_source=1&gclid=CjwKCAjw1vXTBhB-EiwAEKr_k_YHOyxD7Jv0zc5hJ1JvLchFK-QMH167Tmqdqr-YKVR3CEY3qcPw',
  referring_site: 'https://www.google.com/',
  discount_codes: [{ code: 'WEL30-4P2XTMQ8' }], note_attributes: [],
  line_items: [{ title: 'Coconut Lotion', price: '35.99', quantity: 1 }],
};

const TEST_ORDER = {
  id: 6003, name: '#2326', created_at: '2026-08-17T19:53:19-06:00', total_price: '0.00',
  source_name: 'web', landing_site: '/', referring_site: null,
  discount_codes: [{ code: 'TEST100' }], note_attributes: [],
  line_items: [{ title: 'Deodorant', price: '0.00', quantity: 1 }],
};

// The real 2026-08-12 day, rebuilt from the order shapes that produced
// data/snapshots/shopify/2026-08-12.json on the production server. Three orders, of
// which #2331 is an admin preview: the snapshot recorded 3 / $110.15 / aov $36.72 and
// topProducts 3 orders / $90 when only 2 orders / $71.98 / $60 of product were real.
const AUG12_PREVIEW = {
  id: 7445531656362, name: '#2331', created_at: '2026-08-12T22:09:49-06:00',
  total_price: '38.17', source_name: 'web',
  landing_site: 'https://www.realskincare.com/online_store_preview?preview_key=abc123',
  referring_site: 'https://admin.shopify.com/store/realskincare/products',
  discount_codes: [], note_attributes: [],
  line_items: [{ title: 'Non-Toxic Body Lotion Made With Only 6 Clean Ingredients', price: '30.00', quantity: 1 }],
};

const AUG12_ORGANIC = {
  id: 7444581974186, name: '#2330', created_at: '2026-08-12T10:14:14-06:00',
  total_price: '35.99', source_name: 'web',
  landing_site: '/blogs/news/best-non-toxic-body-lotion-2025',
  referring_site: 'https://search.brave.com/',
  discount_codes: [], note_attributes: [],
  line_items: [{ title: 'Non-Toxic Body Lotion Made With Only 6 Clean Ingredients', price: '30.00', quantity: 1 }],
};

const AUG12_PAID = {
  id: 7444304101546, name: '#2329', created_at: '2026-08-12T06:24:57-06:00',
  total_price: '35.99', source_name: 'web',
  landing_site: '/products/coconut-lotion?gbraid=0AAAAAosZu9vrDsIv2dFxV_X3CiCYneab2',
  referring_site: 'https://www.google.com/',
  discount_codes: [], note_attributes: [],
  line_items: [{ title: 'Non-Toxic Body Lotion Made With Only 6 Clean Ingredients', price: '30.00', quantity: 1 }],
};

const AUG12_ORDERS = [AUG12_PREVIEW, AUG12_ORGANIC, AUG12_PAID];

// ── PT day helpers ───────────────────────────────────────────────────────────

test('ptOffsetFor tracks PDT/PST rather than hardcoding an offset', () => {
  assert.equal(ptOffsetFor('2026-08-17'), '-07:00');   // summer
  assert.equal(ptOffsetFor('2026-01-15'), '-08:00');   // winter
  assert.equal(ptOffsetFor('2026-03-08'), '-07:00');   // spring-forward day
  assert.equal(ptOffsetFor('2026-11-01'), '-08:00');   // fall-back day, after 02:00
});

test('ptDayBounds spans a full PT calendar day', () => {
  assert.deepEqual(ptDayBounds('2026-08-17'), {
    startOffset: '-07:00',
    endOffset: '-07:00',
    dayStart: '2026-08-17T00:00:00-07:00',
    dayEnd: '2026-08-17T23:59:59.999-07:00',
  });
  assert.equal(ptDayBounds('2026-01-15').dayStart, '2026-01-15T00:00:00-08:00');
});

test('ptDayBounds uses a different offset at each end of a DST-transition day', () => {
  // Fall back: the day starts in PDT and ends in PST. One mid-day offset for both would
  // start the window at 01:00 PT and lose the first hour of orders.
  assert.deepEqual(ptDayBounds('2026-11-01'), {
    startOffset: '-07:00',
    endOffset: '-08:00',
    dayStart: '2026-11-01T00:00:00-07:00',
    dayEnd: '2026-11-01T23:59:59.999-08:00',
  });
  // Spring forward: starts in PST, ends in PDT.
  assert.deepEqual(ptDayBounds('2026-03-08'), {
    startOffset: '-08:00',
    endOffset: '-07:00',
    dayStart: '2026-03-08T00:00:00-08:00',
    dayEnd: '2026-03-08T23:59:59.999-07:00',
  });
});

test('ptDayOf buckets by PT calendar day, not UTC', () => {
  // 2026-08-18T05:00Z is still 2026-08-17 22:00 in PT.
  assert.equal(ptDayOf('2026-08-18T05:00:00Z'), '2026-08-17');
  assert.equal(ptDayOf('2026-08-18T07:00:00Z'), '2026-08-18');
  assert.equal(ptDayOf(ORGANIC_ORDER.created_at), '2026-08-17');
  assert.equal(ptDayOf('not-a-date'), null);
  assert.equal(ptDayOf(undefined), null);
});

test('ptDayOf and ptDayBounds agree at the edges, including across a DST switch', () => {
  for (const date of ['2026-08-17', '2026-01-15', '2026-11-01', '2026-03-08']) {
    const { dayStart, dayEnd } = ptDayBounds(date);
    assert.equal(ptDayOf(dayStart), date, `${date} start`);
    assert.equal(ptDayOf(dayEnd), date, `${date} end`);
    // One millisecond outside the window must fall on a different day.
    assert.notEqual(ptDayOf(new Date(new Date(dayStart).getTime() - 1)), date, `${date} pre-start`);
    assert.notEqual(ptDayOf(new Date(new Date(dayEnd).getTime() + 1)), date, `${date} post-end`);
  }
});

test('getYesterdayPT returns the PT day before the given instant', () => {
  assert.equal(getYesterdayPT(new Date('2026-08-17T20:00:00Z')), '2026-08-16');
  // 03:00Z on the 17th is still the evening of the 16th in PT, so yesterday is the 15th.
  assert.equal(getYesterdayPT(new Date('2026-08-17T03:00:00Z')), '2026-08-15');
});

// ── snapshot shaping ─────────────────────────────────────────────────────────

const SNAPSHOT_ARGS = {
  date: '2026-08-17', count: 3, revenue: 99.89, aov: 33.3,
  abandonedCount: 1, rawOrders: [ORGANIC_ORDER, PAID_ORDER, TEST_ORDER],
};

test('buildSnapshot keeps every field name and position, and counts only real orders', () => {
  const snap = buildSnapshot(SNAPSHOT_ARGS);
  assert.equal(snap.date, '2026-08-17');
  // count drops 3 -> 2: the $0 TEST100 order is recorded but not counted. aov is
  // recomputed over the counted orders, NOT copied from the raw getOrders aggregate.
  assert.deepEqual(snap.orders, { count: 2, revenue: 99.89, aov: 49.95 });
  assert.deepEqual(snap.abandonedCheckouts, { count: 1 });
  assert.equal(snap.cartAbandonmentRate, 0.33, 'abandonment rate follows the counted order count');
  assert.deepEqual(snap.topProducts, buildTopProducts(SNAPSHOT_ARGS.rawOrders));
  assert.deepEqual(
    Object.keys(snap),
    ['date', 'orders', 'abandonedCheckouts', 'cartAbandonmentRate', 'topProducts', 'attribution'],
    'field names and order must not change — dashboards and agents read them',
  );
  assert.deepEqual(Object.keys(snap.orders), ['count', 'revenue', 'aov']);
});

// ── the real 2026-08-12 regression ───────────────────────────────────────────

test('2026-08-12: an admin-preview order is no longer counted as store revenue', () => {
  // What the collector actually stored that day, and what it must store now.
  const snap = buildSnapshot({
    date: '2026-08-12', count: 3, revenue: 110.15, aov: 36.72,
    abandonedCount: 0, rawOrders: AUG12_ORDERS,
  });

  assert.deepEqual(snap.orders, { count: 2, revenue: 71.98, aov: 35.99 });

  // topProducts loses the preview order's phantom unit and its $30.
  assert.deepEqual(snap.topProducts, [{
    title: 'Non-Toxic Body Lotion Made With Only 6 Clean Ingredients',
    revenue: 60, orders: 2,
  }]);

  // The excluded order is still on file — the correction stays auditable.
  const preview = snap.attribution.orders.find(o => o.name === '#2331');
  assert.equal(preview.landingPath, '/online_store_preview');
  assert.equal(preview.channel, 'admin-preview');
  assert.equal(preview.total, 38.17);
  assert.equal(preview.countsAsRevenue, false);
  assert.equal(snap.attribution.orders.length, 3, 'no order is dropped from the record');

  // Headline totals and the channel rollup must agree to the cent.
  const rolledUp = snap.attribution.channels.reduce((s, c) => s + c.revenue, 0);
  assert.equal(Math.round(rolledUp * 100) / 100, snap.orders.revenue);
});

test('buildOrderTotals sums only countsAsRevenue rows and derives aov from them', () => {
  const rows = buildAttribution(AUG12_ORDERS).orders;
  assert.deepEqual(buildOrderTotals(rows), { count: 2, revenue: 71.98, aov: 35.99 });

  assert.deepEqual(buildOrderTotals([]), { count: 0, revenue: 0, aov: 0 });
  assert.deepEqual(buildOrderTotals(null), { count: 0, revenue: 0, aov: 0 }, 'no divide by zero');
  assert.deepEqual(
    buildOrderTotals([{ total: 10, countsAsRevenue: false }, { total: 20, countsAsRevenue: false }]),
    { count: 0, revenue: 0, aov: 0 },
    'a day of nothing but test orders is a zero day, not a $30 day',
  );
  // Thirds must not leak a floating-point tail into the snapshot.
  assert.deepEqual(
    buildOrderTotals([
      { total: 10, countsAsRevenue: true }, { total: 10, countsAsRevenue: true },
      { total: 10.01, countsAsRevenue: true },
    ]),
    { count: 3, revenue: 30.01, aov: 10 },
  );
});

test('buildTopProducts drops line items from test, preview and cancelled orders', () => {
  assert.deepEqual(buildTopProducts([AUG12_PREVIEW]), [], 'a preview-only day sells nothing');
  assert.deepEqual(buildTopProducts([TEST_ORDER]), [], 'a TEST-discount order sells nothing');
  assert.deepEqual(
    buildTopProducts([{ ...AUG12_ORGANIC, cancelled_at: '2026-08-13T01:00:00Z' }]),
    [],
    'a cancelled order sells nothing',
  );
  assert.deepEqual(buildTopProducts([AUG12_ORGANIC, AUG12_PAID]), [{
    title: 'Non-Toxic Body Lotion Made With Only 6 Clean Ingredients',
    revenue: 60, orders: 2,
  }]);
  assert.deepEqual(buildTopProducts(null), []);
});

test('buildSnapshot handles a zero-order, zero-abandon day without dividing by zero', () => {
  const snap = buildSnapshot({ date: '2026-08-10', count: 0, revenue: 0, aov: 0, abandonedCount: 0, rawOrders: [] });
  assert.equal(snap.cartAbandonmentRate, 0);
  assert.deepEqual(snap.topProducts, []);
  assert.deepEqual(snap.attribution.orders, []);
  assert.deepEqual(snap.attribution.channels, []);
  assert.equal(snap.attribution.version, ATTRIBUTION_VERSION);
});

test('buildSnapshot tolerates a missing rawOrders array', () => {
  const snap = buildSnapshot({ date: '2026-08-10', count: 0, revenue: 0, aov: 0, abandonedCount: 0 });
  assert.deepEqual(snap.topProducts, []);
  assert.deepEqual(snap.attribution.orders, []);
});

test('buildSnapshot falls back to the raw aggregate only when there is nothing to classify', () => {
  // No rawOrders at all: nothing can be classified, so the caller's numbers stand
  // rather than being silently zeroed into a fake no-sales day.
  const noOrders = buildSnapshot({ date: '2026-08-10', count: 4, revenue: 120, aov: 30, abandonedCount: 0 });
  assert.deepEqual(noOrders.orders, { count: 4, revenue: 120, aov: 30 });

  // An EMPTY array is real information — a genuine zero-order day — and overrides.
  const empty = buildSnapshot({ date: '2026-08-10', count: 4, revenue: 120, aov: 30, abandonedCount: 0, rawOrders: [] });
  assert.deepEqual(empty.orders, { count: 0, revenue: 0, aov: 0 });
});

test('the snapshot attribution block carries no PII', () => {
  const serialized = JSON.stringify(buildSnapshot(SNAPSHOT_ARGS));
  for (const secret of ['buyer@example.com', '203.0.113.9', '1 Main St', 'Dana', 'Austin']) {
    assert.ok(!serialized.includes(secret), `${secret} leaked into the snapshot`);
  }
});

test('buildAttribution records every order and rolls revenue up by channel', () => {
  const attribution = buildAttribution([ORGANIC_ORDER, PAID_ORDER, TEST_ORDER]);
  assert.equal(attribution.orders.length, 3, 'test orders are recorded, just not counted');
  const organic = attribution.orders.find(o => o.name === '#2334');
  assert.equal(organic.channel, 'organic-search');
  assert.equal(organic.landingPath, '/products/organic-foaming-hand-soap');
  assert.equal(organic.paid, false);

  const byChannel = new Map(attribution.channels.map(c => [c.channel, c]));
  assert.deepEqual(byChannel.get('organic-search'), { channel: 'organic-search', orders: 1, revenue: 62.40 });
  assert.deepEqual(byChannel.get('paid-search'), { channel: 'paid-search', orders: 1, revenue: 37.49 });
  assert.equal(byChannel.has('direct'), false, 'the zero-value TEST order must not count as revenue');
});

test('importing the collector does not run the agent', () => {
  // Importing agents/*/index.js in this repo has historically executed the agent —
  // live Shopify calls, a written snapshot, and process.exit. The main guard is what
  // makes this whole test file safe to run, so assert on it directly.
  const out = execFileSync(process.execPath, [
    '--input-type=module', '-e',
    `await import(${JSON.stringify(join(ROOT, 'agents/shopify-collector/index.js'))}); console.log('imported-clean');`,
  ], { encoding: 'utf8', cwd: ROOT });
  assert.equal(out.trim(), 'imported-clean');
  assert.ok(!out.includes('Shopify Collector'), 'the agent banner printed — main() ran on import');
});

// ── backfill helpers ─────────────────────────────────────────────────────────

test('datesInWindow returns N PT days, oldest first, ending on the given date', () => {
  assert.deepEqual(datesInWindow('2026-08-17', 3), ['2026-08-15', '2026-08-16', '2026-08-17']);
  assert.deepEqual(datesInWindow('2026-08-17', 1), ['2026-08-17']);
  assert.equal(datesInWindow('2026-08-17', 90).length, 90);
  assert.equal(datesInWindow('2026-08-17', 90)[0], '2026-05-20');
});

test('datesInWindow crosses a DST switch without repeating or skipping a day', () => {
  // PT falls back on 2026-11-01.
  assert.deepEqual(datesInWindow('2026-11-03', 5), [
    '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03',
  ]);
});

test('bucketOrdersByPtDay groups orders into PT calendar days', () => {
  const late = { ...ORGANIC_ORDER, id: 6010, created_at: '2026-08-18T05:00:00Z' }; // 8/17 22:00 PT
  const next = { ...ORGANIC_ORDER, id: 6011, created_at: '2026-08-18T08:00:00Z' }; // 8/18 01:00 PT
  const m = bucketOrdersByPtDay([ORGANIC_ORDER, PAID_ORDER, late, next]);
  assert.deepEqual([...m.keys()].sort(), ['2026-08-17', '2026-08-18']);
  assert.equal(m.get('2026-08-17').length, 3);
  assert.equal(m.get('2026-08-18').length, 1);
});

test('bucketOrdersByPtDay drops orders with an unusable created_at', () => {
  const m = bucketOrdersByPtDay([{ id: 1, created_at: null }, { id: 2 }, null, ORGANIC_ORDER]);
  assert.deepEqual([...m.keys()], ['2026-08-17']);
  assert.equal(m.get('2026-08-17').length, 1);
});

test('bucketOrdersByPtDay on empty/missing input returns an empty map', () => {
  assert.equal(bucketOrdersByPtDay([]).size, 0);
  assert.equal(bucketOrdersByPtDay(null).size, 0);
});

test('mergeAttribution preserves every existing field, including unknown ones', () => {
  const existing = {
    date: '2026-08-17',
    orders: { count: 1, revenue: 62.40, aov: 62.40 },
    abandonedCheckouts: { count: 0 },
    cartAbandonmentRate: 0,
    topProducts: [{ title: 'Organic Foaming Hand Soap', revenue: 62.40, orders: 1 }],
    someFutureField: { keepMe: true },
  };
  const attribution = buildAttribution([ORGANIC_ORDER]);
  const { action, snapshot } = mergeAttribution(existing, attribution);

  assert.equal(action, 'update');
  for (const key of Object.keys(existing)) {
    assert.deepEqual(snapshot[key], existing[key], `${key} was altered`);
  }
  assert.equal(snapshot.attribution.orders.length, 1);
  assert.equal(existing.attribution, undefined, 'the input snapshot must not be mutated');
});

test('mergeAttribution skips a snapshot that already has a block, unless forced', () => {
  const existing = { date: '2026-08-17', attribution: { version: 1, channels: [], orders: [] } };
  const fresh = buildAttribution([ORGANIC_ORDER]);

  const skipped = mergeAttribution(existing, fresh);
  assert.equal(skipped.action, 'skip-existing');
  assert.deepEqual(skipped.snapshot.attribution.orders, [], 'existing block left alone');

  const forced = mergeAttribution(existing, fresh, { force: true });
  assert.equal(forced.action, 'update');
  assert.equal(forced.snapshot.attribution.orders.length, 1);
  assert.equal(forced.snapshot.date, '2026-08-17');
  assert.deepEqual(existing.attribution.orders, [], 'force must not mutate the input either');
});

// ── clean-revenue backfill helpers ───────────────────────────────────────────

/** The 2026-08-12 snapshot exactly as it sits on the production server today. */
function aug12SnapshotAsStored() {
  return {
    date: '2026-08-12',
    orders: { count: 3, revenue: 110.15, aov: 36.72 },
    abandonedCheckouts: { count: 0 },
    cartAbandonmentRate: 0,
    topProducts: [{ title: 'Non-Toxic Body Lotion Made With Only 6 Clean Ingredients', revenue: 90, orders: 3 }],
    attribution: buildAttribution(AUG12_ORDERS),
  };
}

test('excludedOrders lists the non-revenue orders, and tolerates a missing block', () => {
  assert.deepEqual(excludedOrders(aug12SnapshotAsStored()).map(o => o.name), ['#2331']);
  assert.deepEqual(excludedOrders({ date: '2026-08-12' }), []);
  assert.deepEqual(excludedOrders(null), []);
});

test('planCleanRevenue corrects the stored 2026-08-12 snapshot from its own attribution block', () => {
  const existing = aug12SnapshotAsStored();
  const topProducts = buildTopProducts(AUG12_ORDERS);
  const { action, snapshot, before, after } = planCleanRevenue(existing, { topProducts });

  assert.equal(action, 'update');
  assert.deepEqual(before, { count: 3, revenue: 110.15, aov: 36.72 });
  assert.deepEqual(after, { count: 2, revenue: 71.98, aov: 35.99 });
  assert.deepEqual(snapshot.orders, { count: 2, revenue: 71.98, aov: 35.99 });
  assert.deepEqual(snapshot.topProducts, [{
    title: 'Non-Toxic Body Lotion Made With Only 6 Clean Ingredients', revenue: 60, orders: 2,
  }]);
  assert.deepEqual(existing.orders, { count: 3, revenue: 110.15, aov: 36.72 }, 'input must not be mutated');
});

test('planCleanRevenue merges — it never drops a field or reorders keys', () => {
  const existing = { ...aug12SnapshotAsStored(), someFutureField: { keepMe: true } };
  const keysBefore = Object.keys(existing);
  const { snapshot } = planCleanRevenue(existing, { topProducts: buildTopProducts(AUG12_ORDERS) });

  assert.deepEqual(Object.keys(snapshot), keysBefore, 'key order must survive');
  assert.deepEqual(snapshot.someFutureField, { keepMe: true });
  assert.deepEqual(snapshot.abandonedCheckouts, existing.abandonedCheckouts);
  assert.equal(snapshot.attribution, existing.attribution, 'the attribution block is left alone');
  assert.deepEqual(Object.keys(snapshot.orders), ['count', 'revenue', 'aov']);
});

test('planCleanRevenue leaves topProducts alone when no rebuild was supplied', () => {
  const existing = aug12SnapshotAsStored();
  const { action, snapshot, needsProducts } = planCleanRevenue(existing);
  assert.equal(action, 'update', 'orders.* is still corrected without the Shopify fetch');
  assert.equal(needsProducts, true, 'and the day is flagged as still needing a rebuild');
  assert.deepEqual(snapshot.orders, { count: 2, revenue: 71.98, aov: 35.99 });
  assert.deepEqual(snapshot.topProducts, existing.topProducts);
});

test('planCleanRevenue skips a clean day instead of rewriting it', () => {
  const clean = {
    date: '2026-08-13',
    orders: { count: 1, revenue: 35.99, aov: 35.99 },
    topProducts: [{ title: 'Coconut Lotion', revenue: 30, orders: 1 }],
    attribution: buildAttribution([AUG12_ORGANIC]),
  };
  const { action, needsProducts } = planCleanRevenue(clean, { topProducts: clean.topProducts });
  assert.equal(action, 'skip-unchanged');
  assert.equal(needsProducts, false);
});

test('planCleanRevenue skips a snapshot with no attribution block rather than guessing', () => {
  const legacy = { date: '2026-05-20', orders: { count: 2, revenue: 80, aov: 40 }, topProducts: [] };
  const { action, snapshot, before, after } = planCleanRevenue(legacy);
  assert.equal(action, 'skip-no-attribution');
  assert.equal(snapshot, legacy, 'untouched');
  assert.deepEqual(after, before, 'and it contributes its stored numbers to the totals unchanged');
});

test('planCleanRevenue zeroes a day whose only order was a test order', () => {
  const testOnly = {
    date: '2026-08-14',
    orders: { count: 1, revenue: 0, aov: 0 },
    topProducts: [{ title: 'Deodorant', revenue: 0, orders: 1 }],
    attribution: buildAttribution([TEST_ORDER]),
  };
  const { action, snapshot } = planCleanRevenue(testOnly, { topProducts: buildTopProducts([TEST_ORDER]) });
  assert.equal(action, 'update');
  assert.deepEqual(snapshot.orders, { count: 0, revenue: 0, aov: 0 });
  assert.deepEqual(snapshot.topProducts, []);
});

test('backfill parseArgs is dry-run by default and reads its flags', () => {
  const base = parseArgs(['node', 'x']);
  assert.equal(base.apply, false, 'dry run by default');
  assert.equal(base.noFetch, false);
  assert.equal(base.days, 90);
  assert.ok(base.snapshotsDir.endsWith(join('data', 'snapshots', 'shopify')));

  const flags = parseArgs(['node', 'x', '--apply', '--no-fetch', '--days', '30', '--snapshots-dir', '/tmp/copy']);
  assert.equal(flags.apply, true);
  assert.equal(flags.noFetch, true);
  assert.equal(flags.days, 30);
  assert.equal(flags.snapshotsDir, '/tmp/copy');

  assert.deepEqual(parseArgs(['node', 'x', '--days=7']).days, 7);
  assert.equal(parseArgs(['node', 'x', '--snapshots-dir=/tmp/c']).snapshotsDir, '/tmp/c');
  assert.throws(() => parseArgs(['node', 'x', '--days', '0']), /Invalid --days/);
  assert.throws(() => parseArgs(['node', 'x', '--days', 'abc']), /Invalid --days/);
});

test('importing the clean-revenue backfill does not run it', () => {
  const out = execFileSync(process.execPath, [
    '--input-type=module', '-e',
    `await import(${JSON.stringify(join(ROOT, 'scripts/backfill-clean-order-revenue.mjs'))}); console.log('imported-clean');`,
  ], { encoding: 'utf8', cwd: ROOT });
  assert.equal(out.trim(), 'imported-clean');
  assert.ok(!out.includes('Backfill clean order revenue'), 'main() ran on import');
});
