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

import { extractPageStructure } from '../../agents/competitor-intelligence/scraper.js';

test('extracts H1 and heading hierarchy', () => {
  const html = '<html><body><h1>Best Deodorant</h1><h2>Why It Works</h2></body></html>';
  const result = extractPageStructure(html, ['best', 'deodorant']);
  assert.equal(result.h1, 'Best Deodorant');
  assert.deepEqual(result.h2s, ['Why It Works']);
});

test('detects keyword in H1', () => {
  const html = '<html><body><h1>Best Natural Deodorant</h1><p>First paragraph.</p></body></html>';
  const result = extractPageStructure(html, ['natural', 'deodorant']);
  assert.equal(result.keyword_in_h1, true);
});

test('identifies benefit list format as bullets', () => {
  const html = '<html><body><ul><li>Works all day</li><li>No stains</li></ul></body></html>';
  const result = extractPageStructure(html, []);
  assert.equal(result.benefit_format, 'bullets');
});

test('extracts CTA button text', () => {
  const html = '<html><body><button class="add-to-cart">Add to Cart — Free Shipping</button></button></body></html>';
  const result = extractPageStructure(html, []);
  assert.equal(result.cta_text, 'Add to Cart — Free Shipping');
});
