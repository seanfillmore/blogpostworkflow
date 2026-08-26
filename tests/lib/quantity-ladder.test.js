import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tierUnits, resolveTiers, freeUnitFraming, validateLadder } from '../../lib/quantity-ladder.js';

const bundle = (handle, qtys, status = 'live') => ({
  handle, status,
  variants: [{ components: qtys.map((q, i) => ({ product: 'coconut-soap', variant: `v${i}`, qty: q })) }],
});

const ROSTER = { bundles: [bundle('coconut-bar-soap-4-pack', [1, 1, 1, 1]), bundle('coconut-bar-soap-12-pack', [12])] };
const LADDER = {
  base: 'coconut-soap',
  tiers: ['coconut-soap', 'coconut-bar-soap-4-pack', 'coconut-bar-soap-12-pack'],
  default: 'coconut-bar-soap-12-pack',
};
const CATALOGUE = {
  'coconut-soap': { status: 'ACTIVE' },
  'coconut-bar-soap-4-pack': { status: 'ACTIVE' },
  'coconut-bar-soap-12-pack': { status: 'ACTIVE' },
};

test('tierUnits sums component quantities, never variant count', () => {
  assert.equal(tierUnits(bundle('x', [1, 1, 1, 1])), 4);
  assert.equal(tierUnits(bundle('x', [12])), 12);
  assert.equal(tierUnits(bundle('x', [3, 3, 3, 3])), 12);
});

test('resolveTiers returns tiers in declared order with the base at 1 unit', () => {
  assert.deepEqual(resolveTiers(ROSTER, LADDER), [
    { handle: 'coconut-soap', units: 1, isBase: true },
    { handle: 'coconut-bar-soap-4-pack', units: 4, isBase: false },
    { handle: 'coconut-bar-soap-12-pack', units: 12, isBase: false },
  ]);
});

test('free-unit framing applies only when paid units are whole', () => {
  // 88 / 11 = 8 exactly -> buy 8 get 4 free
  assert.deepEqual(freeUnitFraming({ tierPrice: 8800, baseUnitPrice: 1100, units: 12 }),
    { kind: 'free-units', paid: 8, free: 4 });
});

test('fractional paid units fall back to a savings label', () => {
  // every other multipack in the catalogue: 39/11, 53/15, 34/13
  assert.equal(freeUnitFraming({ tierPrice: 3900, baseUnitPrice: 1100, units: 4 }).kind, 'savings');
  assert.equal(freeUnitFraming({ tierPrice: 5300, baseUnitPrice: 1500, units: 4 }).kind, 'savings');
  assert.equal(freeUnitFraming({ tierPrice: 3400, baseUnitPrice: 1300, units: 3 }).kind, 'savings');
});

test('the base tier never gets free-unit framing', () => {
  // paid == units means nothing is free; must not render "buy 1 get 0 free"
  assert.equal(freeUnitFraming({ tierPrice: 1100, baseUnitPrice: 1100, units: 1 }).kind, 'savings');
});

test('validateLadder accepts a coherent ladder', () => {
  assert.deepEqual(validateLadder(LADDER, ROSTER, CATALOGUE), []);
});

test('validateLadder rejects a tier missing from the catalogue', () => {
  const errs = validateLadder(LADDER, ROSTER, { 'coconut-soap': { status: 'ACTIVE' } });
  assert.equal(errs.length, 2);
  assert.match(errs[0], /coconut-bar-soap-4-pack.*not in the catalogue/);
});

test('validateLadder rejects an unpublished tier', () => {
  // This is the exact 2026-08-25 failure: roster-live, Shopify DRAFT, 404.
  const errs = validateLadder(LADDER, ROSTER, { ...CATALOGUE, 'coconut-bar-soap-4-pack': { status: 'DRAFT' } });
  assert.equal(errs.length, 1);
  assert.match(errs[0], /coconut-bar-soap-4-pack.*DRAFT/);
});

test('validateLadder rejects non-increasing unit counts', () => {
  const bad = { ...LADDER, tiers: ['coconut-soap', 'coconut-bar-soap-12-pack', 'coconut-bar-soap-4-pack'] };
  const errs = validateLadder(bad, ROSTER, CATALOGUE);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /units must increase/);
});

test('validateLadder rejects a default that is not one of the tiers', () => {
  const errs = validateLadder({ ...LADDER, default: 'nope' }, ROSTER, CATALOGUE);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /default "nope" is not one of the tiers/);
});
