import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tagQueries, buildUntappedCandidates } from '../../agents/gsc-query-miner/lib/index-tagger.js';

const idx = {
  keywords: {
    'natural-deodorant':     { slug: 'natural-deodorant',     keyword: 'natural deodorant',     validation_source: 'amazon' },
    'best-soap-for-tattoos': { slug: 'best-soap-for-tattoos', keyword: 'best soap for tattoos', validation_source: 'gsc_ga4' },
  },
};

test('tagQueries stamps validation_source per query', () => {
  const out = tagQueries([
    { keyword: 'natural deodorant', impressions: 100 },
    { keyword: 'unknown', impressions: 50 },
  ], idx);
  assert.equal(out[0].validation_source, 'amazon');
  assert.equal(out[1].validation_source, null);
});

test('tagQueries handles null index', () => {
  const out = tagQueries([{ keyword: 'x' }], null);
  assert.equal(out[0].validation_source, null);
});

test('buildUntappedCandidates pulls leaks above 2× minImpr with 0 clicks, excludes indexed', () => {
  const leaks = [
    { keyword: 'natural deodorant', impressions: 500, clicks: 0, position: 30 },  // already indexed
    { keyword: 'eco friendly soap',  impressions: 500, clicks: 0, position: 40 },  // valid
    { keyword: 'low traffic',        impressions: 50,  clicks: 0, position: 30 },  // below threshold
    { keyword: 'has clicks',         impressions: 500, clicks: 3, position: 30 },  // clicks > 0
  ];
  const out = buildUntappedCandidates(leaks, [], idx, { minImpr: 100 });
  assert.equal(out.length, 1);
  assert.equal(out[0].keyword, 'eco friendly soap');
  assert.equal(out[0].reason, 'impression_leak');
});

test('buildUntappedCandidates pulls untapped clusters with high aggregate impressions', () => {
  const clusters = [{
    keywords: [
      { keyword: 'natural body wash', impressions: 250, position: 40 },
      { keyword: 'organic body wash',  impressions: 100, position: 35 },
    ],
  }];
  const out = buildUntappedCandidates([], clusters, idx, { minClusterImpr: 300 });
  assert.equal(out.length, 1);
  assert.equal(out[0].keyword, 'natural body wash');
  assert.equal(out[0].reason, 'untapped_cluster');
});

test('buildUntappedCandidates dedupes between leaks and clusters', () => {
  const leaks = [{ keyword: 'duplicate kw', impressions: 500, clicks: 0, position: 40 }];
  const clusters = [{ keywords: [{ keyword: 'duplicate kw', impressions: 500, position: 40 }] }];
  const out = buildUntappedCandidates(leaks, clusters, idx, { minImpr: 100, minClusterImpr: 200 });
  assert.equal(out.length, 1);
});
