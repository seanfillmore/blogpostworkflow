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

// ── product-category accuracy in the buy box ──────────────────────────────────
//
// This headline names OUR product, so the target keyword cannot be pasted into it
// unexamined. Two live articles carried `Our pick for travel size antiperspirant:
// Best Coconut Oil Deodorant` on 2026-08-24 — a cosmetic described with an OTC drug
// category name, inside the conversion path, regenerated on every injector run.

test('buildCtaCopy: rewrites an antiperspirant keyword to the accurate category', () => {
  const c = buildCtaCopy({
    product: { title: 'Best Coconut Oil Deodorant — All Natural Formula | 2oz' },
    keyword: 'travel size antiperspirant',
  });
  assert.equal(
    c.headline,
    'Our pick for travel size deodorant: Best Coconut Oil Deodorant — All Natural Formula | 2oz',
  );
  assert.doesNotMatch(c.headline, /antiperspirant/i);
});

test('buildCtaCopy: reproduces the exact live defect and its fix', () => {
  const c = buildCtaCopy({
    product: { title: 'Best Coconut Oil Deodorant — All Natural Formula | 2oz' },
    keyword: 'aluminum free antiperspirant what it is does it work',
  });
  assert.doesNotMatch(c.headline, /antiperspirant/i);
  assert.match(c.headline, /aluminum free deodorant what it is does it work/);
});

test('buildCtaCopy: an ordinary keyword is byte-identical after sanitizing', () => {
  const c = buildCtaCopy({ product: { title: 'Coconut Oil Deodorant' }, keyword: 'best natural deodorant for men' });
  assert.equal(c.headline, 'Our pick for best natural deodorant for men: Coconut Oil Deodorant');
});

test('buildCtaCopy: sanitizing never removes the buy box (no throw, no empty headline)', () => {
  for (const keyword of ['antiperspirant', 'antiperspirants', undefined, '', null]) {
    const c = buildCtaCopy({ product: { title: 'Coconut Oil Deodorant' }, keyword });
    assert.ok(c.headline.length > 0);
    assert.ok(c.buttonText.length > 0);
  }
});

// ── variant titles are part of what a product IS ─────────────────────────────
// RSC sells scents as VARIANTS, not products: "Nourishing Tea Tree" is a variant
// of "Moisturizing Coconut Soap". The haystack was built from title + handle +
// tags + product_type only, so an entire scent line was invisible to the matcher.
//
// Live consequence (2026-08-29): the tea-tree post — 5,744 impressions, live and
// indexed — scored 0 against all 20 products, so pickRelevantProduct returned
// null, featured-product-injector reported "no relevant product", and the
// publisher blocked it every morning. Measured against the real catalogue, the
// two bar soaps that carry the Tea Tree variant go 0 -> matched.

const VARIANT_CATALOG = [
  { handle: 'coconut-lotion', title: 'Non-Toxic Body Lotion', tags: 'lotion,body', product_type: 'Lotion',
    variants: [{ title: 'Default Title' }] },
  { handle: 'coconut-soap', title: 'Moisturizing Coconut Soap', tags: 'bar soap', product_type: 'Bar Soap',
    variants: [{ title: 'Pure Unscented' }, { title: 'Nourishing Tea Tree' }, { title: 'Calming Lavender' }] },
  { handle: 'coconut-oil-toothpaste', title: 'Coconut Oil Toothpaste', tags: 'toothpaste', product_type: 'Toothpaste',
    variants: [{ title: 'Default Title' }] },
];

test('a scent sold as a VARIANT is findable — the tea-tree case', () => {
  const p = pickRelevantProduct(VARIANT_CATALOG, {
    keyword: '',
    title: '11 Benefits of Incorporating Tea Tree Oil Into Your Everyday Life',
  });
  assert.ok(p, 'must not return null — the catalogue does carry a tea tree product');
  assert.equal(p.handle, 'coconut-soap');
});

test('a variant match NEVER outranks a real title/tag match', () => {
  // The regression this weighting exists to prevent: every soap has a "Pure
  // Unscented" variant, so an unscented-LOTION post must still get the lotion.
  const ranked = rankProductsByRelevance(VARIANT_CATALOG, {
    keyword: 'best unscented lotion',
    title: 'Best Unscented Lotion for Sensitive Skin',
  });
  assert.equal(ranked[0].product.handle, 'coconut-lotion');
});

