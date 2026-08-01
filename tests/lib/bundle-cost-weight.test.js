import { strict as assert } from 'node:assert';
import { toOunces, computeTotals } from '../../lib/bundle-cost-weight.js';

// --- Weight normalisation. Shopify returns a unit alongside the value, and a bundle can
// --- mix components measured differently. Summing the raw numbers silently produces
// --- nonsense, so every value is normalised to ounces first.
{
  assert.equal(toOunces(10, 'OUNCES'), 10);
  assert.equal(toOunces(1, 'POUNDS'), 16);
  assert.equal(Math.round(toOunces(1000, 'GRAMS')), 35);
  assert.equal(Math.round(toOunces(1, 'KILOGRAMS')), 35);
  assert.throws(() => toOunces(1, 'FURLONGS'), /unit/i);
}

// --- Totals.
const lookup = (product, variant) => ({
  'coconut-lotion|Coconut Breeze': { unitCost: 5.49, weight: 10, weightUnit: 'OUNCES' },
  'coconut-moisturizer|Coconut Breeze': { unitCost: 5.18, weight: 5, weightUnit: 'OUNCES' },
}[`${product}|${variant}`]);

const RESET = [
  { product: 'coconut-lotion', variant: 'Coconut Breeze', qty: 3 },
  { product: 'coconut-moisturizer', variant: 'Coconut Breeze', qty: 3 },
];

// Cost is quantity-weighted and includes the bundle's packaging cost.
{
  const t = computeTotals(RESET, lookup, { packaging: 0 });
  assert.equal(t.cost, 32.01); // 3×5.49 + 3×5.18
  assert.equal(t.weightOz, 45); // 3×10 + 3×5
  assert.deepEqual(t.missing, []);
}

// Packaging is a dollar cost, not a weight — it must move cost and leave weight alone.
{
  const t = computeTotals(RESET, lookup, { packaging: 1 });
  assert.equal(t.cost, 33.01);
  assert.equal(t.weightOz, 45);
}

// A component with no cost data must be reported, never treated as $0 — a silent zero
// would write a confidently wrong cost onto a live product.
{
  const partial = (p, v) => (p === 'coconut-lotion' ? lookup(p, v) : undefined);
  const t = computeTotals(RESET, partial, { packaging: 0 });
  assert.equal(t.missing.length, 1);
  assert.match(t.missing[0], /coconut-moisturizer/);
  assert.equal(t.cost, null, 'cost must be null when any component is unknown');
  assert.equal(t.weightOz, null);
}

// A component present but with unitCost unset is equally unusable.
{
  const noCost = () => ({ unitCost: null, weight: 10, weightUnit: 'OUNCES' });
  const t = computeTotals(RESET, noCost, { packaging: 0 });
  assert.equal(t.cost, null);
  assert.ok(t.missing.length > 0);
}

// Mixed units sum correctly: 1 lb + 8 oz = 24 oz.
{
  const mixed = (p) => (p === 'a'
    ? { unitCost: 1, weight: 1, weightUnit: 'POUNDS' }
    : { unitCost: 2, weight: 8, weightUnit: 'OUNCES' });
  const t = computeTotals(
    [{ product: 'a', variant: 'x', qty: 1 }, { product: 'b', variant: 'x', qty: 1 }],
    mixed, { packaging: 0 },
  );
  assert.equal(t.weightOz, 24);
  assert.equal(t.cost, 3);
}

// Floating-point money must not leak: 3×5.49 is 16.470000000000002 unrounded.
{
  const t = computeTotals([{ product: 'coconut-lotion', variant: 'Coconut Breeze', qty: 3 }], lookup, { packaging: 0 });
  assert.equal(t.cost, 16.47);
}

console.log('bundle-cost-weight: all assertions passed');
