import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planBackfill, backfillMeta } from '../../scripts/backfill-shopify-status.mjs';

const now = Date.parse('2026-08-22T12:00:00Z');
const PAST = '2025-06-25T11:00:07-06:00';
const FUTURE = '2026-12-01T09:00:00-06:00';

// 52 of 93 posts have a shopify_article_id and no shopify_status. This script
// asks LIVE Shopify what each one actually is and writes the answer down, so
// nothing downstream has to infer.

test('planBackfill targets posts with an article id and no explicit status', () => {
  const posts = [
    { slug: 'legacy', meta: { shopify_article_id: 1, shopify_publish_at: PAST } },
    { slug: 'known', meta: { shopify_article_id: 2, shopify_status: 'published' } },
    { slug: 'no-article', meta: { title: 'draft only' } },
  ];
  assert.deepEqual(planBackfill(posts).map((p) => p.slug), ['legacy']);
});

test('planBackfill --all re-verifies posts that already carry a status', () => {
  const posts = [
    { slug: 'legacy', meta: { shopify_article_id: 1 } },
    { slug: 'known', meta: { shopify_article_id: 2, shopify_status: 'published' } },
    { slug: 'no-article', meta: {} },
  ];
  assert.deepEqual(planBackfill(posts, { all: true }).map((p) => p.slug), ['legacy', 'known']);
});

test('planBackfill honours --slug and --limit', () => {
  const posts = [
    { slug: 'a', meta: { shopify_article_id: 1 } },
    { slug: 'b', meta: { shopify_article_id: 2 } },
  ];
  assert.deepEqual(planBackfill(posts, { slug: 'b' }).map((p) => p.slug), ['b']);
  assert.equal(planBackfill(posts, { limit: 1 }).length, 1);
});

test('backfillMeta writes what Shopify said, not what the local file guessed', () => {
  const out = backfillMeta({ shopify_article_id: 1, shopify_publish_at: PAST }, { published_at: null }, { at: '2026-08-22T12:00:00.000Z', now });
  assert.equal(out.meta.shopify_status, 'draft', 'Shopify is the authority — a past local date does not override it');
  assert.equal(out.changed, true);
  assert.equal(out.meta.shopify_status_verified_at, '2026-08-22T12:00:00.000Z');
});

test('backfillMeta fills a MISSING publish date from the live article', () => {
  const out = backfillMeta({ shopify_article_id: 1 }, { published_at: PAST }, { at: 'X', now });
  assert.equal(out.meta.shopify_status, 'published');
  assert.equal(out.meta.shopify_publish_at, PAST);
});

test('backfillMeta never overwrites a publish date the post already has', () => {
  const out = backfillMeta({ shopify_article_id: 1, shopify_publish_at: PAST }, { published_at: '2020-01-01T00:00:00Z' }, { at: 'X', now });
  assert.equal(out.meta.shopify_publish_at, PAST);
});

test('backfillMeta marks a future-dated live article scheduled', () => {
  const out = backfillMeta({ shopify_article_id: 1 }, { published_at: FUTURE }, { at: 'X', now });
  assert.equal(out.meta.shopify_status, 'scheduled');
});

test('a missing article (404) writes NOTHING — a deleted post is not a draft', () => {
  const before = { shopify_article_id: 1, shopify_publish_at: PAST };
  const out = backfillMeta(before, null, { at: 'X', now });
  assert.equal(out.changed, false);
  assert.equal(out.missing, true);
  assert.deepEqual(out.meta, before);
});

test('re-running on an already-correct meta is a no-op apart from the verified stamp', () => {
  const before = { shopify_article_id: 1, shopify_status: 'published', shopify_publish_at: PAST, shopify_status_verified_at: 'X' };
  const out = backfillMeta(before, { published_at: PAST }, { at: 'X', now });
  assert.equal(out.changed, false, 'idempotent — nothing to write on a second run');
});
