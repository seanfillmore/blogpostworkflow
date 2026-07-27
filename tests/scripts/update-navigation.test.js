import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripCollectionChildren, retargetToPdp, toInput } from '../../scripts/update-navigation.mjs';

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

// Survivors are reachable via /collections (main-menu's Shop item), not via
// header dropdowns — a dropdown with one link in it is still a dropdown, and
// still a click between the visitor and the buy button. Do not "restore" a
// survivor exception here thinking this is a bug; it was removed on purpose.
test('stripCollectionChildren drops a child pointing at a survivor too', () => {
  const m = [{ id: 'a', title: 'Shop', type: 'HTTP', url: '/collections', items: [
    { id: 'b', title: 'Hand Soap', type: 'COLLECTION', url: '/collections/foaming-hand-soap', items: [] },
    { id: 'c', title: 'Rose', type: 'COLLECTION', url: '/collections/rose-lotion', items: [] },
  ] }];
  const out = stripCollectionChildren(m);
  assert.equal(out[0].items.length, 0);
});

// Regression guard for the resourceId bug: menuUpdate replaces the whole
// item tree from what's sent, so a MenuItem tied to a real product/collection
// resource must round-trip its resourceId, and an item with no resource
// (HTTP, PAGE, BLOG) must NOT get an explicit `resourceId: null` — Shopify
// treats "sent as null" differently from "not sent". If this test starts
// failing after an edit to toInput, that edit reintroduced the bug that
// silently severs every nav item's resource association on --apply.
test('toInput preserves resourceId where present and omits the key where absent', () => {
  const items = [
    {
      id: 'gid://shopify/MenuItem/1', title: 'Lotion', type: 'PRODUCT',
      url: '/products/coconut-lotion', resourceId: 'gid://shopify/Product/111',
      items: [],
    },
    {
      id: 'gid://shopify/MenuItem/2', title: 'On Sale', type: 'COLLECTION',
      url: '/collections/on-sale', resourceId: 'gid://shopify/Collection/222',
      items: [],
    },
    {
      id: 'gid://shopify/MenuItem/3', title: 'About Us', type: 'PAGE',
      url: '/pages/about-us', resourceId: null,
      items: [],
    },
  ];
  const out = toInput(items);

  assert.equal(out[0].resourceId, 'gid://shopify/Product/111');
  assert.equal(out[0].id, 'gid://shopify/MenuItem/1');
  assert.equal(out[1].resourceId, 'gid://shopify/Collection/222');

  assert.ok(!('resourceId' in out[2]), 'item with no resource must omit the key, not send null');
});

test('toInput preserves resourceId and id on nested children too', () => {
  const items = [{
    id: 'gid://shopify/MenuItem/10', title: 'Shop', type: 'HTTP', url: '/collections',
    resourceId: null,
    items: [
      { id: 'gid://shopify/MenuItem/11', title: 'On Sale', type: 'COLLECTION',
        url: '/collections/on-sale', resourceId: 'gid://shopify/Collection/222', items: [] },
    ],
  }];
  const out = toInput(items);
  const child = out[0].items[0];
  assert.equal(child.id, 'gid://shopify/MenuItem/11');
  assert.equal(child.resourceId, 'gid://shopify/Collection/222');
  assert.ok(!('resourceId' in out[0]), 'parent with no resource must omit the key, not send null');
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
