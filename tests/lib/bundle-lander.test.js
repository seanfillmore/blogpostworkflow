import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { computeStackTotals } from '../../lib/bundle-lander.js';

// The Reset's actual live variant-level bundle.value_stack, both variants.
const RESET_STACK = [
  { label: 'Body Lotion (8oz)', qty: 3, amount: 90, img: 'component-lotion.webp' },
  { label: 'Body Cream (4oz)', qty: 3, amount: 84, img: 'component-cream.webp' },
  { label: '90-Day Routine & Tracker', amount: 19, digital: true },
  { label: 'Coconut Skincare Field Guide', amount: 15, digital: true },
];

test('digital rows are excluded from the total', () => {
  const r = computeStackTotals(RESET_STACK, 12100);
  assert.equal(r.total, 174, 'total must be product-only, matching the $174 compare-at');
  assert.equal(r.price, 121);
  assert.equal(r.savings, 53);
});

test('digital rows are returned separately so they can render unpriced', () => {
  const r = computeStackTotals(RESET_STACK, 12100);
  assert.equal(r.priced.length, 2);
  assert.equal(r.included.length, 2);
  assert.deepEqual(r.included.map((x) => x.label), [
    '90-Day Routine & Tracker',
    'Coconut Skincare Field Guide',
  ]);
});

test('the pre-fix behaviour is what we are removing', () => {
  // Summing every row is what produces the live $208/$87 contradiction.
  const naive = RESET_STACK.reduce((s, r) => s + r.amount, 0);
  assert.equal(naive, 208);
  assert.notEqual(computeStackTotals(RESET_STACK, 12100).total, naive);
});

test('a stack with no digital rows is unchanged — the other four bundles', () => {
  const cleanSwap = [
    { label: 'Body Lotion (8oz)', amount: 30 },
    { label: 'Natural Deodorant', amount: 15 },
    { label: 'Coconut Toothpaste', amount: 13 },
    { label: 'Coconut Bar Soap', amount: 11 },
  ];
  const r = computeStackTotals(cleanSwap, 5900);
  assert.equal(r.total, 69);
  assert.equal(r.savings, 10);
  assert.equal(r.included.length, 0);
});

test('missing or malformed stack does not throw', () => {
  assert.deepEqual(computeStackTotals(null, 0), {
    priced: [], included: [], total: 0, price: 0, savings: 0,
  });
});
