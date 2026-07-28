import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stripCollectionChildren, retargetToPdp, toInput, buildRetargetMap,
  retargetShopToAllCollections, withSetsAndBundlesItem,
} from '../../scripts/update-navigation.mjs';

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
    { id: 's1', title: 'Deodorant', type: 'COLLECTION', url: '/collections/natural-deodorant',
      resourceId: 'gid://shopify/Collection/999', items: [] },
    { id: 's2', title: 'Hand Soap', type: 'COLLECTION', url: '/collections/foaming-hand-soap', items: [] },
  ];
  const map = {
    '/collections/natural-deodorant': { to: '/products/coconut-oil-deodorant', resourceId: 'gid://shopify/Product/123' },
  };
  const out = retargetToPdp(sidebar, map);
  assert.equal(out[0].url, '/products/coconut-oil-deodorant');
  assert.equal(out[0].type, 'PRODUCT');
  assert.equal(out[0].resourceId, 'gid://shopify/Product/123');
  assert.equal(out[1].url, '/collections/foaming-hand-soap', 'survivor link untouched');
});

// Regression guard for the critical defect: `{...it, url: to, type: 'PRODUCT'}`
// preserved the item's ORIGINAL Collection resourceId, sending Shopify a
// mismatched {type: PRODUCT, resourceId: gid://shopify/Collection/…} pair for
// every sidebar item. A retargeted item must carry the destination product's
// GID (or none at all) — never a Collection GID.
test('a retargeted item never carries a Collection GID', () => {
  const sidebar = [
    { id: 's1', title: 'Deodorant', type: 'COLLECTION', url: '/collections/natural-deodorant',
      resourceId: 'gid://shopify/Collection/153343066147', items: [] },
  ];
  const map = {
    '/collections/natural-deodorant': { to: '/products/coconut-oil-deodorant', resourceId: 'gid://shopify/Product/7644970451114' },
  };
  const out = retargetToPdp(sidebar, map);
  assert.equal(out[0].type, 'PRODUCT');
  assert.ok(!String(out[0].resourceId).includes('Collection'), 'retargeted item must not carry a Collection GID');
  assert.equal(out[0].resourceId, 'gid://shopify/Product/7644970451114');
});

test('buildRetargetMap resolves each destination PDP to its product GID', async () => {
  const fetchProducts = async () => [
    { id: 111, handle: 'coconut-oil-deodorant' },
    { id: 222, handle: 'coconut-lotion' },
  ];
  const map = await buildRetargetMap(
    { '/collections/natural-deodorant': '/products/coconut-oil-deodorant' },
    fetchProducts,
  );
  assert.deepEqual(map['/collections/natural-deodorant'], {
    to: '/products/coconut-oil-deodorant',
    resourceId: 'gid://shopify/Product/111',
  });
});

test('buildRetargetMap throws rather than silently omitting resourceId for a missing product', async () => {
  const fetchProducts = async () => [{ id: 111, handle: 'some-other-product' }];
  await assert.rejects(
    () => buildRetargetMap({ '/collections/natural-deodorant': '/products/coconut-oil-deodorant' }, fetchProducts),
    /no product found/,
  );
});

test('retargetShopToAllCollections retargets a top-level COLLECTION item to the native index', () => {
  const items = [
    { id: 'm1', title: 'Shop', type: 'COLLECTION', url: '/collections/live-collection',
      resourceId: 'gid://shopify/Collection/296983789738',
      items: [{ id: 'c1', title: 'Lotion', type: 'PRODUCT', url: '/products/coconut-lotion', items: [] }] },
    { id: 'm2', title: 'About', type: 'PAGE', url: '/pages/about-us-1', items: [] },
  ];
  const out = retargetShopToAllCollections(items);
  assert.equal(out[0].type, 'COLLECTIONS');
  assert.equal(out[0].url, '/collections');
  assert.ok(!('resourceId' in out[0]), 'must not carry the old Collection GID');
  assert.equal(out[0].items.length, 1, 'children are untouched');
  assert.equal(out[1].type, 'PAGE', 'non-collection items are untouched');
});

test('withSetsAndBundlesItem appends a top-level item with the collection resourceId', () => {
  const items = [{ id: 'p1', title: 'Lotion', type: 'PRODUCT', url: '/products/coconut-lotion', items: [] }];
  const out = withSetsAndBundlesItem(items, 'gid://shopify/Collection/999');
  assert.equal(out.length, 2);
  assert.equal(out[1].title, 'Sets & Bundles');
  assert.equal(out[1].type, 'COLLECTION');
  assert.equal(out[1].url, '/collections/sets-and-bundles');
  assert.equal(out[1].resourceId, 'gid://shopify/Collection/999');
  assert.ok(!('id' in out[1]), 'a brand-new item must have no id so menuUpdate creates it');
});

test('withSetsAndBundlesItem is a no-op when the collection GID is not resolved yet', () => {
  const items = [{ id: 'p1', title: 'Lotion', type: 'PRODUCT', url: '/products/coconut-lotion', items: [] }];
  const out = withSetsAndBundlesItem(items, null);
  assert.equal(out, items, 'must return the same reference so the caller can detect the no-op');
});

test('toInput omits id for a brand-new item so menuUpdate creates it', () => {
  const items = [
    { title: 'Sets & Bundles', type: 'COLLECTION', url: '/collections/sets-and-bundles',
      resourceId: 'gid://shopify/Collection/999', items: [] },
  ];
  const out = toInput(items);
  assert.ok(!('id' in out[0]), 'no id must be sent for a new item');
  assert.equal(out[0].resourceId, 'gid://shopify/Collection/999');
});
