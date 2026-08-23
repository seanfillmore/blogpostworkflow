// The revert-actually-hits-Shopify case, in its own file on purpose.
//
// lib/posts.js resolves its root from SEO_CLAUDE_ROOT at MODULE LOAD, so the
// throwaway posts tree has to exist and the env var has to be set before
// anything in that module graph is imported. A static import anywhere above
// would freeze the real repo root in place, which is why this cannot live
// alongside the rest of the revert tests. `node --test` gives each file its own
// process, so nothing else is affected.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'queue-revert-root-'));
mkdirSync(join(ROOT, 'data', 'posts', 'coconut-lotion'), { recursive: true });
writeFileSync(join(ROOT, 'data', 'posts', 'coconut-lotion', 'meta.json'),
  JSON.stringify({ slug: 'coconut-lotion', shopify_article_id: 563289653418 }));
writeFileSync(join(ROOT, 'data', 'posts', 'coconut-lotion', 'content.html'), '<p>the bad refresh</p>');
writeFileSync(join(ROOT, 'backup.html'), '<p>the good original</p>');
process.env.SEO_CLAUDE_ROOT = ROOT;

const { revertQueueItem } = await import('../../lib/queue-revert.js');

test('reverting a blog refresh rewrites the LIVE article, not only the local file', async (t) => {
  t.after(() => rmSync(ROOT, { recursive: true, force: true }));

  const puts = [];
  const res = await revertQueueItem(
    { revert_plan: { kind: 'blog-html', slug: 'coconut-lotion', backup_html_path: join(ROOT, 'backup.html') } },
    {
      getBlogs: async () => [{ id: 4899 }],
      updateArticle: async (blogId, articleId, fields) => { puts.push({ blogId, articleId, fields }); },
    },
  );

  // The defect this pins: the old route wrote content.html and stopped there,
  // so the storefront kept serving the content the operator was reverting.
  assert.equal(puts.length, 1, 'the live Shopify article MUST be rewritten');
  assert.equal(puts[0].blogId, 4899);
  assert.equal(puts[0].articleId, 563289653418);
  assert.equal(puts[0].fields.body_html, '<p>the good original</p>');

  assert.equal(readFileSync(join(ROOT, 'data', 'posts', 'coconut-lotion', 'content.html'), 'utf8'), '<p>the good original</p>');
  assert.equal(res.reverted, true);
  assert.match(res.detail, /563289653418/);
});
