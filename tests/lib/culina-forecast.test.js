import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  inStockDays, dailyPace, seasonalIndex, forecastUnits, shipPlan,
  inferStockoutDates, componentPlan,
} from '../../lib/culina-forecast.js';

const config = { cover_target_days: [90, 120], lead_time_days: 14, sourced_lead_time_days: 45, sourced_components: ['brush'] };
const flat = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i + 1, 1]));

test('shipPlan: already under 90 days clamps to today', () => {
  const p = shipPlan({ pace: 10, onHand: 600, today: '2026-12-10', seasonal: flat, config });
  assert.equal(p.coverDays, 60);
  assert.equal(p.shipBy, '2026-12-10');
  assert.equal(p.shipQty, 740);
  assert.equal(p.forecast30, 300);
});

test('shipPlan: plenty of stock', () => {
  const p = shipPlan({ pace: 10, onHand: 1500, today: '2026-12-10', seasonal: flat, config });
  assert.equal(p.coverDays, 150);
  assert.equal(p.shipBy, '2027-01-25');
  assert.equal(p.shipQty, 300);
});

test('shipPlan: null pace gives nulls, zero pace ships nothing', () => {
  const p = shipPlan({ pace: null, onHand: 5, today: '2026-12-10', seasonal: flat, config });
  assert.deepEqual(p, { coverDays: null, forecast30: null, forecast60: null, forecast90: null, shipBy: null, shipQty: null });
  const z = shipPlan({ pace: 0, onHand: 5, today: '2026-12-10', seasonal: flat, config });
  assert.equal(z.coverDays, null);
  assert.equal(z.shipBy, null);
  assert.equal(z.shipQty, 0);
});

test('forecastUnits uses the seasonal index, December double', () => {
  const s = { ...flat, 12: 2 };
  assert.equal(forecastUnits(10, '2026-12-01', 30, s), 600);
  assert.equal(forecastUnits(10, '2026-12-01', 30, {}), 300);
});

test('seasonalIndex', () => {
  const kw = [1, 2].map(() => Array.from({ length: 12 }, (_, i) => ({ year: 2025, month: i + 1, search_volume: i === 11 ? 200 : 100 })));
  const idx = seasonalIndex(kw);
  assert.ok(Math.abs(idx[12] - 400 / ((11 * 200 + 400) / 12)) < 1e-9);
  assert.deepEqual(seasonalIndex([]), flat);
  assert.deepEqual(seasonalIndex([[{ year: 2025, month: 1, search_volume: 5 }]]), flat);
});

test('inStockDays and dailyPace ignore stockouts; empty is null', () => {
  const daily = [{ date: '2026-11-01', units: 10 }, { date: '2026-11-02', units: 0 }, { date: '2026-11-03', units: 10 }];
  const out = new Set(['2026-11-02']);
  assert.equal(inStockDays(daily, out).length, 2);
  assert.ok(Math.abs(dailyPace(daily, { stockoutDates: out }) - 10) < 1e-9);
  assert.ok(Math.abs(dailyPace(inStockDays(daily, out)) - 10) < 1e-9);
  assert.equal(dailyPace([]), null);
});

test('inferStockoutDates with snapshots', () => {
  const daily = ['01', '02', '03', '04', '05'].map((d) => ({ date: `2026-11-${d}`, units: 0 }));
  const s = inferStockoutDates(daily, { '2026-11-02': 0, '2026-11-03': 5 });
  assert.ok(s.has('2026-11-02'));
  assert.ok(!s.has('2026-11-03'));
});

test('inferStockoutDates without snapshots: 3+ zero run, item sells', () => {
  const daily = [5, 5, 0, 0, 0, 5, 0, 0, 5].map((u, i) => ({ date: `2026-11-0${i + 1}`, units: u }));
  const s = inferStockoutDates(daily, {});
  assert.deepEqual([...s].sort(), ['2026-11-03', '2026-11-04', '2026-11-05']);
  const slow = [1, 0, 0, 0, 0, 0, 0, 0].map((u, i) => ({ date: `2026-11-0${i + 1}`, units: u }));
  assert.equal(inferStockoutDates(slow, {}).size, 7); // mean over non-zero days is 1
  const none = [0, 0, 0, 0].map((u, i) => ({ date: `2026-11-0${i + 1}`, units: u }));
  assert.equal(inferStockoutDates(none, {}).size, 0);
});

