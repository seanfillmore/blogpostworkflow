import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = readFileSync(join(ROOT, 'lib', 'post-kill.js'), 'utf8');

// Source-scanned rather than executed: killPost's other arms delete directories,
// archive briefs and write data/rejected-keywords.json, and lib/shopify.js throws
// at import time without OAuth credentials. The properties below are structural.

test('no local meta.json falls back to a Shopify handle lookup', () => {
  // THE BUG: the ids live in the gitignored state.json since the 2026-08-31
  // split, and 52 of 93 posts are the legacy corpus with no local record at
  // all. killPost returned `shopify_deleted: false` with a one-line warning and
  // exited 0 while the article stayed live — a kill that killed nothing.
  assert.ok(
    /export async function findArticleByHandle/.test(SRC),
    'a handle lookup must exist so Shopify decides whether the article is there',
  );
  const elseIdx = SRC.indexOf('// NO LOCAL META IS NOT "NOTHING TO DELETE".');
  assert.ok(elseIdx > -1, 'the fallback branch must be present and explained');
  assert.ok(
    SRC.indexOf('findArticleByHandle(slug)', elseIdx) > elseIdx,
    'the fallback must actually call the lookup',
  );
});

test('a LIVE article killed this way warns that no redirect was made', () => {
  // killPost does not create redirects. The eczema page had 19 inbound internal
  // links from live articles, so a bare delete turns 19 live pages into pages
  // linking at a hard 404. Silence there is the failure.
  assert.ok(/summary\.was_live = true/.test(SRC), 'a live kill must be flagged');
  assert.ok(
    /killPost does NOT create a redirect/.test(SRC),
    'the warning must say so in words a human reads, not just set a flag',
  );
});

test('an absent article is reported as absent, not as a successful delete', () => {
  // "Shopify has no article with this handle" and "we deleted it" must never
  // render the same way — the same unreadable-is-not-absent rule the rest of
  // this repo keeps relearning.
  assert.ok(
    /no Shopify article with this handle/.test(SRC),
    'the not-found case must be named',
  );
  // shopify_deleted is only ever set true next to an awaited deleteArticle call.
  const trueSets = [...SRC.matchAll(/summary\.shopify_deleted = true/g)];
  assert.equal(trueSets.length, 2, 'exactly the meta path and the fallback path');
  for (const m of trueSets) {
    const before = SRC.slice(Math.max(0, m.index - 260), m.index);
    assert.ok(
      /await deleteArticle\(/.test(before),
      'shopify_deleted may only be set after an awaited deleteArticle',
    );
  }
});
