import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { classifyCollectionHealth } from '../../lib/collection-health.js';

const base = { baseUrl: 'https://www.realskincare.com' };

test('empty: published collection with 0 products is flagged empty', () => {
  const { empty, orphan } = classifyCollectionHealth(
    [{ handle: 'ghost', published: true, productCount: 0, hasInlinks: true }], base);
  assert.equal(empty.length, 1);
  assert.equal(orphan.length, 0);
  assert.equal(empty[0].url, 'https://www.realskincare.com/collections/ghost');
});

test('orphan: populated collection with no inlinks is flagged orphan', () => {
  const { empty, orphan } = classifyCollectionHealth(
    [{ handle: 'lonely', published: true, productCount: 5, hasInlinks: false }], base);
  assert.equal(empty.length, 0);
  assert.equal(orphan.length, 1);
  assert.equal(orphan[0].product_count, 5);
});

test('healthy: populated + linked collection is flagged neither', () => {
  const { empty, orphan } = classifyCollectionHealth(
    [{ handle: 'good', published: true, productCount: 3, hasInlinks: true }], base);
  assert.deepEqual([empty.length, orphan.length], [0, 0]);
});

test('emptiness takes precedence over orphan (empty + no inlinks → empty only)', () => {
  const { empty, orphan } = classifyCollectionHealth(
    [{ handle: 'both', published: true, productCount: 0, hasInlinks: false }], base);
  assert.equal(empty.length, 1);
  assert.equal(orphan.length, 0);
});

test('unpublished collections are ignored entirely', () => {
  const { empty, orphan } = classifyCollectionHealth(
    [{ handle: 'draft', published: false, productCount: 0, hasInlinks: false }], base);
  assert.deepEqual([empty.length, orphan.length], [0, 0]);
});

test('baseUrl trailing slash is normalized', () => {
  const { empty } = classifyCollectionHealth(
    [{ handle: 'x', published: true, productCount: 0, hasInlinks: true }], { baseUrl: 'https://shop.com/' });
  assert.equal(empty[0].url, 'https://shop.com/collections/x');
});

test('empty/nullish input is safe', () => {
  assert.deepEqual(classifyCollectionHealth(null, base), { empty: [], orphan: [] });
  assert.deepEqual(classifyCollectionHealth([], base), { empty: [], orphan: [] });
});

test('mixed batch classifies each correctly', () => {
  const { empty, orphan } = classifyCollectionHealth([
    { handle: 'e1', published: true, productCount: 0, hasInlinks: true },
    { handle: 'o1', published: true, productCount: 2, hasInlinks: false },
    { handle: 'ok', published: true, productCount: 2, hasInlinks: true },
    { handle: 'draft', published: false, productCount: 0, hasInlinks: false },
  ], base);
  assert.deepEqual(empty.map((e) => e.title), ['e1']);
  assert.deepEqual(orphan.map((o) => o.title), ['o1']);
});