test('"Default Title" is not a token — it is Shopify padding, not a scent', () => {
  const ranked = rankProductsByRelevance(VARIANT_CATALOG, { keyword: 'default title', title: 'Default Title' });
  assert.equal(ranked[0].relevance, 0, 'nothing may match on Shopify\'s placeholder variant name');
});

test('a product with no variants array still ranks exactly as before', () => {
  const noVariants = VARIANT_CATALOG.map(({ variants, ...p }) => p);
  const before = rankProductsByRelevance(noVariants, { keyword: 'toothpaste', title: 'Fluoride Free Toothpaste' });
  assert.equal(before[0].product.handle, 'coconut-oil-toothpaste');
  assert.ok(before[0].relevance > 0);
});

test('rankLinkedProducts sees variant titles too', () => {
  const linked = [{ handle: 'coconut-soap', count: 1 }, { handle: 'coconut-oil-toothpaste', count: 9 }];
  const ranked = rankLinkedProducts(linked, VARIANT_CATALOG, { keyword: '', title: 'Tea Tree Benefits' });
  // Relevance beats raw link count: the soap is linked once, the toothpaste nine
  // times, and the soap still wins because "tea tree" names one of its variants.
  assert.equal(ranked[0].handle, 'coconut-soap');
  assert.ok(ranked[0].relevance > 0, 'the variant is what makes it relevant at all');
});

test('rankLinkedProducts does NOT strip brand-ubiquitous tokens, and that is unchanged', () => {
  // Unlike the catalogue matcher, this one scores on raw tokens — so "oil" is a
  // real match for the toothpaste. Pinned because the variant bonus must not
  // quietly change which matcher strips what.
  const linked = [{ handle: 'coconut-soap', count: 1 }, { handle: 'coconut-oil-toothpaste', count: 9 }];
  const ranked = rankLinkedProducts(linked, VARIANT_CATALOG, { keyword: '', title: 'Tea Tree Oil Benefits' });
  assert.equal(ranked[0].handle, 'coconut-oil-toothpaste', 'matched "oil" on the title, then won on link count');
});

// ── publisher_block is set but was never cleared by anything ─────────────────
// `meta.publisher_block` is written here and READ only by agents/publisher.
// Nothing in the fleet ever removed one, so a post held for "no relevant
// product" stayed held forever — even after the reason stopped being true.
//
// That is what kept the tea-tree post failing every morning: the catalogue does
// carry a tea tree product, the matcher simply could not see a variant title
// (fixed separately). Without this, fixing the matcher unblocks nothing.
//
// It clears only a block THIS agent set. Another agent's hold is not ours to lift.

import { resolvePublisherBlock } from '../../agents/featured-product-injector/index.js';

const OURS = { flagged_by: 'featured-product-injector', reason: 'no relevant product to feature — off product scope; holding for review' };
const THEIRS = { flagged_by: 'editor', reason: 'unsourced health claim' };

test('a successful injection clears the block this agent set', () => {
  const d = resolvePublisherBlock(OURS, { skipped: false, productTitle: 'Coconut Bar Soap' });
  assert.equal(d.action, 'clear');
});

test('a successful injection does NOT clear another agent\'s block', () => {
  const d = resolvePublisherBlock(THEIRS, { skipped: false, productTitle: 'Coconut Bar Soap' });
  assert.equal(d.action, 'leave');
});

test('"already has a buy box" clears our block too — the reason is provably false', () => {
  // The post demonstrably carries a featured product, so "no relevant product"
  // cannot be true of it.
  const d = resolvePublisherBlock(OURS, { skipped: true, reason: 'already has rsc-featured-product' });
  assert.equal(d.action, 'clear');
});

test('"no relevant product" still sets the block', () => {
  const d = resolvePublisherBlock(null, { skipped: true, reason: 'no relevant product' });
  assert.equal(d.action, 'set');
  assert.equal(d.block.flagged_by, 'featured-product-injector');
  assert.match(d.block.reason, /off product scope/);
});

test('an inconclusive skip leaves everything alone — it is not evidence either way', () => {
  // Shopify did not return the linked product data. That says nothing about
  // whether a relevant product exists, so it must neither set nor clear.
  const d = resolvePublisherBlock(OURS, { skipped: true, reason: 'no linked product data found in Shopify' });
  assert.equal(d.action, 'leave');
});

test('no block and nothing to set is a no-op, not a write', () => {
  assert.equal(resolvePublisherBlock(null, { skipped: false }).action, 'leave');
  assert.equal(resolvePublisherBlock(undefined, { skipped: true, reason: 'already has rsc-featured-product' }).action, 'leave');
});
