import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { validateDecide, validateGenerate } from '../../agents/dashboard/routes/ad-brief.js';

const PRODUCTS = [{ handle: 'coconut-lotion' }, { handle: 'coconut-soap' }];

test('a well-formed decision is accepted', () => {
  const r = validateDecide({ product: 'coconut-lotion', briefId: 'coconut-lotion-p1a1-1', state: 'approved' }, { products: PRODUCTS });
  assert.equal(r.ok, true);
});

test('an unknown state is refused', () => {
  assert.equal(validateDecide({ product: 'coconut-lotion', briefId: 'b1', state: 'shipped' }, { products: PRODUCTS }).ok, false);
});

test('a traversal product or brief id is refused', () => {
  assert.equal(validateDecide({ product: '../etc', briefId: 'b1', state: 'approved' }, { products: PRODUCTS }).ok, false);
  assert.equal(validateDecide({ product: 'coconut-lotion', briefId: '../../x', state: 'approved' }, { products: PRODUCTS }).ok, false);
});

test('an unknown product is refused', () => {
  assert.equal(validateDecide({ product: 'not-a-product', briefId: 'b1', state: 'approved' }, { products: PRODUCTS }).ok, false);
});

test('generate requires a known product', () => {
  assert.equal(validateGenerate({ product: 'coconut-lotion' }, { products: PRODUCTS }).ok, true);
  assert.equal(validateGenerate({ product: 'nope' }, { products: PRODUCTS }).ok, false);
  assert.equal(validateGenerate({}, { products: PRODUCTS }).ok, false);
});

test('generate normalises an angle list and refuses a malformed one', () => {
  assert.deepEqual(validateGenerate({ product: 'coconut-lotion', angles: ['p1a1', ' p5a3 '] }, { products: PRODUCTS }).args.angles, ['p1a1', 'p5a3']);
  assert.equal(validateGenerate({ product: 'coconut-lotion', angles: ['../x'] }, { products: PRODUCTS }).ok, false);
});
