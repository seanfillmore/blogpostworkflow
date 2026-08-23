// tests/agents/llms-txt-generator-selection.test.js
//
// Pure-logic tests for agents/llms-txt-generator/selection.js, extracted
// from index.js (which runs the agent on import — see
// llms-txt-generator-import-safety.test.js) specifically so these two
// already-shipped bugs can be regression-tested without stubbing Shopify,
// GSC, or DataForSEO:
//
//   1. commit 37cd6a72 — blog-post selection checked GSC impressions only
//      and never checked Shopify's published state, so three unpublished
//      posts with stale (pre-unpublish) impressions were cited to AI
//      assistants as canonical sources. Mutation this catches: dropping the
//      `.filter((c) => c.isPublished)` gate from selectBlogPosts() — without
//      it, the "published but low impressions" and "unpublished but plenty
//      of impressions" tests below both pass, silently reintroducing the bug.
//   2. commit d24a670d — the hardcoded catalog-intro sentence named "hair
//      care" among the brand's product lines; RSC sells no hair products.
//      Mutation this catches: reverting BRAND_PRODUCT_LINES in selection.js
//      to include a line the brand doesn't sell.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { truncate, selectBlogPosts, buildCuratedSection, buildTemplate } from '../../agents/llms-txt-generator/selection.js';

// ---------------------------------------------------------------------------
// truncate
// ---------------------------------------------------------------------------

test('truncate strips HTML and collapses whitespace', () => {
  assert.equal(truncate('<p>Hello   <b>world</b></p>'), 'Hello world');
});

test('truncate leaves short text untouched', () => {
  assert.equal(truncate('short'), 'short');
});

test('truncate cuts long text at a word boundary and appends an ellipsis', () => {
  const long = 'word '.repeat(60).trim();
  const result = truncate(long, 20);
  assert.ok(result.length <= 20);
  assert.ok(result.endsWith('…'));
});

test('truncate returns empty string for falsy input', () => {
  assert.equal(truncate(''), '');
  assert.equal(truncate(null), '');
  assert.equal(truncate(undefined), '');
});

// ---------------------------------------------------------------------------
// selectBlogPosts — the two-gate regression
// ---------------------------------------------------------------------------

test('REGRESSION (commit 37cd6a72): an unpublished post is excluded even with plenty of impressions', () => {
  // This is the exact shape of the shipped bug: GSC's rolling 90-day window
  // still counted impressions from before the post was unpublished.
  const candidates = [
    { url: '/blogs/news/dead-hair-post', title: 'Dead Hair Post', description: '', impressions: 500, isPublished: false },
  ];
  const selected = selectBlogPosts(candidates);
  assert.deepEqual(selected, [], 'an unpublished candidate must never be selected, regardless of impressions');
});

test('a published post below the impressions floor is excluded', () => {
  const candidates = [
    { url: '/blogs/news/quiet-post', title: 'Quiet Post', description: '', impressions: 99, isPublished: true },
  ];
  assert.deepEqual(selectBlogPosts(candidates), []);
});

test('a published post at or above the impressions floor is selected', () => {
  const candidates = [
    { url: '/blogs/news/popular-post', title: 'Popular Post', description: 'Great info', impressions: 100, isPublished: true },
  ];
  const selected = selectBlogPosts(candidates);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].url, '/blogs/news/popular-post');
  assert.equal(selected[0].impressions, 100);
});

test('published+qualifying posts are sorted by impressions descending', () => {
  const candidates = [
    { url: '/a', title: 'A', description: '', impressions: 150, isPublished: true },
    { url: '/b', title: 'B', description: '', impressions: 900, isPublished: true },
    { url: '/c', title: 'C', description: '', impressions: 300, isPublished: true },
  ];
  const selected = selectBlogPosts(candidates);
  assert.deepEqual(selected.map((s) => s.url), ['/b', '/c', '/a']);
});

