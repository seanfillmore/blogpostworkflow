import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { findPublishDrift } from '../../lib/publish-drift.js';

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
