import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitCases, readFbaBySku, expirationDate } from '../../lib/amazon-inbound-split.js';

const base = { today: '2026-11-12', seasonal: null, coverDays: 30 };
const line = (cases = 10) => ({ key: 'k', sku: 'S1', cases, unitsPerCase: 12 });

test('a pack FBA needs goes to FBA WHOLE, never split (pace 4/day, 50 on hand)', () => {
  const [r] = splitCases({ ...base, lines: [line()], fbaBySku: { S1: { fulfillable: 50, inbound: 0 } }, paceBySku: { S1: 4 } });
  assert.equal(r.needUnits, 70);
  assert.equal(r.fbaCases, 10);
  assert.equal(r.awdCases, 0);
  assert.equal(r.reason, '13 days of FBA cover (under 30), so all 10 cases to FBA'); // 50 / 4 = 12.5 days now
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

test('FBA already covered: the whole pack goes to AWD', () => {
  const [r] = splitCases({ ...base, lines: [line()], fbaBySku: { S1: { fulfillable: 100, inbound: 30 } }, paceBySku: { S1: 4 } });
  assert.equal(r.fbaCases, 0);
  assert.equal(r.awdCases, 10);
  assert.equal(r.reason, '33 days of FBA cover (30+ covered), so all 10 cases to AWD');
});

test('no line is ever split between FBA and AWD', () => {
  for (const have of [0, 30, 60, 90, 119, 120, 121, 200]) {
    const [r] = splitCases({ ...base, lines: [line()], fbaBySku: { S1: { fulfillable: have, inbound: 0 } }, paceBySku: { S1: 4 } });
    assert.ok(r.fbaCases === 0 || r.awdCases === 0, `split at ${have}`);
  }
});
test('expirationDate adds whole years in Amazon YYYY-MM-DD form; Feb 29 falls back to Feb 28', () => {
  assert.equal(expirationDate('2026-11-12', 3), '2029-11-12');
  assert.equal(expirationDate('2028-02-29', 3), '2031-02-28');
});
