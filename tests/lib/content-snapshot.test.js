import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hashContent,
  buildContentState,
  diffContentStates,
} from '../../lib/content-snapshot.js';

// ── hashContent ────────────────────────────────────────────────────────────────

test('hashContent is stable and distinguishes different content', () => {
  assert.equal(hashContent('hello'), hashContent('hello'));
  assert.notEqual(hashContent('hello'), hashContent('hello!'));
});

test('hashContent treats null/undefined/empty as the same empty hash', () => {
  assert.equal(hashContent(null), hashContent(''));
  assert.equal(hashContent(undefined), hashContent(''));
});

// ── buildContentState ──────────────────────────────────────────────────────────

test('buildContentState hashes body_html and keeps small fields raw', () => {
  const state = buildContentState({
    articles: [{ id: 1, handle: 'a', title: 'Title', summary_html: 'meta', body_html: '<p>big body</p>' }],
    products: [{ id: 2, handle: 'p', title: 'Prod', body_html: '<p>desc</p>' }],
    pages: [{ id: 3, handle: 'pg', title: 'Page', body_html: '<p>page</p>' }],
  });
  assert.deepEqual(state.articles[0], {
    id: 1, handle: 'a', title: 'Title', summary_html: 'meta', body_hash: hashContent('<p>big body</p>'),
  });
  // body_html itself is NOT stored (only its hash) — keeps snapshots small
  assert.equal('body_html' in state.articles[0], false);
  assert.equal(state.products[0].body_hash, hashContent('<p>desc</p>'));
  assert.equal(state.pages[0].body_hash, hashContent('<p>page</p>'));
});

test('buildContentState tolerates missing groups and fields', () => {
  const state = buildContentState({});
  assert.deepEqual(state, { articles: [], products: [], pages: [] });
  const s2 = buildContentState({ articles: [{ id: 1, handle: 'a' }] });
  assert.equal(s2.articles[0].title, '');
  assert.equal(s2.articles[0].body_hash, hashContent(''));
});

// ── diffContentStates ───────────────────────────────────────────────────────────

test('detects a body change as content_body', () => {
  const prev = buildContentState({ articles: [{ id: 1, handle: 'a', title: 'T', summary_html: 'm', body_html: 'old' }] });
  const curr = buildContentState({ articles: [{ id: 1, handle: 'a', title: 'T', summary_html: 'm', body_html: 'new' }] });
  const diffs = diffContentStates(prev, curr);
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].changeType, 'content_body');
  assert.equal(diffs[0].url, '/blogs/news/a');
  assert.equal(diffs[0].slug, 'a');
});

test('detects a title change and a meta (summary_html) change', () => {
  const prev = buildContentState({ articles: [{ id: 1, handle: 'a', title: 'Old', summary_html: 'm1', body_html: 'b' }] });
  const curr = buildContentState({ articles: [{ id: 1, handle: 'a', title: 'New', summary_html: 'm2', body_html: 'b' }] });
  const diffs = diffContentStates(prev, curr).map((d) => d.changeType).sort();
  assert.deepEqual(diffs, ['meta_description', 'title']);
});

test('a brand-new item is not a change', () => {
  const prev = buildContentState({ articles: [] });
  const curr = buildContentState({ articles: [{ id: 99, handle: 'fresh', title: 'X', body_html: 'b' }] });
  assert.deepEqual(diffContentStates(prev, curr), []);
});

test('unchanged content produces no diffs', () => {
  const a = { id: 1, handle: 'a', title: 'T', summary_html: 'm', body_html: 'b' };
  assert.deepEqual(diffContentStates(buildContentState({ articles: [a] }), buildContentState({ articles: [a] })), []);
});

test('diffs products and pages too', () => {
  const prev = buildContentState({
    products: [{ id: 2, handle: 'p', title: 'P', body_html: 'b1' }],
    pages: [{ id: 3, handle: 'pg', title: 'PG', body_html: 'g1' }],
  });
  const curr = buildContentState({
    products: [{ id: 2, handle: 'p', title: 'P', body_html: 'b2' }],
    pages: [{ id: 3, handle: 'pg', title: 'PG2', body_html: 'g1' }],
  });
  const diffs = diffContentStates(prev, curr);
  const byType = diffs.map((d) => `${d.resourceType}:${d.changeType}`).sort();
  assert.deepEqual(byType, ['page:title', 'product:content_body']);
  assert.equal(diffs.find((d) => d.resourceType === 'product').url, '/products/p');
  assert.equal(diffs.find((d) => d.resourceType === 'page').url, '/pages/pg');
});
