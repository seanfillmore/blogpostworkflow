import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolvePublishStatus, isLivePost, isLiveOrScheduled, hasExplicitStatus,
  statusFromShopifyArticle, isRetiredPost, RETIRED_STATUSES,
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

// ── retired posts: a KNOWN state, never 'unknown' ─────────────────────────────
//
// THE BUG: `best-soap-for-tattoos-safe-healing-guide` was retired in PR #912 —
// unpublished on Shopify, 301'd to its replacement, stamped
// `shopify_status: 'redirected'`. That value was in no recognised set, so this
// resolver answered 'unknown', which is also what an unparseable date answers,
// and every consumer treats 'unknown' as "might be live". The dashboard drew it
// as "⚠ ACTION REQUIRED — 1 POST HARD-BLOCKED" with three buttons pointed at a
// URL that 301s. 9 of 220 local posts carry that stamp.

test('a redirected post resolves as redirected, NOT unknown', () => {
  const retired = {
    shopify_status: 'redirected',
    shopify_article_id: 564499841194,
    published_at: PAST,
    redirected_to: '/blogs/news/best-soap-for-tattoos-what-to-use-for-safe-healing-2',
    unpublished_at: '2026-09-19T00:00:00Z',
  };
  assert.equal(resolvePublishStatus(retired, { now }), 'redirected');
  assert.equal(isRetiredPost(retired, { now }), true);
  // and it is emphatically not live, despite the past publish date it kept
  assert.equal(isLivePost(retired, { now }), false);
  assert.equal(isLiveOrScheduled(retired, { now }), false);
});

test('every retired status resolves to itself and reads as retired (case-insensitively)', () => {
  for (const status of RETIRED_STATUSES) {
    assert.equal(resolvePublishStatus({ shopify_status: status }, { now }), status);
    assert.equal(isRetiredPost({ shopify_status: status }, { now }), true);
    assert.equal(isRetiredPost({ shopify_status: status.toUpperCase() }, { now }), true);
  }
});

test('retirement is never INFERRED — only an explicitly recorded status counts', () => {
  // 'unknown' still means "we cannot tell", and a caller must still treat it as
  // not-live. What it must never again mean is "we know this was taken down".
  assert.equal(isRetiredPost({ shopify_article_id: 1 }, { now }), false);
  assert.equal(isRetiredPost({}, { now }), false);
  assert.equal(isRetiredPost(null, { now }), false);
  // A page that merely carries a redirect record is not retired by that alone.
  assert.equal(isRetiredPost({ redirected_to: '/x', shopify_article_id: 1, published_at: PAST }, { now }), false);
});

test('a DRAFT is not retired — pre-publish work still needs a human', () => {
  // The set must not widen into "anything that is not live". A draft failing the
  // editorial gate is exactly the row the blocked-posts card exists to show.
  assert.equal(isRetiredPost({ shopify_status: 'draft' }, { now }), false);
  assert.equal(isRetiredPost({ shopify_status: 'published' }, { now }), false);
  assert.equal(isRetiredPost({ shopify_status: 'scheduled' }, { now }), false);
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
