import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitCases, readFbaBySku, expirationDate } from '../../lib/amazon-inbound-split.js';

const base = { today: '2026-11-12', seasonal: null, coverDays: 30 };
const line = (cases = 10) => ({ key: 'k', sku: 'S1', cases, unitsPerCase: 12 });

test('pace 4/day, 50 on hand: 6 FBA, 4 AWD', () => {
  const [r] = splitCases({ ...base, lines: [line()], fbaBySku: { S1: { fulfillable: 50, inbound: 0 } }, paceBySku: { S1: 4 } });
  assert.equal(r.needUnits, 70);
  assert.equal(r.fbaCases, 6);
  assert.equal(r.awdCases, 4);
  assert.equal(r.reason, '30 days of FBA cover, 6 cases to FBA, 4 to AWD');
});

test('need <= 0 gives 0 FBA cases', () => {
  const [r] = splitCases({ ...base, lines: [line()], fbaBySku: { S1: { fulfillable: 100, inbound: 50 } }, paceBySku: { S1: 4 } });
  assert.equal(r.fbaCases, 0);
  assert.equal(r.awdCases, 10);
});

test('need larger than cases: all FBA', () => {
  const [r] = splitCases({ ...base, lines: [line(3)], fbaBySku: {}, paceBySku: { S1: 40 } });
  assert.equal(r.fbaCases, 3);
  assert.equal(r.awdCases, 0);
});

test('null pace: all FBA', () => {
  const [r] = splitCases({ ...base, lines: [line()], fbaBySku: {}, paceBySku: { S1: null } });
  assert.equal(r.fbaCases, 10);
  assert.equal(r.reason, 'no sales pace yet');
});

test('readFbaBySku sums FBA inbound across pages, keys by sellerSku', async () => {
  const pages = [
    { payload: { inventorySummaries: [
      { sellerSku: 'S1', inventoryDetails: { fulfillableQuantity: 5, inboundWorkingQuantity: 1, inboundShippedQuantity: 2, inboundReceivingQuantity: 3 } },
      { sellerSku: 'amzn.gr.S1-x', inventoryDetails: { fulfillableQuantity: 9 } },
    ] }, pagination: { nextToken: 'n2' } },
    { payload: { inventorySummaries: [
      { sellerSku: 'S1', inventoryDetails: { fulfillableQuantity: 4, inboundShippedQuantity: 10 } },
    ] } },
  ];
  const calls = [];
  const deps = { marketplaceId: 'M', request: async (m, p, q) => { calls.push(q); return pages[calls.length - 1]; } };
  const out = await readFbaBySku(deps);
  assert.deepEqual(out.S1, { fulfillable: 9, inbound: 16 });
  assert.equal(out['amzn.gr.S1-x'].fulfillable, 9);
  assert.equal(calls[0].details, 'true');
  assert.equal(calls[1].nextToken, 'n2');
});

test('pace 0 counts as no usable pace: all FBA', () => {
  const [r] = splitCases({ ...base, lines: [line()], fbaBySku: {}, paceBySku: { S1: 0 } });
  assert.equal(r.fbaCases, 10);
  assert.equal(r.reason, 'no sales pace yet');
});

test('float noise above a whole case does not round up', () => {
  const [r] = splitCases({ ...base, lines: [line()], fbaBySku: { S1: { fulfillable: 47.9999999999, inbound: 0 } }, paceBySku: { S1: 4 } });
  assert.equal(r.fbaCases, 6);
  assert.equal(r.awdCases, 4);
});

test('expirationDate adds whole years in Amazon YYYY-MM-DD form; Feb 29 falls back to Feb 28', () => {
  assert.equal(expirationDate('2026-11-12', 3), '2029-11-12');
  assert.equal(expirationDate('2028-02-29', 3), '2031-02-28');
});
