import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildArticleSchema, buildBreadcrumb } from '../../lib/schema-builders.js';

const CONFIG = { name: 'Real Skin Care', url: 'https://www.realskincare.com', author: { name: 'Sean Fillmore', slug: 'sean-fillmore' } };

test('buildArticleSchema: core fields + author url + publisher', () => {
  const s = buildArticleSchema({ title: 'Best Natural Deodorant', meta_description: 'desc' }, 'https://www.realskincare.com/blogs/news/x', CONFIG);
  assert.equal(s['@type'], 'Article');
  assert.equal(s.headline, 'Best Natural Deodorant');
  assert.equal(s.author.name, 'Sean Fillmore');
  assert.equal(s.author.url, 'https://www.realskincare.com/pages/sean-fillmore');
  assert.equal(s.publisher.name, 'Real Skin Care');
  assert.equal(s.mainEntityOfPage, 'https://www.realskincare.com/blogs/news/x');
});

test('buildArticleSchema: datePublished/dateModified from meta', () => {
  const s = buildArticleSchema({ title: 'X', published_at: '2026-05-01T08:00:00Z', last_refreshed_at: '2026-06-10T08:00:00Z' }, 'u', CONFIG);
  assert.equal(s.datePublished, '2026-05-01T08:00:00Z');
  assert.equal(s.dateModified, '2026-06-10T08:00:00Z');
});

test('buildArticleSchema: dateModified falls back to datePublished', () => {
  const s = buildArticleSchema({ title: 'X', published_at: '2026-05-01T08:00:00Z' }, 'u', CONFIG);
  assert.equal(s.dateModified, '2026-05-01T08:00:00Z');
});

test('buildArticleSchema: image prefers shopify_image_url then image_url', () => {
  assert.deepEqual(buildArticleSchema({ title: 'X', shopify_image_url: 'a', image_url: 'b' }, 'u', CONFIG).image, ['a']);
  assert.deepEqual(buildArticleSchema({ title: 'X', image_url: 'b' }, 'u', CONFIG).image, ['b']);
  assert.equal('image' in buildArticleSchema({ title: 'X' }, 'u', CONFIG), false);
});

test('buildArticleSchema: keywords from target_keyword + semantic', () => {
  const s = buildArticleSchema({ title: 'X', target_keyword: 'natural deodorant', semantic_keywords: ['aluminum free', 'baking soda'] }, 'u', CONFIG);
  assert.equal(s.keywords, 'natural deodorant, aluminum free, baking soda');
});

test('buildArticleSchema: no datePublished key when no date available', () => {
  const s = buildArticleSchema({ title: 'X' }, 'u', CONFIG);
  assert.equal('datePublished' in s, false);
  assert.equal('dateModified' in s, false);
});

test('buildBreadcrumb: builds positioned ItemList', () => {
  const b = buildBreadcrumb([{ name: 'Home', url: 'https://x' }, { name: 'News', url: 'https://x/blogs/news' }, { name: 'Post', url: 'https://x/blogs/news/p' }]);
  assert.equal(b['@type'], 'BreadcrumbList');
  assert.equal(b.itemListElement.length, 3);
  assert.equal(b.itemListElement[0].position, 1);
  assert.equal(b.itemListElement[2].item, 'https://x/blogs/news/p');
  assert.equal(b.itemListElement[2].name, 'Post');
});
