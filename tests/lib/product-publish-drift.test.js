import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findProductPublishDrift } from '../../lib/publish-drift.js';

/**
 * The blog-post detector missed products entirely, which is how eight bundles
 * the roster called "live" sat at HTTP 404 on 2026-08-25 with nothing alerting.
 * `config/bundles.json` is the declared source of truth for what should be live,
 * so anything it calls live that Shopify does not serve is drift.
 */

const live = (over = {}) => ({ status: 'ACTIVE', publishedToOnlineStore: true, ...over });

test('a roster-live product that is ACTIVE and published is not drift', () => {
  const drift = findProductPublishDrift(
    [{ handle: 'coconut-bar-soap-12-pack', status: 'live' }],
    { 'coconut-bar-soap-12-pack': live() },
  );
  assert.deepEqual(drift, []);
});

test('a roster-live product sitting at DRAFT is drift', () => {
  const drift = findProductPublishDrift(
    [{ handle: 'coconut-bar-soap-4-pack', status: 'live' }],
    { 'coconut-bar-soap-4-pack': live({ status: 'DRAFT' }) },
  );
  assert.deepEqual(drift, [{ handle: 'coconut-bar-soap-4-pack', reason: 'draft' }]);
});

test('ACTIVE but unpublished from the Online Store is still drift', () => {
  // ACTIVE alone does not make a product reachable — it also has to be published
  // to the Online Store publication, and those two drift independently.
  const drift = findProductPublishDrift(
    [{ handle: 'gift-box', status: 'live' }],
    { 'gift-box': live({ publishedToOnlineStore: false }) },
  );
  assert.deepEqual(drift, [{ handle: 'gift-box', reason: 'unpublished' }]);
});

test('a product absent from Shopify is reported as missing, not draft', () => {
  // Deleted is a different problem from unpublished and must never be auto-fixed
  // by republishing — there is nothing to republish.
  const drift = findProductPublishDrift(
    [{ handle: 'deleted-bundle', status: 'live' }],
    {},
  );
  assert.deepEqual(drift, [{ handle: 'deleted-bundle', reason: 'missing' }]);
});

test('a roster entry that is not live is never drift, whatever Shopify says', () => {
  const roster = [
    { handle: 'retired-thing', status: 'retired' },
    { handle: 'draft-thing', status: 'draft' },
    { handle: 'rejected-thing', status: 'rejected' },
  ];
  const shopify = {
    'retired-thing': live({ status: 'DRAFT' }),
    'draft-thing': live({ status: 'DRAFT' }),
    'rejected-thing': live({ status: 'DRAFT' }),
  };
  assert.deepEqual(findProductPublishDrift(roster, shopify), []);
});

test('a deliberately held handle is excluded even when roster-live and draft', () => {
  const drift = findProductPublishDrift(
    [{ handle: 'held-bundle', status: 'live' }],
    { 'held-bundle': live({ status: 'DRAFT' }) },
    { intentional: new Set(['held-bundle']) },
  );
  assert.deepEqual(drift, []);
});

test('reports every drifted product, not just the first', () => {
  const roster = [
    { handle: 'a', status: 'live' },
    { handle: 'b', status: 'live' },
    { handle: 'c', status: 'live' },
  ];
  const shopify = { a: live({ status: 'DRAFT' }), b: live(), c: live({ status: 'DRAFT' }) };
  assert.deepEqual(findProductPublishDrift(roster, shopify), [
    { handle: 'a', reason: 'draft' },
    { handle: 'c', reason: 'draft' },
  ]);
});

test('tolerates a missing or empty roster without throwing', () => {
  assert.deepEqual(findProductPublishDrift(undefined, {}), []);
  assert.deepEqual(findProductPublishDrift([], {}), []);
  assert.deepEqual(findProductPublishDrift([{ handle: 'x', status: 'live' }], undefined), [
    { handle: 'x', reason: 'missing' },
  ]);
});
