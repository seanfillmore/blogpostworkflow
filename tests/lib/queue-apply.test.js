import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planCollectionGap, matchProductsForGap, publishCollectionGap, fixUnclosedHtml, isArticleGoneError, publishBlogRefresh,
} from '../../lib/queue-apply.js';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { getContentPath, getMetaPath, getPostDir } from '../../lib/posts.js';

// A body long enough to clear validateCollectionSpec's 300-word floor.
const FAT_BODY = `<p>${'clean coconut oil toothpaste without sulfates '.repeat(60)}</p>`;

const PRODUCTS = [
  { id: 1, title: 'Coconut Oil Toothpaste — Mint', handle: 'coconut-oil-toothpaste', tags: 'toothpaste,sls free' },
  { id: 2, title: 'Coconut Oil Toothpaste — Cinnamon', handle: 'coconut-oil-toothpaste-cinnamon', tags: 'toothpaste,sls free' },
  { id: 3, title: 'Coconut Oil Deodorant', handle: 'coconut-oil-deodorant', tags: 'deodorant' },
];

const gapItem = (over = {}) => ({
  slug: 'sls-free-toothpaste',
  trigger: 'collection-gap',
  signal_source: { keyword: 'sls free toothpaste' },
  proposed_collection: {
    title: 'SLS Free Toothpaste',
    handle: 'sls-free-toothpaste',
    seo_title: 'SLS Free Toothpaste — Gentle Natural Oral Care',
    seo_description: 'Toothpaste without sodium lauryl sulfate, made with organic coconut oil for people whose mouths react to foaming detergents.',
    body_html: FAT_BODY,
  },
  ...over,
});

// ── the three Prime-Directive defects the approve path shipped with ──────────

test('a collection with fewer than 2 matching products is refused, not created', () => {
  // The old route built `collects` from the match and proceeded even when the
  // match was EMPTY, publishing a live collection page holding nothing.
  const onlyOne = [PRODUCTS[0], PRODUCTS[2]];
  const plan = planCollectionGap(gapItem(), onlyOne);
  assert.equal(plan.ok, false);
  assert.match(plan.errors.join(' '), /only 1 distinct product/);

  const none = planCollectionGap(gapItem({ signal_source: { keyword: 'lip scrub exfoliant' } }), PRODUCTS);
  assert.equal(none.ok, false);
  assert.match(none.errors.join(' '), /only 0 distinct products/);
});

test('two or more matching products clears the product gate', () => {
  const plan = planCollectionGap(gapItem(), PRODUCTS);
  assert.equal(plan.ok, true, plan.errors.join('; '));
  assert.equal(plan.matched.length, 2);
});

test('the collection is created as a DRAFT, matching the agent path', async () => {
  // agents/collection-creator has always passed published:false; this path
  // omitted it, so Approve put an unreviewed page straight into the index.
  const calls = [];
  const deps = {
    createCustomCollection: async (fields) => { calls.push(fields); return { id: 99 }; },
    upsertMetafield: async (...a) => { calls.push(a); },
  };
  const res = await publishCollectionGap(gapItem(), deps, { products: PRODUCTS });
  assert.equal(calls[0].published, false, 'must be created as a draft');
  assert.deepEqual(calls[0].collects, [{ product_id: 1 }, { product_id: 2 }]);
  assert.equal(res.draft, true);
  assert.equal(res.matched, 2);
});

test('an invalid spec is refused before any Shopify call', async () => {
  // "DISQUALIFIED" is a real sentinel that reached the live queue directory.
  let created = false;
  const deps = { createCustomCollection: async () => { created = true; return { id: 1 }; }, upsertMetafield: async () => {} };
  const bad = gapItem({ proposed_collection: { ...gapItem().proposed_collection, title: 'DISQUALIFIED' } });
  await assert.rejects(() => publishCollectionGap(bad, deps, { products: PRODUCTS }), /Refusing to create collection.*sentinel/s);
  assert.equal(created, false, 'nothing may be written to Shopify when the spec is invalid');
});

test('a thin body is refused', () => {
  const thin = gapItem({ proposed_collection: { ...gapItem().proposed_collection, body_html: '<p>Buy toothpaste.</p>' } });
  const plan = planCollectionGap(thin, PRODUCTS);
  assert.equal(plan.ok, false);
  assert.match(plan.errors.join(' '), /too thin/);
});

test('a duplicate handle is refused when the existing handles are known', () => {
  const plan = planCollectionGap(gapItem(), PRODUCTS, { existingHandles: new Set(['sls-free-toothpaste']) });
  assert.equal(plan.ok, false);
  assert.match(plan.errors.join(' '), /already exists/);
});

