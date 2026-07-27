import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SKIN_CLUSTER_HANDLES,
  normalizeJudgemeReview,
  normalizeTavilyResult,
  normalizeSerpItem,
  dedupeRecords,
  filterSkinCluster,
} from '../../lib/voice-of-customer.js';

// ── cluster definition ──────────────────────────────────────────────────────
test('SKIN_CLUSTER_HANDLES is the exact five-handle list', () => {
  assert.deepEqual([...SKIN_CLUSTER_HANDLES].sort(), [
    'body-lotion-1',
    'coconut-lotion',
    'coconut-moisturizer',
    'coconut-soap',
    'organic-foaming-hand-soap',
  ]);
});

// ── normalization ───────────────────────────────────────────────────────────
test('normalizeJudgemeReview maps a Judge.me review onto the record shape', () => {
  const rec = normalizeJudgemeReview({
    id: 991,
    product_handle: 'coconut-lotion',
    rating: 5,
    body: '  Cleared up my eczema in a week.  ',
  });
  assert.equal(rec.source, 'judgeme');
  assert.equal(rec.id, 'judgeme:991');
  assert.equal(rec.handle, 'coconut-lotion');
  assert.equal(rec.rating, 5);
  assert.equal(rec.text, 'Cleared up my eczema in a week.');
  assert.equal(rec.url, null);
});

test('normalizeTavilyResult keys on the URL and joins title + content', () => {
  const rec = normalizeTavilyResult({
    url: 'https://reddit.com/r/SkincareAddiction/comments/abc/',
    title: 'Does coconut oil clog pores?',
    content: 'It broke me out badly.',
  });
  assert.equal(rec.source, 'reddit');
  assert.equal(rec.url, 'https://reddit.com/r/SkincareAddiction/comments/abc/');
  assert.match(rec.text, /Does coconut oil clog pores\?/);
  assert.match(rec.text, /broke me out badly/);
  assert.equal(rec.handle, null);
  assert.equal(rec.rating, null);
});

test('normalizeSerpItem maps a DataForSEO organic item', () => {
  const rec = normalizeSerpItem({
    url: 'https://example.com/coconut-oil-review',
    title: 'Coconut Oil Lotion Review',
    description: 'Greasy and slow to absorb.',
  });
  assert.equal(rec.source, 'serp');
  assert.equal(rec.url, 'https://example.com/coconut-oil-review');
  assert.match(rec.text, /Greasy and slow to absorb/);
});

// ── dedup ───────────────────────────────────────────────────────────────────
test('dedupeRecords collapses the same URL arriving via Tavily and SERP', () => {
  const shared = 'https://reddit.com/r/SkincareAddiction/comments/abc/';
  const out = dedupeRecords([
    normalizeTavilyResult({ url: shared, title: 'T', content: 'body' }),
    normalizeSerpItem({ url: shared, title: 'T', description: 'body' }),
  ]);
  assert.equal(out.length, 1);
});

test('dedupeRecords ignores a trailing slash and querystring when comparing URLs', () => {
  const out = dedupeRecords([
    normalizeTavilyResult({ url: 'https://reddit.com/r/x/abc/', title: 'T', content: 'b' }),
    normalizeSerpItem({ url: 'https://reddit.com/r/x/abc?utm_source=g', title: 'T', description: 'b' }),
  ]);
  assert.equal(out.length, 1);
});

test('dedupeRecords keeps distinct Judge.me reviews that have no URL', () => {
  const out = dedupeRecords([
    normalizeJudgemeReview({ id: 1, product_handle: 'coconut-lotion', rating: 5, body: 'a' }),
    normalizeJudgemeReview({ id: 2, product_handle: 'coconut-lotion', rating: 4, body: 'b' }),
  ]);
  assert.equal(out.length, 2);
});

// ── cluster filter ──────────────────────────────────────────────────────────
test('filterSkinCluster keeps skin handles and drops other clusters', () => {
  const out = filterSkinCluster([
    normalizeJudgemeReview({ id: 1, product_handle: 'coconut-lotion', rating: 5, body: 'a' }),
    normalizeJudgemeReview({ id: 2, product_handle: 'coconut-oil-toothpaste', rating: 4, body: 'b' }),
    normalizeJudgemeReview({ id: 3, product_handle: 'coconut-breeze', rating: 5, body: 'c' }),
  ]);
  assert.deepEqual(out.map((r) => r.handle), ['coconut-lotion']);
});

test('filterSkinCluster keeps handle-less external records', () => {
  const out = filterSkinCluster([
    normalizeTavilyResult({ url: 'https://reddit.com/r/x/1', title: 'T', content: 'b' }),
  ]);
  assert.equal(out.length, 1);
});
