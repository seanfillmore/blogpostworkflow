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
