// tests/agents/content-researcher-keyword-data.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeVolumeHistory,
  mapSerpResults,
  mapKeywordIdeas,
} from '../../agents/content-researcher/keyword-data.js';

// ── computeVolumeHistory ──────────────────────────────────────────────────────
// Input: DataForSEO monthlySearches array of { year, month, search_volume }
// Output: { peak_month, low_month, seasonality: [{month, avg}, ...] }
// Matches the shape the content-researcher brief prompt expects.

test('computeVolumeHistory identifies peak and low months', () => {
  const monthlySearches = [
    { year: 2025, month: 1,  search_volume: 1000 },
    { year: 2025, month: 2,  search_volume: 1200 },
    { year: 2025, month: 3,  search_volume: 2500 },  // peak
    { year: 2025, month: 4,  search_volume: 1800 },
    { year: 2025, month: 5,  search_volume: 1100 },
    { year: 2025, month: 6,  search_volume:  900 },
    { year: 2025, month: 7,  search_volume:  800 },
    { year: 2025, month: 8,  search_volume:  700 },  // low
    { year: 2025, month: 9,  search_volume:  950 },
    { year: 2025, month: 10, search_volume: 1100 },
    { year: 2025, month: 11, search_volume: 1400 },
    { year: 2025, month: 12, search_volume: 1600 },
  ];
  const result = computeVolumeHistory(monthlySearches);
  assert.equal(result.peak_month, 'March');
  assert.equal(result.low_month, 'August');
});

test('computeVolumeHistory seasonality is sorted desc by volume', () => {
  const monthlySearches = [
    { year: 2025, month: 1, search_volume: 500 },
    { year: 2025, month: 2, search_volume: 2000 },
    { year: 2025, month: 3, search_volume: 100 },
  ];
  const result = computeVolumeHistory(monthlySearches);
  assert.equal(result.seasonality[0].month, 'February');
  assert.equal(result.seasonality[0].avg, 2000);
  assert.equal(result.seasonality[1].month, 'January');
  assert.equal(result.seasonality[2].month, 'March');
});

test('computeVolumeHistory returns null for empty or missing input', () => {
  assert.equal(computeVolumeHistory([]), null);
  assert.equal(computeVolumeHistory(null), null);
  assert.equal(computeVolumeHistory(undefined), null);
});

// ── mapSerpResults ────────────────────────────────────────────────────────────
// Input: getSerpResults() return from lib/dataforseo.js — { organic, serpFeatures }
// Output: array of { position, url, title, domain, description } ready for brief generation

test('mapSerpResults filters to the first N organic entries and preserves shape', () => {
  const dfs = {
    organic: [
      { position: 1, url: 'https://a.com',  title: 'A', domain: 'a.com', description: 'desc a' },
      { position: 2, url: 'https://b.com',  title: 'B', domain: 'b.com', description: 'desc b' },
      { position: 3, url: 'https://c.com',  title: 'C', domain: 'c.com', description: 'desc c' },
    ],
    serpFeatures: ['featured_snippet', 'people_also_ask'],
  };
  const result = mapSerpResults(dfs, 2);
  assert.equal(result.length, 2);
  assert.deepEqual(result[0], {
    position: 1,
    url: 'https://a.com',
    title: 'A',
    domain: 'a.com',
    description: 'desc a',
  });
});

test('mapSerpResults drops entries without url', () => {
  const dfs = {
    organic: [
      { position: 1, url: '',               title: 'A', domain: 'a.com' },
      { position: 2, url: 'https://b.com',  title: 'B', domain: 'b.com' },
    ],
    serpFeatures: [],
  };
  const result = mapSerpResults(dfs, 10);
  assert.equal(result.length, 1);
  assert.equal(result[0].url, 'https://b.com');
});

test('mapSerpResults handles empty/missing input', () => {
  assert.deepEqual(mapSerpResults(null), []);
  assert.deepEqual(mapSerpResults({}), []);
  assert.deepEqual(mapSerpResults({ organic: [] }), []);
});

// ── mapKeywordIdeas ───────────────────────────────────────────────────────────
// Input: getKeywordIdeas() return from lib/dataforseo.js — [{ keyword, volume, kd, cpc, ... }]
// Output: [{ keyword, volume, difficulty, traffic_potential }] — matches the Ahrefs-shaped
// interface that generateBrief already consumes (see "TP: ${k.traffic_potential}" in prompt).

test('mapKeywordIdeas maps kd -> difficulty and preserves volume/traffic_potential', () => {
  const dfs = [
    { keyword: 'natural deodorant', volume: 10000, kd: 35, cpc: 1.2, trafficPotential: 8000 },
    { keyword: 'aluminum-free',     volume:  3200, kd:  8, cpc: 0.9, trafficPotential: 2000 },
  ];
  const result = mapKeywordIdeas(dfs);
  assert.deepEqual(result[0], {
    keyword: 'natural deodorant',
    volume: 10000,
    difficulty: 35,
    traffic_potential: 8000,
  });
  assert.equal(result[1].difficulty, 8);
});

test('mapKeywordIdeas filters entries without keyword', () => {
  const dfs = [
    { keyword: '',           volume: 100, kd: 5 },
    { keyword: 'good kw',    volume: 100, kd: 5 },
  ];
  const result = mapKeywordIdeas(dfs);
  assert.equal(result.length, 1);
  assert.equal(result[0].keyword, 'good kw');
});

test('mapKeywordIdeas applies volume and difficulty filters when provided', () => {
  const dfs = [
    { keyword: 'low vol',     volume:  50, kd:  5 },
    { keyword: 'high kd',     volume: 500, kd: 80 },
    { keyword: 'keeper',      volume: 500, kd: 20 },
  ];
  const result = mapKeywordIdeas(dfs, { minVolume: 100, maxDifficulty: 40 });
  assert.equal(result.length, 1);
  assert.equal(result[0].keyword, 'keeper');
});

test('mapKeywordIdeas handles empty input', () => {
  assert.deepEqual(mapKeywordIdeas(null), []);
  assert.deepEqual(mapKeywordIdeas([]), []);
});
