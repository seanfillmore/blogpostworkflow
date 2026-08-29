import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeTargetSlug } from '../../agents/content-refresher/index.js';

// The Shopify article handle is NOT always the local post-dir name. 93 of the
// local metas record the article as `shopify_handle` and live under a shorter
// directory — `data/posts/organic-toothpaste/` holds the article whose handle is
// `best-organic-toothpaste-what-to-look-for-why-it-matters`.
//
// content-refresher used `article.handle` directly as its write target, so it
// created a SECOND directory for a post that already had one, containing a
// content-refreshed.html and nothing else. Two things broke downstream:
// performance-engine and refresh-runner looked for the refresh under the slug
// they asked for and reported "content-refresher did not produce ..."; and the
// orphan directory (no content.html) later fed queue-autoapply's repair loop.
//
// lib/posts.js `resolvePostSlug` exists for exactly this mapping. These tests
// inject it so they assert the wiring without touching the filesystem.

test('writes back to the local post dir the article is already stored under', () => {
  const resolve = (handle) => (
    handle === 'best-organic-toothpaste-what-to-look-for-why-it-matters' ? 'organic-toothpaste' : null
  );
  assert.equal(
    writeTargetSlug('best-organic-toothpaste-what-to-look-for-why-it-matters', resolve),
    'organic-toothpaste',
  );
});

test('falls back to the Shopify handle when no local post dir claims it', () => {
  // A genuinely new article has no local directory yet; creating one named for
  // the handle is correct.
  assert.equal(writeTargetSlug('a-brand-new-article', () => null), 'a-brand-new-article');
});

test('is identity when the local dir is already named for the handle', () => {
  assert.equal(writeTargetSlug('no-fluoride-toothpaste', (h) => h), 'no-fluoride-toothpaste');
});

test('never returns an empty target', () => {
  assert.equal(writeTargetSlug('some-handle', () => ''), 'some-handle');
});
