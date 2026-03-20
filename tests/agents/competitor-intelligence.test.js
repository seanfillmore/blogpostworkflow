// tests/agents/competitor-intelligence.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchCompetitorUrl } from '../../agents/competitor-intelligence/matcher.js';

const pages = [
  { url: 'https://store.com/products/coconut-deodorant', slug: 'coconut-deodorant', type: 'product' },
  { url: 'https://store.com/collections/natural-deodorant', slug: 'natural-deodorant', type: 'collection' },
];

test('exact slug match for product URL', () => {
  const result = matchCompetitorUrl('https://competitor.com/products/coconut-deodorant', pages);
  assert.deepEqual(result, { slug: 'coconut-deodorant', type: 'product' });
});

test('exact slug match for collection URL', () => {
  const result = matchCompetitorUrl('https://competitor.com/collections/natural-deodorant', pages);
  assert.deepEqual(result, { slug: 'natural-deodorant', type: 'collection' });
});

test('token overlap match (2+ shared tokens)', () => {
  const result = matchCompetitorUrl('https://competitor.com/products/best-coconut-deodorant-stick', pages);
  assert.deepEqual(result, { slug: 'coconut-deodorant', type: 'product' });
});

test('returns null when no match', () => {
  const result = matchCompetitorUrl('https://competitor.com/products/totally-unrelated-thing', pages);
  assert.equal(result, null);
});

test('skips non-product non-collection URLs', () => {
  const result = matchCompetitorUrl('https://competitor.com/blogs/news/some-post', pages);
  assert.equal(result, null);
});