test('a missing proposed_collection is an error, not a crash', () => {
  const plan = planCollectionGap({ slug: 'x', trigger: 'collection-gap' }, PRODUCTS);
  assert.equal(plan.ok, false);
  assert.match(plan.errors.join(' '), /No proposed_collection/);
});

// ── the product matcher ──────────────────────────────────────────────────────

test('matching is every-word across title, handle and tags', () => {
  assert.equal(matchProductsForGap({ signal_source: { keyword: 'coconut oil' } }, PRODUCTS).length, 3);
  assert.equal(matchProductsForGap({ signal_source: { keyword: 'sls free' } }, PRODUCTS).length, 2);
  assert.equal(matchProductsForGap({ signal_source: { keyword: 'griddle' } }, PRODUCTS).length, 0);
});

test('matching with no keyword at all matches nothing, rather than everything', () => {
  assert.deepEqual(matchProductsForGap({}, PRODUCTS), []);
  assert.deepEqual(matchProductsForGap({ signal_source: { keyword: '   ' } }, PRODUCTS), []);
  assert.deepEqual(matchProductsForGap(null, PRODUCTS), []);
});

test('the matcher tolerates a product with no tags', () => {
  const res = matchProductsForGap({ signal_source: { keyword: 'coconut' } }, [{ id: 1, title: 'Coconut Soap', handle: 'coconut-soap' }]);
  assert.equal(res.length, 1);
});

// ── carried-over helpers ─────────────────────────────────────────────────────

test('fixUnclosedHtml closes truncated tags and leaves void tags alone', () => {
  assert.equal(fixUnclosedHtml('<p>hi'), '<p>hi</p>');
  assert.equal(fixUnclosedHtml('<p>hi</p>'), '<p>hi</p>');
  assert.equal(fixUnclosedHtml('<p>a<br>b'), '<p>a<br>b</p>');
});

test('isArticleGoneError still separates a deleted article from a transient failure', () => {
  assert.equal(isArticleGoneError(new Error('HTTP 404: {"errors":"Not Found"}')), true);
  assert.equal(isArticleGoneError(new Error('HTTP 500')), false);
  assert.equal(isArticleGoneError(null), false);
});

// ── founder-note usage stamping on a queue-driven refresh ───────────────────

async function withRefreshPost(metaExtra, fn) {
  const slug = `zz-founder-notes-test-${process.pid}-${Date.now()}`;
  const dir = getPostDir(slug);
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(getMetaPath(slug), JSON.stringify({ slug, shopify_article_id: 77, ...metaExtra }));
    const refreshed = `${dir}/content-refreshed.html`;
    writeFileSync(refreshed, '<p>refreshed body</p>');
    await fn({ slug, item: { slug, refreshed_html_path: refreshed } });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const refreshDeps = (over = {}) => {
  const writes = [];
  return {
    writes,
    getBlogs: async () => [{ id: 1 }],
    getArticle: async () => ({}),
    updateArticle: async () => ({}),
    mayEditLivePost: () => ({ allowed: true }),
    recordMaterialEdit: () => {},
    writePostMeta: (slug, changes) => writes.push(changes),
    now: () => '2026-10-21T00:00:00.000Z',
    ...over,
  };
};

test('publishBlogRefresh stamps founder note uses from the refreshed HTML', async () => {
  await withRefreshPost({ founder_notes_offered: ['a', 'b'], founder_notes_used: ['a'] }, async ({ slug, item }) => {
    const calls = [];
    const deps = refreshDeps({ stampFounderNoteUses: (args) => { calls.push(args); return ['b']; } });
    const r = await publishBlogRefresh(item, deps);
    assert.equal(r.published, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].text, '<p>refreshed body</p>');
    assert.deepEqual(calls[0].offered, ['a', 'b']);
    assert.equal(calls[0].surface, 'editorial');
    assert.equal(calls[0].ref, slug);
    assert.deepEqual(deps.writes.at(-1), { founder_notes_used: ['a', 'b'] });
  });
});

test('publishBlogRefresh is not failed by a throwing founder note stamp', async () => {
  await withRefreshPost({ founder_notes_offered: ['a'] }, async ({ item }) => {
    const deps = refreshDeps({ stampFounderNoteUses: () => { throw new Error('boom'); } });
    const r = await publishBlogRefresh(item, deps);
    assert.equal(r.published, true);
  });
});

test('publishBlogRefresh skips stamping when no notes were offered', async () => {
  await withRefreshPost({}, async ({ item }) => {
    let called = false;
    const deps = refreshDeps({ stampFounderNoteUses: () => { called = true; return []; } });
    await publishBlogRefresh(item, deps);
    assert.equal(called, false);
  });
});
