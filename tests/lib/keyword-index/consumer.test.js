import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadIndex, lookupByKeyword, lookupByUrl, validationTag, _resetCacheForTests } from '../../../lib/keyword-index/consumer.js';

test('loadIndex returns null when file missing', () => {
  _resetCacheForTests();
  const dir = mkdtempSync(join(tmpdir(), 'kwi-'));
  try {
    assert.equal(loadIndex(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadIndex parses a valid keyword-index.json', () => {
  _resetCacheForTests();
  const dir = mkdtempSync(join(tmpdir(), 'kwi-'));
  try {
    mkdirSync(join(dir, 'data'), { recursive: true });
    writeFileSync(join(dir, 'data', 'keyword-index.json'), JSON.stringify({
      built_at: '2026-04-27T00:00:00.000Z',
      keywords: { 'foo': { keyword: 'foo', slug: 'foo', cluster: 'soap', validation_source: 'amazon' } },
    }));
    const idx = loadIndex(dir);
    assert.equal(idx.keywords.foo.cluster, 'soap');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const lookupFixture = {
  keywords: {
    'natural-deodorant':     { keyword: 'natural deodorant',     slug: 'natural-deodorant',     validation_source: 'amazon' },
    'best-soap-for-tattoos': { keyword: 'best soap for tattoos', slug: 'best-soap-for-tattoos', validation_source: 'gsc_ga4' },
  },
};

test('lookupByKeyword exact slug match', () => {
  const e = lookupByKeyword(lookupFixture, 'natural-deodorant');
  assert.equal(e?.slug, 'natural-deodorant');
});

test('lookupByKeyword normalized-slug match from raw keyword', () => {
  const e = lookupByKeyword(lookupFixture, 'Natural Deodorant');
  assert.equal(e?.slug, 'natural-deodorant');
});

test('lookupByKeyword case-insensitive fallback', () => {
  const e = lookupByKeyword(lookupFixture, 'BEST SOAP FOR TATTOOS!');
  assert.equal(e?.slug, 'best-soap-for-tattoos');
});

test('lookupByKeyword miss returns null', () => {
  assert.equal(lookupByKeyword(lookupFixture, 'something we never see'), null);
});

test('lookupByKeyword null index returns null', () => {
  assert.equal(lookupByKeyword(null, 'foo'), null);
});

const urlFixture = {
  keywords: {
    'natural-deodorant': {
      slug: 'natural-deodorant',
      gsc: { top_page: 'https://www.realskincare.com/blogs/news/best-natural-deodorant', position: 8 },
    },
    'orphan-no-gsc': {
      slug: 'orphan-no-gsc',
      gsc: null,
    },
  },
};

test('lookupByUrl matches gsc.top_page exactly', () => {
  const e = lookupByUrl(urlFixture, 'https://www.realskincare.com/blogs/news/best-natural-deodorant');
  assert.equal(e?.slug, 'natural-deodorant');
});

test('lookupByUrl miss returns null', () => {
  assert.equal(lookupByUrl(urlFixture, 'https://example.com/other'), null);
});

test('lookupByUrl skips entries with null gsc', () => {
  assert.equal(lookupByUrl(urlFixture, ''), null);
});

test('lookupByUrl null index returns null', () => {
  assert.equal(lookupByUrl(null, 'https://x'), null);
});

test('validationTag returns amazon for amazon-validated entry', () => {
  assert.equal(validationTag({ validation_source: 'amazon' }), 'amazon');
});

test('validationTag returns gsc_ga4 for gsc_ga4-validated entry', () => {
  assert.equal(validationTag({ validation_source: 'gsc_ga4' }), 'gsc_ga4');
});

test('validationTag returns null for null entry', () => {
  assert.equal(validationTag(null), null);
});

test('validationTag returns null for entry with no validation_source', () => {
  assert.equal(validationTag({ slug: 'x' }), null);
});

import { clusterMatesFor } from '../../../lib/keyword-index/consumer.js';

const clusterFixture = {
  keywords: {
    'natural-deodorant':       { slug: 'natural-deodorant',       cluster: 'deodorant', amazon: { purchases: 100 }, gsc: { impressions: 500 } },
    'aluminum-free-deodorant': { slug: 'aluminum-free-deodorant', cluster: 'deodorant', amazon: { purchases: 200 }, gsc: { impressions: 300 } },
    'roll-on-deodorant':       { slug: 'roll-on-deodorant',       cluster: 'deodorant', amazon: null,                gsc: { impressions: 800 } },
    'natural-soap':            { slug: 'natural-soap',            cluster: 'soap',      amazon: { purchases: 50 },   gsc: { impressions: 200 } },
    'orphan':                  { slug: 'orphan',                  cluster: 'unclustered' },
  },
};

test('clusterMatesFor returns [] for null index', () => {
  assert.deepEqual(clusterMatesFor(null, { cluster: 'deodorant' }), []);
});

test('clusterMatesFor returns [] for null entry', () => {
  assert.deepEqual(clusterMatesFor(clusterFixture, null), []);
});

test('clusterMatesFor returns [] for unclustered entry', () => {
  assert.deepEqual(clusterMatesFor(clusterFixture, clusterFixture.keywords.orphan), []);
});

test('clusterMatesFor excludes self by default', () => {
  const mates = clusterMatesFor(clusterFixture, clusterFixture.keywords['natural-deodorant']);
  assert.ok(!mates.some((m) => m.slug === 'natural-deodorant'));
});

test('clusterMatesFor includes self when excludeSelf=false', () => {
  const mates = clusterMatesFor(clusterFixture, clusterFixture.keywords['natural-deodorant'], { excludeSelf: false });
  assert.ok(mates.some((m) => m.slug === 'natural-deodorant'));
});

test('clusterMatesFor sorts by amazon.purchases desc, then gsc.impressions desc', () => {
  const mates = clusterMatesFor(clusterFixture, clusterFixture.keywords['natural-deodorant']);
  assert.deepEqual(mates.map((m) => m.slug), ['aluminum-free-deodorant', 'roll-on-deodorant']);
});

test('clusterMatesFor respects limit', () => {
  const mates = clusterMatesFor(clusterFixture, clusterFixture.keywords['natural-deodorant'], { limit: 1 });
  assert.equal(mates.length, 1);
});

import { entriesForCluster, loadCategoryCompetitors } from '../../../lib/keyword-index/consumer.js';

test('entriesForCluster returns matching cluster entries sorted by amazon.purchases then impressions', () => {
  const idx = {
    keywords: {
      a: { slug: 'a', cluster: 'deodorant', amazon: { purchases: 10 }, gsc: { impressions: 100 } },
      b: { slug: 'b', cluster: 'deodorant', amazon: { purchases: 20 }, gsc: { impressions: 50 } },
      c: { slug: 'c', cluster: 'deodorant', amazon: null, gsc: { impressions: 500 } },
      d: { slug: 'd', cluster: 'soap',      amazon: { purchases: 30 } },
    },
  };
  const out = entriesForCluster(idx, 'deodorant');
  assert.deepEqual(out.map((e) => e.slug), ['b', 'a', 'c']);
});

test('entriesForCluster respects limit', () => {
  const idx = { keywords: { a: { slug: 'a', cluster: 'x' }, b: { slug: 'b', cluster: 'x' } } };
  assert.equal(entriesForCluster(idx, 'x', { limit: 1 }).length, 1);
});

test('entriesForCluster returns [] for null index or missing cluster', () => {
  assert.deepEqual(entriesForCluster(null, 'x'), []);
  assert.deepEqual(entriesForCluster({ keywords: {} }, 'x'), []);
});

test('loadCategoryCompetitors returns {} when file missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kwi-'));
  try {
    assert.deepEqual(loadCategoryCompetitors(dir), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadCategoryCompetitors returns parsed object', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kwi-'));
  try {
    mkdirSync(join(dir, 'data'), { recursive: true });
    writeFileSync(join(dir, 'data', 'category-competitors.json'),
      JSON.stringify({ deodorant: [{ domain: 'native.com', avg_position: 4 }] }));
    const out = loadCategoryCompetitors(dir);
    assert.equal(out.deodorant[0].domain, 'native.com');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

import { buildPromptGrounding } from '../../../lib/keyword-index/consumer.js';

test('buildPromptGrounding (consumer.js): returns null for null entry', () => {
  assert.equal(buildPromptGrounding(null, []), null);
});

test('buildPromptGrounding (consumer.js): extracts amazon validation + conversion share', () => {
  const g = buildPromptGrounding({ validation_source: 'amazon', amazon: { conversion_share: 0.08 } }, [{ keyword: 'a' }, { keyword: 'b' }]);
  assert.equal(g.validationTag, 'amazon');
  assert.equal(g.conversionShare, 0.08);
  assert.deepEqual(g.clusterMateKeywords, ['a', 'b']);
});

import { unmappedIndexEntries } from '../../../lib/keyword-index/consumer.js';

const unmappedFixture = {
  keywords: {
    'natural-deodorant':       { slug: 'natural-deodorant',       keyword: 'natural deodorant',     validation_source: 'amazon',  amazon: { purchases: 100 } },
    'aluminum-free-deodorant': { slug: 'aluminum-free-deodorant', keyword: 'aluminum free deodorant', validation_source: 'amazon',  amazon: { purchases: 200 } },
    'best-soap-for-tattoos':   { slug: 'best-soap-for-tattoos',   keyword: 'best soap for tattoos',  validation_source: 'gsc_ga4', ga4: { conversions: 18 } },
    'natural-bar-soap':        { slug: 'natural-bar-soap',        keyword: 'natural bar soap',       validation_source: 'gsc_ga4', ga4: { conversions: 5 } },
  },
};

test('unmappedIndexEntries returns [] for null index', () => {
  assert.deepEqual(unmappedIndexEntries(null, new Set()), []);
});

test('unmappedIndexEntries excludes slugs already in inventory', () => {
  const inv = new Set(['natural-deodorant']);
  const out = unmappedIndexEntries(unmappedFixture, inv);
  assert.ok(!out.some((e) => e.slug === 'natural-deodorant'));
});

test('unmappedIndexEntries sorts amazon first (by purchases desc), then gsc_ga4 (by conversions desc)', () => {
  const out = unmappedIndexEntries(unmappedFixture, new Set());
  assert.deepEqual(out.map((e) => e.slug), [
    'aluminum-free-deodorant', 'natural-deodorant',
    'best-soap-for-tattoos', 'natural-bar-soap',
  ]);
});

test('unmappedIndexEntries respects limit', () => {
  const out = unmappedIndexEntries(unmappedFixture, new Set(), { limit: 2 });
  assert.equal(out.length, 2);
});

import { topAmazonValidatedForAds } from '../../../lib/keyword-index/consumer.js';

const adsFixture = {
  keywords: {
    'a': { keyword: 'a', amazon: { purchases: 100, conversion_share: 0.10 } },         // score 10.0
    'b': { keyword: 'b', amazon: { purchases: 200, conversion_share: 0.05 } },         // score 10.0 (tie)
    'c': { keyword: 'c', amazon: { purchases: 50,  conversion_share: 0.20 } },         // score 10.0 (tie)
    'd': { keyword: 'd', amazon: { purchases: 500, conversion_share: 0.01 } },         // score 5.0
    'e': { keyword: 'e', amazon: { purchases: 0,   conversion_share: 0.50 } },         // excluded (0 purchases)
    'f': { keyword: 'f', amazon: { purchases: 100, conversion_share: 0 } },            // excluded (0 share)
    'g': { keyword: 'g' },                                                              // excluded (no amazon)
  },
};

test('topAmazonValidatedForAds excludes entries with 0 purchases or 0 conversion_share', () => {
  const out = topAmazonValidatedForAds(adsFixture);
  const keys = out.map((e) => e.keyword);
  assert.ok(!keys.includes('e'));
  assert.ok(!keys.includes('f'));
  assert.ok(!keys.includes('g'));
});

test('topAmazonValidatedForAds sorts by purchases × conversion_share desc', () => {
  const out = topAmazonValidatedForAds(adsFixture);
  // a/b/c all tie at score 10.0; d is 5.0
  assert.equal(out[out.length - 1].keyword, 'd');
});

test('topAmazonValidatedForAds respects limit', () => {
  const out = topAmazonValidatedForAds(adsFixture, { limit: 2 });
  assert.equal(out.length, 2);
});

test('topAmazonValidatedForAds returns [] for null index', () => {
  assert.deepEqual(topAmazonValidatedForAds(null), []);
});
