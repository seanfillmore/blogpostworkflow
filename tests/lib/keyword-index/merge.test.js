import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeSources, classifyValidationSource } from '../../../lib/keyword-index/merge.js';

test('classifyValidationSource is "amazon" when amazon has purchases', () => {
  const r = classifyValidationSource({ amazon: { purchases: 5, clicks: 10 }, gsc: null, ga4: null });
  assert.equal(r, 'amazon');
});

test('classifyValidationSource is "amazon" when amazon has clicks but no purchases', () => {
  const r = classifyValidationSource({ amazon: { purchases: 0, clicks: 5 }, gsc: null, ga4: null });
  assert.equal(r, 'amazon');
});

test('classifyValidationSource is "gsc_ga4" when no amazon but ga4 has conversions', () => {
  const r = classifyValidationSource({ amazon: null, gsc: { impressions: 100 }, ga4: { conversions: 3 } });
  assert.equal(r, 'gsc_ga4');
});

test('classifyValidationSource is null when neither path qualifies', () => {
  const r = classifyValidationSource({ amazon: null, gsc: { impressions: 100 }, ga4: { conversions: 0 } });
  assert.equal(r, null);
});

test('mergeSources produces an Amazon-qualified entry', () => {
  const amazon = { 'natural deodorant for women': { query: 'natural deodorant for women', search_frequency_rank: 12345, impressions: 1240, clicks: 96, add_to_cart: 56, purchases: 38, cvr: 0.396, asins: [{ asin: 'B0FAKERSC', clicks: 96, purchases: 38 }], competitors: [{ asin: 'B0N', click_share: 0.18 }] } };
  const gsc = { 'natural deodorant for women': { impressions: 2400, clicks: 96, ctr: 0.04, position: 14.2, top_page: '/products/x', pages: [] } };
  const ga4Map = { '/products/x': { sessions: 480, conversions: 28, page_revenue: 1240 } };
  const clusters = { 'natural deodorant for women': 'deodorant' };

  const out = mergeSources({ amazon, gsc, ga4Map, clusters });
  assert.equal(Object.keys(out).length, 1);
  const slug = Object.keys(out)[0];
  assert.equal(out[slug].keyword, 'natural deodorant for women');
  assert.equal(out[slug].validation_source, 'amazon');
  assert.equal(out[slug].cluster, 'deodorant');
  assert.ok(out[slug].amazon);
  assert.ok(out[slug].gsc);
  assert.ok(out[slug].ga4);
});

test('mergeSources produces a GSC-qualified entry when no amazon signal', () => {
  const amazon = {};
  const gsc = { 'shopify only kw': { impressions: 500, clicks: 30, ctr: 0.06, position: 8.0, top_page: '/products/y', pages: [] } };
  const ga4Map = { '/products/y': { sessions: 100, conversions: 5, page_revenue: 200 } };
  const clusters = {};

  const out = mergeSources({ amazon, gsc, ga4Map, clusters });
  const slug = Object.keys(out)[0];
  assert.equal(out[slug].validation_source, 'gsc_ga4');
  assert.equal(out[slug].amazon, null);
  assert.ok(out[slug].gsc);
});

test('mergeSources drops unqualified entries', () => {
  const amazon = {};
  const gsc = { 'no signal kw': { impressions: 100, clicks: 0, ctr: 0, position: 80, top_page: '/x', pages: [] } };
  const ga4Map = { '/x': { sessions: 5, conversions: 0, page_revenue: 0 } };
  const out = mergeSources({ amazon, gsc, ga4Map, clusters: {} });
  assert.deepEqual(out, {});
});

test('mergeSources falls back to "unclustered" when no cluster match', () => {
  const amazon = { 'mystery kw': { query: 'mystery kw', purchases: 5, clicks: 10, impressions: 100, add_to_cart: 7, cvr: 0.5, asins: [], competitors: [] } };
  const out = mergeSources({ amazon, gsc: {}, ga4Map: {}, clusters: {} });
  const slug = Object.keys(out)[0];
  assert.equal(out[slug].cluster, 'unclustered');
});

test('mergeSources derives a cluster from keyword text when prior has none', () => {
  // GSC-discovered keyword, no prior cluster — must be derived, not 'unclustered'.
  const gsc = { 'best body lotion for sensitive skin': { impressions: 500, clicks: 30, ctr: 0.06, position: 8, top_page: '/p/y', pages: [] } };
  const ga4Map = { '/p/y': { sessions: 100, conversions: 5, page_revenue: 200 } };
  const out = mergeSources({ amazon: {}, gsc, ga4Map, clusters: {} });
  assert.equal(out[Object.keys(out)[0]].cluster, 'lotion');
});

test('mergeSources does NOT copy a stale "unclustered" forward — it recomputes', () => {
  // Prior build collapsed this keyword to 'unclustered'; we must re-derive it.
  const gsc = { 'fluoride free toothpaste': { impressions: 800, clicks: 40, ctr: 0.05, position: 6, top_page: '/p/z', pages: [] } };
  const ga4Map = { '/p/z': { sessions: 120, conversions: 7, page_revenue: 300 } };
  const clusters = { 'fluoride free toothpaste': 'unclustered' };
  const out = mergeSources({ amazon: {}, gsc, ga4Map, clusters });
  assert.equal(out[Object.keys(out)[0]].cluster, 'toothpaste');
});

test('mergeSources preserves a real cluster carried over from the prior index', () => {
  const gsc = { 'some kw': { impressions: 500, clicks: 30, ctr: 0.06, position: 8, top_page: '/p/w', pages: [] } };
  const ga4Map = { '/p/w': { sessions: 100, conversions: 5, page_revenue: 200 } };
  const clusters = { 'some kw': 'coconut oil' }; // manually curated; must win
  const out = mergeSources({ amazon: {}, gsc, ga4Map, clusters });
  assert.equal(out[Object.keys(out)[0]].cluster, 'coconut oil');
});
