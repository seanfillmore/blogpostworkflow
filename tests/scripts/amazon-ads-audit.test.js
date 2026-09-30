import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyBrand } from '../../scripts/amazon-ads-audit.mjs';
import { sumRows, acos } from '../../scripts/amazon-ads-analyze.mjs';
import { reportWindows, isoDay } from '../../lib/amazon/ads-api-client.js';

// Every string below is a REAL campaign name from the live account, so these pin the
// classifier against the data it actually runs on rather than against invented examples.

test('ASIN wins over an absent brand keyword — the case a name-only rule got wrong', () => {
  // No brand word anywhere in the name; B08BTVXLXN is Culina's cleaning scrub.
  assert.equal(classifyBrand('SP - Auto (Loose) 0.40 - All - Prime - B08BTVXLXN - EB'), 'Culina');
});

test('classifies Culina campaigns by keyword when no ASIN is present', () => {
  assert.equal(classifyBrand('Sp - MKW - Broad - Cast Iron Set'), 'Culina');
  assert.equal(classifyBrand('Sp - Blackstone KW - Ph - Soap & Oil'), 'Culina');
  assert.equal(classifyBrand('Sp - KW (cast iron seasoning stick) - Ph - Seasoning Stick'), 'Culina');
});

test('classifies RSC campaigns', () => {
  assert.equal(classifyBrand('Sp - Auto (down) - Toothpaste - B0B6DQTL11/B0B6DHNCW3/B0B6DYZF5H'), 'RSC');
  assert.equal(classifyBrand('Sp - Auto (down) - Deodorant - B0B687583D/B0B6873YQ7'), 'RSC');
  assert.equal(classifyBrand('Sp - 5KW - Broad - Body Lotion - B0BSTLKV6N - EB'), 'RSC');
  assert.equal(classifyBrand('Sp - Branded KW (real skin care)  - Broad - RSC Lotions - B09QJFBPJ1/B08GMCDMQ7'), 'RSC');
});

test('an account-wide campaign is UNKNOWN, never silently folded into RSC', () => {
  // These genuinely span both brands. Defaulting them to RSC would inflate the one
  // figure this repo cares about, which is why UNKNOWN is a reported bucket.
  assert.equal(classifyBrand('SP - Auto All (0.50) - All Enrolled - Prime - EB'), 'UNKNOWN');
  assert.equal(classifyBrand('Sp - Search Terms - Ex - All Products - EB'), 'UNKNOWN');
  assert.equal(classifyBrand('SP -  Catch all (0.45) - All - Prime - EB'), 'UNKNOWN');
});

test('a campaign naming ASINs from BOTH brands is UNKNOWN rather than whichever matched first', () => {
  assert.equal(classifyBrand('Sp - Mixed - B071SGF6GT/B0BSTLKV6N'), 'UNKNOWN');
});

test('sumRows recombines the per-window rows a chunked report returns', () => {
  // A 90-day pull arrives as three 31-day windows; failing to sum them under-reports
  // spend by two thirds, which is the whole reason this helper exists.
  const rows = [
    { campaignId: '1', campaignName: 'A', impressions: 100, clicks: 10, cost: 5, purchases30d: 1, sales30d: 20 },
    { campaignId: '1', campaignName: 'A', impressions: 200, clicks: 20, cost: 15, purchases30d: 2, sales30d: 40 },
    { campaignId: '2', campaignName: 'B', impressions: 50, clicks: 5, cost: 2, purchases30d: 0, sales30d: 0 },
  ];
  const out = sumRows(rows, (r) => r.campaignId).sort((a, b) => a.key.localeCompare(b.key));

  assert.equal(out.length, 2);
  assert.deepEqual(
    { clicks: out[0].clicks, cost: out[0].cost, orders: out[0].orders, sales: out[0].sales },
    { clicks: 30, cost: 20, orders: 3, sales: 60 }
  );
});

test('acos returns null rather than Infinity when there are no sales', () => {
  // Spend with zero sales is the headline waste finding; it must not render as a number
  // that sorts alongside real ACoS values.
  assert.equal(acos({ cost: 50, sales: 0 }), null);
  assert.equal(acos({ cost: 20, sales: 80 }), 0.25);
});

test('reportWindows chunks a 90-day span into requestable windows covering every day', () => {
  const w = reportWindows('2026-07-01', '2026-09-28');

  assert.equal(w.length, 3);
  assert.equal(w[0].startDate, '2026-07-01');
  assert.equal(w.at(-1).endDate, '2026-09-28');

  // No gap and no overlap between consecutive windows.
  for (let i = 1; i < w.length; i++) {
    const prevEnd = new Date(w[i - 1].endDate);
    prevEnd.setUTCDate(prevEnd.getUTCDate() + 1);
    assert.equal(w[i].startDate, isoDay(prevEnd));
  }
});

test('reportWindows returns a single window when the span already fits', () => {
  const w = reportWindows('2026-09-01', '2026-09-10');
  assert.deepEqual(w, [{ startDate: '2026-09-01', endDate: '2026-09-10' }]);
});
