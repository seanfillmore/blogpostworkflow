import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildSnapshot, buildAttribution, buildTopProducts,
  ptOffsetFor, ptDayBounds, ptDayOf, getYesterdayPT, ATTRIBUTION_VERSION,
} from '../../agents/shopify-collector/index.js';
import {
  datesInWindow, bucketOrdersByPtDay, mergeAttribution,
} from '../../scripts/backfill-order-attribution.mjs';

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

test('buildSnapshot keeps every pre-existing field unchanged and adds attribution', () => {
  const snap = buildSnapshot(SNAPSHOT_ARGS);
  // Field-for-field against the shape the collector emitted before attribution existed.
  assert.equal(snap.date, '2026-08-17');
  assert.deepEqual(snap.orders, { count: 3, revenue: 99.89, aov: 33.3 });
  assert.deepEqual(snap.abandonedCheckouts, { count: 1 });
  assert.equal(snap.cartAbandonmentRate, 0.25);
  assert.deepEqual(snap.topProducts, buildTopProducts(SNAPSHOT_ARGS.rawOrders));
  assert.deepEqual(
    Object.keys(snap),
    ['date', 'orders', 'abandonedCheckouts', 'cartAbandonmentRate', 'topProducts', 'attribution'],
    'attribution must be purely additive and appended last',
  );
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
