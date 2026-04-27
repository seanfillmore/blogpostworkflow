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
