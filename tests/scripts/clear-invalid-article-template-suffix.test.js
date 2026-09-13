import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  templateExists, decideArticle, main,
} from '../../scripts/clear-invalid-article-template-suffix.mjs';

const tmpOut = () => mkdtempSync(join(tmpdir(), 'article-suffix-test-'));
const LIVE_KEYS = ['templates/article.json', 'templates/product.json', 'sections/main-article.liquid'];

test('templateExists checks both .json and .liquid, with and without a suffix', () => {
  assert.equal(templateExists('article', null, LIVE_KEYS), true);
  assert.equal(templateExists('article', 'article', LIVE_KEYS), false);
  assert.equal(templateExists('article', 'wide', ['templates/article.wide.liquid']), true);
  assert.equal(templateExists('article', 'Default blog post', LIVE_KEYS), false);
});

test('decideArticle keeps empty and resolvable suffixes, clears the rest', () => {
  assert.equal(decideArticle({ template_suffix: null }, LIVE_KEYS).action, 'keep');
  assert.equal(decideArticle({ template_suffix: '' }, LIVE_KEYS).action, 'keep');
  assert.equal(decideArticle({}, LIVE_KEYS).action, 'keep');
  assert.equal(decideArticle({ template_suffix: 'wide' }, [...LIVE_KEYS, 'templates/article.wide.json']).action, 'keep');
  // The two live shapes found on 2026-09-12.
  assert.equal(decideArticle({ template_suffix: 'article' }, LIVE_KEYS).action, 'clear');
  assert.equal(decideArticle({ template_suffix: 'Default blog post' }, LIVE_KEYS).action, 'clear');
});

function stubApi({ articles, keys = LIVE_KEYS, driftOnReread = {} } = {}) {
  const store = new Map(articles.map((a) => [a.id, { ...a }]));
  const calls = { update: [], getArticle: [] };
  return {
    calls,
    store,
    getMainThemeId: async () => 111,
    listThemeAssets: async () => keys.map((key) => ({ key })),
    getBlogs: async () => [{ id: 9, handle: 'news' }],
    getArticles: async (_blogId, { since_id: sinceId = 0 } = {}) =>
      [...store.values()].filter((a) => a.id > sinceId).sort((a, b) => a.id - b.id).map((a) => ({ ...a })),
    getArticle: async (_blogId, id) => {
      calls.getArticle.push(id);
      if (driftOnReread[id] !== undefined) store.get(id).template_suffix = driftOnReread[id];
      return { ...store.get(id) };
    },
    updateArticle: async (_blogId, id, fields) => {
      calls.update.push({ id, fields });
      Object.assign(store.get(id), fields);
      return { ...store.get(id) };
    },
  };
}

const ARTICLES = [
  { id: 1, handle: 'a-null', template_suffix: null, published_at: '2026-01-01' },
  { id: 2, handle: 'b-empty', template_suffix: '', published_at: '2026-01-01' },
  { id: 3, handle: 'c-article', template_suffix: 'article', published_at: '2026-01-01' },
  { id: 4, handle: 'd-default', template_suffix: 'Default blog post', published_at: '2026-01-01' },
  { id: 5, handle: 'e-draft', template_suffix: 'article', published_at: null },
];
const noSleep = async () => {};

test('dry run writes nothing to Shopify and reports the three invalid suffixes', async () => {
  const api = stubApi({ articles: ARTICLES });
  const rec = await main({ api, argv: ['node', 's'], sleep: noSleep, outDir: tmpOut() });
  assert.equal(api.calls.update.length, 0);
  assert.equal(rec.applied, false);
  assert.deepEqual(rec.cleared.map((r) => r.handle), ['c-article', 'd-default', 'e-draft']);
});

test('--apply clears only invalid suffixes to null, verifies, and writes before-values first', async () => {
  const api = stubApi({ articles: ARTICLES });
  const outDir = tmpOut();
  const rec = await main({ api, argv: ['node', 's', '--apply'], sleep: noSleep, outDir });
  assert.deepEqual(api.calls.update.map((c) => c.id), [3, 4, 5]);
  for (const c of api.calls.update) assert.deepEqual(c.fields, { template_suffix: null });
  assert.ok(rec.cleared.every((r) => r.written && r.verified));
  assert.equal(api.store.get(1).template_suffix, null);
  assert.equal(api.store.get(2).template_suffix, '');
  assert.ok(readdirSync(outDir).some((f) => f.startsWith('before-')));
});

test('--handle restricts the run to one article', async () => {
  const api = stubApi({ articles: ARTICLES });
  const rec = await main({ api, argv: ['node', 's', '--apply', '--handle', 'd-default'], sleep: noSleep, outDir: tmpOut() });
  assert.deepEqual(api.calls.update.map((c) => c.id), [4]);
  assert.equal(rec.checked, 1);
});

test('an article whose suffix changed since listing is skipped, not overwritten', async () => {
  const api = stubApi({ articles: ARTICLES, driftOnReread: { 3: 'something-new' } });
  const rec = await main({ api, argv: ['node', 's', '--apply'], sleep: noSleep, outDir: tmpOut() });
  assert.ok(!api.calls.update.some((c) => c.id === 3));
  assert.match(rec.cleared.find((r) => r.id === 3).skipped, /something-new/);
});

test('aborts before any write when the asset list has no base article template', async () => {
  const api = stubApi({ articles: ARTICLES, keys: [] });
  await assert.rejects(main({ api, argv: ['node', 's', '--apply'], sleep: noSleep, outDir: tmpOut() }), /ABORT/);
  assert.equal(api.calls.update.length, 0);
});

test('an unknown --handle is an error, not a silent no-op', async () => {
  const api = stubApi({ articles: ARTICLES });
  await assert.rejects(main({ api, argv: ['node', 's', '--handle', 'nope'], sleep: noSleep, outDir: tmpOut() }), /No article/);
});
