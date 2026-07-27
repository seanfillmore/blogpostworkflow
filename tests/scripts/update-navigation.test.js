import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripCollectionChildren, retargetToPdp } from '../../scripts/update-navigation.mjs';

const header = [
  { id: 'gid://1', title: 'Lotion', type: 'PRODUCT', url: '/products/coconut-lotion', items: [
    { id: 'gid://11', title: 'Rose Lotion', type: 'COLLECTION', url: '/collections/rose-lotion', items: [] },
    { id: 'gid://12', title: 'Unscented', type: 'COLLECTION', url: '/collections/unscented-lotion', items: [] },
  ] },
  { id: 'gid://2', title: 'Toothpaste', type: 'PRODUCT', url: '/products/coconut-oil-toothpaste', items: [
    { id: 'gid://21', title: 'Mint', type: 'COLLECTION', url: '/collections/mint-toothpaste', items: [] },
  ] },
];

test('stripCollectionChildren removes every child while preserving top-level items', () => {
  const out = stripCollectionChildren(header);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((i) => i.url),
    ['/products/coconut-lotion', '/products/coconut-oil-toothpaste']);
  assert.ok(out.every((i) => (i.items || []).length === 0), 'no dropdowns may remain');
});

test('stripCollectionChildren keeps children that are not collections', () => {
  const mixed = [{ id: 'a', title: 'More', type: 'HTTP', url: '/pages/x', items: [
    { id: 'b', title: 'FAQ', type: 'PAGE', url: '/pages/faq', items: [] },
    { id: 'c', title: 'Rose', type: 'COLLECTION', url: '/collections/rose-lotion', items: [] },
  ] }];
  const out = stripCollectionChildren(mixed);
  assert.equal(out[0].items.length, 1);
  assert.equal(out[0].items[0].url, '/pages/faq');
});

test('stripCollectionChildren preserves a child pointing at a survivor', () => {
  const m = [{ id: 'a', title: 'Shop', type: 'HTTP', url: '/collections', items: [
    { id: 'b', title: 'Hand Soap', type: 'COLLECTION', url: '/collections/foaming-hand-soap', items: [] },
    { id: 'c', title: 'Rose', type: 'COLLECTION', url: '/collections/rose-lotion', items: [] },
  ] }];
  const out = stripCollectionChildren(m);
  assert.equal(out[0].items.length, 1);
  assert.equal(out[0].items[0].url, '/collections/foaming-hand-soap');
});

test('retargetToPdp rewrites mapped collection links and leaves others alone', () => {
  const sidebar = [
    { id: 's1', title: 'Deodorant', type: 'COLLECTION', url: '/collections/natural-deodorant', items: [] },
    { id: 's2', title: 'Hand Soap', type: 'COLLECTION', url: '/collections/foaming-hand-soap', items: [] },
  ];
  const out = retargetToPdp(sidebar, { '/collections/natural-deodorant': '/products/coconut-oil-deodorant' });
  assert.equal(out[0].url, '/products/coconut-oil-deodorant');
  assert.equal(out[0].type, 'PRODUCT');
  assert.equal(out[1].url, '/collections/foaming-hand-soap', 'survivor link untouched');
});
