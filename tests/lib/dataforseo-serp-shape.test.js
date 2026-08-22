// tests/lib/dataforseo-serp-shape.test.js
//
// getSerpResults has NINE production callers, every one destructuring { organic }.
// This file's first job is to pin that shape so an additive change stays additive.
// Its second job is to prove paa/relatedSearches are actually extracted.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { extractSerpPayload } from '../../lib/dataforseo.js';

/** A SERP response with organic results, a PAA box, and a related-searches box. */
const FIXTURE_ITEMS = [
  { type: 'organic', rank_group: 1, url: 'https://a.example/1', title: 'A', domain: 'a.example', description: 'first' },
  { type: 'organic', rank_group: 2, url: 'https://b.example/2', title: 'B', domain: 'b.example', description: 'second' },
  {
    type: 'people_also_ask',
    items: [
      { type: 'people_also_ask_element', title: 'Does coconut oil clog pores?' },
      { type: 'people_also_ask_element', title: 'Is coconut oil comedogenic?' },
    ],
  },
  { type: 'related_searches', items: ['coconut oil for dry skin', 'coconut oil breakout'] },
];

test('organic keeps its exact pre-existing shape', () => {
  const { organic } = extractSerpPayload(FIXTURE_ITEMS);
  assert.equal(organic.length, 2);
  assert.deepEqual(organic[0], {
    position: 1, url: 'https://a.example/1', title: 'A', domain: 'a.example', description: 'first',
  });
});

test('serpFeatures keeps its exact pre-existing shape — deduped type names', () => {
  const { serpFeatures } = extractSerpPayload(FIXTURE_ITEMS);
  assert.deepEqual(serpFeatures, ['organic', 'people_also_ask', 'related_searches']);
});

test('paa is extracted as question records', () => {
  const { paa } = extractSerpPayload(FIXTURE_ITEMS);
  assert.deepEqual(paa, [
    { question: 'Does coconut oil clog pores?', source: 'paa' },
    { question: 'Is coconut oil comedogenic?', source: 'paa' },
  ]);
});

test('relatedSearches is extracted as question records', () => {
  const { relatedSearches } = extractSerpPayload(FIXTURE_ITEMS);
  assert.deepEqual(relatedSearches, [
    { question: 'coconut oil for dry skin', source: 'related_search' },
    { question: 'coconut oil breakout', source: 'related_search' },
  ]);
});

test('a SERP with no PAA or related box yields empty arrays, not undefined', () => {
  const { paa, relatedSearches, organic } = extractSerpPayload([FIXTURE_ITEMS[0]]);
  assert.deepEqual(paa, []);
  assert.deepEqual(relatedSearches, []);
  assert.equal(organic.length, 1, 'organic still works when nothing else is present');
});

test('malformed PAA and related items are skipped, not thrown on', () => {
  const messy = [
    { type: 'people_also_ask' },                                  // no items
    { type: 'people_also_ask', items: [{ title: '' }, {}] },       // empty and missing title
    { type: 'related_searches', items: [null, '', 'usable one'] },
  ];
  const { paa, relatedSearches } = extractSerpPayload(messy);
  assert.deepEqual(paa, []);
  assert.deepEqual(relatedSearches, [{ question: 'usable one', source: 'related_search' }]);
});

test('every existing caller destructuring only { organic } is unaffected', () => {
  // The nine callers do `const { organic } = await getSerpResults(...)`. Adding keys
  // cannot break that, but this pins the intent so a future edit that *replaces*
  // rather than *adds* fails here rather than in production.
  const payload = extractSerpPayload(FIXTURE_ITEMS);
  assert.ok('organic' in payload && 'serpFeatures' in payload);
  assert.ok(Array.isArray(payload.organic) && Array.isArray(payload.serpFeatures));
});
