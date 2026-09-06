import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCsv, campaignBrands, duplicateTargets, breakEvenRows, financeByAsin,
  isOneToOne, isAuto, NEGATION_CLICK_FLOOR,
} from '../../scripts/amazon/culina-ppc-audit.mjs';

test('parseCsv handles quoted fields, embedded commas and Amazon money formatting', () => {
  const rows = parseCsv('Campaign Name,Spend,Clicks\r\n"Sp - Auto (Close), v2","$1,234.56",10\r\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]['Campaign Name'], 'Sp - Auto (Close), v2');
  assert.equal(rows[0].Spend, 1234.56, '$ and thousands separator stripped to a number');
  assert.equal(rows[0].Clicks, 10);
});

test('parseCsv keeps a doubled quote and does not invent a row from a trailing newline', () => {
  const rows = parseCsv('A,B\n"say ""hi""",2\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].A, 'say "hi"');
});

test('campaignBrands: SKU prefix decides, and a mixed campaign is MIXED not a guess', () => {
  const m = campaignBrands([
    { 'Campaign Name': 'c1', 'Advertised SKU': 'RSC-LO-PU' },
    { 'Campaign Name': 'c2', 'Advertised SKU': 'salt_Soap' },
    { 'Campaign Name': 'c3', 'Advertised SKU': 'RSC-DEO' },
    { 'Campaign Name': 'c3', 'Advertised SKU': 'cast_iron' },
  ]);
  assert.equal(m.get('c1'), 'RSC');
  assert.equal(m.get('c2'), 'Culina');
  assert.equal(m.get('c3'), 'MIXED');
});

test('one-to-one vs auto campaigns are read off the operator naming convention', () => {
  assert.ok(isOneToOne('Sp - MKW - Exact - Cast Iron Set - B08'));
  assert.ok(isOneToOne('Sp - PT - (B0CR98NXYS) - Scrub Set'));
  assert.ok(isOneToOne('Sp - KW (cast iron cleaner) - Ex - 3 Pack'));
  assert.ok(!isOneToOne('Sp - MKW - Broad - Cleaning Scrub'));
  assert.ok(isAuto('Sp - Auto (Close) - Cast Iron Set'));
  assert.ok(!isAuto('Sp - MKW - Exact - Soap'));
});

test('duplicateTargets EXCLUDES auto-targeting groups — one per auto campaign is correct', () => {
  // Without this the headline inflated from $3,738 to $7,184 on the real account,
  // because `close-match` legitimately appears once in each of 20 auto campaigns.
  const tg = [
    { 'Campaign Name': 'a1', Targeting: 'close-match', 'Match Type': '-', Spend: 100 },
    { 'Campaign Name': 'a2', Targeting: 'close-match', 'Match Type': '-', Spend: 100 },
    { 'Campaign Name': 'e1', Targeting: 'cast iron cleaner', 'Match Type': 'exact', Spend: 60 },
    { 'Campaign Name': 'e2', Targeting: 'Cast Iron Cleaner', 'Match Type': 'EXACT', Spend: 40 },
    { 'Campaign Name': 'e1', Targeting: 'cast iron oil', 'Match Type': 'exact', Spend: 5 },
  ];
  const { dupes, totalTargets } = duplicateTargets(tg, () => true);
  assert.equal(totalTargets, 2, 'auto groups never counted as targets');
  assert.equal(dupes.length, 1);
  assert.equal(dupes[0].target, 'cast iron cleaner [exact]', 'case-insensitive match');
  assert.equal(dupes[0].campaigns, 2);
  assert.equal(dupes[0].spend, 100);
});

test('duplicateTargets is brand-scoped', () => {
  const tg = [
    { 'Campaign Name': 'rsc1', Targeting: 'lotion', 'Match Type': 'exact', Spend: 10 },
    { 'Campaign Name': 'rsc2', Targeting: 'lotion', 'Match Type': 'exact', Spend: 10 },
  ];
  assert.equal(duplicateTargets(tg, () => false).dupes.length, 0);
});

const events = {
  ShipmentEventList: [{
    ShipmentItemList: [
      { SellerSKU: 'cast_iron_soap', QuantityShipped: 2,
        ItemChargeList: [{ ChargeType: 'Principal', ChargeAmount: { CurrencyAmount: 20 } }],
        ItemFeeList: [{ FeeType: 'Commission', FeeAmount: { CurrencyAmount: -3 } },
                      { FeeType: 'FBAPerUnitFulfillmentFee', FeeAmount: { CurrencyAmount: -5 } }] },
      { SellerSKU: 'RSC-LO-PU', QuantityShipped: 1,
        ItemChargeList: [{ ChargeType: 'Principal', ChargeAmount: { CurrencyAmount: 30 } }],
        ItemFeeList: [{ FeeType: 'Commission', FeeAmount: { CurrencyAmount: -4.5 } }] },
    ],
  }],
};
const skuToAsin = new Map([['cast_iron_soap', 'B08CAST'], ['RSC-LO-PU', 'B08LOTION']]);

test('financeByAsin BRAND-FILTERS, so RSC ASINs never surface as Culina missing COGS', () => {
  const all = financeByAsin(events, skuToAsin);
  assert.deepEqual(Object.keys(all).sort(), ['B08CAST', 'B08LOTION']);

  const culinaOnly = financeByAsin(events, skuToAsin, (sku) => !/^RSC-/i.test(sku));
  assert.deepEqual(Object.keys(culinaOnly), ['B08CAST'], 'RSC excluded at the source');
  assert.equal(culinaOnly.B08CAST.gross, 20);
  assert.equal(culinaOnly.B08CAST.units, 2);
  assert.equal(culinaOnly.B08CAST.referral, -3);
  assert.equal(culinaOnly.B08CAST.fba, -5);
});

test('breakEvenAcos IS contribution margin before ads; an ASIN above it loses money', () => {
  const finance = { B08CAST: { gross: 100, referral: -15, fba: -20, otherFee: 0, promo: 0, units: 10 } };
  const cogsTable = { B08CAST: { cogs: 2, name: 'Soap' } };
  const { rows } = breakEvenRows({
    finance,
    adSpend: { B08CAST: { spend: 40, adSales: 80 } },
    cogsTable,
  });
  const r = rows[0];
  // 100 gross - 35 Amazon fees - 20 COGS = 45 contribution => break-even ACoS 45%.
  assert.equal(r.contribBeforeAds, 45);
  assert.equal(r.breakEvenAcos, 0.45);
  assert.equal(r.actualAcos, 0.5, '40 spend / 80 ad sales');
  assert.ok(r.actualAcos > r.breakEvenAcos, 'losing money on every ad-driven sale');
  assert.equal(r.net, 5, 'contribution minus ad spend');
});

test('an ASIN with no COGS is REPORTED as unpriced, never assumed free', () => {
  const { rows, unpriced } = breakEvenRows({
    finance: { B08NEW: { gross: 50, referral: -7, fba: -5, otherFee: 0, promo: 0, units: 3 } },
    adSpend: { B08NEW: { spend: 9, adSales: 20 } },
    cogsTable: {},
  });
  assert.equal(rows.length, 0, 'never enters the totals');
  assert.deepEqual(unpriced, [{ asin: 'B08NEW', gross: 50, spend: 9 }]);
});

test('the negation click floor is a real floor, not zero', () => {
  assert.ok(NEGATION_CLICK_FLOOR >= 5, 'below ~5 clicks a zero-order term is noise, not evidence');
});
