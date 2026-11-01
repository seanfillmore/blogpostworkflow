import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planSamplePriming, renderPrimingLines, creatorNameFromOrder, shipmentState, isTrybeSampleOrder, normName,
} from '../../lib/trybe-samples.js';

const NOW = Date.parse('2026-10-02T12:00:00Z');
const order = (over = {}) => ({
  name: '#2360', createdAt: '2026-09-22T00:00:00Z', tags: ['abc', 'sample-request', 'trybe'],
  note: 'Trybe sample request for Lori Yockim', shippingAddress: { name: 'Lori Yockim' },
  lineItems: { nodes: [{ title: 'Body Lotion' }, { title: 'Bar Soap' }] },
  fulfillments: [{ status: 'SUCCESS', displayStatus: 'DELIVERED', deliveredAt: '2026-09-26T19:10:00Z' }],
  ...over,
});
const sub = (name, products, status = 'approved') => ({ status, creator: { name }, products: products.map((n) => ({ name: n })) });

test('only Trybe sample orders count', () => {
  assert.equal(isTrybeSampleOrder(order()), true);
  assert.equal(isTrybeSampleOrder(order({ tags: ['PR Package'] })), false);
  assert.equal(isTrybeSampleOrder(order({ tags: ['sample-request'] })), false);
});

test('the creator comes from the NOTE, not a forwarder ship-to name', () => {
  const o = order({ note: 'Trybe sample request for Laura Muñoz', shippingAddress: { name: '#ICC35294 Jose Guzmán' } });
  assert.equal(creatorNameFromOrder(o), 'Laura Muñoz');
  assert.equal(creatorNameFromOrder(order({ note: '' })), 'Lori Yockim');
  assert.equal(normName('Laura  MUÑOZ'), 'laura munoz');
});

test('shipment states', () => {
  assert.equal(shipmentState(order({ fulfillments: [] })).state, 'unshipped');
  assert.equal(shipmentState(order({ cancelledAt: '2026-09-23' })).state, 'cancelled');
  assert.equal(shipmentState(order({ fulfillments: [{ displayStatus: 'IN_TRANSIT' }] })).state, 'in_transit');
  assert.equal(shipmentState(order({ fulfillments: [{ displayStatus: 'DELAYED' }] })).state, 'problem');
  // Multi-parcel: delivered only when every parcel is.
  assert.equal(shipmentState(order({ fulfillments: [{ displayStatus: 'DELIVERED', deliveredAt: '2026-09-26' }, { displayStatus: 'IN_TRANSIT' }] })).state, 'in_transit');
});

test('delivered 5+ days with no content: prime, longest wait first', () => {
  const plan = planSamplePriming({
    now: NOW,
    orders: [
      order(),
      order({ name: '#2359', note: 'Trybe sample request for Kristin Crane', fulfillments: [{ displayStatus: 'DELIVERED', deliveredAt: '2026-09-28T00:00:00Z' }] }),
    ],
  });
  assert.deepEqual(plan.prime.map((r) => r.creator), ['Lori Yockim']);
  assert.equal(plan.prime[0].daysSinceDelivery, 5);
  assert.deepEqual(plan.waiting.map((r) => r.creator), ['Kristin Crane']);
});

test('partial coverage still primes, naming only the missing products', () => {
  const plan = planSamplePriming({ now: NOW, orders: [order()], submissions: [sub('lori yockim', ['Body Lotion'])] });
  assert.deepEqual(plan.prime[0].missing, ['Bar Soap']);
  assert.equal(plan.prime[0].submitted, true);
});

test('full coverage, even rejected work, is not primed', () => {
  const plan = planSamplePriming({ now: NOW, orders: [order()], submissions: [sub('Lori Yockim', ['Body Lotion', 'Bar Soap'], 'rejected')] });
  assert.equal(plan.prime.length, 0);
});

test('unshipped past the threshold is flagged; fresh ones are not', () => {
  const plan = planSamplePriming({
    now: NOW,
    orders: [
      order({ name: '#2381', createdAt: '2026-09-29T00:00:00Z', fulfillments: [] }),
      order({ name: '#2382', note: 'Trybe sample request for Suzette', createdAt: '2026-10-02T00:00:00Z', fulfillments: [] }),
    ],
  });
  assert.deepEqual(plan.unshipped.map((r) => r.order), ['#2381']);
  assert.equal(plan.inTransit.length, 1);
});

test('creators without a sample order or content are counted', () => {
  const plan = planSamplePriming({ now: NOW, orders: [order()], submissions: [sub('Zena', ['x'])], creators: [{ name: 'Lori Yockim' }, { name: 'Zena' }, { name: 'New Person' }] });
  assert.deepEqual(plan.noSample, ['New Person']);
});

test('digest lines name who to nudge and degrade on a null plan', () => {
  const plan = planSamplePriming({ now: NOW, orders: [order(), order({ name: '#9', note: 'Trybe sample request for Kaci', fulfillments: [{ displayStatus: 'DELAYED', estimatedDeliveryAt: '2026-10-01T00:00:00Z' }] })] });
  const text = renderPrimingLines(plan).join('\n');
  assert.match(text, /Lori Yockim · #2360 · delivered 5d ago · no content for: Body Lotion, Bar Soap/);
  assert.match(text, /Kaci · #9 · DELAYED · was due 2026-10-01/);
  assert.match(renderPrimingLines(null).join('\n'), /could not be read/);
});
