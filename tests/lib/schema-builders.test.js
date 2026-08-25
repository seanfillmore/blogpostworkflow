import { strict as assert } from 'node:assert';
import { test } from 'node:test';
// `buildArticleSchema` is deliberately absent: it was retired on 2026-08-24
// because the live theme already publishes an Article node on 182/182 blog
// pages, and an unused builder is how the duplicate gets re-added. Its
// replacement, `buildPostSchemas`, is tested in
// tests/agents/schema-injector-dead-types.test.js alongside the evidence.
// `buildFaqSchema` is deliberately absent too, retired 2026-08-24 in the
// follow-up change that stopped the COMMERCIAL callers. Google removed the FAQ
// rich result from Search outright. Its evidence and the removal from all three
// callers are pinned in tests/agents/commercial-dead-schema.test.js.
import { buildBreadcrumb, buildCollectionPageSchema, buildItemListSchema } from '../../lib/schema-builders.js';

const CONFIG = { name: 'Real Skin Care', url: 'https://www.realskincare.com', author: { name: 'Sean Fillmore', slug: 'sean-fillmore' } };

test('buildBreadcrumb: builds positioned ItemList', () => {
  const b = buildBreadcrumb([{ name: 'Home', url: 'https://x' }, { name: 'News', url: 'https://x/blogs/news' }, { name: 'Post', url: 'https://x/blogs/news/p' }]);
  assert.equal(b['@type'], 'BreadcrumbList');
  assert.equal(b.itemListElement.length, 3);
  assert.equal(b.itemListElement[0].position, 1);
  assert.equal(b.itemListElement[2].item, 'https://x/blogs/news/p');
  assert.equal(b.itemListElement[2].name, 'Post');
});

test('buildCollectionPageSchema: core fields', () => {
  const s = buildCollectionPageSchema({ name: 'Natural Deodorant', description: 'desc', url: 'https://x/collections/nd', image: 'https://img' });
  assert.equal(s['@type'], 'CollectionPage');
  assert.equal(s.name, 'Natural Deodorant');
  assert.equal(s.url, 'https://x/collections/nd');
  assert.equal(s.image, 'https://img');
});

test('buildCollectionPageSchema: omits image when absent', () => {
  const s = buildCollectionPageSchema({ name: 'X', description: 'd', url: 'u' });
  assert.equal('image' in s, false);
});

test('buildItemListSchema: positioned product URLs', () => {
  const s = buildItemListSchema(['https://x/products/a', 'https://x/products/b']);
  assert.equal(s['@type'], 'ItemList');
  assert.equal(s.itemListElement.length, 2);
  assert.equal(s.itemListElement[0].position, 1);
  assert.equal(s.itemListElement[1].url, 'https://x/products/b');
});

