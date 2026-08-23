// tests/agents/seo-opportunity-analyzer-queue-item.test.js
//
// Unit tests for agents/seo-opportunity-analyzer/queue-item.js, extracted from
// main() so it's testable without a live GSC + paid DataForSEO run (see
// tests/agents/seo-opportunity-analyzer-import-safety.test.js for the import-safety
// half of that fix).
//
// Fixtures are built by running the REAL producer, lib/seo-opportunities.js's
// analyzeOpportunities, over GSC-shaped rows — not hand-authored opportunity
// objects — so this test exercises the actual shape buildOpportunityQueueItem
// receives in production, not a shape a plan says it should receive.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { analyzeOpportunities } from '../../lib/seo-opportunities.js';
import { buildOpportunityQueueItem, slugFromPage } from '../../agents/seo-opportunity-analyzer/queue-item.js';

const HOST = 'https://www.realskincare.com';
const NOW = '2026-08-21T00:00:00.000Z';

// One page, several queries — the "8 SLS variants clustered into one opportunity"
// case the agent's header docstring calls out.
const RANK_PUSH_ROWS = [
  { keyword: 'unscented lotion for eczema', page: `${HOST}/collections/unscented-lotion`, impressions: 900, clicks: 5, ctr: 0.0055, position: 14, volume: 720 },
  { keyword: 'fragrance free lotion eczema', page: `${HOST}/collections/unscented-lotion`, impressions: 300, clicks: 1, ctr: 0.0033, position: 16, volume: 210 },
];

function rankPushOpportunity() {
  const opps = analyzeOpportunities(RANK_PUSH_ROWS, { productHandles: [] });
  const o = opps.find((x) => x.page === `${HOST}/collections/unscented-lotion`);
  assert.equal(o.action, 'rank_push', 'fixture must exercise the rank_push branch — check the fixture if this fails');
  return o;
}

// ── slugFromPage ─────────────────────────────────────────────────────────────
test('slugFromPage takes the last path segment', () => {
  assert.equal(slugFromPage(`${HOST}/collections/unscented-lotion`), 'unscented-lotion');
  assert.equal(slugFromPage(`${HOST}/collections/unscented-lotion/`), 'unscented-lotion');
  assert.equal(slugFromPage(`${HOST}/blogs/news/best-soap-for-tattoos`), 'best-soap-for-tattoos');
});

// ── buildOpportunityQueueItem ────────────────────────────────────────────────
test('shapes a clustered rank_push opportunity into the full queue-item field set', () => {
  const o = rankPushOpportunity();
  const item = buildOpportunityQueueItem(o, { host: HOST, now: NOW });

  assert.deepEqual(Object.keys(item), [
    'slug', 'title', 'trigger', 'signal_source', 'summary',
    'resource_type', 'recommended_action', 'recommended_agent',
    'target_keyword', 'status', 'created_at',
  ], 'field set (and order — writeItem JSON.stringifies this object directly) must not silently change');

  assert.equal(item.slug, 'seo-opp-unscented-lotion');
  assert.equal(item.title, 'SEO opportunity: unscented lotion for eczema');
  assert.equal(item.trigger, 'seo-opportunity');
  assert.equal(item.resource_type, 'collection');
  assert.equal(item.recommended_action, 'rank_push');
  assert.equal(item.recommended_agent, 'collection-linker');
  assert.equal(item.target_keyword, 'unscented lotion for eczema');
  assert.equal(item.status, 'pending');
  assert.equal(item.created_at, NOW);
});

test('signal_source carries the clustered totals and up to 10 keywords', () => {
  const o = rankPushOpportunity();
  const item = buildOpportunityQueueItem(o, { host: HOST, now: NOW });

  assert.deepEqual(item.signal_source, {
    type: 'gsc-opportunity-analyzer',
    page: `${HOST}/collections/unscented-lotion`,
    page_type: 'collection',
    cluster_volume: 930, // 720 + 210
    impressions: 1200,   // 900 + 300
    position: 14,        // best (lowest) position in the cluster
    keywords: ['unscented lotion for eczema', 'fragrance free lotion eczema'],
  });
});

test('signal_source.keywords is capped at 10 even when the cluster has more', () => {
  const rows = Array.from({ length: 15 }, (_, i) => ({
    keyword: `kw ${i}`, page: `${HOST}/collections/many`, impressions: 100, clicks: 1, ctr: 0.01, position: 15, volume: 50,
  }));
  const [o] = analyzeOpportunities(rows, { productHandles: [] });
  const item = buildOpportunityQueueItem(o, { host: HOST, now: NOW });
  assert.equal(item.signal_source.keywords.length, 10);
});

test('summary strips the host from the page path and states the recommended action', () => {
  const o = rankPushOpportunity();
  const item = buildOpportunityQueueItem(o, { host: HOST, now: NOW });

  assert.match(item.summary.what_changed, /\/collections\/unscented-lotion/);
  assert.ok(!item.summary.what_changed.includes(HOST), 'host must be stripped, not just the path kept alongside it');
  assert.match(item.summary.why, /Recommended: rank push/);
  assert.match(item.summary.projected_impact, /collection-linker/);
  assert.match(item.summary.projected_impact, /page 2 onto page 1/, 'rank_push wording, not the refresh wording');
});

test('a refresh-action opportunity gets the deeper-rebuild wording and collection-content-optimizer', () => {
  const rows = [
    { keyword: 'deep collection query', page: `${HOST}/collections/refresh-me`, impressions: 500, clicks: 1, ctr: 0.002, position: 35, volume: 300 },
  ];
  const [o] = analyzeOpportunities(rows, { productHandles: [] });
  assert.equal(o.action, 'refresh');

  const item = buildOpportunityQueueItem(o, { host: HOST, now: NOW });
  assert.equal(item.recommended_agent, 'collection-content-optimizer');
  assert.match(item.summary.projected_impact, /content rebuild/);
  assert.ok(!item.summary.projected_impact.includes('page 2 onto page 1'));
});

test('created_at defaults to the current time when `now` is omitted', () => {
  const o = rankPushOpportunity();
  const before = Date.now();
  const item = buildOpportunityQueueItem(o, { host: HOST });
  const after = Date.now();
  const ts = Date.parse(item.created_at);
  assert.ok(ts >= before && ts <= after, 'created_at must be a real current timestamp, not a fixed default');
});

test('is pure: does not mutate the opportunity it is given', () => {
  const o = rankPushOpportunity();
  const snapshot = JSON.parse(JSON.stringify(o));
  buildOpportunityQueueItem(o, { host: HOST, now: NOW });
  assert.deepEqual(o, snapshot);
});
