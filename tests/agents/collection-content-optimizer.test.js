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

// ── Reachability gate, added 2026-09-08 ─────────────────────────────────────
//
// NOTE the selector at the top of this file is a COPY, not an import — the agent
// calls loadEnv() and can process.exit at import time, so it cannot be imported.
// That copy therefore cannot catch a regression in the real one, which is why the
// gate below is checked as a SOURCE SCAN against the agent itself. Same technique
// as tests/agents/seo-copy-writers-gated.test.js.
//
// WHAT THIS PREVENTS. Measured live 2026-09-08, three of the four collection
// bodies sitting in the queue were for pages that CANNOT RANK: organic-body-lotion,
// organic-lip-balm and unscented-lotion are each `published_at: null` (a DRAFT)
// *and* carry a /collections/<handle> URL redirect. Only foaming-hand-soap was
// live. All four had been generated at 450-650 words of paid LLM output, queued,
// and rendered in the 5 AM digest as revenue opportunities with explicit forecasts
// ("move from ~#35 to #15-25", "CTR from near 0% to 1-3%") that a draft behind a
// 301 cannot possibly deliver.
//
// The impressions floor cannot stand in for this: GSC keeps reporting impressions
// for a redirected URL long after the redirect lands.
import { readFileSync as readSrc } from 'node:fs';
import { join as joinSrc, dirname as dirnameSrc } from 'node:path';
import { fileURLToPath as fileURLToPathSrc } from 'node:url';

const AGENT_SRC = readSrc(
  joinSrc(dirnameSrc(fileURLToPathSrc(import.meta.url)), '..', '..',
    'agents', 'collection-content-optimizer', 'index.js'),
  'utf8',
);

test('the agent skips DRAFT collections — published_at is checked', () => {
  assert.match(AGENT_SRC, /if \(!c\.published_at\) return null;/,
    'a collection with no published_at is a draft and can never rank');
  // The field has to survive the custom/smart mapping or the check above is dead.
  assert.equal(
    (AGENT_SRC.match(/published_at: c\.published_at \|\| null/g) || []).length, 2,
    'published_at must be carried through BOTH the custom and smart mappings',
  );
});

test('the agent skips REDIRECTED collection handles', () => {
  assert.match(AGENT_SRC, /redirectedHandles\.has\(c\.handle\)/);
  assert.match(AGENT_SRC, /getRedirects/, 'the redirect table must actually be fetched');
  // Degrade, never block: a failed redirect fetch still leaves the published_at
  // half of the check working. Ranking/display degrades; it destroys nothing.
  assert.match(AGENT_SRC, /Redirect table unavailable/,
    'a failed redirect fetch must be reported and tolerated, not thrown');
});

test('reachability is judged BEFORE the candidate cap, like every other gate here', () => {
  // Same rule as lib/cluster-hold.js: filtering after the slice lets unreachable
  // collections eat the budget and leave the reachable ones untouched.
  const sel = AGENT_SRC.slice(
    AGENT_SRC.indexOf('function selectCollectionCandidates'),
    AGENT_SRC.indexOf('// -- claude content generator'),
  );
  assert.ok(sel.indexOf('published_at') < sel.indexOf('.slice(0, candidateLimit)'),
    'the draft check must run before the cap');
  assert.ok(sel.indexOf('redirectedHandles') < sel.indexOf('.slice(0, candidateLimit)'),
    'the redirect check must run before the cap');
});
