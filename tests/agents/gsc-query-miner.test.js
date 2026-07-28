import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tagQueries, buildUntappedCandidates } from '../../agents/gsc-query-miner/lib/index-tagger.js';

const idx = {
  keywords: {
    'natural-deodorant':          { slug: 'natural-deodorant',          keyword: 'natural deodorant',          validation_source: 'amazon' },
    'best-soap-for-tattoos':      { slug: 'best-soap-for-tattoos',      keyword: 'best soap for tattoos',      validation_source: 'gsc_ga4' },
    'refillable-soap-dispenser':  { slug: 'refillable-soap-dispenser',  keyword: 'refillable soap dispenser',  validation_source: 'gsc_untapped' },
    'zero-waste-shampoo-bar':     { slug: 'zero-waste-shampoo-bar',     keyword: 'zero waste shampoo bar',     validation_source: 'gsc_untapped' },
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

test('buildUntappedCandidates is not bounded at 50 when the leak set is larger', () => {
  const leaks = Array.from({ length: 80 }, (_, i) => ({
    keyword: `leak query ${i}`,
    impressions: 500 - i,
    clicks: 0,
    position: 40,
  }));
  const out = buildUntappedCandidates(leaks, [], null, { minImpr: 50 });
  assert.equal(out.length, 80, 'every qualifying leak should reach the feed');
});

// ── Finding 1 regression: the feed must not self-exclude ────────────────────
//
// A keyword this feed put into the index (validation_source: 'gsc_untapped')
// must keep being emitted by the feed, or the next keyword-index build has
// nothing to re-admit it from and it silently drops out, then reappears next
// cycle once the miner sees it's gone — an infinite oscillation. Only
// keywords qualified by a DIFFERENT source should be excluded as "already
// covered".

test('buildUntappedCandidates (leaks path) still emits a leak already indexed as gsc_untapped', () => {
  const leaks = [
    { keyword: 'refillable soap dispenser', impressions: 500, clicks: 0, position: 40 }, // indexed via gsc_untapped — must stay in the feed
  ];
  const out = buildUntappedCandidates(leaks, [], idx, { minImpr: 100 });
  assert.equal(out.length, 1);
  assert.equal(out[0].keyword, 'refillable soap dispenser');
});

test('buildUntappedCandidates (leaks path) excludes a leak indexed by a different source (amazon)', () => {
  const leaks = [
    { keyword: 'natural deodorant', impressions: 500, clicks: 0, position: 30 }, // indexed via amazon — a real qualifying signal, must stay excluded
  ];
  const out = buildUntappedCandidates(leaks, [], idx, { minImpr: 100 });
  assert.equal(out.length, 0);
});

test('buildUntappedCandidates (clusters path) still emits a cluster top query already indexed as gsc_untapped', () => {
  const clusters = [{
    keywords: [
      { keyword: 'zero waste shampoo bar', impressions: 250, position: 40 }, // indexed via gsc_untapped — must stay in the feed
      { keyword: 'plastic free shampoo',   impressions: 100, position: 35 },
    ],
  }];
  const out = buildUntappedCandidates([], clusters, idx, { minClusterImpr: 300 });
  assert.equal(out.length, 1);
  assert.equal(out[0].keyword, 'zero waste shampoo bar');
});

test('buildUntappedCandidates (clusters path) excludes a cluster top query indexed by a different source (gsc_ga4)', () => {
  const clusters = [{
    keywords: [
      { keyword: 'best soap for tattoos', impressions: 250, position: 40 }, // indexed via gsc_ga4 — a real qualifying signal, must stay excluded
      { keyword: 'tattoo aftercare soap', impressions: 100, position: 35 },
    ],
  }];
  const out = buildUntappedCandidates([], clusters, idx, { minClusterImpr: 300 });
  assert.equal(out.length, 0);
});
