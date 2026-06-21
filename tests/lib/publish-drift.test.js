import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { findPublishDrift, reconcileEverPublishedLedger } from '../../lib/publish-drift.js';

// records: posts we believe are published (our meta says shopify_status: published)
// live: Map<String(articleId), { published:boolean, handle }>

test('findPublishDrift: a post published in both records and Shopify is not drift', () => {
  const records = [{ slug: 'a', articleId: '111', handle: 'a' }];
  const live = new Map([['111', { published: true, handle: 'a' }]]);
  assert.deepEqual(findPublishDrift(records, live), []);
});

test('findPublishDrift: published in our records but a draft on Shopify is drift', () => {
  const records = [{ slug: 'a', articleId: '111', handle: 'a' }];
  const live = new Map([['111', { published: false, handle: 'a' }]]);
  const d = findPublishDrift(records, live);
  assert.equal(d.length, 1);
  assert.equal(d[0].slug, 'a');
  assert.equal(d[0].reason, 'draft');
});

test('findPublishDrift: published in our records but missing on Shopify is drift (deleted)', () => {
  const records = [{ slug: 'a', articleId: '111', handle: 'a' }];
  const live = new Map(); // not present
  const d = findPublishDrift(records, live);
  assert.equal(d.length, 1);
  assert.equal(d[0].reason, 'missing');
});

test('findPublishDrift: matches by article id even when ids differ in type (number vs string)', () => {
  const records = [{ slug: 'a', articleId: 111, handle: 'a' }]; // numeric id
  const live = new Map([['111', { published: true, handle: 'a' }]]);
  assert.deepEqual(findPublishDrift(records, live), []);
});

test('findPublishDrift: records without an article id are skipped (nothing to compare)', () => {
  const records = [{ slug: 'a', articleId: null, handle: 'a' }];
  const live = new Map();
  assert.deepEqual(findPublishDrift(records, live), []);
});

test('findPublishDrift: excludes intentionally-unpublished posts (cannibalization/kill) by slug or handle', () => {
  const records = [
    { slug: 'consolidated', articleId: '1', handle: 'consolidated-handle' },
    { slug: 'real-drift', articleId: '2', handle: 'real-drift' },
  ];
  const live = new Map([
    ['1', { published: false, handle: 'consolidated-handle' }], // intentionally retired
    ['2', { published: false, handle: 'real-drift' }],          // genuine drift
  ]);
  const intentional = new Set(['consolidated-handle']); // matched by handle
  const d = findPublishDrift(records, live, { intentional });
  assert.deepEqual(d.map((x) => x.slug), ['real-drift']);
});

test('findPublishDrift: intentional exclusion also matches on slug', () => {
  const records = [{ slug: 'killed-post', articleId: '9', handle: 'killed-post-handle' }];
  const live = new Map([['9', { published: false, handle: 'killed-post-handle' }]]);
  assert.deepEqual(findPublishDrift(records, live, { intentional: new Set(['killed-post']) }), []);
});

test('findPublishDrift: reports each drifted post once, preserving slug/handle/id', () => {
  const records = [
    { slug: 'ok', articleId: '1', handle: 'ok' },
    { slug: 'gone', articleId: '2', handle: 'gone' },
    { slug: 'draft', articleId: '3', handle: 'draft' },
  ];
  const live = new Map([
    ['1', { published: true, handle: 'ok' }],
    ['3', { published: false, handle: 'draft' }],
  ]);
  const d = findPublishDrift(records, live);
  assert.deepEqual(d.map((x) => `${x.slug}:${x.reason}`).sort(), ['draft:draft', 'gone:missing']);
});

// ── reconcileEverPublishedLedger: the watch-list that closes the no-local-meta blind spot ──

test('reconcileEverPublishedLedger: seeds the ledger from every live-published article', () => {
  const live = new Map([
    ['1', { published: true, handle: 'alpha' }],
    ['2', { published: true, handle: 'beta' }],
  ]);
  const { ledger } = reconcileEverPublishedLedger({}, live, '2026-06-21T00:00:00Z');
  assert.equal(ledger['1'].handle, 'alpha');
  assert.equal(ledger['2'].lastSeenPublished, '2026-06-21T00:00:00Z');
});

test('reconcileEverPublishedLedger: a ledgered post now draft is returned as a record (catches drift with no local meta)', () => {
  const ledger = { '7': { handle: 'gone-to-draft', firstSeen: '2026-06-01T00:00:00Z' } };
  const live = new Map([['7', { published: false, handle: 'gone-to-draft' }]]);
  const { records } = reconcileEverPublishedLedger(ledger, live, '2026-06-21T00:00:00Z');
  assert.deepEqual(records, [{ slug: 'gone-to-draft', articleId: '7', handle: 'gone-to-draft' }]);
  // and findPublishDrift then flags it as draft drift
  const drift = findPublishDrift(records, live);
  assert.deepEqual(drift.map((d) => `${d.handle}:${d.reason}`), ['gone-to-draft:draft']);
});

test('reconcileEverPublishedLedger: preserves firstSeen across runs', () => {
  const ledger = { '5': { handle: 'old', firstSeen: '2026-01-01T00:00:00Z', lastSeenPublished: '2026-01-01T00:00:00Z' } };
  const live = new Map([['5', { published: true, handle: 'old' }]]);
  const { ledger: next } = reconcileEverPublishedLedger(ledger, live, '2026-06-21T00:00:00Z');
  assert.equal(next['5'].firstSeen, '2026-01-01T00:00:00Z');
  assert.equal(next['5'].lastSeenPublished, '2026-06-21T00:00:00Z');
});

test('reconcileEverPublishedLedger: prunes entries deleted on Shopify', () => {
  const ledger = { '9': { handle: 'deleted' } };
  const live = new Map(); // article 9 no longer exists
  const { ledger: next, records } = reconcileEverPublishedLedger(ledger, live, '2026-06-21T00:00:00Z');
  assert.equal(next['9'], undefined);
  assert.deepEqual(records, []);
});

test('reconcileEverPublishedLedger: does not duplicate records already tracked locally', () => {
  const ledger = { '3': { handle: 'tracked' } };
  const live = new Map([['3', { published: false, handle: 'tracked' }]]);
  const { records } = reconcileEverPublishedLedger(ledger, live, '2026-06-21T00:00:00Z', new Set(['3']));
  assert.deepEqual(records, []); // already covered by a local record
});
