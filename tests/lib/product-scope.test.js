import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { isInProductScope, PRODUCT_SCOPE_TERMS } from '../../lib/product-scope.js';

test('isInProductScope: in-scope keyword (deodorant)', () => {
  assert.equal(isInProductScope('best natural deodorant'), true);
});

test('isInProductScope: off-scope keyword (shampoo)', () => {
  assert.equal(isInProductScope('best clarifying shampoo'), false);
});

test('isInProductScope: handles null/empty safely', () => {
  assert.equal(isInProductScope(''), false);
  assert.equal(isInProductScope(null), false);
});

test('PRODUCT_SCOPE_TERMS includes the core categories', () => {
  for (const t of ['deodorant', 'toothpaste', 'lotion', 'soap', 'lip balm', 'coconut oil']) {
    assert.ok(PRODUCT_SCOPE_TERMS.includes(t), `missing ${t}`);
  }
});
