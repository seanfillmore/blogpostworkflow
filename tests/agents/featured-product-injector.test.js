import { strict as assert } from 'assert';
import { test } from 'node:test';
import {
  findPrimaryProduct,
  renderStars,
  removeMidArticleCta,
  findInsertionPoint,
  buildFeaturedProductHtml,
  rankLinkedProducts,
  rankProductsByRelevance,
  pickRelevantProduct,
  buildCtaCopy,
  linkedProductCounts,
} from '../../agents/featured-product-injector/index.js';

// ── rankProductsByRelevance: score the whole catalog vs the post ──────────────
const CATALOG = [
  { handle: 'coconut-oil-deodorant', title: 'Coconut Oil Deodorant', tags: 'deodorant,aluminum free', product_type: 'Deodorant' },
  { handle: 'coconut-lotion', title: 'Coconut Body Lotion', tags: 'lotion,body,moisturizer', product_type: 'Lotion' },
  { handle: 'coconut-oil-toothpaste', title: 'Coconut Oil Toothpaste', tags: 'toothpaste,fluoride free', product_type: 'Toothpaste' },
];

test('rankProductsByRelevance ranks the most topically relevant product first', () => {
  const ranked = rankProductsByRelevance(CATALOG, { keyword: 'natural body lotion', title: 'Best Natural Body Lotion for Dry Skin' });
  assert.equal(ranked[0].product.handle, 'coconut-lotion');
  assert.ok(ranked[0].relevance > 0);
  // every product is scored (relevance-0 entries are retained, just last)
  assert.equal(ranked.length, 3);
});

test('pickRelevantProduct returns the best match when something is relevant', () => {
  const p = pickRelevantProduct(CATALOG, { keyword: 'aluminum free deodorant', title: 'Switching to Natural Deodorant' });
  assert.equal(p.handle, 'coconut-oil-deodorant');
});

test('pickRelevantProduct returns null when nothing in the catalog is relevant', () => {
  // off-scope topic with zero token overlap → hold for review, do not force a random product
  assert.equal(pickRelevantProduct(CATALOG, { keyword: 'best wireless headphones', title: 'Top Bluetooth Earbuds 2026' }), null);
  assert.equal(pickRelevantProduct([], { keyword: 'anything', title: 'anything' }), null);
});

// findPrimaryProduct: returns the most-linked /products/<handle>
assert.equal(
  findPrimaryProduct('<a href="/products/foo">x</a><a href="/products/foo">x</a><a href="/products/bar">x</a>'),
  'foo'
);
assert.equal(findPrimaryProduct('<p>no links here</p>'), null);
assert.equal(
  findPrimaryProduct('<a href="/collections/foo">x</a>'),
  null
);
// also matches absolute URLs
assert.equal(
  findPrimaryProduct('<a href="https://www.realskincare.com/products/coconut-oil-deodorant">x</a><a href="https://www.realskincare.com/products/coconut-oil-deodorant">x</a>'),
  'coconut-oil-deodorant'
);

// renderStars: rounds to nearest integer, returns ★/☆ string
assert.equal(renderStars(4.8), '★★★★★');
assert.equal(renderStars(4.2), '★★★★☆');
assert.equal(renderStars(3.5), '★★★★☆'); // rounds to 4
assert.equal(renderStars(5),   '★★★★★');

// removeMidArticleCta: strips <section> with border:1px dashed
const withDashed = '<p>before</p><section style="border:1px dashed #ddd;padding:10px"><p>CTA</p></section><p>after</p>';
const withoutDashed = removeMidArticleCta(withDashed);
assert.ok(!withoutDashed.includes('border:1px dashed'), 'dashed section removed');
assert.ok(withoutDashed.includes('<p>before</p>'), 'content before preserved');
assert.ok(withoutDashed.includes('<p>after</p>'), 'content after preserved');

// removeMidArticleCta: no-op when no dashed section
const clean = '<p>just content</p>';
assert.equal(removeMidArticleCta(clean), clean);

