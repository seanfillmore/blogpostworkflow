import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchListings, fetchDailyUnits, fetchMonthlySales, fetchStock, fetchFinance, fetchAdSpend, fetchSeasonal,
} from '../../lib/culina-data.js';

const base = (request, extra = {}) => ({
  request, marketplaceId: 'MKT', sleep: async () => {}, now: () => new Date('2026-11-10T20:00:00Z'), ...extra,
});

const fba = {
  payload: { inventorySummaries: [
    { asin: 'A1', sellerSku: 'S1', productName: 'Culina Cast Iron Soap', inventoryDetails: { fulfillableQuantity: 10, inboundWorkingQuantity: 1, inboundShippedQuantity: 2, inboundReceivingQuantity: 3 } },
    { asin: 'A2', sellerSku: 'S2', productName: 'RSC Lotion', inventoryDetails: { fulfillableQuantity: 5 } },
  ] },
};

test('fetchListings classifies by title', async () => {
  const l = await fetchListings(base(async () => fba));
  assert.deepEqual(l.map((x) => [x.asin, x.sku, x.culina]), [['A1', 'S1', true], ['A2', 'S2', false]]);
});

test('daily units parsed from orderMetrics, with LA offset and per-ASIN calls', async () => {
  const calls = [];
  const d = base(async (m, p, params) => {
    calls.push(params);
    return { payload: [
      { interval: '2026-10-01T00:00-07:00--2026-10-02T00:00-07:00', unitCount: 3 },
      { interval: '2026-10-02T00:00-07:00--2026-10-03T00:00-07:00', unitCount: 0 },
    ] };
  });
  const r = await fetchDailyUnits(d, ['A1', 'A2'], 120);
  assert.deepEqual(r.A1, [{ date: '2026-10-01', units: 3 }, { date: '2026-10-02', units: 0 }]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].granularity, 'Day');
  assert.equal(calls[0].asin, 'A1');
  assert.match(calls[0].interval, /^2026-07-13T00:00:00-07:00--2026-11-10T00:00:00-08:00$/);
});

test('a 429 then success retries', async () => {
  let n = 0;
  const d = base(async () => {
    if (++n < 3) throw new Error('SP-API GET x failed (429): quota');
    return [{ interval: '2026-10-01T00:00-07:00--2026-10-02T00:00-07:00', unitCount: 4 }];
  });
  const r = await fetchDailyUnits(d, ['A1']);
  assert.equal(n, 3);
  assert.equal(r.A1[0].units, 4);
});

test('retry gives up after 5 attempts and non-429 errors throw immediately', async () => {
  let n = 0;
  await assert.rejects(fetchDailyUnits(base(async () => { n++; throw new Error('failed (429)'); }), ['A1']));
  assert.equal(n, 5);
  n = 0;
  await assert.rejects(fetchDailyUnits(base(async () => { n++; throw new Error('failed (403)'); }), ['A1']));
  assert.equal(n, 1);
});

test('monthly sales summed across ASINs by month', async () => {
  const d = base(async (m, p, params) => [
    { interval: '2026-10-01T00:00-07:00--2026-11-01T00:00-07:00', unitCount: 2, totalSales: { amount: '20.5', currencyCode: 'USD' } },
    { interval: '2026-09-01T00:00-07:00--2026-10-01T00:00-07:00', unitCount: 1, totalSales: { amount: 10, currencyCode: 'USD' } },
  ]);
  const r = await fetchMonthlySales(d, ['A1', 'A2'], '2026-09');
  assert.deepEqual(r, [{ month: '2026-09', sales: 20, units: 2 }, { month: '2026-10', sales: 41, units: 4 }]);
});

test('stock merges FBA and AWD by SKU', async () => {
  const d = base(async (m, path) => {
    if (path.includes('/fba/')) return fba;
    return { inventory: [
      { sku: 'S1', totalOnhandQuantity: 100, totalInboundQuantity: 40 },
      { sku: 'UNKNOWN', totalOnhandQuantity: 9, totalInboundQuantity: 9 },
    ] };
  });
  const s = await fetchStock(d);
  assert.deepEqual(s.A1, { fba: 10, awd: 100, inbound: 46 });
  assert.deepEqual(s.A2, { fba: 5, awd: 0, inbound: 0 });
});

test('finance paginates and concatenates arrays', async () => {
  const seen = [];
  const pages = [
    { payload: { FinancialEvents: { ShipmentEventList: [1], ServiceFeeEventList: [9] }, NextToken: 't' } },
    { payload: { FinancialEvents: { ShipmentEventList: [2] } } },
  ];
  const r = await fetchFinance(base(async (m, p, params) => { seen.push(params); return pages.shift(); }), 'a', 'b');
  assert.deepEqual(r, { ShipmentEventList: [1, 2], ServiceFeeEventList: [9] });
  assert.deepEqual(seen[1], { NextToken: 't' });
  assert.equal(seen[0].MaxResultsPerPage, 100);
});

test('fetchAdSpend returns the three reports; null plus error on failure', async () => {
  const configs = [];
  const ok = base(null, { ads: { run: async (c) => { configs.push(c.configuration.reportTypeId); return [{ cost: 1 }]; } } });
  const r = await fetchAdSpend(ok, '2026-10-01', '2026-10-31');
  assert.deepEqual(Object.keys(r), ['sp', 'sb', 'sd']);
  assert.deepEqual(configs, ['spAdvertisedProduct', 'sbCampaigns', 'sdCampaigns']);

  const errs = [];
  const bad = base(null, { ads: { run: async () => { throw new Error('boom'); } }, onError: (k, m) => errs.push([k, m]) });
  assert.equal(await fetchAdSpend(bad, 'a', 'b'), null);
  assert.deepEqual(errs, [['ads', 'boom']]);
});

test('fetchSeasonal maps monthlySearches, null on failure', async () => {
  const r = await fetchSeasonal({ getSearchVolume: async () => [{ keyword: 'k', monthlySearches: [{ month: 1, search_volume: 5 }] }] }, ['k']);
  assert.deepEqual(r, [[{ month: 1, search_volume: 5 }]]);
  assert.equal(await fetchSeasonal({ getSearchVolume: async () => { throw new Error('x'); } }, ['k']), null);
});
