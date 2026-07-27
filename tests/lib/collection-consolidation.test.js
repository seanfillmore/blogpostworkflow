import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SURVIVORS, classifyTarget, buildRedirectPlan } from '../../lib/collection-consolidation.js';

test('survivors classify as null so they are never redirected', () => {
  for (const h of ['non-toxic-body-lotion', 'foaming-hand-soap', 'all-products', 'on-sale']) {
    assert.equal(classifyTarget(h), null, `${h} must survive`);
  }
  assert.equal(SURVIVORS.size, 4);
});

test('lotion-family handles route to the lotion survivor', () => {
  for (const h of ['coconut-oil-lotion', 'vegan-body-lotion', 'coconut-body-cream',
                   'rose-lotion', 'moisturizing-body-cream', 'coconut-body-butter',
                   'coconut-oil-as-moisturizer']) {
    assert.equal(classifyTarget(h), '/collections/non-toxic-body-lotion', h);
  }
});

test('single-SKU categories route to their PDP, not to a collection', () => {
  assert.equal(classifyTarget('cinnamon-toothpaste'), '/products/coconut-oil-toothpaste');
  assert.equal(classifyTarget('sls-free-toothpaste'), '/products/coconut-oil-toothpaste');
  assert.equal(classifyTarget('vegan-deodorant'), '/products/coconut-oil-deodorant');
  assert.equal(classifyTarget('organic-lip-balm'), '/products/coconut-oil-lip-balm');
  assert.equal(classifyTarget('mens-natural-soap'), '/products/coconut-soap');
  assert.equal(classifyTarget('best-soap-for-tattoos'), '/products/coconut-soap');
});

test('hand-soap handles route to the hand-soap survivor, not to the bar-soap PDP', () => {
  assert.equal(classifyTarget('foaming-soap-dispenser'), '/collections/foaming-hand-soap');
});

test('toothpaste wins over soap when a handle could match both', () => {
  // 'sls' and 'mint' are toothpaste markers; ordering must not let a generic rule win first.
  assert.equal(classifyTarget('mint-toothpaste'), '/products/coconut-oil-toothpaste');
});

test('unclassifiable handles fall back to all-products rather than throwing', () => {
  assert.equal(classifyTarget('live-collection'), '/collections/all-products');
  assert.equal(classifyTarget('main-menu-3'), '/collections/all-products');
  assert.equal(classifyTarget('coconut-oil-products'), '/collections/all-products');
});

test('buildRedirectPlan omits survivors and keeps every other collection', () => {
  const input = [
    { handle: 'all-products', id: 1, kind: 'smart', live: true, products: 19 },
    { handle: 'vegan-deodorant', id: 2, kind: 'smart', live: true, products: 1 },
    { handle: 'coconut-body-butter', id: 3, kind: 'custom', live: false, products: 0 },
  ];
  const plan = buildRedirectPlan(input);
  assert.equal(plan.length, 2);
  assert.ok(!plan.some((r) => r.handle === 'all-products'));
  const deo = plan.find((r) => r.handle === 'vegan-deodorant');
  assert.equal(deo.target, '/products/coconut-oil-deodorant');
  assert.equal(deo.live, true);
});

test('buildRedirectPlan never emits a redirect whose source equals its target', () => {
  const plan = buildRedirectPlan([
    { handle: 'non-toxic-body-lotion', id: 9, kind: 'custom', live: true, products: 2 },
  ]);
  assert.deepEqual(plan, []);
});
