import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { monthPnl, comparePnl, assignCampaignBrand } from '../../lib/culina-pnl.js';

const events = JSON.parse(readFileSync(new URL('../fixtures/culina/finance-events.json', import.meta.url)));
const culinaAsins = new Set(['B0CULFAKE1']);
const rscAsins = new Set(['B08GMCDMQ7']);
const base = {
  financeEvents: events,
  culinaSkus: new Set(['CUL-FAKE-A']),
  cogsTable: { B0CULFAKE1: { cogs: 5 } },
  skuToAsin: new Map([['CUL-FAKE-A', 'B0CULFAKE1'], ['RSC-FAKE-B', 'B08GMCDMQ7']]),
  culinaAsins, rscAsins,
};
const ads = {
  sp: [
    { campaignName: 'SP - A', advertisedAsin: 'B0CULFAKE1', advertisedSku: 'CUL-FAKE-A', cost: 10 },
    { campaignName: 'SP - B', advertisedAsin: 'B08GMCDMQ7', cost: 7 },
  ],
  sb: [{ campaignName: 'SB - PC - Search Terms3 - Broad - EB', cost: 4 }, { campaignName: 'SB - Cast Iron Brand', cost: 3 }],
  sd: [{ campaignName: 'SD - RM - VCPM - Body Lotions - B08GMCDMQ7 - EB', cost: 5 }],
};

test('assignCampaignBrand', () => {
  assert.equal(assignCampaignBrand('SD - RM - VCPM - Body Lotions - B08GMCDMQ7 - EB', culinaAsins, rscAsins), 'rsc');
  assert.equal(assignCampaignBrand('SB - PC - Search Terms3 - Broad - EB', culinaAsins, rscAsins), null);
  assert.equal(assignCampaignBrand('SP - B0CULFAKE1 - x', culinaAsins, rscAsins), 'culina');
  assert.equal(assignCampaignBrand('Cast Iron Scrub', culinaAsins, rscAsins), 'culina');
});

test('monthPnl core lines and allocation', () => {
  const p = monthPnl({ ...base, ads });
  assert.equal(p.sales, 40);
  assert.equal(p.fba, -8);
  assert.equal(p.referral, -6);
  assert.equal(p.promotions, -2);
  assert.equal(p.refunds, -20);
  assert.equal(p.cogs, -10);
  assert.equal(p.contribution, 40 - 8 - 6 - 2 - 20 - 10);
  assert.ok(Math.abs(p.unitShare - 2 / 3) < 1e-9);
  assert.equal(p.freight, -66.67);
  assert.equal(p.storage, -20);
  assert.equal(p.couponFees, -0.4);
  assert.equal(p.reimbursements, 6);
  assert.deepEqual(p.adSpend, { sp: -10, sb: -3, sd: 0, total: -13 });
  assert.deepEqual(p.unassignedCampaigns, ['SB - PC - Search Terms3 - Broad - EB']);
  assert.equal(p.net, Math.round((p.contribution - 13 - 66.67 - 20 - 0.4 + 6) * 100) / 100);
  assert.ok(!('agency' in p));
});

test('ads null gives null net and adSpend', () => {
  const p = monthPnl({ ...base, ads: null });
  assert.equal(p.adSpend, null);
  assert.equal(p.net, null);
});

test('comparePnl', () => {
  const c = monthPnl({ ...base, ads });
  const rows = comparePnl(c, { ...c, sales: 20 });
  const sales = rows.find((r) => r.line === 'sales');
  assert.deepEqual(sales, { line: 'sales', curr: 40, prev: 20, change: 20 });
  assert.ok(rows.find((r) => r.line === 'adSpend'));
});

test('RSC soap words vs Culina soap words', () => {
  assert.equal(assignCampaignBrand('SB - Coconut Soap - Broad', culinaAsins, rscAsins), 'rsc');
  assert.equal(assignCampaignBrand('SB - Hand Soaps - Exact', culinaAsins, rscAsins), 'rsc');
  assert.equal(assignCampaignBrand('SB - Cast Iron Soap - Exact', culinaAsins, rscAsins), 'culina');
  assert.equal(assignCampaignBrand('SB - Scrubs and Oils', culinaAsins, rscAsins), 'culina');
});

test('missingCogs lists Culina SKUs without a COGS figure', () => {
  const p = monthPnl({ ...base, cogsTable: {}, ads: null });
  assert.deepEqual(p.missingCogs, ['CUL-FAKE-A']);
  assert.equal(p.cogs, 0);
  const q = monthPnl({ ...base, skuToAsin: new Map(), ads: null });
  assert.deepEqual(q.missingCogs, ['CUL-FAKE-A']);
  assert.deepEqual(monthPnl({ ...base, ads: null }).missingCogs, []);
});

test('service fee with its own SKU/ASIN is charged to that brand fully', () => {
  const ev = JSON.parse(JSON.stringify(events));
  ev.ServiceFeeEventList = [
    { SellerSKU: 'CUL-FAKE-A', FeeList: [{ FeeType: 'FBAStorageFee', FeeAmount: { CurrencyAmount: -10 } }] },
    { SellerSKU: 'RSC-FAKE-B', FeeList: [{ FeeType: 'FBAStorageFee', FeeAmount: { CurrencyAmount: -50 } }] },
    { ASIN: 'B0CULFAKE1', FeeList: [{ FeeType: 'FBAInboundTransportationFee', FeeAmount: { CurrencyAmount: -7 } }] },
    { FeeList: [{ FeeType: 'FBAInboundTransportationFee', FeeAmount: { CurrencyAmount: -30 } }] },
  ];
  const p = monthPnl({ ...base, financeEvents: ev, ads: null });
  assert.equal(p.storage, -10);
  assert.equal(p.freight, -27); // -7 own + -30 * 2/3
});

test('no units shipped: unitShare and allocated lines are null', () => {
  const ev = { ShipmentEventList: [], ServiceFeeEventList: events.ServiceFeeEventList, AdjustmentEventList: events.AdjustmentEventList };
  const p = monthPnl({ ...base, financeEvents: ev, ads });
  assert.equal(p.unitShare, null);
  assert.equal(p.freight, null);
  assert.equal(p.storage, null);
  assert.equal(p.couponFees, null);
  assert.equal(p.reimbursements, null);
  assert.equal(p.net, null);
});

test('-0 normalised and unnamed campaigns listed', () => {
  const p = monthPnl({ ...base, ads: { sp: [], sb: [{ cost: 1 }], sd: [] } });
  assert.ok(Object.is(p.adSpend.sd, 0) && Object.is(p.adSpend.sp, 0));
  assert.deepEqual(p.unassignedCampaigns, ['(unnamed)']);
  const z = monthPnl({ ...base, financeEvents: {}, ads: null });
  for (const k of ['sales', 'fba', 'referral', 'promotions', 'refunds', 'cogs', 'contribution']) assert.ok(Object.is(z[k], 0), k);
});
