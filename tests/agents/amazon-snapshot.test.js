import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  classifyBrand, buildSkuBrandMap, aggregateFinance, rscInventory, buildSnapshot, LOW_STOCK_UNITS,
} from '../../agents/amazon-snapshot/index.js';

test('classifyBrand: culina / cast iron → Culina, else RSC', () => {
  assert.equal(classifyBrand('Culina Cast Iron Soap'), 'Culina');
  assert.equal(classifyBrand('CAST IRON conditioner'), 'Culina');
  assert.equal(classifyBrand('Real Skin Care Coconut Lotion'), 'RSC');
  assert.equal(classifyBrand(''), 'RSC');
});

const listings = [
  { sku: 'RSC-LO-PU', summaries: [{ asin: 'B08LOTION', itemName: 'Real Skin Care Coconut Body Lotion' }] },
  { sku: 'OPAQUE-DEO', summaries: [{ asin: 'B08DEO', itemName: 'Real Skin Care Deodorant' }] },
  { sku: 'CUL-1', summaries: [{ asin: 'B08CAST', itemName: 'Culina Cast Iron Soap' }] },
];

test('buildSkuBrandMap maps sku → brand/asin/itemName', () => {
  const m = buildSkuBrandMap(listings);
  assert.equal(m.get('RSC-LO-PU').brand, 'RSC');
  assert.equal(m.get('RSC-LO-PU').asin, 'B08LOTION');
  assert.equal(m.get('CUL-1').brand, 'Culina');
});

const events = {
  ShipmentEventList: [
    { ShipmentItemList: [
      { SellerSKU: 'RSC-LO-PU', QuantityShipped: 1,
        ItemChargeList: [{ ChargeType: 'Principal', ChargeAmount: { CurrencyAmount: 30 } }],
        ItemFeeList: [{ FeeType: 'Commission', FeeAmount: { CurrencyAmount: -4.5 } }, { FeeType: 'FBAPerUnitFulfillmentFee', FeeAmount: { CurrencyAmount: -4.35 } }] },
      { SellerSKU: 'CUL-1', QuantityShipped: 2,
        ItemChargeList: [{ ChargeType: 'Principal', ChargeAmount: { CurrencyAmount: 40 } }],
        ItemFeeList: [{ FeeType: 'Commission', FeeAmount: { CurrencyAmount: -6 } }, { FeeType: 'FBAPerUnitFulfillmentFee', FeeAmount: { CurrencyAmount: -5 } }] },
    ] },
  ],
  RefundEventList: [
    { ShipmentItemList: [{ SellerSKU: 'RSC-LO-PU', ItemChargeList: [{ ChargeType: 'Principal', ChargeAmount: { CurrencyAmount: -5 } }] }] },
  ],
};

test('aggregateFinance splits RSC vs Culina and nets fees + refunds', () => {
  const agg = aggregateFinance(events, buildSkuBrandMap(listings));
  // RSC: gross 30, referral -4.5, fba -4.35, refund -5 → net 16.15
  assert.equal(agg.RSC.gross, 30);
  assert.equal(agg.RSC.referral, -4.5);
  assert.equal(agg.RSC.fba, -4.35);
  assert.equal(agg.RSC.refund, -5);
  assert.equal(agg.RSC.net, 16.15);
  assert.equal(agg.RSC.units, 1);
  assert.equal(agg.RSC.feePct, 29.5); // (4.5+4.35)/30*100
  // Culina isolated
  assert.equal(agg.Culina.gross, 40);
  assert.equal(agg.Culina.net, 29);
  // per-ASIN net for RSC
  assert.equal(agg.RSC.byAsin[0].asin, 'B08LOTION');
  assert.equal(agg.RSC.byAsin[0].net, 21.15); // gross 30 - 8.85 fees (refund tracked at brand level, not per-asin)
});

