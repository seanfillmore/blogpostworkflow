// tests/agents/cannibalization-extended.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

function classifyUrl(url) {
  const path = new URL(url).pathname;
  if (path.startsWith('/blogs/')) return 'blog';
  if (path.startsWith('/products/')) return 'product';
  if (path.startsWith('/collections/')) return 'collection';
  return 'other';
}

function detectCannibalizationExtended(queryPageRows, minImpr = 50) {
  const byQuery = new Map();
  for (const row of queryPageRows) {
    const type = classifyUrl(row.page);
    if (type === 'other') continue;
    if (!byQuery.has(row.query)) byQuery.set(row.query, []);
    byQuery.get(row.query).push({ ...row, type });
  }

  return [...byQuery.entries()]
    .filter(([, pages]) => pages.length >= 2)
    .map(([query, pages]) => {
      const sorted = [...pages].sort((a, b) => b.impressions - a.impressions);
      const types = new Set(sorted.map((p) => p.type));
      const conflictType = types.size === 1 ? `${[...types][0]}-vs-${[...types][0]}` :
        [...types].sort().join('-vs-');
      return {
        query,
        conflictType,
        totalImpressions: pages.reduce((s, p) => s + p.impressions, 0),
        pages: sorted.map((p) => ({
          url: p.page,
          type: p.type,
          impressions: p.impressions,
          position: p.position,
        })),
      };
    })
    .filter((g) => g.totalImpressions >= minImpr)
    .sort((a, b) => b.totalImpressions - a.totalImpressions);
}

test('detectCannibalizationExtended finds blog-vs-blog conflicts', () => {
  const rows = [
    { query: 'coconut oil', page: 'https://example.com/blogs/news/a', impressions: 500, position: 5 },
    { query: 'coconut oil', page: 'https://example.com/blogs/news/b', impressions: 300, position: 12 },
  ];
  const result = detectCannibalizationExtended(rows);
  assert.equal(result.length, 1);
  assert.equal(result[0].conflictType, 'blog-vs-blog');
});

test('detectCannibalizationExtended finds blog-vs-product conflicts', () => {
  const rows = [
    { query: 'coconut lotion', page: 'https://example.com/blogs/news/a', impressions: 400, position: 6 },
    { query: 'coconut lotion', page: 'https://example.com/products/coconut-lotion', impressions: 300, position: 10 },
  ];
  const result = detectCannibalizationExtended(rows);
  assert.equal(result.length, 1);
  assert.equal(result[0].conflictType, 'blog-vs-product');
});

test('detectCannibalizationExtended ignores homepage and other URLs', () => {
  const rows = [
    { query: 'skincare', page: 'https://example.com/', impressions: 1000, position: 3 },
    { query: 'skincare', page: 'https://example.com/blogs/news/a', impressions: 200, position: 15 },
  ];
  const result = detectCannibalizationExtended(rows);
  assert.equal(result.length, 0);
});

test('detectCannibalizationExtended respects minImpr threshold', () => {
  const rows = [
    { query: 'niche query', page: 'https://example.com/blogs/news/a', impressions: 10, position: 5 },
    { query: 'niche query', page: 'https://example.com/blogs/news/b', impressions: 10, position: 12 },
  ];
  assert.equal(detectCannibalizationExtended(rows, 50).length, 0);
  assert.equal(detectCannibalizationExtended(rows, 10).length, 1);
});