test('selectBlogPosts truncates the description on the way out', () => {
  const candidates = [
    { url: '/a', title: 'A', description: '<p>hello</p>', impressions: 100, isPublished: true },
  ];
  assert.equal(selectBlogPosts(candidates)[0].description, 'hello');
});

test('a mix of published/unpublished and qualifying/non-qualifying posts keeps only the ones passing BOTH gates', () => {
  const candidates = [
    { url: '/keep', title: 'Keep', description: '', impressions: 500, isPublished: true },
    { url: '/unpublished-high-impressions', title: 'Unpublished', description: '', impressions: 5000, isPublished: false },
    { url: '/published-low-impressions', title: 'Low', description: '', impressions: 10, isPublished: true },
  ];
  const selected = selectBlogPosts(candidates);
  assert.deepEqual(selected.map((s) => s.url), ['/keep']);
});

test('minImpressions is configurable but defaults to 100', () => {
  const candidates = [
    { url: '/a', title: 'A', description: '', impressions: 60, isPublished: true },
  ];
  assert.deepEqual(selectBlogPosts(candidates), []);
  assert.equal(selectBlogPosts(candidates, { minImpressions: 50 }).length, 1);
});

// ---------------------------------------------------------------------------
// buildCuratedSection — the product-line regression
// ---------------------------------------------------------------------------

test('REGRESSION (commit d24a670d): the catalog intro never names a product line the brand does not sell', () => {
  const section = buildCuratedSection({ brandName: 'Real Skin Care', blogPosts: [], products: [], collections: [] });
  assert.ok(!/hair/i.test(section), `catalog intro must not mention hair care: ${section}`);
});

test('the catalog intro names every real product line', () => {
  const section = buildCuratedSection({ brandName: 'Real Skin Care', blogPosts: [], products: [], collections: [] });
  for (const line of ['deodorants', 'lotions', 'body cream', 'toothpaste', 'lip balm', 'hand soap']) {
    assert.ok(section.includes(line), `expected catalog intro to mention "${line}"`);
  }
});

test('buildCuratedSection omits a heading entirely when its list is empty', () => {
  const section = buildCuratedSection({ brandName: 'Real Skin Care', blogPosts: [], products: [], collections: [] });
  assert.ok(!section.includes('### Products'));
  assert.ok(!section.includes('### Collections'));
  assert.ok(!section.includes('### Guides & Articles'));
});

test('buildCuratedSection renders each list as a markdown link with an optional description', () => {
  const section = buildCuratedSection({
    brandName: 'Real Skin Care',
    blogPosts: [],
    products: [{ title: 'Coconut Deodorant', url: 'https://realskincare.com/products/deo', description: 'Aluminum-free.' }],
    collections: [],
  });
  assert.ok(section.includes('- [Coconut Deodorant](https://realskincare.com/products/deo): Aluminum-free.'));
});

// ---------------------------------------------------------------------------
// buildTemplate
// ---------------------------------------------------------------------------

test('buildTemplate wraps the preamble + curated section in {% raw %}', () => {
  const template = buildTemplate({
    preamble: 'PREAMBLE TEXT',
    brandName: 'Real Skin Care',
    blogPosts: [],
    products: [],
    collections: [],
  });
  assert.ok(template.startsWith('{% raw %}\n'));
  assert.ok(template.endsWith('{% endraw %}\n'));
  assert.ok(template.includes('PREAMBLE TEXT'));
  assert.ok(template.includes('## Catalog & Content for AI Search'));
});

test('buildTemplate is deterministic for the same inputs (byte-identical output)', () => {
  const input = {
    preamble: 'PREAMBLE',
    brandName: 'Real Skin Care',
    blogPosts: [{ url: '/b', title: 'B', description: 'x', impressions: 200 }],
    products: [{ url: '/p', title: 'P', description: 'y' }],
    collections: [{ url: '/c', title: 'C', description: 'z' }],
  };
  assert.equal(buildTemplate(input), buildTemplate(input));
});
