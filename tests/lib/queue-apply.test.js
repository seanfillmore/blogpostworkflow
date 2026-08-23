import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planCollectionGap, matchProductsForGap, publishCollectionGap, fixUnclosedHtml, isArticleGoneError,
} from '../../lib/queue-apply.js';

// A body long enough to clear validateCollectionSpec's 300-word floor.
const FAT_BODY = `<p>${'clean coconut oil toothpaste without sulfates '.repeat(60)}</p>`;

const PRODUCTS = [
  { id: 1, title: 'Coconut Oil Toothpaste — Mint', handle: 'coconut-oil-toothpaste', tags: 'toothpaste,sls free' },
  { id: 2, title: 'Coconut Oil Toothpaste — Cinnamon', handle: 'coconut-oil-toothpaste-cinnamon', tags: 'toothpaste,sls free' },
  { id: 3, title: 'Coconut Oil Deodorant', handle: 'coconut-oil-deodorant', tags: 'deodorant' },
];

const gapItem = (over = {}) => ({
  slug: 'sls-free-toothpaste',
  trigger: 'collection-gap',
  signal_source: { keyword: 'sls free toothpaste' },
  proposed_collection: {
    title: 'SLS Free Toothpaste',
    handle: 'sls-free-toothpaste',
    seo_title: 'SLS Free Toothpaste — Gentle Natural Oral Care',
    seo_description: 'Toothpaste without sodium lauryl sulfate, made with organic coconut oil for people whose mouths react to foaming detergents.',
    body_html: FAT_BODY,
  },
  ...over,
});

// ── the three Prime-Directive defects the approve path shipped with ──────────

test('a collection with fewer than 2 matching products is refused, not created', () => {
  // The old route built `collects` from the match and proceeded even when the
  // match was EMPTY, publishing a live collection page holding nothing.
  const onlyOne = [PRODUCTS[0], PRODUCTS[2]];
  const plan = planCollectionGap(gapItem(), onlyOne);
  assert.equal(plan.ok, false);
  assert.match(plan.errors.join(' '), /only 1 distinct product/);

  const none = planCollectionGap(gapItem({ signal_source: { keyword: 'lip scrub exfoliant' } }), PRODUCTS);
  assert.equal(none.ok, false);
  assert.match(none.errors.join(' '), /only 0 distinct products/);
});

test('two or more matching products clears the product gate', () => {
  const plan = planCollectionGap(gapItem(), PRODUCTS);
  assert.equal(plan.ok, true, plan.errors.join('; '));
  assert.equal(plan.matched.length, 2);
});

test('the collection is created as a DRAFT, matching the agent path', async () => {
  // agents/collection-creator has always passed published:false; this path
  // omitted it, so Approve put an unreviewed page straight into the index.
  const calls = [];
  const deps = {
    createCustomCollection: async (fields) => { calls.push(fields); return { id: 99 }; },
    upsertMetafield: async (...a) => { calls.push(a); },
  };
  const res = await publishCollectionGap(gapItem(), deps, { products: PRODUCTS });
  assert.equal(calls[0].published, false, 'must be created as a draft');
  assert.deepEqual(calls[0].collects, [{ product_id: 1 }, { product_id: 2 }]);
  assert.equal(res.draft, true);
  assert.equal(res.matched, 2);
});

test('an invalid spec is refused before any Shopify call', async () => {
  // "DISQUALIFIED" is a real sentinel that reached the live queue directory.
  let created = false;
  const deps = { createCustomCollection: async () => { created = true; return { id: 1 }; }, upsertMetafield: async () => {} };
  const bad = gapItem({ proposed_collection: { ...gapItem().proposed_collection, title: 'DISQUALIFIED' } });
  await assert.rejects(() => publishCollectionGap(bad, deps, { products: PRODUCTS }), /Refusing to create collection.*sentinel/s);
  assert.equal(created, false, 'nothing may be written to Shopify when the spec is invalid');
});

test('a thin body is refused', () => {
  const thin = gapItem({ proposed_collection: { ...gapItem().proposed_collection, body_html: '<p>Buy toothpaste.</p>' } });
  const plan = planCollectionGap(thin, PRODUCTS);
  assert.equal(plan.ok, false);
  assert.match(plan.errors.join(' '), /too thin/);
});

test('a duplicate handle is refused when the existing handles are known', () => {
  const plan = planCollectionGap(gapItem(), PRODUCTS, { existingHandles: new Set(['sls-free-toothpaste']) });
  assert.equal(plan.ok, false);
  assert.match(plan.errors.join(' '), /already exists/);
});

test('a missing proposed_collection is an error, not a crash', () => {
  const plan = planCollectionGap({ slug: 'x', trigger: 'collection-gap' }, PRODUCTS);
  assert.equal(plan.ok, false);
  assert.match(plan.errors.join(' '), /No proposed_collection/);
});

// ── the product matcher ──────────────────────────────────────────────────────

test('matching is every-word across title, handle and tags', () => {
  assert.equal(matchProductsForGap({ signal_source: { keyword: 'coconut oil' } }, PRODUCTS).length, 3);
  assert.equal(matchProductsForGap({ signal_source: { keyword: 'sls free' } }, PRODUCTS).length, 2);
  assert.equal(matchProductsForGap({ signal_source: { keyword: 'griddle' } }, PRODUCTS).length, 0);
});

test('matching with no keyword at all matches nothing, rather than everything', () => {
  assert.deepEqual(matchProductsForGap({}, PRODUCTS), []);
  assert.deepEqual(matchProductsForGap({ signal_source: { keyword: '   ' } }, PRODUCTS), []);
  assert.deepEqual(matchProductsForGap(null, PRODUCTS), []);
});

test('the matcher tolerates a product with no tags', () => {
  const res = matchProductsForGap({ signal_source: { keyword: 'coconut' } }, [{ id: 1, title: 'Coconut Soap', handle: 'coconut-soap' }]);
  assert.equal(res.length, 1);
});

// ── carried-over helpers ─────────────────────────────────────────────────────

test('fixUnclosedHtml closes truncated tags and leaves void tags alone', () => {
  assert.equal(fixUnclosedHtml('<p>hi'), '<p>hi</p>');
  assert.equal(fixUnclosedHtml('<p>hi</p>'), '<p>hi</p>');
  assert.equal(fixUnclosedHtml('<p>a<br>b'), '<p>a<br>b</p>');
});

test('isArticleGoneError still separates a deleted article from a transient failure', () => {
  assert.equal(isArticleGoneError(new Error('HTTP 404: {"errors":"Not Found"}')), true);
  assert.equal(isArticleGoneError(new Error('HTTP 500')), false);
  assert.equal(isArticleGoneError(null), false);
});
