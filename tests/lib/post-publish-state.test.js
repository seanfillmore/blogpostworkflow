import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolvePublishStatus, isLivePost, isLiveOrScheduled, hasExplicitStatus,
  statusFromShopifyArticle,
} from '../../lib/post-publish-state.js';

// THE BUG THIS EXISTS FOR: 52 of 93 posts carry a shopify_article_id and NO
// shopify_status key at all — the legacy corpus, synced into data/posts/ without
// ever passing through agents/publisher. Every consumer that required a strict
// `shopify_status === 'published'` therefore treated a live, indexed, traffic-
// earning page as "not published": the digest reported it hard-blocked forever,
// and post-performance / refresh-runner / publish-drift / draft-refresher could
// not see it at all.
const now = Date.parse('2026-08-22T12:00:00Z');
const PAST = '2025-06-25T11:00:07-06:00';
const FUTURE = '2026-12-01T09:00:00-06:00';

test('legacy live post (article id + past publish date, no status) resolves published', () => {
  const meta = { shopify_article_id: 562334302378, shopify_publish_at: PAST };
  assert.equal(resolvePublishStatus(meta, { now }), 'published');
  assert.equal(isLivePost(meta, { now }), true);
  assert.equal(hasExplicitStatus(meta), false);
});

test('explicit shopify_status wins over any inference', () => {
  assert.equal(resolvePublishStatus({ shopify_status: 'published' }, { now }), 'published');
  assert.equal(resolvePublishStatus({ shopify_status: 'scheduled' }, { now }), 'scheduled');
  // An explicit draft is a draft even with a past date + article id — Shopify is
  // the authority and the backfill writes what Shopify actually says.
  const unpublished = { shopify_status: 'draft', shopify_article_id: 1, shopify_publish_at: PAST };
  assert.equal(resolvePublishStatus(unpublished, { now }), 'draft');
  assert.equal(isLivePost(unpublished, { now }), false);
});

test('a future publish date with an article id is scheduled, not live', () => {
  const meta = { shopify_article_id: 1, shopify_publish_at: FUTURE };
  assert.equal(resolvePublishStatus(meta, { now }), 'scheduled');
  assert.equal(isLivePost(meta, { now }), false);
  assert.equal(isLiveOrScheduled(meta, { now }), true);
});

test('published_at is accepted as the date field too (post-performance uses it)', () => {
  assert.equal(resolvePublishStatus({ shopify_article_id: 1, published_at: PAST }, { now }), 'published');
});

test('no article id → unknown, whatever the date says', () => {
  assert.equal(resolvePublishStatus({ shopify_publish_at: PAST }, { now }), 'unknown');
  assert.equal(resolvePublishStatus({}, { now }), 'unknown');
  assert.equal(resolvePublishStatus(null, { now }), 'unknown');
  assert.equal(isLivePost(null, { now }), false);
});

test('article id but no usable date → unknown (never guessed live)', () => {
  assert.equal(resolvePublishStatus({ shopify_article_id: 1 }, { now }), 'unknown');
  assert.equal(resolvePublishStatus({ shopify_article_id: 1, shopify_publish_at: 'not-a-date' }, { now }), 'unknown');
});

test('matches the inference indexing-checker and legacy-triage already use', () => {
  // indexing-checker/index.js:84-85 — status published OR (article id + publish date + no status)
  // legacy-triage/index.js:194     — status published OR past publish date
  // Both agree on this shape; the helper must not invent a third answer.
  const legacy = { shopify_article_id: 99, shopify_publish_at: PAST };
  const indexingCheckerRule = legacy.shopify_status === 'published'
    || (legacy.shopify_article_id && legacy.shopify_publish_at && !legacy.shopify_status);
  assert.equal(isLivePost(legacy, { now }), Boolean(indexingCheckerRule));
});

// ── statusFromShopifyArticle: what the backfill writes ────────────────────────

test('statusFromShopifyArticle reads the live article, not the local guess', () => {
  assert.equal(statusFromShopifyArticle({ published_at: PAST }, { now }), 'published');
  assert.equal(statusFromShopifyArticle({ published_at: FUTURE }, { now }), 'scheduled');
  assert.equal(statusFromShopifyArticle({ published_at: null }, { now }), 'draft');
  assert.equal(statusFromShopifyArticle({}, { now }), 'draft');
});

test('statusFromShopifyArticle returns null for a missing article (never invents a status)', () => {
  assert.equal(statusFromShopifyArticle(null, { now }), null);
  assert.equal(statusFromShopifyArticle(undefined, { now }), null);
});
