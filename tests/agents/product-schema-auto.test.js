// tests/agents/product-schema-auto.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

function filterByGscImpressions(products, gscUrls, minImpressions = 50) {
  return products.filter((p) => {
    const impr = gscUrls.get(p.url);
    return impr != null && impr >= minImpressions;
  });
}

function buildProductSchemaWithReviews(baseSchema, reviewStats) {
  if (!reviewStats || reviewStats.reviewCount === 0) return baseSchema;
  return {
    ...baseSchema,
    aggregateRating: {
      '@type': 'AggregateRating',
      ratingValue: String(Math.round(reviewStats.rating * 10) / 10),
      reviewCount: reviewStats.reviewCount,
      bestRating: '5',
      worstRating: '1',
    },
  };
}

test('filterByGscImpressions keeps products with >= 50 impressions', () => {
  const products = [
    { url: 'https://example.com/products/a', title: 'A' },
    { url: 'https://example.com/products/b', title: 'B' },
    { url: 'https://example.com/products/c', title: 'C' },
  ];
  const gscUrls = new Map([
    ['https://example.com/products/a', 200],
    ['https://example.com/products/b', 30],
  ]);
  const result = filterByGscImpressions(products, gscUrls);
  assert.equal(result.length, 1);
  assert.equal(result[0].title, 'A');
});

test('filterByGscImpressions with custom threshold', () => {
  const products = [{ url: 'https://example.com/products/a', title: 'A' }];
  const gscUrls = new Map([['https://example.com/products/a', 30]]);
  assert.equal(filterByGscImpressions(products, gscUrls, 20).length, 1);
  assert.equal(filterByGscImpressions(products, gscUrls, 50).length, 0);
});

test('buildProductSchemaWithReviews adds aggregateRating when reviews exist', () => {
  const base = { '@type': 'Product', name: 'Lotion' };
  const stats = { rating: 4.75, reviewCount: 12 };
  const result = buildProductSchemaWithReviews(base, stats);
  assert.equal(result.aggregateRating['@type'], 'AggregateRating');
  assert.equal(result.aggregateRating.ratingValue, '4.8');
  assert.equal(result.aggregateRating.reviewCount, 12);
  assert.equal(result.aggregateRating.bestRating, '5');
});

test('buildProductSchemaWithReviews returns base schema when no reviews', () => {
  const base = { '@type': 'Product', name: 'Lotion' };
  assert.deepEqual(buildProductSchemaWithReviews(base, null), base);
  assert.deepEqual(buildProductSchemaWithReviews(base, { rating: 0, reviewCount: 0 }), base);
});
