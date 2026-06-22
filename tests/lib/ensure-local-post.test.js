import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBootstrapMeta } from '../../lib/ensure-local-post.js';

test('buildBootstrapMeta mirrors a live article into trackable meta', () => {
  const article = { id: 562322047146, handle: 'best-sls-free-toothpaste-2025', title: 'Best SLS-Free Toothpaste 2025', body_html: '<p>x</p>', published_at: '2026-01-01T00:00:00Z' };
  const blog = { id: 123, handle: 'news' };
  const m = buildBootstrapMeta(article, blog);
  assert.equal(m.shopify_article_id, 562322047146);
  assert.equal(m.shopify_handle, 'best-sls-free-toothpaste-2025');
  assert.equal(m.handle, 'best-sls-free-toothpaste-2025');           // so resolvePostSlug matches
  assert.equal(m.shopify_status, 'published');
  assert.equal(m.shopify_blog_id, 123);
  assert.ok(m.url.endsWith('/blogs/news/best-sls-free-toothpaste-2025'));
  assert.equal(m.bootstrapped_from_live, true);
});

test('buildBootstrapMeta marks an unpublished article as draft', () => {
  const m = buildBootstrapMeta({ id: 1, handle: 'h', title: 't', published_at: null }, { id: 9, handle: 'news' });
  assert.equal(m.shopify_status, 'draft');
});
