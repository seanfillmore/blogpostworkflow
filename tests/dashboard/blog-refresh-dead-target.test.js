import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isArticleGoneError } from '../../agents/dashboard/routes/performance-queue.js';

// A blog-refresh queue item can outlive its Shopify article: the
// cannibalization-resolver deletes consolidation losers and 301-redirects them,
// so a later "publish refresh" PUT hits a deleted article ID and Shopify returns
// a bare 404. We classify that specific error as "article gone" (retire the
// queue item gracefully) and rethrow everything else (real transient failure).
test('isArticleGoneError distinguishes a deleted-article 404 from other errors', () => {
  assert.equal(
    isArticleGoneError(new Error('Shopify API PUT /blogs/48998449187/articles/563289653418.json → HTTP 404: {"errors":"Not Found"}')),
    true,
    '404 from a deleted article → gone',
  );
  assert.equal(
    isArticleGoneError(new Error('Shopify API GET /blogs/1/articles/2.json → HTTP 404: {"errors":"Not Found"}')),
    true,
    'GET 404 also means gone',
  );
  assert.equal(isArticleGoneError(new Error('HTTP 500: internal server error')), false, '5xx is transient, not gone');
  assert.equal(isArticleGoneError(new Error('HTTP 429: rate limited')), false, 'rate limit is transient, not gone');
  assert.equal(isArticleGoneError(new Error('fetch failed')), false, 'network error is not "gone"');
  assert.equal(isArticleGoneError(null), false, 'null error is not "gone"');
  assert.equal(isArticleGoneError(undefined), false, 'undefined error is not "gone"');
});
