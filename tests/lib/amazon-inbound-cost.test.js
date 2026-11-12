import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { palletize, chooseCheapest, feeAmount } from '../../lib/amazon-inbound-cost.js';

const cfg = JSON.parse(readFileSync(new URL('../../config/amazon-inbound.json', import.meta.url), 'utf8'));
const pallet = cfg.pallet;
const c = (sku, count, l, w, h, lb) => ({ sku, count, case_in: { l, w, h }, case_lb: lb });
const total = (pallets) => pallets.reduce((n, p) => n + p.cases.reduce((m, x) => m + x.count, 0), 0);

test('9 cases of 18x10x12: 2 layers, 29 in, 274 lb', () => {
  const p = palletize([c('A', 9, 18, 10, 12, 26)], pallet);
  assert.equal(p.length, 1);
  assert.equal(p[0].height_in, 29);
  assert.equal(p[0].weight_lb, 274);
  assert.equal(p[0].length_in, 48);
  assert.equal(p[0].width_in, 40);
  assert.deepEqual(p[0].cases, [{ sku: 'A', count: 9 }]);
});

test('32 cases fill one pallet (4 layers, 53 in), 33 need two', () => {
  const one = palletize([c('A', 32, 18, 10, 12, 26)], pallet);
  assert.equal(one.length, 1);
  assert.equal(one[0].height_in, 53);
  assert.equal(palletize([c('A', 33, 18, 10, 12, 26)], pallet).length, 2);
});

test('18x9 cases: 10 per layer', () => {
  const p = palletize([c('A', 10, 18, 9, 12, 27)], pallet);
  assert.equal(p[0].height_in, 17);
});

test('real 33-case batch: counts and weights add up, heights within limit', () => {
  const cases = [c('2', 5, 18, 9, 12, 27), c('3', 9, 18, 10, 12, 26), c('4', 9, 18, 10, 12, 28), c('6', 10, 18, 10, 12, 31)];
  const p = palletize(cases, pallet);
  assert.equal(total(p), 33);
  const lb = 5 * 27 + 9 * 26 + 9 * 28 + 10 * 31;
  assert.equal(p.reduce((n, x) => n + x.weight_lb, 0), lb + 40 * p.length);
  for (const x of p) assert.ok(x.height_in <= 60);
  assert.equal(p.length, 2);
  for (const s of ['2', '3', '4', '6']) {
    assert.equal(p.flatMap((x) => x.cases).filter((x) => x.sku === s).reduce((n, x) => n + x.count, 0), cases.find((k) => k.sku === s).count);
  }
});

test('mixed SKUs only on the trailing pallets', () => {
  const p = palletize([c('A', 40, 18, 10, 12, 26), c('B', 3, 18, 10, 12, 26)], pallet);
  assert.equal(p.length, 2);
  assert.equal(p[0].cases.length, 1);
  assert.equal(total(p), 43);
});

test('a 61 in case throws', () => {
  assert.throws(() => palletize([c('A', 1, 18, 10, 61, 26)], pallet), /palletize:/);
});

test('footprint larger than the pallet throws', () => {
  assert.throws(() => palletize([c('A', 1, 50, 45, 12, 26)], pallet), /palletize:/);
});

test('chooseCheapest: fee 30 + parcel 120 beats fee 0 + parcel 80 + parcel 90', () => {
  const r = chooseCheapest([
    { placementOptionId: 'p1', placementFee: 0, shipments: [
      { shipmentId: 's1', options: [{ transportationOptionId: 't1', mode: 'GROUND_SMALL_PARCEL', amount: 80 }] },
      { shipmentId: 's2', options: [{ transportationOptionId: 't2', mode: 'GROUND_SMALL_PARCEL', amount: 90 }] },
    ] },
    { placementOptionId: 'p2', placementFee: 30, shipments: [
      { shipmentId: 's3', options: [{ transportationOptionId: 't3', mode: 'GROUND_SMALL_PARCEL', amount: 120 }] },
    ] },
  ]);
  assert.equal(r.placementOptionId, 'p2');
  assert.equal(r.total, 150);
});

test('chooseCheapest: LTL beats parcel when cheaper, per shipment', () => {
  const r = chooseCheapest([{ placementOptionId: 'p', placementFee: 10, shipments: [
    { shipmentId: 's', options: [
      { transportationOptionId: 'a', mode: 'GROUND_SMALL_PARCEL', amount: 200 },
      { transportationOptionId: 'b', mode: 'FREIGHT_LTL', amount: 150 },
      { transportationOptionId: 'c', mode: 'FREIGHT_LTL', amount: null },
    ] },
  ] }]);
  assert.deepEqual(r, { placementOptionId: 'p', total: 160, picks: [{ shipmentId: 's', transportationOptionId: 'b', mode: 'FREIGHT_LTL', amount: 150 }] });
});

test('chooseCheapest: null fee and unquoted shipments are skipped; none gives null', () => {
  const ship = (amount) => [{ shipmentId: 's', options: [{ transportationOptionId: 't', mode: 'M', amount }] }];
  const r = chooseCheapest([
    { placementOptionId: 'nofee', placementFee: null, shipments: ship(1) },
    { placementOptionId: 'unq', placementFee: 0, shipments: ship(null) },
    { placementOptionId: 'ok', placementFee: 5, shipments: ship(50) },
  ]);
  assert.equal(r.placementOptionId, 'ok');
  assert.equal(chooseCheapest([{ placementOptionId: 'x', placementFee: null, shipments: ship(1) }, { placementOptionId: 'y', placementFee: 0, shipments: ship(null) }]), null);
  assert.equal(chooseCheapest([]), null);
});

test('chooseCheapest: tie goes to fewest shipments, then first', () => {
  const sh = (id, a) => ({ shipmentId: id, options: [{ transportationOptionId: id, mode: 'M', amount: a }] });
  const r = chooseCheapest([
    { placementOptionId: 'two', placementFee: 0, shipments: [sh('a', 50), sh('b', 50)] },
    { placementOptionId: 'one', placementFee: 0, shipments: [sh('c', 100)] },
    { placementOptionId: 'one-b', placementFee: 0, shipments: [sh('d', 100)] },
  ]);
  assert.equal(r.placementOptionId, 'one');
});

test('feeAmount', () => {
  assert.equal(feeAmount({ amount: -5, code: 'USD' }), -5);
  assert.equal(feeAmount({ amount: 5, code: 'CAD' }), null);
  assert.equal(feeAmount(null), null);
  assert.equal(feeAmount(undefined), null);
  assert.equal(feeAmount({ code: 'USD' }), null);
  assert.equal(feeAmount({ amount: 12.5, code: 'USD' }), 12.5);
});
