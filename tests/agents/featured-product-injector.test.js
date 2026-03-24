import { strict as assert } from 'assert';
import {
  findPrimaryProduct,
  renderStars,
  removeMidArticleCta,
  findInsertionPoint,
  buildFeaturedProductHtml,
} from '../../agents/featured-product-injector/index.js';

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
