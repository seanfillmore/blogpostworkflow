import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ZIGPOLL_CLUSTERS,
  zigpollOrderInScope,
  normalizeZigpollResponse,
  filterSkinCluster,
  dedupeRecords,
} from '../../lib/voice-of-customer.js';

// Real product titles, copied verbatim from the live Zigpoll account's
// `shopify_line_items` metadata on 2026-08-24. These are the strings the filter
// actually sees; a paraphrase would not prove anything about assignCluster.
const LIVE_TITLES = {
  lotion: 'Non-Toxic Body Lotion Made With Only 6 Clean Ingredients - Pure Unscented',
  lotion2: 'Lightweight Coconut Lotion | 8oz - Calming Lavender',
  moisturizer: 'Coconut Moisturizer | 4oz - Coconut Breeze',
  soap: 'Moisturizing Coconut Soap | 3.4oz - Nourishing Tea Tree',
  soap2: 'Foaming Liquid Coconut Oil Soap | 8oz - Coconut Breeze',
  refill: 'Foam Soap Refill | 32oz - Orange Zest',
  deodorant: 'All Natural Coconut Oil Deodorant | 2oz - Calming Lavender',
  toothpaste: 'Coconut Oil Toothpaste | Fluoride Free',
  lipBalm: 'Natural Coconut Oil Lip Balm | 0.15oz | Four Pack - Vanilla',
};

test('ZIGPOLL_CLUSTERS is exactly lotion, soap and the coconut-oil fallback', () => {
  assert.deepEqual([...ZIGPOLL_CLUSTERS].sort(), ['coconut oil', 'lotion', 'soap']);
});

test('every in-scope live product title is recognised', () => {
  for (const key of ['lotion', 'lotion2', 'moisturizer', 'soap', 'soap2', 'refill']) {
    assert.equal(zigpollOrderInScope([LIVE_TITLES[key]]), true, `${key} should be in scope`);
  }
});

test('deodorant, toothpaste and lip balm are out of scope', () => {
  // Not because they earn nothing — toothpaste earns — but because
  // voice-of-customer is scoped to the skin cluster.
  for (const key of ['deodorant', 'toothpaste', 'lipBalm']) {
    assert.equal(zigpollOrderInScope([LIVE_TITLES[key]]), false, `${key} should be out of scope`);
  }
});

test('a mixed order counts as in scope when ANY line is', () => {
  assert.equal(zigpollOrderInScope([LIVE_TITLES.toothpaste, LIVE_TITLES.lotion]), true);
  assert.equal(zigpollOrderInScope([LIVE_TITLES.lotion, LIVE_TITLES.toothpaste]), true);
});

test('an order with no line items is NOT in scope', () => {
  // Exit-intent and cart responses carry no order, so nothing says which cluster
  // the visitor was looking at.
  assert.equal(zigpollOrderInScope([]), false);
  assert.equal(zigpollOrderInScope(null), false);
  assert.equal(zigpollOrderInScope(undefined), false);
});

test('normalizeZigpollResponse produces the shared corpus record shape', () => {
  const rec = normalizeZigpollResponse({ _id: 'abc123' }, '  Originally found on Amazon  ');
  assert.deepEqual(rec, {
    source: 'zigpoll',
    id: 'zigpoll:abc123',
    url: null,
    handle: null,
    rating: null,
    text: 'Originally found on Amazon',
  });
});

test('normalizeZigpollResponse falls back to a content hash when there is no id', () => {
  const a = normalizeZigpollResponse({}, 'same text');
  const b = normalizeZigpollResponse({}, 'same text');
  const c = normalizeZigpollResponse({}, 'different text');
  assert.equal(a.id, b.id, 'same text produces a stable id');
  assert.notEqual(a.id, c.id);
  assert.ok(a.id.startsWith('zigpoll:'));
});

test('a zigpoll record survives filterSkinCluster', () => {
  // handle is null by design: scope was already decided against the cluster
  // vocabulary, because Zigpoll records a product title and never a handle.
  const rec = normalizeZigpollResponse({ _id: 'x' }, 'love this stuff');
  assert.deepEqual(filterSkinCluster([rec]), [rec]);
});

test('two zigpoll responses with the same id collapse, different ids do not', () => {
  const a = normalizeZigpollResponse({ _id: 'dup' }, 'first');
  const b = normalizeZigpollResponse({ _id: 'dup' }, 'first');
  const c = normalizeZigpollResponse({ _id: 'other' }, 'second');
  assert.equal(dedupeRecords([a, b, c]).length, 2);
});