// findInsertionPoint: returns index after </p> near target word count
const html = '<p>' + 'word '.repeat(50) + '</p><p>' + 'word '.repeat(50) + '</p>';
const idx = findInsertionPoint(html, 40); // target 40 words
assert.ok(idx > 0, 'returns a positive index');
assert.ok(idx <= html.indexOf('</p>') + 4 + 1, 'inserts after first </p>');

// buildFeaturedProductHtml: contains required fields
const html2 = buildFeaturedProductHtml({
  title: 'My Product',
  handle: 'my-product',
  imageUrl: 'https://cdn.example.com/img.jpg',
  price: '18.99',
  quote: 'Great stuff',
  verified: true,
  stars: '★★★★★',
  reviewCount: 42,
});
assert.ok(html2.includes('rsc-featured-product'), 'has idempotency class');
assert.ok(html2.includes('My Product'), 'has product title');
assert.ok(html2.includes('/products/my-product'), 'has product URL');
assert.ok(html2.includes('Great stuff'), 'has review quote');
assert.ok(html2.includes('$18.99'), 'has price');
assert.ok(html2.includes('★★★★★'), 'has stars');
assert.ok(html2.includes('42 reviews'), 'has review count');
assert.ok(html2.includes('img.jpg'), 'has image');

// buildFeaturedProductHtml: graceful when optional fields missing
const minHtml = buildFeaturedProductHtml({
  title: 'My Product',
  handle: 'my-product',
  imageUrl: null,
  price: null,
  quote: null,
  verified: false,
  stars: null,
  reviewCount: null,
});
assert.ok(minHtml.includes('rsc-featured-product'), 'has class even with missing fields');
assert.ok(!minHtml.includes('<img'), 'no img when imageUrl is null');
assert.ok(!minHtml.includes('reviews'), 'no review count when null');

console.log('✓ featured-product-injector pure function tests pass');

// ── New tests: linkedProductCounts, rankLinkedProducts, buildCtaCopy ──────────

const PRODUCTS = [
  { handle: 'coconut-deodorant', title: 'Coconut Oil Deodorant', tags: ['deodorant', 'aluminum free'], product_type: 'Deodorant' },
  { handle: 'body-lotion', title: 'Non-Toxic Body Lotion', tags: ['lotion'], product_type: 'Lotion' },
];

test('linkedProductCounts: counts product links descending', () => {
  const out = linkedProductCounts('<a href="/products/body-lotion"></a><a href="/products/coconut-deodorant"></a><a href="/products/coconut-deodorant"></a>');
  assert.equal(out[0].handle, 'coconut-deodorant');
  assert.equal(out[0].count, 2);
});

test('rankLinkedProducts: picks product most relevant to the keyword, not most-linked', () => {
  const linked = [{ handle: 'body-lotion', count: 3 }, { handle: 'coconut-deodorant', count: 1 }];
  const ranked = rankLinkedProducts(linked, PRODUCTS, { keyword: 'best natural deodorant', title: 'Best Natural Deodorant for Men' });
  assert.equal(ranked[0].handle, 'coconut-deodorant');
});

test('rankLinkedProducts: tie on relevance falls back to link count', () => {
  const linked = [{ handle: 'body-lotion', count: 1 }, { handle: 'coconut-deodorant', count: 5 }];
  const ranked = rankLinkedProducts(linked, PRODUCTS, { keyword: 'skincare', title: 'Skincare' });
  assert.equal(ranked[0].handle, 'coconut-deodorant');
});

test('rankLinkedProducts: empty linked → []', () => {
  assert.deepEqual(rankLinkedProducts([], PRODUCTS, { keyword: 'x', title: 'y' }), []);
});

test('buildCtaCopy: benefit headline + product-specific button text', () => {
  const c = buildCtaCopy({ product: { title: 'Coconut Oil Deodorant' }, keyword: 'natural deodorant' });
  assert.ok(c.headline.length > 0);
  assert.match(c.buttonText, /shop/i);
});
