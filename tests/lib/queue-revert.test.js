import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { revertPlanFor, revertQueueItem } from '../../lib/queue-revert.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'queue-revert-'));

// ── what a revert would need, captured before the write ──────────────────────

test('a page-meta rewrite records the previously-live metafields', () => {
  const plan = revertPlanFor({
    trigger: 'page-meta-rewrite',
    resource_id: 93868261546,
    proposed_meta: { seo_title: 'new', original_title: 'FAQS', original_description: null },
  });
  assert.equal(plan.kind, 'metafield');
  assert.equal(plan.resource, 'pages');
  assert.equal(plan.resource_id, 93868261546);
  assert.equal(plan.previous.title_tag, 'FAQS');
});

test('values read live at apply time win over the ones stored in the item', () => {
  // The stored `original_*` were captured when the item was QUEUED, which for
  // the live faqs item was a month ago. Whatever is on the page right now is
  // what a revert has to put back.
  const plan = revertPlanFor(
    { trigger: 'product-meta-rewrite', resource_id: 7, proposed_meta: { original_title: 'stale' } },
    { previous: { title_tag: 'actually live', description_tag: 'live desc' } },
  );
  assert.equal(plan.resource, 'products');
  assert.equal(plan.previous.title_tag, 'actually live');
});

test('a blog refresh reverts from its backup HTML', () => {
  const plan = revertPlanFor({ trigger: 'quick-win', slug: 'coconut-lotion', backup_html_path: '/q/coconut-lotion.backup.html' });
  assert.equal(plan.kind, 'blog-html');
  assert.equal(plan.backup_html_path, '/q/coconut-lotion.backup.html');
});

test('a seo-opportunity is revertible only because a backup is taken before the executor runs', () => {
  assert.equal(revertPlanFor({ trigger: 'seo-opportunity', slug: 'seo-opp-x' }), null,
    'no backup captured → say so rather than promise a revert that would fail');
  const plan = revertPlanFor({ trigger: 'seo-opportunity', slug: 'seo-opp-x', backup_html_path: '/q/x.backup.html' });
  assert.equal(plan.kind, 'blog-html');
  assert.match(plan.note, /not undone/, 'the caveat about executor side effects is recorded, not hidden');
});

test('item types with no honest automatic revert record null', () => {
  for (const trigger of ['collection-gap', 'collection-content', 'product-description-rewrite', 'product-title-rewrite']) {
    assert.equal(revertPlanFor({ trigger, slug: 's', backup_html_path: '/x' }), null, trigger);
  }
  assert.equal(revertPlanFor(null), null);
});

// ── performing the revert ────────────────────────────────────────────────────

test('a refresh with no Shopify article id refuses rather than reverting only the local file', async (t) => {
  const dir = tmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const backup = join(dir, 'b.html');
  writeFileSync(backup, '<p>original</p>');
  const puts = [];
  await assert.rejects(
    () => revertQueueItem(
      { revert_plan: { kind: 'blog-html', slug: '__no_such_post__', backup_html_path: backup } },
      { getBlogs: async () => [{ id: 1 }], updateArticle: async (...a) => puts.push(a) },
    ),
    /refusing to revert only the local file/i,
  );
  assert.equal(puts.length, 0);
});

test('reverting metafields restores both tags, including one that was empty', async () => {
  const calls = [];
  await revertQueueItem(
    { revert_plan: { kind: 'metafield', resource: 'pages', resource_id: 12, previous: { title_tag: 'FAQS', description_tag: '' } } },
    { upsertMetafield: async (...a) => calls.push(a) },
  );
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], ['pages', 12, 'global', 'title_tag', 'FAQS']);
  assert.deepEqual(calls[1], ['pages', 12, 'global', 'description_tag', ''],
    'a previously-empty description must be restored to empty, not skipped');
});

test('a revert with nothing captured fails loudly instead of reporting success', async () => {
  await assert.rejects(
    () => revertQueueItem({ revert_plan: { kind: 'metafield', resource: 'pages', resource_id: 12, previous: {} } }, {}),
    /No previous title\/description/,
  );
  await assert.rejects(
    () => revertQueueItem({ trigger: 'collection-gap', slug: 'x' }, {}),
    /records no way to revert/,
  );
  await assert.rejects(
    () => revertQueueItem({ revert_plan: { kind: 'blog-html', slug: 'x', backup_html_path: '/nope/missing.html' } }, {}),
    /Backup HTML missing/,
  );
});
