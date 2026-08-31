import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  nonDigitalTotal, checkStackConsistency,
} from '../../lib/bundle-value-stack.js';
import { bindingDuration, assertDurationClaim } from '../../lib/supply-duration.js';

const bundles = JSON.parse(readFileSync('config/bundles.json', 'utf8')).bundles;
const reset = bundles.find((b) => b.handle === '99-coconut-reset-digital');

// ─────────────────────────────────────────────────────────────────────────────
// THE BUG THIS PREVENTS (2026-08-30)
//
// The Reset lander showed "$180 of value … $59 in savings" in three places and
// "Total value $174 … You save $53" in a fourth, while Shopify's buy box struck
// through $174. Nothing was stale: two Liquid blocks computed a total from the
// SAME bundle.value_stack metafield under two different rules, and the only
// difference between them was the "Free shipping $6" row.
//
// The fix is in the DATA, not a rule: a stack whose only non-digital row is the
// physical product value totals the same under every summation anyone might
// write. This pins that invariant.
// ─────────────────────────────────────────────────────────────────────────────

test('nonDigitalTotal sums only the rows a customer receives as physical value', () => {
  const stack = [
    { label: 'products', amount: 174, digital: false },
    { label: 'tracker', amount: 19, digital: true },
    { label: 'guide', amount: 15, digital: true },
  ];
  assert.equal(nonDigitalTotal(stack), 174);
});

test('a valued shipping row is exactly what produced the $180 vs $174 split', () => {
  const withShipping = [
    { label: 'products', amount: 174, digital: false },
    { label: 'Free shipping', amount: 6, digital: false },
  ];
  assert.equal(nonDigitalTotal(withShipping), 180);

  const zeroed = [
    { label: 'products', amount: 174, digital: false },
    { label: 'Free shipping', amount: 0, digital: false },
  ];
  assert.equal(nonDigitalTotal(zeroed), 174);
});

test('checkStackConsistency flags a stack that disagrees with the compare-at price', () => {
  const r = checkStackConsistency({
    stack: [
      { label: 'products', amount: 174, digital: false },
      { label: 'Free shipping', amount: 6, digital: false },
    ],
    compareAtPrice: 174,
    price: 121,
  });
  assert.equal(r.ok, false);
  assert.equal(r.total, 180);
  assert.match(r.problems.join(' '), /compare-at/i);
  // The offending row is named, because "the totals disagree" is not actionable.
  assert.match(r.problems.join(' '), /Free shipping/);
});

test('checkStackConsistency passes when every surface would render the same number', () => {
  const r = checkStackConsistency({
    stack: [
      { label: '3 Body Lotions + 3 Body Creams', amount: 174, digital: false },
      { label: '90-Day Routine & Tracker', amount: 19, digital: true },
      { label: 'Coconut Skincare Field Guide', amount: 15, digital: true },
      { label: 'Free shipping', amount: 0, digital: false },
    ],
    compareAtPrice: 174,
    price: 121,
  });
  assert.equal(r.ok, true, r.problems.join('; '));
  assert.equal(r.total, 174);
  assert.equal(r.savings, 53);
});

test('zeroing the shipping row is what closes the split, not deleting it', () => {
  // Zero rather than delete: the row still renders as a free inclusion, and the
  // rule that excludes it is visible in the data instead of implied by a label.
  const stack = [
    { label: 'products', amount: 174, digital: false },
    { label: 'Free shipping', amount: 0, digital: false },
  ];
  assert.equal(nonDigitalTotal(stack), 174);
  assert.ok(stack.some((r) => r.label === 'Free shipping'), 'the row survives');
});

test('valued digital rows are an advisory note, never a failure', () => {
  // `digital: true` is the theme's own exclusion contract, so those amounts are
  // inert and worth keeping as the notional value of the bonuses. Failing on
  // them would delete real information to guard a case already covered.
  const r = checkStackConsistency({
    stack: [
      { label: 'products', amount: 174, digital: false },
      { label: 'tracker', amount: 19, digital: true },
    ],
    compareAtPrice: 174,
    price: 121,
  });
  assert.equal(r.ok, true, r.problems.join('; '));
  assert.equal(r.total, 174);
  assert.equal(r.notes.length, 1);
  assert.match(r.notes[0], /notional value/);
});

// ─────────────────────────────────────────────────────────────────────────────
// The duration claim, which blocked the price generator from running at all.
// Rates were reorder-gap derived; at ~16 orders/month that sample cannot carry
// the claim. Sean supplied the merchant figure: 30 days per unit for both.
// ─────────────────────────────────────────────────────────────────────────────

test('the Reset supports its own 90-day claim', () => {
  const components = reset.variants[0].components;
  const r = bindingDuration(components);
  assert.equal(r.days, 90, `binding duration is ${r.days}, limited by ${r.limitedBy}`);
  assert.doesNotThrow(() => assertDurationClaim(90, components, 'The 90-Day Coconut Reset'));
});

test('raising the two rates cannot make any other bundle over-claim', () => {
  // Both moved UP relative to nothing being bound lower, so the change can only
  // relax the guard. Any bundle that becomes SHORTER than before is a regression
  // this test exists to catch.
  const expectedFloor = {
    'sensitive-skin-starter-set': 30,
    '99-coconut-reset-digital': 90,
    'coconut-bar-soap-4-pack': 100,
    'coconut-bar-soap-12-pack': 300,
    '90-day-clean-swap': 75,
    'head-to-toe': 25,
    'clean-swap': 25,
    'gift-box': 25,
    'coconut-deodorant-4-pack': 168,
    // Lowered 183 -> 135 on 2026-08-30, and this is the ONE entry that has ever
    // moved down. Toothpaste went 61 -> 45 d/unit when the merchant replaced the
    // last gap-derived rate. The floor is lowered deliberately and only after
    // checking that no live claim depended on the old figure: this bundle
    // carries no `bundle.duration_days` metafield, so nothing on the storefront
    // asserted 183 days. A future drop with a live claim behind it must fix the
    // claim, not this number.
    'coconut-toothpaste-3-pack': 135,
  };
  for (const [handle, floor] of Object.entries(expectedFloor)) {
    const b = bundles.find((x) => x.handle === handle);
    if (!b?.variants?.[0]?.components) continue;
    const r = bindingDuration(b.variants[0].components);
    assert.ok(r.days >= floor, `${handle}: ${r.days}d is below the recorded ${floor}d`);
  }
});
