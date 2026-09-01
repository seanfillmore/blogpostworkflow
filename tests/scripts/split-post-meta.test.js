// The one-time data migration that moves machine state out of meta.json.
//
// SEO_CLAUDE_ROOT is set before the dynamic import because lib/posts.js resolves
// ROOT at module scope; node --test gives each file its own process.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = mkdtempSync(join(tmpdir(), 'split-meta-'));
process.env.SEO_CLAUDE_ROOT = ROOT;

let split, posts;
before(async () => {
  split = await import('../../scripts/split-post-meta.mjs');
  posts = await import('../../lib/posts.js');
});

const dir = (slug) => join(ROOT, 'data', 'posts', slug);
beforeEach(() => rmSync(join(ROOT, 'data'), { recursive: true, force: true }));

function makePost(slug, meta) {
  mkdirSync(dir(slug), { recursive: true });
  writeFileSync(join(dir(slug), 'meta.json'), JSON.stringify(meta, null, 2));
}

const FULL = {
  slug: 'a-post',
  title: 'A Title',
  target_keyword: 'kw',
  shopify_article_id: 12345,
  legacy_locked: true,
  indexing_state: { state: 'indexed' },
  published_at: '2026-01-01T00:00:00Z',
};

test('planSplit counts what moves and what stays', () => {
  const p = split.planSplit(FULL);
  assert.equal(p.authored, 3);   // slug, title, target_keyword
  assert.equal(p.moved, 4);
  assert.equal(p.noop, false);
});

test('planSplit reports a post already holding only authored fields as a no-op', () => {
  assert.equal(split.planSplit({ title: 'T', slug: 's' }).noop, true);
});

test('sameMergedView is the verification the migration rolls back on', () => {
  assert.equal(split.sameMergedView({ a: 1, b: 2 }, { a: 1, b: 2 }), true);
  assert.equal(split.sameMergedView({ a: 1, b: 2 }, { b: 2, a: 1 }), true, 'key order is not a difference');
  assert.equal(split.sameMergedView({ a: 1 }, { a: 2 }), false, 'a changed value must fail');
  assert.equal(split.sameMergedView({ a: 1, b: 2 }, { a: 1 }), false, 'a DROPPED field must fail');
  assert.equal(split.sameMergedView({ a: 1 }, { a: 1, b: 2 }), false, 'an invented field must fail');
});

test('the split preserves the merged view exactly, field for field', () => {
  // The whole safety property in one assertion: every reader calls getPostMeta,
  // so if that returns the same object the migration is invisible to all 31.
  makePost('a-post', FULL);
  const before = posts.getPostMeta('a-post');
  posts.replacePostMeta('a-post', before);
  assert.deepEqual(posts.getPostMeta('a-post'), FULL);
});

test('after the split, meta.json holds ONLY authored fields', () => {
  makePost('a-post', FULL);
  posts.replacePostMeta('a-post', posts.getPostMeta('a-post'));
  const meta = JSON.parse(readFileSync(join(dir('a-post'), 'meta.json'), 'utf8'));
  assert.deepEqual(Object.keys(meta).sort(), ['slug', 'target_keyword', 'title']);
  assert.equal('shopify_article_id' in meta, false,
    'a deploy must never again be able to collide on machine state');
});

test('after the split, state.json holds the machine half', () => {
  makePost('a-post', FULL);
  posts.replacePostMeta('a-post', posts.getPostMeta('a-post'));
  const state = JSON.parse(readFileSync(join(dir('a-post'), 'state.json'), 'utf8'));
  assert.equal(state.shopify_article_id, 12345);
  assert.equal(state.legacy_locked, true);
  assert.equal(state.published_at, '2026-01-01T00:00:00Z');
});

test('it is IDEMPOTENT — a second pass writes the same thing', () => {
  // The migration will be run more than once (dry, apply, then again after a
  // deploy), and cron is writing throughout. A second run must be a no-op.
  makePost('a-post', FULL);
  posts.replacePostMeta('a-post', posts.getPostMeta('a-post'));
  const metaOnce = readFileSync(join(dir('a-post'), 'meta.json'), 'utf8');
  const stateOnce = readFileSync(join(dir('a-post'), 'state.json'), 'utf8');

  posts.replacePostMeta('a-post', posts.getPostMeta('a-post'));
  assert.equal(readFileSync(join(dir('a-post'), 'meta.json'), 'utf8'), metaOnce);
  assert.equal(readFileSync(join(dir('a-post'), 'state.json'), 'utf8'), stateOnce);
});

test('a partially-split post (both files already present) merges correctly', () => {
  // The shape a crash between the two writes leaves behind.
  makePost('a-post', { title: 'T', shopify_article_id: 'STALE' });
  writeFileSync(join(dir('a-post'), 'state.json'), JSON.stringify({ shopify_article_id: 99 }));
  posts.replacePostMeta('a-post', posts.getPostMeta('a-post'));
  assert.equal(posts.getPostMeta('a-post').shopify_article_id, 99, 'state is the newer authority');
  const meta = JSON.parse(readFileSync(join(dir('a-post'), 'meta.json'), 'utf8'));
  assert.equal('shopify_article_id' in meta, false, 'the stale copy must be gone from meta.json');
});

test('an unclassified field is surfaced, not swallowed', () => {
  const p = split.planSplit({ title: 'T', a_brand_new_stamp: 'x' });
  assert.deepEqual(p.unclassified, ['a_brand_new_stamp']);
});

test('no state.json is written for a post that has only authored fields', () => {
  makePost('plain', { title: 'T', slug: 'plain' });
  posts.replacePostMeta('plain', posts.getPostMeta('plain'));
  assert.equal(existsSync(join(dir('plain'), 'state.json')), false);
});
