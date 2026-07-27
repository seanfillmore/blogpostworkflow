import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { validateRoster, SKU_BY_HANDLE } from '../../lib/bundle-roster.js';

const CATALOGUE = {
  'coconut-lotion': ['Pure Unscented', 'Coconut Breeze', 'Calming Lavender'],
  'coconut-oil-deodorant': ['Geranium Flower', 'Calming Lavender'],
  'coconut-soap': ['Calming Lavender', 'Pure Unscented'],
};

const bundle = (over = {}) => ({
  handle: 'test-bundle', title: 'Test Bundle', status: 'live', packaging: 0,
  options: [{ name: 'Kit', values: ['Gentle'] }],
  variants: [{
    options: { Kit: 'Gentle' }, price: 59, compareAtPrice: 69, contents: '1 × lotion',
    components: [{ product: 'coconut-lotion', variant: 'Pure Unscented', qty: 1 }],
  }],
  ...over,
});

test('a well-formed bundle validates clean', () => {
  assert.deepEqual(validateRoster({ bundles: [bundle()] }, CATALOGUE), []);
});

test('an unknown component product is rejected', () => {
  const bad = bundle({ variants: [{ ...bundle().variants[0],
    components: [{ product: 'nonexistent-product', variant: 'Pure Unscented', qty: 1 }] }] });
  const errs = validateRoster({ bundles: [bad] }, CATALOGUE);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /nonexistent-product/);
});

test('an unknown variant title is rejected — this is the typo that ships the wrong box', () => {
  const bad = bundle({ variants: [{ ...bundle().variants[0],
    components: [{ product: 'coconut-lotion', variant: 'Unscented', qty: 1 }] }] });
  const errs = validateRoster({ bundles: [bad] }, CATALOGUE);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /Unscented/);
});

test('lotion outside the two-scent rule is rejected', () => {
  const bad = bundle({ variants: [{ ...bundle().variants[0],
    components: [{ product: 'coconut-lotion', variant: 'Calming Lavender', qty: 1 }] }] });
  const errs = validateRoster({ bundles: [bad] }, CATALOGUE);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /two-scent rule/);
});

test('a variant whose options do not match the declared option values is rejected', () => {
  const bad = bundle({ variants: [{ ...bundle().variants[0], options: { Kit: 'Bold' } }] });
  const errs = validateRoster({ bundles: [bad] }, CATALOGUE);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /Bold/);
});

test('duplicate handles are rejected', () => {
  const errs = validateRoster({ bundles: [bundle(), bundle()] }, CATALOGUE);
  assert.ok(errs.some(e => /duplicate handle/i.test(e)));
});

test('every component handle maps to a known SKU key', () => {
  for (const key of Object.values(SKU_BY_HANDLE)) {
    assert.ok(typeof key === 'string' && key.length, `bad SKU key: ${key}`);
  }
  assert.equal(SKU_BY_HANDLE['organic-foaming-hand-soap'], 'pump');
  assert.equal(SKU_BY_HANDLE['coconut-soap'], 'barsoap');
});
