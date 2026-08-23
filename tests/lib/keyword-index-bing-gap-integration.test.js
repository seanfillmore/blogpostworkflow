// tests/lib/keyword-index-bing-gap-integration.test.js
//
// keyword-index.json's per-entry shape ({ keyword, slug, cluster, validation_source,
// amazon, gsc, ga4, market }) is defined in lib/keyword-index/merge.js's
// mergeSources — a THIRD module relative to the two ends of this handoff:
// agents/keyword-index-builder writes the file, and agents/bing-keyword-gap's
// joinAgainstIndex (lib/bing-keyword-gap.js) reads it back and destructures
// `entry.validation_source` and `entry.cluster` by name.
//
// This is the one keyword-index.json consumer that does NOT go through the
// shared lib/keyword-index/consumer.js reader (see that agent's own header
// comment: "It does NOT write data/keyword-index.json... Fifteen agents read
// that file" via consumer.js — bing-keyword-gap is the one exception, reading
// the raw JSON itself). A shared reader module would catch a shape drift for
// the other 14; this direct read has nothing standing between it and merge.js.
//
// tests/lib/bing-keyword-gap.test.js already covers joinAgainstIndex's own
// logic, but its INDEX fixture is hand-written to match merge.js's shape from
// memory, never produced by running mergeSources. This test builds the index
// half from the real producing function instead.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { mergeSources } from '../../lib/keyword-index/merge.js';
import { aggregateQueries, joinAgainstIndex } from '../../lib/bing-keyword-gap.js';

test('a real mergeSources entry survives into keyword-index.json shape and is read correctly by joinAgainstIndex', () => {
  // Build a real keyword-index.json `keywords` map the way keyword-index-builder
  // actually does: amazon-sourced demand for one keyword, GSC-conversion-sourced
  // demand for another. Neither is hand-shaped to what bing-keyword-gap expects —
  // this is what mergeSources itself produces from realistic inputs.
  const merged = mergeSources({
    amazon: {
      'natural deodorant for men': { query: 'natural deodorant for men', clicks: 12, purchases: 3 },
    },
    gsc: {
      'coconut oil body lotion': { impressions: 800, clicks: 40, ctr: 0.05, position: 4.2, top_page: 'https://realskincare.com/products/coconut-oil-lotion', pages: [] },
    },
    // ga4ForUrl keys on the URL's PATH, not the full URL (it strips the origin
    // off gsc's top_page before looking up) — this is the real key shape.
    ga4Map: {
      '/products/coconut-oil-lotion': { conversions: 5 },
    },
    clusters: {},
    untapped: null,
  });

  const entries = Object.values(merged);
  assert.equal(entries.length, 2, `expected both sourced keywords to merge, got ${JSON.stringify(entries)}`);

  const index = { built_at: '2026-08-21T00:00:00.000Z', keywords: merged };

  // A Bing snapshot whose queries collide (post-normalize) with the two indexed
  // keywords, plus one genuinely untargeted query.
  const snapshot = {
    queries: [
      { query: 'natural deodorant for men', clicks: 3, impressions: 90, date: '2026-08-14', impressionPosition: 8 },
      { query: 'coconut oil body lotion', clicks: 1, impressions: 40, date: '2026-08-14', impressionPosition: 12 },
      { query: 'best griddle cleaner', clicks: 0, impressions: 200, date: '2026-08-14', impressionPosition: 15 },
    ],
    pages: [],
  };

  const rows = aggregateQueries(snapshot);
  const joined = joinAgainstIndex(rows, index, { brandTerms: [] });

  const deo = joined.find((r) => r.key === 'natural deodorant for men');
  const lotion = joined.find((r) => r.key === 'coconut oil body lotion');
  const untargeted = joined.find((r) => r.key === 'best griddle cleaner');

  assert.ok(deo && lotion && untargeted, `expected all three rows to join, got ${JSON.stringify(joined.map((r) => r.key))}`);

  // The real values, not placeholders — proves the fields actually carried the
  // right content through mergeSources -> keyword-index.json shape -> joinAgainstIndex,
  // not just that some truthy value survived.
  assert.equal(deo.targeted, true);
  assert.equal(deo.validationSource, 'amazon');
  assert.equal(deo.indexCluster, 'deodorant');

  assert.equal(lotion.targeted, true);
  assert.equal(lotion.validationSource, 'gsc_ga4');
  assert.equal(lotion.indexCluster, 'lotion');

  assert.equal(untargeted.targeted, false);
  assert.equal(untargeted.validationSource, null);
  assert.equal(untargeted.indexCluster, null);
});
