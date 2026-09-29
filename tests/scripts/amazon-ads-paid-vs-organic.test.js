import { test } from 'node:test';
import assert from 'node:assert/strict';

import { joinPaidOrganic, quadrant } from '../../scripts/amazon-ads-paid-vs-organic.mjs';

const adRow = (asin, o) => ({ advertisedAsin: asin, clicks: 0, cost: 0, purchases30d: 0, sales30d: 0, ...o });
const trafficRow = (asin, sessions, units) => ({
  parentAsin: asin,
  trafficByAsin: { sessions },
  salesByAsin: { unitsOrdered: units, orderedProductSales: { amount: units * 25 } },
});

test('organic is sessions and units MINUS the paid half, not the raw totals', () => {
  // The whole diagnostic turns on this subtraction. Comparing paid CVR against TOTAL CVR
  // instead of organic CVR compares paid against a number that already contains paid,
  // which drags the two together and hides exactly the gap being looked for.
  const [r] = joinPaidOrganic(
    [adRow('B0TEST00001', { clicks: 100, purchases30d: 5, cost: 50, sales30d: 125 })],
    [trafficRow('B0TEST00001', 500, 45)]
  );

  assert.equal(r.organicSessions, 400);
  assert.equal(r.organicUnits, 40);
  assert.equal(r.paidCvr, 0.05);
  assert.equal(r.organicCvr, 0.1);
  assert.equal(r.ratio, 0.5); // paid converts at half the organic rate
});

test('clamps at zero rather than reporting negative organic sessions', () => {
  // Ad clicks can exceed sessions: one visitor clicking two ads is two clicks but one
  // session, and ad attribution is 14-day while sessions are same-day. A negative here
  // would produce a nonsense CVR that still renders as a number.
  const [r] = joinPaidOrganic(
    [adRow('B0TEST00002', { clicks: 600, purchases30d: 50 })],
    [trafficRow('B0TEST00002', 500, 40)]
  );

  assert.equal(r.organicSessions, 0);
  assert.equal(r.organicUnits, 0);
  assert.equal(r.organicCvr, null);
  assert.equal(r.ratio, null);
});

test('an ASIN with traffic but no ads still appears, with a null paid CVR', () => {
  const [r] = joinPaidOrganic([], [trafficRow('B0TEST00003', 200, 10)]);

  assert.equal(r.paidCvr, null);
  assert.equal(r.organicCvr, 0.05);
  assert.equal(r.adSpend, 0);
});

test('sums multiple report windows for the same ASIN', () => {
  const [r] = joinPaidOrganic(
    [
      adRow('B0TEST00004', { clicks: 50, cost: 25, purchases30d: 2, sales30d: 50 }),
      adRow('B0TEST00004', { clicks: 30, cost: 15, purchases30d: 1, sales30d: 25 }),
    ],
    [trafficRow('B0TEST00004', 400, 20)]
  );

  assert.equal(r.adClicks, 80);
  assert.equal(r.adSpend, 40);
  assert.equal(r.adOrders, 3);
});

test('quadrant routes each combination to its own cheapest fix', () => {
  const floors = { paidFloor: 0.05, organicFloor: 0.1 };
  const row = (paidCvr, organicCvr) => ({ paidCvr, organicCvr });

  assert.match(quadrant(row(0.01, 0.02), floors), /fix the LISTING first/);
  assert.match(quadrant(row(0.08, 0.02), floors), /listing throttles/);
  assert.match(quadrant(row(0.01, 0.20), floors), /targeting is wrong/);
  assert.match(quadrant(row(0.08, 0.20), floors), /iterate/);
});

test('quadrant refuses to classify when either side is missing', () => {
  const floors = { paidFloor: 0.05, organicFloor: 0.1 };
  assert.equal(quadrant({ paidCvr: null, organicCvr: 0.1 }, floors), 'insufficient data');
  assert.equal(quadrant({ paidCvr: 0.05, organicCvr: null }, floors), 'insufficient data');
});