test('componentPlan', () => {
  const cogs = { A: { contents: ['Brush', 'soap'] }, B: { contents: ['brush'] } };
  const plans = [
    { asin: 'A', pace: 2, onHand: 100, shipBy: '2027-01-25', shipQty: 50 },
    { asin: 'B', pace: 3, onHand: 50, shipBy: '2027-02-10', shipQty: 20 },
  ];
  const out = componentPlan(plans, cogs, config, '2026-11-11');
  const brush = out.find((c) => c.name === 'brush');
  // B ships 2027-02-10, one day past today + 90, so only A's 50 count.
  assert.deepEqual(brush, { name: 'brush', pace: 5, onHand: 150, coverDays: 30, shipQty: 50, sourced: true, needBy: '2027-01-25', orderBy: '2026-12-11' });
  const soap = out.find((c) => c.name === 'soap');
  assert.equal(soap.sourced, false);
  assert.throws(() => componentPlan(plans, cogs, config), /today/);
  assert.equal(soap.orderBy, null);
  const clamped = componentPlan(plans, cogs, config, '2026-12-20').find((c) => c.name === 'brush');
  assert.equal(clamped.orderBy, '2026-12-20');
});

test('shipPlan: never crosses within horizon gives null shipBy', () => {
  const p = shipPlan({ pace: 0.05, onHand: 300, today: '2026-11-11', seasonal: flat, config });
  assert.equal(p.shipBy, null);
  assert.equal(p.shipQty, 0);
});

test('shipPlan: slow item is fast', () => {
  const t = Date.now();
  const p = shipPlan({ pace: 0.5, onHand: 1500, today: '2026-11-11', seasonal: flat, config });
  assert.ok(Date.now() - t < 1000);
  assert.equal(p.coverDays, 3000);
});

test('shipPlan: non-flat seasonal index', () => {
  const s = { ...flat, 11: 2, 12: 3 };
  const p = shipPlan({ pace: 10, onHand: 1500, today: '2026-10-01', seasonal: s, config });
  assert.equal(p.coverDays, 81);
  assert.equal(p.shipBy, '2026-10-01');
  assert.equal(p.shipQty, 760);
});

test('shipPlan: zero on hand ships today', () => {
  const p = shipPlan({ pace: 10, onHand: 0, today: '2026-11-11', seasonal: flat, config });
  assert.equal(p.coverDays, 0);
  assert.equal(p.shipBy, '2026-11-11');
});

test('inferStockoutDates: positive snapshot breaks a zero run', () => {
  const daily = [5, 0, 0, 0, 0, 5].map((u, i) => ({ date: `2026-11-0${i + 1}`, units: u }));
  assert.equal(inferStockoutDates(daily, {}).size, 4);
  assert.equal(inferStockoutDates(daily, { '2026-11-04': 7 }).size, 0);
});

test('final-fix: componentPlan counts only ship plans due within 90 days; needBy is the earliest of those', () => {
  const cogs = { A: { contents: ['soap'] }, B: { contents: ['soap'] }, C: { contents: ['soap', 'brush'] }, D: { contents: ['brush'] } };
  const plans = [
    { asin: 'A', pace: 1, onHand: 10, shipBy: '2026-12-01', shipQty: 50 },
    { asin: 'B', pace: 1, onHand: 10, shipBy: '2027-03-01', shipQty: 70 }, // beyond today + 90 (2027-02-09)
    { asin: 'C', pace: 1, onHand: 10, shipBy: null, shipQty: 0 },
    { asin: 'D', pace: 1, onHand: 10, shipBy: '2027-02-09', shipQty: 5 }, // exactly today + 90
  ];
  const out = componentPlan(plans, cogs, config, '2026-11-11');
  const soap = out.find((c) => c.name === 'soap');
  assert.equal(soap.shipQty, 50);
  assert.equal(soap.needBy, '2026-12-01');
  assert.equal(soap.onHand, 30);
  const brush = out.find((c) => c.name === 'brush');
  assert.equal(brush.shipQty, 5);
  assert.equal(brush.needBy, '2027-02-09');
  assert.equal(brush.orderBy, '2026-12-26');
  const none = componentPlan([{ asin: 'B', pace: 1, onHand: 1, shipBy: '2027-06-01', shipQty: 9 }], cogs, config, '2026-11-11')[0];
  assert.equal(none.shipQty, 0);
  assert.equal(none.needBy, null);
});
