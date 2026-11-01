import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planStamps } from '../../scripts/backfill-last-refreshed-at.mjs';

const posts = {
  'all-natural-lotion': { slug: 'all-natural-lotion', meta: {} },
  'already-later': { slug: 'already-later', meta: { last_refreshed_at: '2026-09-10T00:00:00Z' } },
  'long-handle-name': { slug: 'short', meta: {} },
};
const resolve = (slug) => posts[slug] || null;

test('stamps a queue-published body refresh, dated by the item itself', () => {
  const { stamps } = planStamps([
    { slug: 'all-natural-lotion', trigger: 'flop-refresh', status: 'published', published_at: '2026-08-30T07:33:29.659Z' },
  ], resolve);
  assert.deepEqual(stamps.map((s) => [s.slug, s.to]), [['all-natural-lotion', '2026-08-30T07:33:29.659Z']]);
});

test('never moves a stamp backwards', () => {
  const { stamps } = planStamps([
    { slug: 'already-later', trigger: 'quick-win', status: 'published', published_at: '2026-09-01T00:00:00Z' },
  ], resolve);
  assert.equal(stamps.length, 0);
});

test('only body-replacing triggers, only published items', () => {
  const { stamps } = planStamps([
    { slug: 'all-natural-lotion', trigger: 'collection-gap', status: 'published', published_at: '2026-08-30T00:00:00Z' },
    { slug: 'all-natural-lotion', trigger: 'flop-refresh', status: 'dismissed', published_at: '2026-08-30T00:00:00Z' },
    { slug: 'all-natural-lotion', trigger: 'page-meta-rewrite', status: 'published', published_at: '2026-08-30T00:00:00Z' },
  ], resolve);
  assert.equal(stamps.length, 0);
});

test('stamps the RESOLVED post, not the queue item slug; unknown posts are reported', () => {
  const { stamps, skipped } = planStamps([
    { slug: 'long-handle-name', trigger: 'legacy-flop', status: 'published', published_at: '2026-08-01T00:00:00Z' },
    { slug: 'gone', trigger: 'legacy-flop', status: 'published', published_at: '2026-08-01T00:00:00Z' },
  ], resolve);
  assert.deepEqual(stamps.map((s) => s.slug), ['short']);
  assert.deepEqual(skipped, [{ slug: 'gone', why: 'no local post' }]);
});
