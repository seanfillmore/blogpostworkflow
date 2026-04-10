// tests/lib/meta-test.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

function buildTestData({ slug, url, resourceType, resourceId, blogId, originalTitle, newTitle, baselineCTR }) {
  const startDate = new Date().toISOString().slice(0, 10);
  const concludeDate = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
  return {
    slug,
    url,
    resourceType,
    resourceId,
    blogId: blogId || null,
    startDate,
    concludeDate,
    variantA: originalTitle,
    variantB: newTitle,
    baselineCTR,
    status: 'active',
    baselineMean: baselineCTR,
    testMean: null,
    currentDelta: null,
    daysRemaining: 14,
  };
}

test('buildTestData creates correct shape for product', () => {
  const data = buildTestData({
    slug: 'coconut-lotion', url: 'https://example.com/products/coconut-lotion',
    resourceType: 'product', resourceId: 123, originalTitle: 'Old', newTitle: 'New', baselineCTR: 0.02,
  });
  assert.equal(data.slug, 'coconut-lotion');
  assert.equal(data.resourceType, 'product');
  assert.equal(data.resourceId, 123);
  assert.equal(data.blogId, null);
  assert.equal(data.variantA, 'Old');
  assert.equal(data.variantB, 'New');
  assert.equal(data.status, 'active');
  assert.equal(data.daysRemaining, 14);
});

test('buildTestData creates correct shape for article', () => {
  const data = buildTestData({
    slug: 'my-post', url: 'https://example.com/blogs/news/my-post',
    resourceType: 'article', resourceId: 456, blogId: 789, originalTitle: 'A', newTitle: 'B', baselineCTR: null,
  });
  assert.equal(data.resourceType, 'article');
  assert.equal(data.blogId, 789);
  assert.equal(data.baselineCTR, null);
});

test('buildTestData sets 14-day conclude window', () => {
  const data = buildTestData({
    slug: 'test', url: 'u', resourceType: 'product', resourceId: 1, originalTitle: 'A', newTitle: 'B', baselineCTR: 0,
  });
  const start = new Date(data.startDate);
  const conclude = new Date(data.concludeDate);
  const diffDays = Math.round((conclude - start) / 86400000);
  assert.equal(diffDays, 14);
});
