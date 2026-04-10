// tests/agents/product-optimizer-from-gsc.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * selectProductMetaCandidates(products, gscMap, activeQueueSlugs)
 * Filters products to those with ≥100 impressions and CTR < 1%,
 * excludes already-queued handles, sorts by impressions desc.
 */

// Inline the function under test (will be extracted into the agent)
function selectProductMetaCandidates(products, gscMap, activeQueueSlugs) {
  return products
    .map((p) => {
      const gsc = gscMap.get(p.url);
      if (!gsc) return null;
      if (gsc.impressions < 100) return null;
      if (gsc.ctr >= 0.01) return null;
      if (activeQueueSlugs.has(p.handle)) return null;
      return { ...p, gsc };
    })
    .filter(Boolean)
    .sort((a, b) => b.gsc.impressions - a.gsc.impressions);
}

function buildProductMetaQueueItem(product, gsc, topQueries, proposedMeta) {
  return {
    slug: product.handle,
    title: `${product.title} — Meta Rewrite`,
    trigger: 'product-meta-rewrite',
    signal_source: {
      type: 'gsc-product-meta',
      impressions: gsc.impressions,
      position: gsc.position,
      ctr: gsc.ctr,
      top_queries: topQueries.map((q) => q.keyword),
    },
    proposed_meta: {
      seo_title: proposedMeta.seo_title,
      seo_description: proposedMeta.seo_description,
      original_title: product.title,
      original_description: product.metaDescription || null,
    },
    resource_type: 'product',
    resource_id: product.id,
    summary: {
      what_changed: proposedMeta.what_changed,
      why: proposedMeta.why,
      projected_impact: proposedMeta.projected_impact,
    },
    status: 'pending',
    created_at: new Date().toISOString(),
  };
}

test('selectProductMetaCandidates filters by impressions >= 100', () => {
  const products = [
    { handle: 'coconut-lotion', url: 'https://example.com/products/coconut-lotion', title: 'Coconut Lotion', id: 1 },
    { handle: 'lip-balm', url: 'https://example.com/products/lip-balm', title: 'Lip Balm', id: 2 },
  ];
  const gscMap = new Map([
    ['https://example.com/products/coconut-lotion', { impressions: 8000, ctr: 0.002, position: 25 }],
    ['https://example.com/products/lip-balm', { impressions: 50, ctr: 0.001, position: 30 }],
  ]);
  const result = selectProductMetaCandidates(products, gscMap, new Set());
  assert.equal(result.length, 1);
  assert.equal(result[0].handle, 'coconut-lotion');
});

test('selectProductMetaCandidates excludes CTR >= 1%', () => {
  const products = [
    { handle: 'toothpaste', url: 'https://example.com/products/toothpaste', title: 'Toothpaste', id: 3 },
  ];
  const gscMap = new Map([
    ['https://example.com/products/toothpaste', { impressions: 5000, ctr: 0.02, position: 8 }],
  ]);
  const result = selectProductMetaCandidates(products, gscMap, new Set());
  assert.equal(result.length, 0);
});

test('selectProductMetaCandidates excludes already-queued handles', () => {
  const products = [
    { handle: 'coconut-lotion', url: 'https://example.com/products/coconut-lotion', title: 'Coconut Lotion', id: 1 },
  ];
  const gscMap = new Map([
    ['https://example.com/products/coconut-lotion', { impressions: 8000, ctr: 0.002, position: 25 }],
  ]);
  const result = selectProductMetaCandidates(products, gscMap, new Set(['coconut-lotion']));
  assert.equal(result.length, 0);
});

test('selectProductMetaCandidates sorts by impressions desc', () => {
  const products = [
    { handle: 'a', url: 'https://example.com/products/a', title: 'A', id: 1 },
    { handle: 'b', url: 'https://example.com/products/b', title: 'B', id: 2 },
  ];
  const gscMap = new Map([
    ['https://example.com/products/a', { impressions: 500, ctr: 0.001, position: 20 }],
    ['https://example.com/products/b', { impressions: 3000, ctr: 0.003, position: 15 }],
  ]);
  const result = selectProductMetaCandidates(products, gscMap, new Set());
  assert.equal(result[0].handle, 'b');
  assert.equal(result[1].handle, 'a');
});

test('buildProductMetaQueueItem produces correct shape', () => {
  const product = { handle: 'coconut-lotion', title: 'Coconut Lotion', id: 123, metaDescription: null };
  const gsc = { impressions: 8000, position: 25, ctr: 0.002 };
  const topQueries = [{ keyword: 'coconut lotion' }, { keyword: 'coconut body lotion' }];
  const proposedMeta = {
    seo_title: 'Organic Coconut Lotion | Real Skin Care',
    seo_description: 'Lightweight coconut body lotion made with organic virgin coconut oil.',
    what_changed: 'Rewrote title and meta description.',
    why: 'Low CTR on high-impression product page.',
    projected_impact: 'CTR improvement from 0.2% to 1%+.',
  };
  const item = buildProductMetaQueueItem(product, gsc, topQueries, proposedMeta);
  assert.equal(item.slug, 'coconut-lotion');
  assert.equal(item.trigger, 'product-meta-rewrite');
  assert.equal(item.resource_type, 'product');
  assert.equal(item.resource_id, 123);
  assert.equal(item.status, 'pending');
  assert.equal(item.proposed_meta.seo_title, 'Organic Coconut Lotion | Real Skin Care');
  assert.equal(item.proposed_meta.original_title, 'Coconut Lotion');
  assert.deepEqual(item.signal_source.top_queries, ['coconut lotion', 'coconut body lotion']);
});
