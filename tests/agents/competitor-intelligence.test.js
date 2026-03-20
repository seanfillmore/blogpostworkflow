// tests/agents/competitor-intelligence.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchCompetitorUrl } from '../../agents/competitor-intelligence/matcher.js';

const pages = [
  { url: 'https://store.com/products/coconut-deodorant', slug: 'coconut-deodorant', type: 'product' },
  { url: 'https://store.com/collections/natural-deodorant', slug: 'natural-deodorant', type: 'collection' },
];

test('exact slug match for product URL', () => {
  const result = matchCompetitorUrl('https://competitor.com/products/coconut-deodorant', pages);
  assert.deepEqual(result, { slug: 'coconut-deodorant', type: 'product' });
});

test('exact slug match for collection URL', () => {
  const result = matchCompetitorUrl('https://competitor.com/collections/natural-deodorant', pages);
  assert.deepEqual(result, { slug: 'natural-deodorant', type: 'collection' });
});

test('token overlap match (2+ shared tokens)', () => {
  const result = matchCompetitorUrl('https://competitor.com/products/best-coconut-deodorant-stick', pages);
  assert.deepEqual(result, { slug: 'coconut-deodorant', type: 'product' });
});

test('returns null when no match', () => {
  const result = matchCompetitorUrl('https://competitor.com/products/totally-unrelated-thing', pages);
  assert.equal(result, null);
});

test('skips non-product non-collection URLs', () => {
  const result = matchCompetitorUrl('https://competitor.com/blogs/news/some-post', pages);
  assert.equal(result, null);
});

import { extractPageStructure } from '../../agents/competitor-intelligence/scraper.js';

test('extracts H1 and heading hierarchy', () => {
  const html = '<html><body><h1>Best Deodorant</h1><h2>Why It Works</h2></body></html>';
  const result = extractPageStructure(html, ['best', 'deodorant']);
  assert.equal(result.h1, 'Best Deodorant');
  assert.deepEqual(result.h2s, ['Why It Works']);
});

test('detects keyword in H1', () => {
  const html = '<html><body><h1>Best Natural Deodorant</h1><p>First paragraph.</p></body></html>';
  const result = extractPageStructure(html, ['natural', 'deodorant']);
  assert.equal(result.keyword_in_h1, true);
});

test('identifies benefit list format as bullets', () => {
  const html = '<html><body><ul><li>Works all day</li><li>No stains</li></ul></body></html>';
  const result = extractPageStructure(html, []);
  assert.equal(result.benefit_format, 'bullets');
});

test('extracts CTA button text', () => {
  const html = '<html><body><button class="add-to-cart">Add to Cart — Free Shipping</button></body></html>';
  const result = extractPageStructure(html, []);
  assert.equal(result.cta_text, 'Add to Cart — Free Shipping');
});

import { deduplicateChanges, computeOptimizeKpis } from '../../agents/competitor-intelligence/brief-writer.js';

test('deduplicates by type, keeps highest traffic_value competitor', () => {
  const changes = [
    { type: 'meta_title', label: 'Meta A', proposed: 'Title A', rationale: 'reason A', fromTrafficValue: 1000 },
    { type: 'meta_title', label: 'Meta B', proposed: 'Title B', rationale: 'reason B', fromTrafficValue: 5000 },
    { type: 'body_html',  label: 'Desc',   proposed: '<p>Desc</p>', rationale: 'reason C', fromTrafficValue: 2000 },
  ];
  const result = deduplicateChanges(changes);
  assert.equal(result.length, 2);
  const metaChange = result.find(c => c.type === 'meta_title');
  assert.equal(metaChange.proposed, 'Title B'); // higher traffic value wins
});

test('assigns sequential IDs to changes', () => {
  const changes = [
    { type: 'meta_title', label: 'Meta', proposed: 'T', rationale: 'r', fromTrafficValue: 100 },
    { type: 'body_html',  label: 'Body', proposed: 'B', rationale: 'r', fromTrafficValue: 100 },
  ];
  const result = deduplicateChanges(changes);
  assert.equal(result[0].id, 'change-001');
  assert.equal(result[1].id, 'change-002');
});

test('computeOptimizeKpis counts pending pages correctly', () => {
  const briefs = [
    { proposed_changes: [{ status: 'pending' }, { status: 'approved' }], competitors: [], generated_at: new Date().toISOString() },
    { proposed_changes: [{ status: 'applied' }], competitors: [], generated_at: new Date().toISOString() },
  ];
  const kpis = computeOptimizeKpis({ briefs });
  assert.equal(kpis.pendingPages, 1);
  assert.equal(kpis.approvedChanges, 1);
  assert.equal(kpis.optimizedThisMonth, 1); // second brief: all changes applied, none approved
});