test('unknown SKU (not in listings) buckets to Unknown, not RSC', () => {
  const ev = { ShipmentEventList: [{ ShipmentItemList: [
    { SellerSKU: 'GHOST', QuantityShipped: 1, ItemChargeList: [{ ChargeType: 'Principal', ChargeAmount: { CurrencyAmount: 9 } }], ItemFeeList: [] },
  ] }] };
  const agg = aggregateFinance(ev, buildSkuBrandMap(listings));
  assert.equal(agg.RSC.gross, 0);
  assert.equal(agg.Unknown.gross, 9);
});

test('rscInventory sums RSC fulfillable and flags hero lotion', () => {
  const inv = [
    { asin: 'B08LOTION', inventoryDetails: { fulfillableQuantity: 12 }, productName: 'Coconut Body Lotion' },
    { asin: 'B08DEO', inventoryDetails: { fulfillableQuantity: 40 }, productName: 'Deodorant' },
    { asin: 'B08CAST', inventoryDetails: { fulfillableQuantity: 99 }, productName: 'Culina Cast Iron' },
  ];
  const out = rscInventory(inv, buildSkuBrandMap(listings));
  assert.equal(out.rscFulfillable, 52); // 12 + 40, excludes Culina
  assert.equal(out.heroLotion.length, 1);
  assert.equal(out.heroLotion[0].fulfillable, 12);
});

test('rscInventory sums duplicate SKU rows of the same ASIN (zombie 0-unit rows)', () => {
  const inv = [
    { asin: 'B08LOTION', inventoryDetails: { fulfillableQuantity: 0 }, productName: 'Coconut Body Lotion' },   // zombie SKU
    { asin: 'B08LOTION', inventoryDetails: { fulfillableQuantity: 90 }, productName: 'Coconut Body Lotion' },  // live SKU
    { asin: 'B08LOTION', inventoryDetails: { fulfillableQuantity: 0 }, productName: 'Coconut Body Lotion' },   // another zombie
  ];
  const out = rscInventory(inv, buildSkuBrandMap(listings));
  assert.equal(out.heroLotion.length, 1);          // deduped to one ASIN
  assert.equal(out.heroLotion[0].fulfillable, 90);  // summed, not 3 rows of 0/90/0
});

test('lowStock does NOT fire on a non-selling (dead) hero-lotion ASIN at 0 units', () => {
  // events sell B08LOTION only; a dead lotion ASIN B08DEAD at 0u must not alarm.
  const agg = aggregateFinance(events, buildSkuBrandMap(listings));
  const inv = { rscFulfillable: 90, heroLotion: [
    { asin: 'B08LOTION', itemName: 'Lotion', fulfillable: 90 }, // selling, healthy
    { asin: 'B08DEAD', itemName: 'Dead Lotion', fulfillable: 0 }, // NOT selling
  ] };
  const snap = buildSnapshot('2026-07-22', { postedAfter: 'x' }, agg, inv);
  assert.equal(snap.lowStock, false); // dead ASIN ignored
  assert.equal(snap.inventory.heroLotion.find((h) => h.asin === 'B08DEAD').selling, false);
});

test('buildSnapshot flags lowStock when hero lotion below threshold', () => {
  const agg = aggregateFinance(events, buildSkuBrandMap(listings));
  const inv = { rscFulfillable: 12, heroLotion: [{ asin: 'B08LOTION', itemName: 'Lotion', fulfillable: 12 }] };
  const snap = buildSnapshot('2026-07-22', { postedAfter: 'x', }, agg, inv);
  assert.equal(snap.lowStock, true); // 12 < 30
  assert.equal(snap.rsc.net, 16.15);
  assert.ok(LOW_STOCK_UNITS >= 30);
  const inv2 = { rscFulfillable: 80, heroLotion: [{ asin: 'B08LOTION', itemName: 'Lotion', fulfillable: 80 }] };
  assert.equal(buildSnapshot('2026-07-22', { postedAfter: 'x' }, agg, inv2).lowStock, false);
});
