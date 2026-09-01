import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  UNIT_PRICE, stackFor, loadVariants, shopifyTitle, slugify,
} from '../../scripts/build-hand-soap-set-stacks.mjs';
import { checkStackConsistency } from '../../lib/bundle-value-stack.js';

// hand-soap-set is a live bundle-landing product whose 12 variants carried NO
// value_stack, so "What's in the box" rendered as an empty padded band.

test('the lotion scent comes from the ROSTER, never from the variant title', () => {
  // "3 pumps + body lotion / Orange Zest" contains a PURE UNSCENTED lotion —
  // there is no orange zest lotion in the catalogue. Reading the scent off the
  // title would put a product on the page that RSC does not sell.
  const v = loadVariants().find((x) => x.options.Configuration === '3 pumps + body lotion'
    && x.options.Scent === 'Orange Zest');
  const lotion = stackFor(v).find((r) => r.label.startsWith('Body Lotion'));
  assert.equal(lotion.scent, 'Pure Unscented');
  assert.equal(lotion.img, 'component-lotion-pure-unscented.webp');
});

test('the Coconut Breeze tier is the one that really does take a matching lotion', () => {
  const v = loadVariants().find((x) => x.options.Configuration === '3 pumps + body lotion'
    && x.options.Scent === 'Coconut Breeze');
  const lotion = stackFor(v).find((r) => r.label.startsWith('Body Lotion'));
  assert.equal(lotion.scent, 'Coconut Breeze', 'this one is not a Pure Unscented substitution');
});

test('every variant reconciles to its own compare-at price', () => {
  // 4x13=52, 3x13+30=69, 4x13+30=82. This is the invariant check-value-stacks
  // enforces store-wide; a stack that misses it overstates or understates the box.
  for (const v of loadVariants()) {
    const stack = stackFor(v);
    const r = checkStackConsistency({
      stack, compareAtPrice: v.compareAtPrice, price: v.price,
    });
    assert.ok(r.ok, `${shopifyTitle(v)}: ${r.problems.join('; ')}`);
    assert.equal(r.total, v.compareAtPrice);
  }
});

test('a component with no known unit price throws instead of pricing at zero', () => {
  // Silently amounting to 0 would still satisfy nothing and would ship a box
  // whose stated value is short by a whole product.
  assert.throws(
    () => stackFor({ components: [{ product: 'mystery-item', variant: 'X', qty: 1 }] }),
    /no unit price/,
  );
});

test('image filenames are derived from the component scent', () => {
  assert.equal(slugify('Calming Lavender'), 'calming-lavender');
  assert.equal(slugify('Pure Unscented'), 'pure-unscented');
  const v = loadVariants().find((x) => x.options.Configuration === '4 pumps'
    && x.options.Scent === 'Calming Lavender');
  assert.equal(stackFor(v)[0].img, 'component-handsoap-calming-lavender.webp');
});

test('all 12 variants are covered and every row carries an image', () => {
  const vs = loadVariants();
  assert.equal(vs.length, 12);
  for (const v of vs) {
    const stack = stackFor(v);
    assert.ok(stack.length >= 1);
    // whats-in-it wraps the WHOLE card in `{%- if row.img -%}`, so a row without
    // an image renders nothing at all — it would silently vanish from the box.
    for (const r of stack) assert.match(r.img, /^component-[a-z]+-[a-z-]+\.webp$/, `${shopifyTitle(v)}: ${r.label}`);
  }
});

test('quantities carry through to the amount', () => {
  const v = loadVariants().find((x) => x.options.Configuration === '4 pumps'
    && x.options.Scent === 'Orange Zest');
  const [soap] = stackFor(v);
  assert.equal(soap.qty, 4);
  assert.equal(soap.amount, 4 * UNIT_PRICE['organic-foaming-hand-soap']);
});
