// tests/agents/collection-content-optimizer.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Selection logic — will be used in the agent
function selectCollectionCandidates(collections, gscResults, activeQueueSlugs, limit = 5) {
  return collections
    .map((c) => {
      const gsc = gscResults.get(c.url);
      if (!gsc) return null;
      if (gsc.impressions < 500) return null;
      if (gsc.position <= 10 && gsc.ctr >= 0.005) return null; // already performing well
      if (activeQueueSlugs.has(c.handle)) return null;
      return { ...c, gsc };
    })
    .filter(Boolean)
    .sort((a, b) => b.gsc.impressions - a.gsc.impressions)
    .slice(0, limit);
}

function findRelatedBlogPosts(topicalMap, collectionHandle, collectionTitle) {
  const searchTerms = collectionHandle.replace(/-/g, ' ').toLowerCase().split(' ')
    .filter((w) => w.length > 3);
  const results = [];
  for (const cluster of topicalMap.clusters || []) {
    for (const article of cluster.articles || []) {
      const titleLower = article.title.toLowerCase();
      if (searchTerms.some((t) => titleLower.includes(t))) {
        results.push({ url: article.url, title: article.title, cluster: cluster.tag });
      }
    }
  }
  return results.slice(0, 5);
}

function findRelevantIngredients(ingredientsConfig, collectionHandle) {
  const handleTerms = collectionHandle.replace(/-/g, ' ').toLowerCase();
  const matches = [];
  for (const [key, product] of Object.entries(ingredientsConfig)) {
    const nameMatch = product.name.toLowerCase().split(' ').some((w) => handleTerms.includes(w));
    const keyMatch = handleTerms.includes(key);
    if (nameMatch || keyMatch) {
      matches.push({ product: product.name, base_ingredients: product.base_ingredients || [] });
    }
  }
  return matches;
}

test('selectCollectionCandidates filters by impressions >= 500', () => {
  const collections = [
    { handle: 'body-lotion', url: 'https://example.com/collections/body-lotion', title: 'Body Lotion', id: 1 },
    { handle: 'soap', url: 'https://example.com/collections/soap', title: 'Soap', id: 2 },
  ];
  const gscResults = new Map([
    ['https://example.com/collections/body-lotion', { impressions: 12000, ctr: 0.003, position: 32 }],
    ['https://example.com/collections/soap', { impressions: 200, ctr: 0.001, position: 40 }],
  ]);
  const result = selectCollectionCandidates(collections, gscResults, new Set());
  assert.equal(result.length, 1);
  assert.equal(result[0].handle, 'body-lotion');
});

test('selectCollectionCandidates excludes already-queued', () => {
  const collections = [
    { handle: 'body-lotion', url: 'https://example.com/collections/body-lotion', title: 'Body Lotion', id: 1 },
  ];
  const gscResults = new Map([
    ['https://example.com/collections/body-lotion', { impressions: 12000, ctr: 0.003, position: 32 }],
  ]);
  const result = selectCollectionCandidates(collections, gscResults, new Set(['body-lotion']));
  assert.equal(result.length, 0);
});

test('selectCollectionCandidates allows top-10 position if CTR is still low', () => {
  const collections = [
    { handle: 'lotion', url: 'https://example.com/collections/lotion', title: 'Lotion', id: 1 },
  ];
  const gscResults = new Map([
    ['https://example.com/collections/lotion', { impressions: 5000, ctr: 0.002, position: 8 }],
  ]);
  const result = selectCollectionCandidates(collections, gscResults, new Set());
  assert.equal(result.length, 1); // position <= 10 but CTR < 0.5%, still a candidate
});

test('findRelatedBlogPosts matches by collection handle terms', () => {
  const topicalMap = {
    clusters: [{
      tag: 'mof',
      articles: [
        { url: 'https://example.com/blogs/news/coconut-oil-guide', title: 'Coconut Oil for Skin: Ultimate Guide' },
        { url: 'https://example.com/blogs/news/rose-water-benefits', title: 'Rose Water Benefits' },
      ],
    }],
  };
  const results = findRelatedBlogPosts(topicalMap, 'organic-coconut-lotion', 'Organic Coconut Lotion');
  assert.equal(results.length, 1);
  assert.ok(results[0].title.includes('Coconut'));
});

test('findRelevantIngredients matches by handle terms', () => {
  const ingredientsConfig = {
    lotion: { name: 'Body Lotion', base_ingredients: ['coconut oil', 'jojoba'] },
    soap: { name: 'Bar Soap', base_ingredients: ['coconut oil', 'olive oil'] },
  };
  const results = findRelevantIngredients(ingredientsConfig, 'non-toxic-body-lotion');
  assert.equal(results.length, 1);
  assert.equal(results[0].product, 'Body Lotion');
});

import { clusterForCollection } from '../../agents/collection-content-optimizer/lib/cluster-mapper.js';

const idx = {
  keywords: {
    'natural-deodorant':       { keyword: 'natural deodorant',       slug: 'natural-deodorant',       cluster: 'deodorant' },
    'aluminum-free-deodorant': { keyword: 'aluminum free deodorant', slug: 'aluminum-free-deodorant', cluster: 'deodorant' },
    'roll-on-deodorant':       { keyword: 'roll on deodorant',       slug: 'roll-on-deodorant',       cluster: 'deodorant' },
    'natural-bar-soap':        { keyword: 'natural bar soap',        slug: 'natural-bar-soap',        cluster: 'soap' },
    'orphan-thing':            { keyword: 'orphan thing',             slug: 'orphan-thing',            cluster: 'unclustered' },
  },
};

test('clusterForCollection picks cluster with most token matches', () => {
  const c = { handle: 'natural-deodorant', title: 'Natural Deodorants' };
  assert.equal(clusterForCollection(c, idx), 'deodorant');
});

test('clusterForCollection requires at least 2 token hits', () => {
  const c = { handle: 'soap-dish', title: 'Soap Dish' };
  assert.equal(clusterForCollection(c, idx), null);
});

test('clusterForCollection ignores unclustered entries', () => {
  const c = { handle: 'orphan-thing', title: 'Orphan thing' };
  assert.equal(clusterForCollection(c, idx), null);
});

test('clusterForCollection returns null when index is null', () => {
  const c = { handle: 'natural-deodorant', title: 'Natural Deodorants' };
  assert.equal(clusterForCollection(c, null), null);
});

test('clusterForCollection returns null when no cluster has 2+ hits', () => {
  const c = { handle: 'random-stuff', title: 'Random Stuff' };
  assert.equal(clusterForCollection(c, idx), null);
});
